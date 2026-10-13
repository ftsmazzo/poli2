import { createHash } from 'node:crypto';
import { z } from 'zod';
import { formatarQuando } from '../agente/ferramentas';
import { aplicarGates, SEM_RESULTADO } from '../agente/gates';
import type { Chat } from '../agente/llm';
import { promptAnalista } from '../agente/prompts';
import type { Db } from '../migrate';
import { prepararEnvios } from './envio';

// Importância mínima para virar alerta, e teto de alertas de importância 2 por dia (os de 3 sempre passam).
export const IMPORTANCIA_MINIMA = 2;
export const LIMITE_DIARIO_IMPORTANCIA_2 = 5;
const MAX_MENSAGENS = 400;
// Ao ligar um grupo, a Poli resume este tanto de histórico (sem alertar) para a equipe ver que está funcionando.
const JANELA_DO_RESUMO_INICIAL_MS = 24 * 60 * 60_000;
const FUSO = 'America/Belem';

const esquema = z.object({
  resumo: z.string().trim().min(1).max(4000),
  importancia: z.coerce.number().int().min(0).max(3),
  alerta: z.string().trim().max(600).nullish(),
});

// O modelo às vezes escreve algo antes ou depois do JSON: pega do primeiro "{" ao último "}".
export function lerResposta(texto: string | null): z.infer<typeof esquema> | null {
  if (!texto) return null;
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim < ini) return null;
  try {
    const r = esquema.safeParse(JSON.parse(texto.slice(ini, fim + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const compactar = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const diaLocal = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: FUSO });

export interface GrupoParaLer {
  id: number;
  workspace_id: number;
  nome: string | null;
  ultima_leitura_msg_id: number | null;
}

export type SituacaoLeitura = 'inicio' | 'sem_novidade' | 'lido' | 'alerta' | 'falha';

interface LinhaDeMensagem {
  id: number | string;
  enviada_em: string | Date;
  autor: string;
  texto: string;
}

const emLinhas = (rows: LinhaDeMensagem[]) =>
  rows.map((m) => `[${formatarQuando(m.enviada_em)}] ${m.autor}: ${String(m.texto).replace(/\s+/g, ' ')}`);

// Lê as mensagens novas de um grupo: resume, dá a nota de importância e, se for o caso, cria o alerta.
export async function lerGrupo(db: Db, chat: Chat, modelo: string, g: GrupoParaLer, agora = new Date()): Promise<SituacaoLeitura> {
  const marcar = (msgId: number | null) =>
    db.query('update grupos set ultima_leitura_em = $2, ultima_leitura_msg_id = coalesce($3, ultima_leitura_msg_id) where id = $1', [
      g.id,
      agora.toISOString(),
      msgId,
    ]);

  const pedirAnalise = async (evidencia: string, inicial: boolean) => {
    const pedido = [
      { role: 'system' as const, content: promptAnalista() },
      {
        role: 'user' as const,
        content:
          `Grupo: ${g.nome ?? 'sem nome'}\nAgora: ${formatarQuando(agora)}\n` +
          (inicial
            ? 'Este é o RESUMO INICIAL das últimas 24 horas, para a equipe ver o que o grupo andou falando. Preencha o resumo e use alerta null: coisa antiga não gera alerta.\n'
            : '') +
          `\nMensagens ${inicial ? 'das últimas 24 horas' : 'novas'}:\n${evidencia}`,
      },
    ];
    // Uma segunda chance se a resposta não vier em JSON válido.
    return lerResposta((await chat({ model: modelo, messages: pedido })).content) ?? lerResposta((await chat({ model: modelo, messages: pedido })).content);
  };

  const guardarResumo = (analise: { resumo: string; importancia: number }, rows: LinhaDeMensagem[]) =>
    db.query(
      `insert into resumos (workspace_id, grupo_id, de_msg_id, ate_msg_id, de_em, ate_em, texto, importancia)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [g.workspace_id, g.id, Number(rows[0].id), Number(rows[rows.length - 1].id), rows[0].enviada_em, rows[rows.length - 1].enviada_em, analise.resumo, analise.importancia],
    );

  // Primeira vez: resume as últimas 24 horas (sem alertar) e passa a acompanhar só o que chegar daqui em diante.
  if (g.ultima_leitura_msg_id === null) {
    const max = await db.query('select coalesce(max(id), 0) as m from mensagens where grupo_id = $1', [g.id]);
    const recentes = await db.query(
      `select * from (
         select m.id, m.enviada_em, coalesce(p.nome, 'alguém') as autor, left(m.texto, 500) as texto
         from mensagens m left join pessoas p on p.id = m.autor_pessoa_id
         where m.grupo_id = $1 and m.texto is not null and m.tipo <> 'sticker' and m.enviada_em >= $2
         order by m.id desc limit ${MAX_MENSAGENS}
       ) t order by id`,
      [g.id, new Date(agora.getTime() - JANELA_DO_RESUMO_INICIAL_MS).toISOString()],
    );
    if (recentes.rows.length > 0) {
      try {
        const analise = await pedirAnalise(emLinhas(recentes.rows as LinhaDeMensagem[]).join('\n'), true);
        if (analise) await guardarResumo(analise, recentes.rows as LinhaDeMensagem[]);
      } catch (err) {
        // Falha no resumo inicial não pode impedir o acompanhamento de começar.
        console.error('resumo inicial falhou:', err instanceof Error ? err.message : err);
      }
    }
    await marcar(Number(max.rows[0].m));
    return 'inicio';
  }

  const novas = await db.query(
    `select m.id, m.enviada_em, coalesce(p.nome, 'alguém') as autor, left(m.texto, 500) as texto
     from mensagens m left join pessoas p on p.id = m.autor_pessoa_id
     where m.grupo_id = $1 and m.id > $2 and m.texto is not null and m.tipo <> 'sticker'
     order by m.id limit ${MAX_MENSAGENS}`,
    [g.id, g.ultima_leitura_msg_id],
  );
  if (novas.rows.length === 0) {
    await marcar(null);
    return 'sem_novidade';
  }

  const evidencia = emLinhas(novas.rows as LinhaDeMensagem[]).join('\n');
  const analise = await pedirAnalise(evidencia, false);
  if (!analise) {
    // Não avança o ponteiro: as mesmas mensagens são lidas de novo no próximo intervalo.
    await marcar(null);
    return 'falha';
  }

  const ultimoId = Number(novas.rows[novas.rows.length - 1].id);
  const resumo = await guardarResumo(analise, novas.rows as LinhaDeMensagem[]);
  await marcar(ultimoId);

  // A trava de links, telefones e cifras vale também aqui: um alerta com dado que não está nas mensagens não sai.
  const alerta = analise.alerta ? aplicarGates(analise.alerta, evidencia) : null;
  if (!alerta || alerta === SEM_RESULTADO || analise.importancia < IMPORTANCIA_MINIMA) return 'lido';

  const chave = `${g.id}|${createHash('sha1').update(compactar(alerta).slice(0, 160)).digest('hex')}|${diaLocal(agora)}`;
  if (analise.importancia < 3) {
    const inicioDoDia = new Date(`${diaLocal(agora)}T00:00:00-03:00`).toISOString();
    const hoje = await db.query(
      'select count(*)::int as n from alertas where workspace_id = $1 and severidade < 3 and criado_em >= $2',
      [g.workspace_id, inicioDoDia],
    );
    if (hoje.rows[0].n >= LIMITE_DIARIO_IMPORTANCIA_2) return 'lido';
  }

  const criado = await db.query(
    // criado_em usa o mesmo "agora" da contagem diária acima: o teto de alertas por dia depende dessa hora.
    `insert into alertas (workspace_id, grupo_id, resumo_id, severidade, texto, dedupe_key, criado_em)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (workspace_id, dedupe_key) do nothing returning id`,
    [g.workspace_id, g.id, resumo.rows[0].id, analise.importancia, alerta, chave, agora.toISOString()],
  );
  if (criado.rows.length === 0) return 'lido';
  await prepararEnvios(db, Number(criado.rows[0].id));
  return 'alerta';
}

export interface ResultadoLeituras {
  lidos: number;
  alertas: number;
  falhas: number;
  inicios: number;
}

// Lê os grupos acompanhados cujo intervalo venceu, poucos por vez.
export async function lerGruposVencidos(db: Db, chat: Chat, modelo: string, agora = new Date(), limite = 5): Promise<ResultadoLeituras> {
  const r: ResultadoLeituras = { lidos: 0, alertas: 0, falhas: 0, inicios: 0 };
  const grupos = await db.query(
    `select id, workspace_id, nome, ultima_leitura_msg_id from grupos
     where acompanhar and (ultima_leitura_em is null or ultima_leitura_em + intervalo_min * interval '1 minute' <= $1::timestamptz)
     order by ultima_leitura_em nulls first limit $2`,
    [agora.toISOString(), limite],
  );
  for (const g of grupos.rows) {
    try {
      const s = await lerGrupo(
        db,
        chat,
        modelo,
        { id: Number(g.id), workspace_id: Number(g.workspace_id), nome: g.nome, ultima_leitura_msg_id: g.ultima_leitura_msg_id === null ? null : Number(g.ultima_leitura_msg_id) },
        agora,
      );
      if (s === 'inicio') r.inicios++;
      else if (s === 'falha') r.falhas++;
      else if (s !== 'sem_novidade') r.lidos++;
      if (s === 'alerta') r.alertas++;
    } catch (err) {
      // Um grupo com problema não pode travar os outros; só a mensagem do erro vai ao log.
      console.error('leitura de grupo falhou:', err instanceof Error ? err.message : err);
      r.falhas++;
    }
  }
  return r;
}

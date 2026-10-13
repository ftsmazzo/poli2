import type { Db } from '../migrate';

const FUSO = 'America/Belem';
const MAX_TENTATIVAS = 3;
// Alerta de importância menor que 3 só sai de dia; o de importância 3 sai a qualquer hora.
const HORA_INICIO = 7;
const HORA_FIM = 22;

export function horaLocal(agora: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: FUSO, hour: '2-digit', hourCycle: 'h23' }).format(agora));
}

export function dentroDoHorario(agora: Date, severidade: number): boolean {
  if (severidade >= 3) return true;
  const h = horaLocal(agora);
  return h >= HORA_INICIO && h < HORA_FIM;
}

// Cria uma mensagem pendente para cada destino do alerta: o privado de cada Head (com telefone conhecido) e
// os grupos marcados como "Grupo dos Heads". Não duplica: chamar de novo só cria o que ainda falta.
export async function prepararEnvios(db: Db, alertaId: number): Promise<number> {
  const a = await db.query(
    `select a.workspace_id, a.texto, g.nome as grupo from alertas a left join grupos g on g.id = a.grupo_id where a.id = $1`,
    [alertaId],
  );
  if (a.rows.length === 0) return 0;
  const { workspace_id: workspaceId, texto, grupo } = a.rows[0];

  const heads = await db.query(
    `select distinct telefone from pessoas where workspace_id = $1 and papel = 'head' and telefone is not null and telefone <> ''`,
    [workspaceId],
  );
  const grupos = await db.query('select jid from grupos where workspace_id = $1 and eh_heads', [workspaceId]);
  const destinos = [
    ...heads.rows.map((r) => ({ jid: r.telefone as string, tipo: 'privado' as const })),
    ...grupos.rows.map((r) => ({ jid: r.jid as string, tipo: 'grupo' as const })),
  ];

  const mensagem = `*ALERTA*${grupo ? ` · ${grupo}` : ''}\n${texto}`;
  let criados = 0;
  for (const d of destinos) {
    const r = await db.query(
      `insert into mensagens_saida (workspace_id, destino_jid, destino_tipo, origem, alerta_id, texto)
       select $1, $2, $3, 'alerta', $4, $5
       where not exists (select 1 from mensagens_saida where alerta_id = $4 and destino_jid = $2)
       returning id`,
      [workspaceId, d.jid, d.tipo, alertaId, mensagem],
    );
    criados += r.rows.length;
  }
  return criados;
}

// Alertas das últimas 24 horas que ficaram sem nenhum destino (ainda não havia Head cadastrado, por exemplo).
export async function reprocessarSemDestino(db: Db, agora = new Date()): Promise<number> {
  const sem = await db.query(
    `select a.id from alertas a
     where a.enviado_em is null and a.criado_em > $1::timestamptz - interval '24 hours'
       and not exists (select 1 from mensagens_saida m where m.alerta_id = a.id)`,
    [agora.toISOString()],
  );
  let criados = 0;
  for (const r of sem.rows) criados += await prepararEnvios(db, Number(r.id));
  return criados;
}

export interface ResultadoEnvio {
  enviadas: number;
  falhas: number;
  adiadas: number;
}

export type EnviarTexto = (instancia: string, destino: string, texto: string) => Promise<{ waMessageId: string | null }>;

// Envia os alertas pendentes, poucos por vez, respeitando o horário. Falha tenta de novo, até 3 vezes.
export async function enviarPendentes(db: Db, enviar: EnviarTexto, agora = new Date(), lote = 20): Promise<ResultadoEnvio> {
  const r: ResultadoEnvio = { enviadas: 0, falhas: 0, adiadas: 0 };
  const pendentes = await db.query(
    `select ms.id, ms.destino_jid, ms.texto, ms.tentativas, ms.alerta_id, a.severidade,
            (select i.evolution_instance from instancias_wa i where i.workspace_id = ms.workspace_id and i.ativa order by i.id limit 1) as instancia
     from mensagens_saida ms join alertas a on a.id = ms.alerta_id
     where ms.estado = 'pendente' and ms.origem = 'alerta' and ms.tentativas < $1
     order by ms.id limit $2`,
    [MAX_TENTATIVAS, lote],
  );

  for (const p of pendentes.rows) {
    if (!dentroDoHorario(agora, Number(p.severidade))) {
      r.adiadas++;
      continue;
    }
    if (!p.instancia) {
      r.adiadas++;
      continue;
    }
    try {
      const enviada = await enviar(p.instancia, p.destino_jid, p.texto);
      await db.query(`update mensagens_saida set estado = 'enviada', enviada_em = $2, wa_message_id = $3 where id = $1`, [
        p.id,
        agora.toISOString(),
        enviada.waMessageId,
      ]);
      await db.query('update alertas set enviado_em = coalesce(enviado_em, $2) where id = $1', [p.alerta_id, agora.toISOString()]);
      r.enviadas++;
    } catch (err) {
      const tentativas = Number(p.tentativas) + 1;
      console.error('envio de alerta falhou:', err instanceof Error ? err.message : err);
      await db.query(`update mensagens_saida set tentativas = $2, estado = $3 where id = $1`, [
        p.id,
        tentativas,
        tentativas >= MAX_TENTATIVAS ? 'falhou' : 'pendente',
      ]);
      r.falhas++;
    }
  }
  return r;
}

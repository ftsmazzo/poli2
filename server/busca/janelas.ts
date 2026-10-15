import type { Db } from '../migrate';
import { formatarQuando } from '../agente/ferramentas';
import { comoVetor, type Embedder } from './embeddings';

// Uma janela junta mensagens seguidas de um grupo (uma conversa), para a busca por significado achar o assunto
// mesmo quando a palavra exata não aparece. Uma mensagem sozinha ("sim, no sábado") não diz nada; a janela, sim.
export const MENSAGENS_POR_JANELA = 10;
// A última janela, incompleta, só fecha depois de um tempo sem conversa nova (senão ficaria sempre mudando).
export const PAUSA_PARA_FECHAR_MS = 30 * 60_000;
const MAX_JANELAS_POR_RODADA = 40;
const LOTE_DE_EMBEDDINGS = 20;
const MAX_CARACTERES_DA_JANELA = 6000;

interface LinhaDeMensagem {
  id: string | number;
  enviada_em: Date | string;
  autor: string;
  texto: string;
}

const emTexto = (rows: LinhaDeMensagem[]) =>
  rows
    .map((m) => `[${formatarQuando(m.enviada_em)}] ${m.autor}: ${String(m.texto).replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n')
    .slice(0, MAX_CARACTERES_DA_JANELA);

// Cria as janelas que faltam (mensagens novas desde a última janela de cada grupo) e guarda o vetor de cada uma.
// Idempotente: roda de tempos em tempos e só faz o que ainda não foi feito.
export async function indexarJanelas(db: Db, embed: Embedder, agora = new Date()): Promise<{ janelas: number }> {
  const pendentes = await db.query(
    `select g.id, g.workspace_id,
            coalesce((select max(j.ate_msg_id) from janelas j where j.grupo_id = g.id), 0) as ultimo
     from grupos g
     where exists (
       select 1 from mensagens m
       where m.grupo_id = g.id and m.texto is not null and m.tipo <> 'sticker'
         and m.id > coalesce((select max(j.ate_msg_id) from janelas j where j.grupo_id = g.id), 0)
     )
     order by g.id`,
  );

  const novas: { workspaceId: number; grupoId: number; de: number; ate: number; inicio: Date | string; fim: Date | string; texto: string }[] = [];
  for (const g of pendentes.rows) {
    if (novas.length >= MAX_JANELAS_POR_RODADA) break;
    const falta = (MAX_JANELAS_POR_RODADA - novas.length) * MENSAGENS_POR_JANELA;
    const r = await db.query(
      `select m.id, m.enviada_em, coalesce(p.nome, 'alguém') as autor, m.texto
       from mensagens m left join pessoas p on p.id = m.autor_pessoa_id
       where m.grupo_id = $1 and m.id > $2 and m.texto is not null and m.tipo <> 'sticker'
       order by m.id limit ${falta}`,
      [g.id, g.ultimo],
    );
    const rows = r.rows as LinhaDeMensagem[];
    for (let i = 0; i < rows.length; i += MENSAGENS_POR_JANELA) {
      const grupo = rows.slice(i, i + MENSAGENS_POR_JANELA);
      const completa = grupo.length === MENSAGENS_POR_JANELA;
      // Janela incompleta e recente: espera mais mensagens (e deixa as ids para a próxima rodada).
      if (!completa && agora.getTime() - new Date(grupo[grupo.length - 1].enviada_em).getTime() < PAUSA_PARA_FECHAR_MS) break;
      novas.push({
        workspaceId: Number(g.workspace_id),
        grupoId: Number(g.id),
        de: Number(grupo[0].id),
        ate: Number(grupo[grupo.length - 1].id),
        inicio: grupo[0].enviada_em,
        fim: grupo[grupo.length - 1].enviada_em,
        texto: emTexto(grupo),
      });
    }
  }

  let criadas = 0;
  for (let i = 0; i < novas.length; i += LOTE_DE_EMBEDDINGS) {
    const lote = novas.slice(i, i + LOTE_DE_EMBEDDINGS);
    const vetores = await embed(lote.map((j) => j.texto));
    for (let k = 0; k < lote.length; k++) {
      const j = lote[k];
      await db.query(
        `insert into janelas (workspace_id, grupo_id, de_msg_id, ate_msg_id, inicio_em, fim_em, texto, embedding)
         values ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [j.workspaceId, j.grupoId, j.de, j.ate, j.inicio, j.fim, j.texto, comoVetor(vetores[k])],
      );
      criadas++;
    }
  }
  return { janelas: criadas };
}

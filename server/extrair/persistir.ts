import type { Db } from '../migrate';
import { extrairItens } from './extrair';

export interface ResultadoExtracao {
  mensagens: number;
  itens: number;
}

// Extrai links, contatos, endereços e arquivos das mensagens que ainda não foram processadas.
// Cada mensagem é processada uma vez. O mesmo item em várias mensagens é um item só, que aponta para a
// mensagem mais antiga e conta quantas vezes apareceu.
export async function extrairItensPendentes(db: Db, lote = 500): Promise<ResultadoExtracao> {
  const r: ResultadoExtracao = { mensagens: 0, itens: 0 };

  const pendentes = await db.query(
    `select m.id, m.workspace_id, m.grupo_id, m.tipo, m.texto, m.enviada_em, m.autor_pessoa_id, m.origem,
            exists (select 1 from midias x where x.mensagem_id = m.id) as tem_midia,
            (select x.nome_arquivo from midias x where x.mensagem_id = m.id order by x.id limit 1) as nome_arquivo
     from mensagens m
     where m.itens_extraidos_em is null
     order by m.id
     limit $1`,
    [lote],
  );

  for (const m of pendentes.rows) {
    const itens = extrairItens({
      mensagemId: Number(m.id),
      tipo: m.tipo,
      texto: m.texto,
      origem: m.origem,
      midia: m.tem_midia ? { nomeArquivo: m.nome_arquivo } : null,
    });

    for (const item of itens) {
      await db.query(
        `insert into itens (workspace_id, grupo_id, mensagem_id, tipo, valor, dados, autor_pessoa_id, enviada_em, dedupe_key)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         on conflict (workspace_id, dedupe_key) do update set
           mensagem_id = case when excluded.enviada_em < itens.enviada_em then excluded.mensagem_id else itens.mensagem_id end,
           autor_pessoa_id = case when excluded.enviada_em < itens.enviada_em then excluded.autor_pessoa_id else itens.autor_pessoa_id end,
           enviada_em = least(itens.enviada_em, excluded.enviada_em),
           valor = case
             when excluded.dados->>'origem' = 'vcard' then excluded.valor
             when itens.dados->>'nome' is not null then itens.valor
             else coalesce(excluded.dados->>'nome', itens.valor)
           end,
           dados = (case
             when excluded.dados->>'origem' = 'vcard' then itens.dados || excluded.dados
             else excluded.dados || itens.dados
           end) || jsonb_build_object('vezes', coalesce((itens.dados->>'vezes')::int, 1) + 1)`,
        [
          m.workspace_id,
          m.grupo_id,
          m.id,
          item.tipo,
          item.valor,
          JSON.stringify({ ...item.dados, vezes: 1 }),
          m.autor_pessoa_id,
          new Date(m.enviada_em).toISOString(),
          item.chave,
        ],
      );
      r.itens++;
    }
    await db.query('update mensagens set itens_extraidos_em = now() where id = $1', [m.id]);
    r.mensagens++;
  }
  return r;
}

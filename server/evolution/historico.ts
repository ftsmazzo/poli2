import type { Db } from '../migrate';
import { extrairMensagem, gravarMensagem } from '../ingest/evolution';
import { buscarMensagens, listarGrupos, type EvolutionCfg } from './client';

export interface ResultadoHistorico {
  grupos: number;
  gruposImportados: number;
  gravadas: number;
  duplicadas: number;
  erros: string[];
}

export interface OpcoesHistorico {
  porPagina: number;
  maxPaginas: number;
}

const PADRAO: OpcoesHistorico = { porPagina: 100, maxPaginas: 500 };

// Atualiza o nome de todos os grupos da instância e importa o histórico dos que ainda não foram importados.
// Cada grupo é importado uma vez: depois disso só o webhook traz mensagens novas.
export async function importarHistoricoPendente(
  db: Db,
  evo: EvolutionCfg,
  instancia: string,
  f: typeof fetch = fetch,
  opcoes: OpcoesHistorico = PADRAO,
): Promise<ResultadoHistorico> {
  const r: ResultadoHistorico = { grupos: 0, gruposImportados: 0, gravadas: 0, duplicadas: 0, erros: [] };

  const ws = await db.query('select workspace_id from instancias_wa where evolution_instance = $1 and ativa', [instancia]);
  if (ws.rows.length === 0) return r;
  const workspaceId = ws.rows[0].workspace_id as number;

  const grupos = await listarGrupos(evo, instancia, f);
  r.grupos = grupos.length;

  for (const g of grupos) {
    // Um grupo com problema não pode travar os outros.
    try {
      const reg = await db.query(
        `insert into grupos (workspace_id, jid, nome) values ($1, $2, $3)
         on conflict (workspace_id, jid) do update set nome = coalesce(excluded.nome, grupos.nome)
         returning historico_importado_em`,
        [workspaceId, g.jid, g.nome],
      );
      if (reg.rows[0].historico_importado_em) continue;

      let gravadasNoGrupo = 0;
      for (let pagina = 1; pagina <= opcoes.maxPaginas; pagina++) {
        const { registros, paginas } = await buscarMensagens(evo, instancia, g.jid, pagina, opcoes.porPagina, f);
        for (const registro of registros) {
          const msg = extrairMensagem(registro);
          if (!msg) continue;
          const resultado = await gravarMensagem(db, instancia, msg);
          if (resultado === 'gravada') {
            r.gravadas++;
            gravadasNoGrupo++;
          } else if (resultado === 'duplicada') {
            r.duplicadas++;
          }
        }
        if (registros.length === 0 || pagina >= paginas) break;
      }

      await db.query(
        'update grupos set historico_importado_em = now(), historico_mensagens = $3 where workspace_id = $1 and jid = $2',
        [workspaceId, g.jid, gravadasNoGrupo],
      );
      r.gruposImportados++;
    } catch (err) {
      // Só o id do grupo no erro: o nome pode ser sensível e a resposta da Evolution nunca entra aqui.
      r.erros.push(`${g.jid}: ${err instanceof Error ? err.message : 'falha'}`);
    }
  }
  return r;
}

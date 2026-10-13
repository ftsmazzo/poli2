import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../migrate';
import { baixarMidia, type EvolutionCfg } from '../evolution/client';
import {
  extrairTextoExportacao,
  importarExportacao,
  pareceExportacao,
  type ResultadoImportacao,
} from '../ingest/exportacao';

export interface OpcoesMidia {
  mediaDir: string;
  // Arquivo comum: 25 MB. Exportação de conversa: mais folga, porque o zip pode trazer fotos.
  limiteBytes: number;
  limiteExportacaoBytes: number;
  maxTentativas: number;
}

export const LIMITES_PADRAO = {
  limiteBytes: 25 * 1024 * 1024,
  limiteExportacaoBytes: 100 * 1024 * 1024,
  maxTentativas: 3,
};

export interface ResultadoMidias {
  baixadas: number;
  ignoradas: number;
  falhas: number;
  exportacoes: ResultadoImportacao[];
}

// O arquivo fica em <mediaDir>/<workspace>/<sha256>: o mesmo conteúdo nunca é gravado duas vezes.
async function salvar(mediaDir: string, workspaceId: number, dados: Buffer): Promise<{ sha256: string; caminho: string }> {
  const sha256 = createHash('sha256').update(dados).digest('hex');
  const dir = path.join(mediaDir, String(workspaceId));
  await mkdir(dir, { recursive: true });
  const caminho = path.join(dir, sha256);
  try {
    await writeFile(caminho, dados, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return { sha256, caminho };
}

// Baixa os anexos pendentes (poucos por vez) e, se for uma exportação de conversa, importa as mensagens.
export async function processarMidiasPendentes(
  db: Db,
  evo: EvolutionCfg,
  opc: OpcoesMidia,
  f: typeof fetch = fetch,
  lote = 5,
): Promise<ResultadoMidias> {
  const r: ResultadoMidias = { baixadas: 0, ignoradas: 0, falhas: 0, exportacoes: [] };

  const pendentes = await db.query(
    `select distinct on (m.id)
            m.id, m.workspace_id, m.nome_arquivo, m.bytes, m.tentativas,
            ms.wa_message_id, ms.grupo_id, g.jid as grupo_jid, i.evolution_instance
     from midias m
     join mensagens ms on ms.id = m.mensagem_id
     left join grupos g on g.id = ms.grupo_id
     join instancias_wa i on i.workspace_id = m.workspace_id and i.ativa
     where m.estado = 'pendente' and m.tentativas < $1
     order by m.id
     limit $2`,
    [opc.maxTentativas, lote],
  );

  for (const p of pendentes.rows) {
    const exportacao = pareceExportacao(p.nome_arquivo);
    const limite = exportacao ? opc.limiteExportacaoBytes : opc.limiteBytes;

    const ignorar = async (motivo: string) => {
      await db.query(`update midias set estado = 'ignorada', erro = $2 where id = $1`, [p.id, motivo]);
      r.ignoradas++;
    };

    // O tamanho declarado evita baixar o que já se sabe que passa do limite.
    if (p.bytes && Number(p.bytes) > limite) {
      await ignorar('maior que o limite');
      continue;
    }

    try {
      const baixada = await baixarMidia(evo, p.evolution_instance, p.wa_message_id, f);
      if (baixada.dados.length > limite) {
        await ignorar('maior que o limite');
        continue;
      }
      const { sha256, caminho } = await salvar(opc.mediaDir, p.workspace_id, baixada.dados);
      await db.query(
        `update midias set estado = 'baixada', mime = coalesce($2, mime), bytes = $3, sha256 = $4, caminho = $5,
                baixada_em = now(), erro = null
         where id = $1`,
        [p.id, baixada.mime, baixada.dados.length, sha256, caminho],
      );
      r.baixadas++;

      if (exportacao && p.grupo_id) {
        const texto = extrairTextoExportacao(baixada.dados);
        if (texto) {
          r.exportacoes.push(
            await importarExportacao(db, {
              workspaceId: p.workspace_id,
              grupoId: p.grupo_id,
              grupoJid: p.grupo_jid,
              ref: p.wa_message_id,
              texto,
            }),
          );
        }
      }
    } catch (err) {
      // Só a mensagem do erro (status da Evolution): o corpo da resposta nunca é registrado.
      const tentativas = Number(p.tentativas) + 1;
      await db.query(`update midias set tentativas = $2, erro = $3, estado = $4 where id = $1`, [
        p.id,
        tentativas,
        err instanceof Error ? err.message : 'falha',
        tentativas >= opc.maxTentativas ? 'falhou' : 'pendente',
      ]);
      r.falhas++;
    }
  }
  return r;
}

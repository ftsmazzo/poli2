import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from './migrate';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

// Simula o banco de produção: aplica só até a 005, grava mensagens como o webhook gravava
// antes da fila de mídia existir, e então roda a 006.
describe('migration 006: anexos antigos entram na fila', () => {
  it('cria a linha de mídia para documento e imagem, e não para texto nem para quem já tem', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'poli2-mig-'));
    try {
      for (const nome of (await readdir(MIGRATIONS)).filter((n) => n < '006')) {
        await cp(path.join(MIGRATIONS, nome), path.join(dir, nome));
      }
      const db = new PGlite({ extensions: { vector } });
      expect(await migrate(db, dir)).toHaveLength(5);

      await db.query(`insert into workspaces (nome) values ('Tenant A')`);
      await db.query(`insert into grupos (workspace_id, jid) values (1, '1203@g.us')`);
      const bruto = (message: unknown) => JSON.stringify({ key: { id: 'x' }, message });
      await db.query(
        `insert into mensagens (workspace_id, grupo_id, wa_message_id, enviada_em, tipo, texto, bruto) values
         (1, 1, 'ZIP', now(), 'documento', 'Conversa.zip', $1::jsonb),
         (1, 1, 'FOTO', now(), 'imagem', null, $2::jsonb),
         (1, 1, 'TXT', now(), 'texto', 'oi', $3::jsonb),
         (1, 1, 'JA', now(), 'documento', 'ja.pdf', $4::jsonb)`,
        [
          bruto({ documentMessage: { fileName: 'Conversa do WhatsApp com Grupo A.zip', mimetype: 'application/zip' } }),
          bruto({ imageMessage: { mimetype: 'image/jpeg' } }),
          bruto({ conversation: 'oi' }),
          bruto({ documentMessage: { fileName: 'ja.pdf' } }),
        ],
      );
      await db.query(
        `insert into midias (workspace_id, mensagem_id, nome_arquivo, estado) select 1, id, 'ja.pdf', 'baixada' from mensagens where wa_message_id = 'JA'`,
      );

      expect(await migrate(db, dir)).toEqual([]);
      expect(await migrate(db)).toEqual(['006_fila_midia_anexos_antigos.sql']);

      const m = await db.query<{ wa: string; nome_arquivo: string | null; mime: string | null; estado: string }>(
        `select ms.wa_message_id as wa, m.nome_arquivo, m.mime, m.estado
         from midias m join mensagens ms on ms.id = m.mensagem_id order by ms.id`,
      );
      expect(m.rows).toEqual([
        { wa: 'ZIP', nome_arquivo: 'Conversa do WhatsApp com Grupo A.zip', mime: 'application/zip', estado: 'pendente' },
        { wa: 'FOTO', nome_arquivo: null, mime: 'image/jpeg', estado: 'pendente' },
        { wa: 'JA', nome_arquivo: 'ja.pdf', mime: null, estado: 'baixada' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

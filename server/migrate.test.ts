import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from './migrate';

async function novoBanco() {
  return new PGlite({ extensions: { vector } });
}

describe('migrate', () => {
  it('aplica o schema e é idempotente', async () => {
    const db = await novoBanco();
    const primeira = await migrate(db);
    expect(primeira).toContain('001_core.sql');
    expect(await migrate(db)).toEqual([]);
  });

  it('guarda a hora real e impede mensagem duplicada', async () => {
    const db = await novoBanco();
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Teste')`);
    const ins = `insert into mensagens (workspace_id, wa_message_id, enviada_em, texto)
                 values (1, 'ABC', '2026-10-10T12:00:00-03:00', 'oi')`;
    await db.query(ins);
    await expect(db.query(ins)).rejects.toThrow();
    const r = await db.query<{ enviada_em: string }>(`select enviada_em from mensagens`);
    expect(new Date(r.rows[0].enviada_em).toISOString()).toBe('2026-10-10T15:00:00.000Z');
  });

  it('busca por texto em português (tsvector)', async () => {
    const db = await novoBanco();
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Teste')`);
    await db.query(
      `insert into mensagens (workspace_id, wa_message_id, enviada_em, texto) values
       (1,'1',now(),'O endereço da reunião é Rua das Flores, 10'),
       (1,'2',now(),'bom dia a todos')`,
    );
    const r = await db.query<{ wa_message_id: string }>(
      `select wa_message_id from mensagens where tsv @@ plainto_tsquery('portuguese','endereços')`,
    );
    expect(r.rows.map((x) => x.wa_message_id)).toEqual(['1']);
  });
});

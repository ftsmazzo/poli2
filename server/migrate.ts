import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mínimo que o runner precisa de qualquer driver (pg Pool ou PGlite).
export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  exec?(sql: string): Promise<unknown>;
}

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    `create table if not exists _migracoes (
       nome text primary key,
       aplicada_em timestamptz not null default now()
     )`,
  );
  const feitas = new Set(
    (await db.query('select nome from _migracoes')).rows.map((r) => r.nome as string),
  );
  const arquivos = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas: string[] = [];
  for (const nome of arquivos) {
    if (feitas.has(nome)) continue;
    const sql = await readFile(path.join(dir, nome), 'utf8');
    // exec aceita múltiplos statements (PGlite); pg aceita no query sem parâmetros.
    await (db.exec ? db.exec(sql) : db.query(sql));
    await db.query('insert into _migracoes (nome) values ($1)', [nome]);
    aplicadas.push(nome);
  }
  return aplicadas;
}

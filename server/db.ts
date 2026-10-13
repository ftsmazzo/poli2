import pg from 'pg';
import { migrate, type Db } from './migrate';

export function criarPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

// Dois containers podem subir juntos durante um deploy (zero downtime):
// o lock garante que só um rode as migrations por vez.
const LOCK_MIGRACOES = 8421001;

// Roda `fn` só se ninguém mais estiver rodando a mesma tarefa (outro container, por exemplo).
// Devolve false quando outro já está com o lock, sem esperar.
export async function comLockTentativa(
  pool: pg.Pool,
  chave: number,
  fn: (db: Db) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const r = await client.query('select pg_try_advisory_lock($1) as ok', [chave]);
    if (!r.rows[0].ok) return false;
    try {
      await fn(client as unknown as Db);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [chave]).catch(() => undefined);
    }
    return true;
  } finally {
    client.release();
  }
}

export async function migrarComLock(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_MIGRACOES]);
    return await migrate(client as unknown as Db);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_MIGRACOES]).catch(() => undefined);
    client.release();
  }
}

import pg from 'pg';
import { migrate, type Db } from './migrate';

export function criarPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

// Dois containers podem subir juntos durante um deploy (zero downtime):
// o lock garante que só um rode as migrations por vez.
const LOCK_MIGRACOES = 8421001;

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

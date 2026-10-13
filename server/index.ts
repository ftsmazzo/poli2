import express from 'express';
import type { Pool } from 'pg';
import { loadConfig } from './config';
import { criarPool, migrarComLock } from './db';
import { webhookRouter } from './webhooks';

const cfg = loadConfig();
const app = express();

let pool: Pool | undefined;
let bancoPronto = false;

// Só estado do processo e se o banco responde. Detalhes ficam no Diagnóstico autenticado.
app.get('/health', async (_req, res) => {
  let db = false;
  if (pool && bancoPronto) {
    try {
      await pool.query('select 1');
      db = true;
    } catch {
      db = false;
    }
  }
  res.json({ ok: true, db });
});

app.use('/webhooks', webhookRouter(() => (bancoPronto ? pool : undefined), cfg.webhookToken));

app.listen(cfg.port, () => {
  console.log(`poli2 ouvindo na porta ${cfg.port}`);
});

// O servidor sobe antes do banco: se o banco falhar, o /health continua respondendo e mostra db:false.
async function iniciarBanco(): Promise<void> {
  if (!cfg.databaseUrl) {
    console.warn('DATABASE_URL vazia: rodando sem banco.');
    return;
  }
  try {
    pool = criarPool(cfg.databaseUrl);
    const aplicadas = await migrarComLock(pool);
    bancoPronto = true;
    console.log(aplicadas.length ? `migrations aplicadas: ${aplicadas.join(', ')}` : 'banco em dia');
  } catch (err) {
    console.error('falha ao preparar o banco:', err instanceof Error ? err.message : err);
  }
}

void iniciarBanco();

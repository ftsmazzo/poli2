// Uso (no console do container do app no EasyPanel):
//   npx tsx server/cli/criar-tenant.ts "Nome da campanha" nome-da-instancia-evolution
import { criarPool, migrarComLock } from '../db';

async function main() {
  const [nome, instancia] = process.argv.slice(2);
  const url = process.env.DATABASE_URL?.trim();
  if (!nome || !instancia || !url) {
    console.error('Uso: criar-tenant "Nome" instancia   (precisa de DATABASE_URL)');
    process.exit(1);
  }
  const pool = criarPool(url);
  try {
    await migrarComLock(pool);
    const existente = await pool.query('select workspace_id from instancias_wa where evolution_instance = $1', [instancia]);
    if (existente.rows.length > 0) {
      console.error(`A instância "${instancia}" já pertence ao workspace ${existente.rows[0].workspace_id}.`);
      process.exit(1);
    }
    const ws = await pool.query('insert into workspaces (nome) values ($1) returning id', [nome]);
    await pool.query('insert into instancias_wa (workspace_id, evolution_instance) values ($1, $2)', [ws.rows[0].id, instancia]);
    console.log(`Workspace ${ws.rows[0].id} ("${nome}") criado com a instância "${instancia}".`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

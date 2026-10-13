import express from 'express';
import type { Pool } from 'pg';
import { loadConfig } from './config';
import { comLockTentativa, criarPool, migrarComLock } from './db';
import { importarHistoricoPendente } from './evolution/historico';
import { sincronizarInstancias } from './evolution/sync';
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
    return;
  }
  iniciarSincronizacao();
}

const LOCK_SINCRONIZACAO = 8421002;
const INTERVALO_SINCRONIZACAO_MS = 5 * 60_000;

// A Poli descobre sozinha as instâncias da Evolution: cria o tenant de cada uma
// e aponta o webhook para si mesma. Ninguém precisa configurar isso à mão.
async function sincronizarEvolution(): Promise<void> {
  if (!pool || !cfg.evolutionUrl || !cfg.evolutionApiKey || !cfg.webhookToken) return;
  const evo = { url: cfg.evolutionUrl, apiKey: cfg.evolutionApiKey };
  const opcoes = { webhookBase: cfg.webhookBaseUrl, token: cfg.webhookToken };
  try {
    await comLockTentativa(pool, LOCK_SINCRONIZACAO, async (db) => {
      const r = await sincronizarInstancias(db, evo, opcoes);
      if (r.tenantsCriados.length || r.webhooksConfigurados.length || r.erros.length) {
        console.log(
          `evolution: ${r.instancias} instância(s); tenants criados: [${r.tenantsCriados}]; webhooks ajustados: [${r.webhooksConfigurados}]; erros: [${r.erros}]`,
        );
      }

      // Histórico: cada grupo é importado uma vez, depois só o webhook traz mensagens.
      const instancias = await db.query('select evolution_instance from instancias_wa where ativa');
      for (const { evolution_instance: nome } of instancias.rows) {
        try {
          const h = await importarHistoricoPendente(db, evo, nome);
          if (h.gruposImportados || h.erros.length) {
            console.log(
              `histórico ${nome}: ${h.grupos} grupo(s); importados agora: ${h.gruposImportados}; mensagens gravadas: ${h.gravadas}; já existiam: ${h.duplicadas}; erros: [${h.erros}]`,
            );
          }
        } catch (err) {
          console.error(`histórico ${nome} falhou:`, err instanceof Error ? err.message : err);
        }
      }
    });
  } catch (err) {
    console.error('sincronização com a Evolution falhou:', err instanceof Error ? err.message : err);
  }
}

function iniciarSincronizacao(): void {
  if (!cfg.evolutionUrl || !cfg.evolutionApiKey || !cfg.webhookToken) {
    console.warn('Sincronização com a Evolution desligada: faltam EVOLUTION_URL, EVOLUTION_API_KEY ou EVOLUTION_WEBHOOK_TOKEN.');
    return;
  }
  void sincronizarEvolution();
  setInterval(() => void sincronizarEvolution(), INTERVALO_SINCRONIZACAO_MS);
}

void iniciarBanco();

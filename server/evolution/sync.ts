import type { Db } from '../migrate';
import { definirWebhook, eventosDoWebhook, listarInstancias, lerWebhook, type EvolutionCfg } from './client';

export interface OpcoesSync {
  // Endereço do app visto de dentro da rede do projeto (a Evolution chama por aqui).
  webhookBase: string;
  token: string;
}

export interface ResultadoSync {
  instancias: number;
  tenantsCriados: string[];
  webhooksConfigurados: string[];
  erros: string[];
}

// Cria o tenant da instância se ainda não existir. O nome vira o da instância; o painel permite renomear.
async function garantirTenant(db: Db, instancia: string): Promise<boolean> {
  const existente = await db.query('select 1 from instancias_wa where evolution_instance = $1', [instancia]);
  if (existente.rows.length > 0) return false;
  const ws = await db.query('insert into workspaces (nome) values ($1) returning id', [instancia]);
  const id = ws.rows[0].id as number;
  try {
    await db.query('insert into instancias_wa (workspace_id, evolution_instance) values ($1, $2)', [id, instancia]);
  } catch (err) {
    // Outra sincronização chegou antes: desfaz o tenant órfão.
    await db.query('delete from workspaces where id = $1', [id]);
    if (await db.query('select 1 from instancias_wa where evolution_instance = $1', [instancia]).then((r) => r.rows.length > 0)) {
      return false;
    }
    throw err;
  }
  return true;
}

export async function sincronizarInstancias(
  db: Db,
  evo: EvolutionCfg,
  opcoes: OpcoesSync,
  f: typeof fetch = fetch,
): Promise<ResultadoSync> {
  const resultado: ResultadoSync = { instancias: 0, tenantsCriados: [], webhooksConfigurados: [], erros: [] };
  const instancias = await listarInstancias(evo, f);
  resultado.instancias = instancias.length;

  for (const { nome } of instancias) {
    // Uma instância com problema não pode travar as outras.
    try {
      if (await garantirTenant(db, nome)) resultado.tenantsCriados.push(nome);

      const url = `${opcoes.webhookBase.replace(/\/+$/, '')}/webhooks/evolution/${encodeURIComponent(nome)}`;
      const atual = await lerWebhook(evo, nome, f);
      const certo = atual?.enabled === true && atual.url === url && eventosDoWebhook(atual).includes('messages.upsert');
      if (!certo) {
        await definirWebhook(evo, nome, { url, token: opcoes.token }, f);
        resultado.webhooksConfigurados.push(nome);
      }
    } catch (err) {
      resultado.erros.push(`${nome}: ${err instanceof Error ? err.message : 'falha'}`);
    }
  }
  return resultado;
}

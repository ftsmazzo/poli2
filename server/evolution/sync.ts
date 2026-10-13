import type { Db } from '../migrate';
import { definirWebhook, eventosDoWebhook, listarInstancias, lerWebhook, type EvolutionCfg } from './client';

export interface OpcoesSync {
  // Endereço do app visto de dentro da rede do projeto (a Evolution chama por aqui).
  webhookBase: string;
  token: string;
}

export interface ResultadoSync {
  // Estado da conexão de cada instância no WhatsApp, como a Evolution informou (ex.: "open").
  estados: Record<string, string | null>;
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

// Guarda o estado da conexão e, quando o número cai ou volta, registra o evento (a faixa do painel usa isso).
async function registrarEstado(db: Db, instancia: string, estado: string): Promise<void> {
  const atual = await db.query('select workspace_id, estado_conexao from instancias_wa where evolution_instance = $1', [instancia]);
  if (atual.rows.length === 0 || atual.rows[0].estado_conexao === estado) return;
  const antes = atual.rows[0].estado_conexao as string | null;
  await db.query('update instancias_wa set estado_conexao = $2, estado_em = now() where evolution_instance = $1', [instancia, estado]);
  const caiu = antes === 'open' && estado !== 'open';
  const voltou = antes !== null && antes !== 'open' && estado === 'open';
  if (caiu || voltou) {
    await db.query(
      `insert into eventos_saude (workspace_id, tipo, alvo, estado, detalhe) values ($1, 'instancia', $2, $3, $4)`,
      [atual.rows[0].workspace_id, instancia, caiu ? 'caiu' : 'voltou', estado],
    );
  }
}

export async function sincronizarInstancias(
  db: Db,
  evo: EvolutionCfg,
  opcoes: OpcoesSync,
  f: typeof fetch = fetch,
): Promise<ResultadoSync> {
  const resultado: ResultadoSync = { estados: {}, instancias: 0, tenantsCriados: [], webhooksConfigurados: [], erros: [] };
  const instancias = await listarInstancias(evo, f);
  resultado.instancias = instancias.length;

  for (const { nome, jid, perfil, status } of instancias) {
    // Uma instância com problema não pode travar as outras.
    try {
      if (await garantirTenant(db, nome)) resultado.tenantsCriados.push(nome);
      resultado.estados[nome] = status;
      if (status) await registrarEstado(db, nome, status);
      if (perfil) {
        await db.query(
          'update instancias_wa set nome_perfil = $2 where evolution_instance = $1 and nome_perfil is distinct from $2',
          [nome, perfil],
        );
      }
      if (jid) {
        await db.query(
          'update instancias_wa set jid_proprio = $2 where evolution_instance = $1 and jid_proprio is distinct from $2',
          [nome, jid],
        );
      }

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

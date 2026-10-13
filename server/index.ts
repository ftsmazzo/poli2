import express from 'express';
import type { Pool } from 'pg';
import { loadConfig } from './config';
import { comLockTentativa, criarPool, migrarComLock } from './db';
import { importarHistoricoPendente } from './evolution/historico';
import { sincronizarInstancias } from './evolution/sync';
import { criarChatOpenRouter } from './agente/llm';
import { avaliarPedido } from './agente/pedido';
import { responderPedido } from './agente/turno';
import { enviarTexto } from './evolution/client';
import type { MensagemNormalizada } from './ingest/evolution';
import type { Db } from './migrate';
import { extrairItensPendentes } from './extrair/persistir';
import { LIMITES_PADRAO, processarMidiasPendentes } from './midia/processar';
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

// Pedido feito à Poli no grupo: reconhece, confere quem pediu, busca, redige e responde.
async function aoGravar(instancia: string, msg: MensagemNormalizada): Promise<void> {
  if (!pool || !bancoPronto || !cfg.openrouterKey || !cfg.evolutionUrl || !cfg.evolutionApiKey) {
    console.log('pedido ignorado: agente desligado por falta de configuração (veja a linha "agente:" ao subir)');
    return;
  }
  const db = pool as unknown as Db;
  const avaliacao = await avaliarPedido(db, instancia, msg, cfg.comandantes);
  if (avaliacao.tipo === 'nao_autorizado') {
    // Sem resposta e sem número no log: só o tipo do identificador, para diagnosticar.
    console.log(`pedido ignorado: autor não autorizado (${avaliacao.detalhe})`);
    return;
  }
  if (avaliacao.tipo === 'ignorar') {
    // Só registra quando a mensagem parece falar com a Poli (cita "poli" ou tem @): evita ruído de conversa comum.
    if (avaliacao.motivo && /poli|@/i.test(msg.texto ?? '')) console.log(`pedido ignorado: ${avaliacao.motivo}`);
    return;
  }

  const evo = { url: cfg.evolutionUrl, apiKey: cfg.evolutionApiKey };
  const situacao = await responderPedido(
    {
      db,
      chat: criarChatOpenRouter(cfg.openrouterKey),
      modelos: { orquestrador: cfg.modeloOrquestrador, redatora: cfg.modeloRedatora },
      enviar: (inst, jid, texto) => enviarTexto(evo, inst, jid, texto),
    },
    avaliacao.pedido,
  );
  console.log(`pedido ${situacao}`);
}

app.use('/webhooks', webhookRouter(() => (bancoPronto ? pool : undefined), cfg.webhookToken, aoGravar));

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

const LOCK_MIDIA = 8421003;
const INTERVALO_MIDIA_MS = 20_000;

// Baixa os anexos que chegaram nos grupos e, se for uma exportação de conversa, importa as mensagens.
async function processarMidias(): Promise<void> {
  if (!pool || !cfg.evolutionUrl || !cfg.evolutionApiKey) return;
  const evo = { url: cfg.evolutionUrl, apiKey: cfg.evolutionApiKey };
  try {
    await comLockTentativa(pool, LOCK_MIDIA, async (db) => {
      const r = await processarMidiasPendentes(db, evo, { mediaDir: cfg.mediaDir, ...LIMITES_PADRAO });
      if (r.baixadas || r.ignoradas || r.falhas) {
        console.log(`mídia: baixadas ${r.baixadas}; ignoradas ${r.ignoradas}; falhas ${r.falhas}`);
      }
      for (const e of r.exportacoes) {
        console.log(`exportação de conversa: ${e.linhas} mensagens lidas; gravadas ${e.gravadas}; já existiam ${e.jaExistiam}`);
      }
    });
  } catch (err) {
    console.error('processamento de mídia falhou:', err instanceof Error ? err.message : err);
  }
}

const LOCK_EXTRACAO = 8421004;
const INTERVALO_EXTRACAO_MS = 15_000;
const LOTE_EXTRACAO = 500;

// Extrai links, contatos, endereços e arquivos das mensagens novas. Com muita coisa atrasada
// (uma exportação grande, por exemplo), continua em lotes até esvaziar a fila.
async function extrairItens(): Promise<void> {
  if (!pool) return;
  try {
    await comLockTentativa(pool, LOCK_EXTRACAO, async (db) => {
      let mensagens = 0;
      let itens = 0;
      for (let i = 0; i < 40; i++) {
        const r = await extrairItensPendentes(db, LOTE_EXTRACAO);
        mensagens += r.mensagens;
        itens += r.itens;
        if (r.mensagens < LOTE_EXTRACAO) break;
      }
      if (mensagens) console.log(`extração: ${mensagens} mensagem(ns) lida(s); ${itens} item(ns) encontrado(s)`);
    });
  } catch (err) {
    console.error('extração de itens falhou:', err instanceof Error ? err.message : err);
  }
}

function iniciarSincronizacao(): void {
  // A extração só depende do banco, não da Evolution.
  // Estado do agente ao subir: só nomes de variáveis que faltam e contagens, nunca valores.
  const faltando = [
    !cfg.openrouterKey && 'OPENROUTER_API_KEY',
    !cfg.evolutionUrl && 'EVOLUTION_URL',
    !cfg.evolutionApiKey && 'EVOLUTION_API_KEY',
  ].filter(Boolean);
  console.log(
    `agente: ${faltando.length ? `DESLIGADO, faltam ${faltando.join(', ')}` : 'pronto'}; comandantes lidos: ${cfg.comandantes.length}; modelos: ${cfg.modeloOrquestrador} e ${cfg.modeloRedatora}`,
  );
  void extrairItens();
  setInterval(() => void extrairItens(), INTERVALO_EXTRACAO_MS);
  if (!cfg.evolutionUrl || !cfg.evolutionApiKey || !cfg.webhookToken) {
    console.warn('Sincronização com a Evolution desligada: faltam EVOLUTION_URL, EVOLUTION_API_KEY ou EVOLUTION_WEBHOOK_TOKEN.');
    return;
  }
  void sincronizarEvolution();
  setInterval(() => void sincronizarEvolution(), INTERVALO_SINCRONIZACAO_MS);
  void processarMidias();
  setInterval(() => void processarMidias(), INTERVALO_MIDIA_MS);
}

void iniciarBanco();

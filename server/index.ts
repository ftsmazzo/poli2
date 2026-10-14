import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Pool } from 'pg';
import { loadConfig } from './config';
import { comLockTentativa, criarPool, migrarComLock } from './db';
import { importarHistoricoPendente } from './evolution/historico';
import { descobrirIdentificadores } from './evolution/lids';
import { sincronizarInstancias } from './evolution/sync';
import { enviarPendentes, reprocessarSemDestino } from './alertas/envio';
import { lerGruposVencidos } from './alertas/leitura';
import { criarChatOpenRouter } from './agente/llm';
import { avaliarPedido, avaliarPrivado, type Avaliacao } from './agente/pedido';
import { responderPedido } from './agente/turno';
import { enviarTexto } from './evolution/client';
import type { MensagemNormalizada, MensagemPrivada } from './ingest/evolution';
import type { Db } from './migrate';
import { extrairItensPendentes } from './extrair/persistir';
import { LIMITES_PADRAO, processarMidiasPendentes } from './midia/processar';
import { ehPedidoDePainel, entregarLinkDoPainel } from './agente/painel';
import { conectorReal } from './fontes/mcp';
import { painelRouter } from './painel/api';
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
  await atender(db, await avaliarPedido(db, instancia, msg, cfg.comandantes), msg.texto);
}

// Conversa privada: mesma checagem de quem pode pedir, mas sem precisar chamar a Poli pelo nome.
async function aoPrivado(instancia: string, dm: MensagemPrivada): Promise<void> {
  if (!pool || !bancoPronto || !cfg.openrouterKey || !cfg.evolutionUrl || !cfg.evolutionApiKey) return;
  const db = pool as unknown as Db;
  await atender(db, await avaliarPrivado(db, instancia, dm, cfg.comandantes), dm.texto);
}

async function atender(db: Db, avaliacao: Avaliacao, texto: string | null): Promise<void> {
  if (!cfg.openrouterKey || !cfg.evolutionUrl || !cfg.evolutionApiKey) return;
  if (avaliacao.tipo === 'nao_autorizado') {
    // Sem resposta e sem número no log: só o tipo do identificador, para diagnosticar.
    console.log(`pedido ignorado: autor não autorizado (${avaliacao.detalhe})`);
    return;
  }
  if (avaliacao.tipo === 'ignorar') {
    // Só registra quando a mensagem parece falar com a Poli (cita "poli" ou tem @): evita ruído de conversa comum.
    if (avaliacao.motivo && /poli|@/i.test(texto ?? '')) console.log(`pedido ignorado: ${avaliacao.motivo}`);
    return;
  }

  const evo = { url: cfg.evolutionUrl, apiKey: cfg.evolutionApiKey };
  const enviar = (inst: string, destino: string, texto: string) => enviarTexto(evo, inst, destino, texto);

  // "painel": o link de acesso vai para o PRIVADO de quem pediu; o grupo só recebe o aviso.
  if (ehPedidoDePainel(avaliacao.pedido.consulta)) {
    console.log(`painel: link ${await entregarLinkDoPainel({ db, enviar, urlBase: cfg.appUrl }, avaliacao.pedido)}`);
    return;
  }

  const situacao = await responderPedido(
    {
      db,
      chat: criarChatOpenRouter(cfg.openrouterKey),
      modelos: { orquestrador: cfg.modeloOrquestrador, redatora: cfg.modeloRedatora },
      enviar,
      conectorMcp: conectorReal,
      chaveCripto: cfg.chaveCripto,
    },
    avaliacao.pedido,
  );
  console.log(`pedido ${situacao}`);
}

app.use('/webhooks', webhookRouter(() => (bancoPronto ? pool : undefined), cfg.webhookToken, aoGravar, aoPrivado));

// O painel acessa o banco por aqui: se o banco ainda não subiu, o pedido falha com erro claro em vez de travar.
const bancoDoPainel: Db = {
  query: async (sql, params) => {
    if (!pool || !bancoPronto) throw new Error('banco indisponível');
    return pool.query(sql, params as unknown[]);
  },
};
app.use('/api', painelRouter({ db: bancoDoPainel, conectar: conectorReal, chaveCripto: cfg.chaveCripto, cookieSeguro: cfg.appUrl.startsWith('https://') }));

// Painel (React): arquivos estáticos e a página inicial para qualquer endereço que não seja da API.
const pastaDoPainel = path.resolve(process.cwd(), 'painel', 'dist');
if (existsSync(pastaDoPainel)) {
  app.use(express.static(pastaDoPainel, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path === '/health' || req.path.startsWith('/webhooks') || req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(pastaDoPainel, 'index.html'));
  });
}

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

const ultimoResumoIdentificadores = new Map<string, string>();
const ultimoEstadoWhatsapp = new Map<string, string>();
// Listar grupos e participantes pesa no WhatsApp (que limita esse tipo de consulta): por instância, no máximo
// uma vez por hora, ou em 15 minutos se a última tentativa falhou.
const proximaConsultaDeGrupos = new Map<string, number>();
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
      // A conexão do número com o WhatsApp: só registra quando muda (e na primeira vez, ao subir).
      for (const [nomeDaInstancia, estado] of Object.entries(r.estados)) {
        if (estado && ultimoEstadoWhatsapp.get(nomeDaInstancia) !== estado) {
          ultimoEstadoWhatsapp.set(nomeDaInstancia, estado);
          console.log(`whatsapp ${nomeDaInstancia}: conexão ${estado}`);
        }
      }
      if (r.tenantsCriados.length || r.webhooksConfigurados.length || r.erros.length) {
        console.log(
          `evolution: ${r.instancias} instância(s); tenants criados: [${r.tenantsCriados}]; webhooks ajustados: [${r.webhooksConfigurados}]; erros: [${r.erros}]`,
        );
      }

      // Histórico: cada grupo é importado uma vez, depois só o webhook traz mensagens.
      const instancias = await db.query('select evolution_instance from instancias_wa where ativa');
      for (const { evolution_instance: nome } of instancias.rows) {
        if (Date.now() < (proximaConsultaDeGrupos.get(nome) ?? 0)) continue;
        let falhou = false;
        try {
          const h = await importarHistoricoPendente(db, evo, nome);
          if (h.gruposImportados || h.erros.length) {
            console.log(
              `histórico ${nome}: ${h.grupos} grupo(s); importados agora: ${h.gruposImportados}; mensagens gravadas: ${h.gravadas}; já existiam: ${h.duplicadas}; erros: [${h.erros}]`,
            );
          }
        } catch (err) {
          falhou = true;
          console.error(`histórico ${nome} falhou:`, err instanceof Error ? err.message : err);
        }

        // Liga LID <-> telefone e descobre o LID da própria Poli. Só registra quando o resultado muda.
        try {
          const i = await descobrirIdentificadores(db, evo, nome, fetch, cfg.comandantes);
          const resumo =
            `participantes ${i.participantes}; com LID ${i.comLid}; com telefone ${i.comTelefone}; pares aprendidos ${i.pares}; ` +
            `comandantes presentes nos grupos: ${i.comandantesPresentes} de ${cfg.comandantes.length}; ` +
            `campos [${i.campos.join(',')}]; LID próprio: ${i.lidProprio ? `encontrado (${i.via})` : 'NÃO encontrado'}`;
          if (ultimoResumoIdentificadores.get(nome) !== resumo) {
            ultimoResumoIdentificadores.set(nome, resumo);
            console.log(`identificadores ${nome}: ${resumo}`);
          }
        } catch (err) {
          falhou = true;
          console.error(`identificadores ${nome} falhou:`, err instanceof Error ? err.message : err);
        }
        proximaConsultaDeGrupos.set(nome, Date.now() + (falhou ? 15 : 60) * 60_000);
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

const LOCK_LEITURA = 8421005;
const INTERVALO_LEITURA_MS = 60_000;

// A cada minuto, lê os grupos acompanhados cujo intervalo venceu: resume, dá nota e cria alertas.
async function lerGrupos(): Promise<void> {
  if (!pool || !cfg.openrouterKey) return;
  const chat = criarChatOpenRouter(cfg.openrouterKey);
  try {
    await comLockTentativa(pool, LOCK_LEITURA, async (db) => {
      const r = await lerGruposVencidos(db, chat, cfg.modeloOrquestrador);
      if (r.lidos || r.alertas || r.falhas || r.inicios) {
        console.log(`leitura de grupos: ${r.lidos} lido(s); ${r.inicios} iniciado(s); alertas criados: ${r.alertas}; falhas: ${r.falhas}`);
      }
    });
  } catch (err) {
    console.error('leitura de grupos falhou:', err instanceof Error ? err.message : err);
  }
}

const LOCK_ENVIO = 8421006;
const INTERVALO_ENVIO_MS = 30_000;

// A cada 30 segundos, manda os alertas pendentes aos Heads (privado e Grupo dos Heads).
async function enviarAlertas(): Promise<void> {
  if (!pool || !cfg.evolutionUrl || !cfg.evolutionApiKey) return;
  const evo = { url: cfg.evolutionUrl, apiKey: cfg.evolutionApiKey };
  try {
    await comLockTentativa(pool, LOCK_ENVIO, async (db) => {
      await reprocessarSemDestino(db);
      const r = await enviarPendentes(db, (inst, destino, texto) => enviarTexto(evo, inst, destino, texto));
      if (r.enviadas || r.falhas) console.log(`alertas: ${r.enviadas} enviado(s); ${r.falhas} falha(s); ${r.adiadas} adiado(s)`);
    });
  } catch (err) {
    console.error('envio de alertas falhou:', err instanceof Error ? err.message : err);
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
    `agente: ${faltando.length ? `DESLIGADO, faltam ${faltando.join(', ')}` : 'pronto'}; comandantes lidos: ${cfg.comandantes.length}; chave de criptografia: ${cfg.chaveCripto ? 'presente' : 'AUSENTE (Fontes com token não funcionam)'}; modelos: ${cfg.modeloOrquestrador} e ${cfg.modeloRedatora}`,
  );
  void extrairItens();
  setInterval(() => void extrairItens(), INTERVALO_EXTRACAO_MS);
  void lerGrupos();
  setInterval(() => void lerGrupos(), INTERVALO_LEITURA_MS);
  if (!cfg.evolutionUrl || !cfg.evolutionApiKey || !cfg.webhookToken) {
    console.warn('Sincronização com a Evolution desligada: faltam EVOLUTION_URL, EVOLUTION_API_KEY ou EVOLUTION_WEBHOOK_TOKEN.');
    return;
  }
  void sincronizarEvolution();
  setInterval(() => void sincronizarEvolution(), INTERVALO_SINCRONIZACAO_MS);
  void processarMidias();
  setInterval(() => void processarMidias(), INTERVALO_MIDIA_MS);
  void enviarAlertas();
  setInterval(() => void enviarAlertas(), INTERVALO_ENVIO_MS);
}

void iniciarBanco();

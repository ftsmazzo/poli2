import { normalizarEvento } from '../ingest/evolution';

export interface EvolutionCfg {
  url: string;
  apiKey: string;
}

export interface InstanciaEvo {
  nome: string;
  status: string | null;
  // Número da própria instância (o da Poli), usado para saber quando ela é marcada.
  jid: string | null;
  // Nome do perfil do WhatsApp (o que as pessoas veem no grupo).
  perfil: string | null;
}

export interface WebhookAtual {
  enabled: boolean;
  url: string | null;
  events: string[];
}

type Fetcher = typeof fetch;

async function chamar(
  cfg: EvolutionCfg,
  f: Fetcher,
  caminho: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<any> {
  const res = await f(`${cfg.url.replace(/\/+$/, '')}${caminho}`, {
    ...init,
    headers: { apikey: cfg.apiKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // O erro leva só o status: o corpo pode ter dados da conta.
  if (!res.ok) throw new Error(`Evolution ${init.method ?? 'GET'} ${caminho} respondeu ${res.status}`);
  const texto = await res.text();
  return texto ? JSON.parse(texto) : null;
}

// A v2 devolve { name, connectionStatus }; versões anteriores, { instance: { instanceName, status } }.
export async function listarInstancias(cfg: EvolutionCfg, f: Fetcher = fetch): Promise<InstanciaEvo[]> {
  const dados = await chamar(cfg, f, '/instance/fetchInstances');
  const lista: any[] = Array.isArray(dados) ? dados : [];
  return lista
    .map((i) => ({
      nome: String(i?.name ?? i?.instanceName ?? i?.instance?.instanceName ?? ''),
      status: (i?.connectionStatus ?? i?.instance?.status ?? null) as string | null,
      jid: (i?.ownerJid ?? i?.owner ?? i?.instance?.owner ?? null) as string | null,
      perfil: (typeof i?.profileName === 'string' && i.profileName.trim() ? i.profileName.trim() : null) as string | null,
    }))
    .filter((i) => i.nome !== '');
}

// null = sem webhook configurado (ou a Evolution não respondeu: nesse caso configurar de novo é seguro).
export async function lerWebhook(cfg: EvolutionCfg, nome: string, f: Fetcher = fetch): Promise<WebhookAtual | null> {
  try {
    const r = await chamar(cfg, f, `/webhook/find/${encodeURIComponent(nome)}`);
    const w = r?.webhook ?? r;
    if (!w || typeof w !== 'object') return null;
    return {
      enabled: Boolean(w.enabled),
      url: typeof w.url === 'string' ? w.url : null,
      events: Array.isArray(w.events) ? w.events.map(String) : [],
    };
  } catch {
    return null;
  }
}

export interface GrupoEvo {
  jid: string;
  nome: string | null;
}

// Grupos de que o número participa, com o nome (assunto) de cada um.
export async function listarGrupos(cfg: EvolutionCfg, instancia: string, f: Fetcher = fetch): Promise<GrupoEvo[]> {
  const dados = await chamar(cfg, f, `/group/fetchAllGroups/${encodeURIComponent(instancia)}?getParticipants=false`);
  const lista: any[] = Array.isArray(dados) ? dados : [];
  return lista
    .map((g) => ({
      jid: String(g?.id ?? ''),
      nome: typeof g?.subject === 'string' && g.subject ? (g.subject as string) : null,
    }))
    .filter((g) => g.jid.endsWith('@g.us'));
}

export interface PaginaMensagens {
  registros: any[];
  paginas: number;
}

// Mensagens que a Evolution guardou de um grupo, página a página (formato igual ao do webhook).
export async function buscarMensagens(
  cfg: EvolutionCfg,
  instancia: string,
  grupoJid: string,
  pagina: number,
  porPagina: number,
  f: Fetcher = fetch,
): Promise<PaginaMensagens> {
  const r = await chamar(cfg, f, `/chat/findMessages/${encodeURIComponent(instancia)}`, {
    method: 'POST',
    // Na Evolution v2 "offset" é o tamanho da página.
    body: JSON.stringify({ where: { key: { remoteJid: grupoJid } }, page: pagina, offset: porPagina }),
  });
  const m = r?.messages ?? r;
  const registros: any[] = Array.isArray(m) ? m : Array.isArray(m?.records) ? m.records : [];
  // Sem total de páginas na resposta: página cheia indica que pode haver mais.
  const paginas = Number(m?.pages ?? r?.pages ?? (registros.length >= porPagina ? pagina + 1 : pagina));
  return { registros, paginas };
}

// Participantes de todos os grupos. Conforme a versão da Evolution, cada um traz LID, telefone ou os dois.
export async function listarParticipantes(cfg: EvolutionCfg, instancia: string, f: Fetcher = fetch): Promise<any[]> {
  const dados = await chamar(cfg, f, `/group/fetchAllGroups/${encodeURIComponent(instancia)}?getParticipants=true`, {}, 60_000);
  const grupos: any[] = Array.isArray(dados) ? dados : [];
  return grupos.flatMap((g) => (Array.isArray(g?.participants) ? g.participants : []));
}

// Pergunta à Evolution como o WhatsApp conhece um número (algumas versões devolvem o LID).
export async function consultarNumeros(cfg: EvolutionCfg, instancia: string, numeros: string[], f: Fetcher = fetch): Promise<any[]> {
  const r = await chamar(cfg, f, `/chat/whatsappNumbers/${encodeURIComponent(instancia)}`, {
    method: 'POST',
    body: JSON.stringify({ numbers: numeros }),
  });
  return Array.isArray(r) ? r : [];
}

// Envia uma mensagem de texto para um grupo (ou pessoa).
export async function enviarTexto(
  cfg: EvolutionCfg,
  instancia: string,
  destino: string,
  texto: string,
  f: Fetcher = fetch,
): Promise<{ waMessageId: string | null }> {
  const r = await chamar(cfg, f, `/message/sendText/${encodeURIComponent(instancia)}`, {
    method: 'POST',
    body: JSON.stringify({ number: destino, text: texto }),
  });
  return { waMessageId: typeof r?.key?.id === 'string' ? r.key.id : null };
}

export interface MidiaBaixada {
  dados: Buffer;
  mime: string | null;
  nomeArquivo: string | null;
}

// Baixa o anexo de uma mensagem já recebida. Arquivos grandes demoram: timeout de 3 minutos.
export async function baixarMidia(
  cfg: EvolutionCfg,
  instancia: string,
  waMessageId: string,
  f: Fetcher = fetch,
): Promise<MidiaBaixada> {
  const r = await chamar(
    cfg,
    f,
    `/chat/getBase64FromMediaMessage/${encodeURIComponent(instancia)}`,
    { method: 'POST', body: JSON.stringify({ message: { key: { id: waMessageId } }, convertToMp4: false }) },
    180_000,
  );
  const base64 = typeof r?.base64 === 'string' ? r.base64.replace(/^data:[^;]*;base64,/, '') : '';
  if (!base64) throw new Error('A Evolution não devolveu o arquivo');
  return {
    dados: Buffer.from(base64, 'base64'),
    mime: typeof r.mimetype === 'string' ? r.mimetype : null,
    nomeArquivo: typeof r.fileName === 'string' ? r.fileName : null,
  };
}

export function eventosDoWebhook(w: WebhookAtual): string[] {
  return w.events.map(normalizarEvento);
}

export async function definirWebhook(
  cfg: EvolutionCfg,
  nome: string,
  webhook: { url: string; token: string },
  f: Fetcher = fetch,
): Promise<void> {
  const dados = {
    enabled: true,
    url: webhook.url,
    headers: { 'x-webhook-token': webhook.token },
    byEvents: false,
    base64: false,
    events: ['MESSAGES_UPSERT'],
  };
  const caminho = `/webhook/set/${encodeURIComponent(nome)}`;
  try {
    // Formato da v2.2 (embrulhado em "webhook").
    await chamar(cfg, f, caminho, { method: 'POST', body: JSON.stringify({ webhook: dados }) });
  } catch {
    // Formato das versões anteriores (plano).
    await chamar(cfg, f, caminho, { method: 'POST', body: JSON.stringify(dados) });
  }
}

import { normalizarEvento } from '../ingest/evolution';

export interface EvolutionCfg {
  url: string;
  apiKey: string;
}

export interface InstanciaEvo {
  nome: string;
  status: string | null;
}

export interface WebhookAtual {
  enabled: boolean;
  url: string | null;
  events: string[];
}

type Fetcher = typeof fetch;

async function chamar(cfg: EvolutionCfg, f: Fetcher, caminho: string, init: RequestInit = {}): Promise<any> {
  const res = await f(`${cfg.url.replace(/\/+$/, '')}${caminho}`, {
    ...init,
    headers: { apikey: cfg.apiKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
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

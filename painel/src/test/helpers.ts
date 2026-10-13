import { vi } from 'vitest';

export interface Chamada {
  metodo: string;
  caminho: string;
  cabecalhos: Record<string, string>;
  corpo: unknown;
  credentials?: RequestCredentials;
}

type Resposta = { status?: number; json?: unknown } | Promise<{ status?: number; json?: unknown }>;

export function simularFetch(tratar: (c: Chamada) => Resposta) {
  const chamadas: Chamada[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const c: Chamada = {
      metodo: init?.method ?? 'GET',
      caminho: String(url),
      cabecalhos: (init?.headers ?? {}) as Record<string, string>,
      corpo: init?.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init?.credentials,
    };
    chamadas.push(c);
    const r = await tratar(c);
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.json ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return chamadas;
}

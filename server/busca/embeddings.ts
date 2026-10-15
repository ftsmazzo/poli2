// Cliente de embeddings (OpenRouter, API compatível com a da OpenAI). O vetor é o "significado" do texto:
// textos que falam da mesma coisa ficam perto, mesmo sem palavras em comum.

export const DIMENSOES = 1536;

export type Embedder = (textos: string[]) => Promise<number[][]>;

export function criarEmbedderOpenRouter(apiKey: string, modelo: string, f: typeof fetch = fetch): Embedder {
  return async (textos) => {
    if (textos.length === 0) return [];
    const res = await f('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-title': 'Poli 2' },
      body: JSON.stringify({ model: modelo, input: textos }),
      signal: AbortSignal.timeout(60_000),
    });
    // O erro leva só o status: o corpo pode ecoar o texto enviado, que é conversa de terceiros.
    if (!res.ok) throw new Error(`OpenRouter (embeddings) respondeu ${res.status}`);
    const dados: any = await res.json();
    const itens: { index?: number; embedding?: unknown }[] = Array.isArray(dados?.data) ? [...dados.data] : [];
    itens.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vetores = itens.map((i) => i.embedding);
    const valido = (v: unknown): v is number[] => Array.isArray(v) && v.length === DIMENSOES && v.every((n) => typeof n === 'number');
    if (vetores.length !== textos.length || !vetores.every(valido)) throw new Error('OpenRouter devolveu embeddings inesperados');
    return vetores as number[][];
  };
}

// Formato que o pgvector aceita em texto: "[0.1,0.2,...]".
export const comoVetor = (v: number[]): string => `[${v.join(',')}]`;

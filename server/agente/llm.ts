// Cliente mínimo do OpenRouter (API compatível com a da OpenAI) com chamada de ferramentas.

export interface ChamadaFerramenta {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface MensagemChat {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChamadaFerramenta[];
  tool_call_id?: string;
}

export interface EspecFerramenta {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface RespostaChat {
  content: string | null;
  toolCalls: ChamadaFerramenta[];
}

export type Chat = (args: {
  model: string;
  messages: MensagemChat[];
  tools?: EspecFerramenta[];
  maxTokens?: number;
}) => Promise<RespostaChat>;

export function criarChatOpenRouter(apiKey: string, f: typeof fetch = fetch): Chat {
  return async ({ model, messages, tools, maxTokens }) => {
    const res = await f('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-title': 'Poli 2',
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    // O erro leva só o status: o corpo pode ecoar o pedido, que tem conversa de terceiros.
    if (!res.ok) throw new Error(`OpenRouter respondeu ${res.status}`);
    const dados: any = await res.json();
    const msg = dados?.choices?.[0]?.message;
    if (!msg) throw new Error('OpenRouter devolveu uma resposta vazia');
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    };
  };
}

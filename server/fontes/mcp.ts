import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EspecFerramenta } from '../agente/llm';
import type { Db } from '../migrate';
import { decifrar } from '../painel/cripto';

export interface FerramentaMcp {
  nome: string;
  descricao: string;
  esquema: Record<string, unknown>;
  somenteLeitura: boolean;
}

export interface ClienteMcp {
  listarFerramentas(): Promise<FerramentaMcp[]>;
  chamar(nome: string, argumentos: Record<string, unknown>): Promise<string>;
  fechar(): Promise<void>;
}

export type ConectorMcp = (alvo: { url: string; headers: Record<string, string> }) => Promise<ClienteMcp>;

const MAX_RESULTADO = 15_000;

// ---------- Leitura x escrita ----------

const NOME_DE_LEITURA = /^(get|list|search|find|query|read|fetch|describe|count|show|lookup|consult|buscar|listar|obter|consultar|ler|ver|pesquisar)/i;
const NOME_DE_ESCRITA = /(delete|remove|create|update|write|set_|insert|drop|send|post_|apagar|criar|atualizar|enviar|excluir|remover|gravar)/i;

// Ferramenta que pode alterar algo nasce desligada. A dica do próprio servidor MCP vale mais que o nome.
export function pareceLeitura(nome: string, anotacoes?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null): boolean {
  if (anotacoes?.destructiveHint === true) return false;
  if (anotacoes?.readOnlyHint === true) return true;
  return NOME_DE_LEITURA.test(nome) && !NOME_DE_ESCRITA.test(nome);
}

// Endereço de Fonte: só http(s), e nunca o endereço de metadados da nuvem (169.254.x.x).
export function urlValida(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !/^169\.254\./.test(u.hostname);
  } catch {
    return false;
  }
}

// ---------- Conexão ----------

function comTimeout<T>(p: Promise<T>, ms: number, rotulo: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rejeita) => {
      t = setTimeout(() => rejeita(new Error(`${rotulo} demorou mais de ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function textoDoResultado(r: any): string {
  const partes: string[] = (r?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text));
  let texto = partes.join('\n');
  if (!texto && r?.structuredContent) texto = JSON.stringify(r.structuredContent);
  if (!texto) texto = '(a fonte não devolveu texto)';
  if (r?.isError) texto = `Erro da fonte: ${texto}`;
  return texto.slice(0, MAX_RESULTADO);
}

export function adaptar(client: Client): ClienteMcp {
  return {
    async listarFerramentas() {
      const ferramentas: FerramentaMcp[] = [];
      let cursor: string | undefined;
      for (let pagina = 0; pagina < 10; pagina++) {
        const r = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of r.tools) {
          ferramentas.push({
            nome: t.name,
            descricao: t.description ?? '',
            esquema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            somenteLeitura: pareceLeitura(t.name, t.annotations),
          });
        }
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return ferramentas;
    },
    async chamar(nome, argumentos) {
      return textoDoResultado(await client.callTool({ name: nome, arguments: argumentos }, undefined, { timeout: 60_000 }));
    },
    async fechar() {
      await client.close();
    },
  };
}

// Tenta o transporte atual (Streamable HTTP) e, se o servidor for antigo, o SSE.
export const conectorReal: ConectorMcp = async ({ url, headers }) => {
  const opcoes = { requestInit: { headers } };
  const novo = () => new Client({ name: 'poli2', version: '0.1.0' });
  try {
    const c = novo();
    await comTimeout(c.connect(new StreamableHTTPClientTransport(new URL(url), opcoes)), 20_000, 'A conexão');
    return adaptar(c);
  } catch (primeiro) {
    try {
      const c = novo();
      await comTimeout(c.connect(new SSEClientTransport(new URL(url), opcoes)), 20_000, 'A conexão');
      return adaptar(c);
    } catch {
      throw primeiro instanceof Error ? primeiro : new Error('Falha ao conectar');
    }
  }
};

// Cabeçalho de autenticação da Fonte. O segredo só existe decifrado aqui, na hora de conectar.
export function cabecalhosDaFonte(config: any, segredoCifrado: string | null, chave: string): Record<string, string> {
  if (!segredoCifrado) return {};
  const segredo = decifrar(segredoCifrado, chave);
  const nome = typeof config?.headerNome === 'string' && config.headerNome ? config.headerNome : 'Authorization';
  const valor = nome.toLowerCase() === 'authorization' && !/^(bearer|basic)\s/i.test(segredo) ? `Bearer ${segredo}` : segredo;
  return { [nome]: valor };
}

// ---------- Testar uma Fonte ----------

export interface ResultadoTeste {
  ok: boolean;
  latenciaMs: number;
  ferramentas: number;
  erro?: string;
}

// Conecta, lista as ferramentas, guarda o que achou e registra o estado da Fonte (ok ou erro, com latência).
// Ferramentas que parecem escrever entram desligadas; o que o admin já ligou ou desligou é mantido.
export async function testarFonte(db: Db, conectar: ConectorMcp, chave: string, workspaceId: number, fonteId: number): Promise<ResultadoTeste | null> {
  const f = await db.query(`select id, config, segredo_enc from fontes where id = $1 and workspace_id = $2 and tipo = 'mcp'`, [fonteId, workspaceId]);
  if (f.rows.length === 0) return null;

  const inicio = Date.now();
  let cliente: ClienteMcp | undefined;
  try {
    const url = f.rows[0].config?.url;
    if (typeof url !== 'string' || !urlValida(url)) throw new Error('Endereço da Fonte inválido');
    cliente = await conectar({ url, headers: cabecalhosDaFonte(f.rows[0].config, f.rows[0].segredo_enc, chave) });
    const ferramentas = await cliente.listarFerramentas();

    for (const t of ferramentas) {
      await db.query(
        `insert into fonte_tools (fonte_id, nome, descricao, ativa, esquema, somente_leitura)
         values ($1, $2, $3, $4, $5::jsonb, $4)
         on conflict (fonte_id, nome) do update set
           descricao = excluded.descricao,
           esquema = excluded.esquema,
           somente_leitura = excluded.somente_leitura,
           ativa = case when fonte_tools.somente_leitura and not excluded.somente_leitura then false else fonte_tools.ativa end`,
        [fonteId, t.nome, t.descricao.slice(0, 2000), t.somenteLeitura, JSON.stringify(t.esquema)],
      );
    }
    await db.query('delete from fonte_tools where fonte_id = $1 and nome <> all($2)', [fonteId, ferramentas.map((t) => t.nome)]);

    const latenciaMs = Date.now() - inicio;
    await db.query(`update fontes set status = 'ok', ultimo_teste_em = now(), ultimo_erro = null, latencia_ms = $2 where id = $1`, [fonteId, latenciaMs]);
    return { ok: true, latenciaMs, ferramentas: ferramentas.length };
  } catch (err) {
    const latenciaMs = Date.now() - inicio;
    const erro = (err instanceof Error ? err.message : 'Falha ao conectar').slice(0, 300);
    await db.query(`update fontes set status = 'erro', ultimo_teste_em = now(), ultimo_erro = $2, latencia_ms = $3 where id = $1`, [fonteId, erro, latenciaMs]);
    return { ok: false, latenciaMs, ferramentas: 0, erro };
  } finally {
    await cliente?.fechar().catch(() => undefined);
  }
}

// ---------- Ferramentas das Fontes para o agente ----------

export interface FerramentasMcp {
  specs: EspecFerramenta[];
  // "Quando usar" de cada Fonte, uma vez só (e não repetido em cada ferramenta), para entrar nas instruções da busca.
  orientacoes: string;
  ehMinha(nome: string): boolean;
  executar(nome: string, argumentosJson: string): Promise<unknown>;
  fechar(): Promise<void>;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

// Só entram as ferramentas LIGADAS de Fontes ATIVAS que passaram no último teste, do tenant, e dentro do escopo
// de grupos da Fonte. O que elas devolvem é dado externo: vai ao modelo como dado, nunca como instrução.
export async function ferramentasMcp(db: Db, conectar: ConectorMcp, chave: string, workspaceId: number, grupoId: number | null): Promise<FerramentasMcp> {
  const r = await db.query(
    `select f.id, f.nome, f.config, f.segredo_enc, f.quando_usar, f.escopo, t.nome as ferramenta, t.descricao, t.esquema
     from fontes f join fonte_tools t on t.fonte_id = f.id
     where f.workspace_id = $1 and f.tipo = 'mcp' and f.ativa and f.status = 'ok' and t.ativa
     order by f.id, t.nome`,
    [workspaceId],
  );

  const mapa = new Map<string, { fonteId: number; fonteNome: string; ferramenta: string; config: any; segredo: string | null }>();
  const specs: EspecFerramenta[] = [];
  const orientacoesPorFonte = new Map<number, { nome: string; quando: string; ferramentas: string[] }>();
  for (const row of r.rows) {
    const grupos = row.escopo?.grupos;
    if (Array.isArray(grupos) && (grupoId === null || !grupos.map(Number).includes(grupoId))) continue;
    const nome = `f${row.id}__${slug(row.ferramenta)}`.slice(0, 64);
    mapa.set(nome, { fonteId: Number(row.id), fonteNome: row.nome, ferramenta: row.ferramenta, config: row.config, segredo: row.segredo_enc });
    if (row.quando_usar) {
      const o = orientacoesPorFonte.get(Number(row.id)) ?? { nome: String(row.nome), quando: String(row.quando_usar), ferramentas: [] };
      o.ferramentas.push(nome);
      orientacoesPorFonte.set(Number(row.id), o);
    }
    specs.push({
      type: 'function',
      function: {
        name: nome,
        description: `[Fonte: ${row.nome}] ${row.descricao ?? ''}`.slice(0, 1000),
        parameters: { type: 'object', properties: {}, ...(row.esquema ?? {}) },
      },
    });
  }

  const clientes = new Map<number, Promise<ClienteMcp>>();
  const clienteDe = (m: { fonteId: number; config: any; segredo: string | null }) => {
    let c = clientes.get(m.fonteId);
    if (!c) {
      c = conectar({ url: m.config.url, headers: cabecalhosDaFonte(m.config, m.segredo, chave) });
      clientes.set(m.fonteId, c);
    }
    return c;
  };

  const orientacoes = [...orientacoesPorFonte.values()]
    .map((o) => `Fonte "${o.nome}" (ferramentas: ${o.ferramentas.join(', ')}). Quando usar: ${o.quando}`)
    .join('\n');

  return {
    specs,
    orientacoes,
    ehMinha: (nome) => mapa.has(nome),
    async executar(nome, argumentosJson) {
      const m = mapa.get(nome);
      if (!m) return { erro: `Ferramenta desconhecida: ${nome}` };
      let args: Record<string, unknown> = {};
      try {
        const lido = argumentosJson ? JSON.parse(argumentosJson) : {};
        if (lido && typeof lido === 'object') args = lido;
      } catch {
        return { erro: 'Argumentos inválidos (JSON).' };
      }
      try {
        const cliente = await clienteDe(m);
        return { fonte: m.fonteNome, dados: await cliente.chamar(m.ferramenta, args) };
      } catch (err) {
        return { fonte: m.fonteNome, erro: `Falha ao consultar a fonte: ${err instanceof Error ? err.message : 'erro'}` };
      }
    },
    async fechar() {
      for (const c of clientes.values()) await c.then((x) => x.fechar()).catch(() => undefined);
    },
  };
}

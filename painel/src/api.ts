// Cliente único da API do painel. Caminhos relativos (/api/...) no mesmo domínio, cookie de sessão HttpOnly.

// ---------- Tipos (espelham server/painel/api.ts) ----------

export type PapelWorkspace = 'admin' | 'head';
export interface WorkspaceDoUsuario {
  id: number;
  papel: PapelWorkspace;
  // O servidor pode mandar mais campos (ex.: nome); só usamos o que está tipado aqui.
  nome?: string;
  [chave: string]: unknown;
}
export interface Eu {
  usuario: { id: number; nome: string | null; telefone: string | null };
  workspaces: WorkspaceDoUsuario[];
  workspaceAtual: number;
}

export type StatusFonte = 'ok' | 'erro' | 'nunca_testada';
export interface Ferramenta {
  nome: string;
  descricao: string | null;
  ativa: boolean;
  somenteLeitura: boolean;
}
export interface Fonte {
  id: number;
  tipo: string;
  nome: string;
  url: string | null;
  headerNome: string | null;
  quandoUsar: string | null;
  escopo: unknown;
  ativa: boolean;
  status: StatusFonte;
  ultimoTesteEm: string | null;
  ultimoErro: string | null;
  latenciaMs: number | null;
  temSegredo: boolean;
  ferramentas: Ferramenta[];
}
export interface FonteNova {
  nome: string;
  url: string;
  segredo?: string;
  headerNome?: string;
  quandoUsar?: string;
}
export type FontePatch = Partial<FonteNova> & { ativa?: boolean };
export interface ResultadoTeste {
  ok: boolean;
  latenciaMs: number;
  ferramentas: number;
  erro?: string;
  fonte: Fonte;
}

export interface Grupo {
  id: number;
  nome: string;
  acompanhar: boolean;
  intervaloMin: number;
  /** Grupo onde a Poli avisa os Heads (além do privado de cada Head). */
  grupoDosHeads: boolean;
  ultimaLeituraEm: string | null;
  historicoImportadoEm: string | null;
  mensagens: number;
  ultimaMensagemEm: string | null;
}
export type PapelPessoa = 'head' | 'vip' | 'equipe' | 'outro';
export interface Pessoa {
  id: number;
  nome: string | null;
  telefone: string | null;
  papel: PapelPessoa;
  podeComandar: boolean;
  podeConversar: boolean;
  mensagens: number;
}
export interface PessoaPatch {
  nome?: string;
  telefone?: string;
  papel?: PapelPessoa;
  podeComandar?: boolean;
  podeConversar?: boolean;
}
export interface Alerta {
  id: number;
  severidade: number;
  texto: string;
  grupo: string | null;
  criadoEm: string;
  enviadoEm: string | null;
}
export interface Diagnostico {
  instancia: { nome: string; nomePerfil: string | null; numeroConhecido: boolean; lidConhecido: boolean } | null;
  totais: { mensagens: number; itens: number; grupos: number; pessoas: number };
  fontes: { id: number; nome: string; ativa: boolean; status: StatusFonte; ultimoTesteEm: string | null; ultimoErro: string | null; latenciaMs: number | null }[];
  midias: { pendentes: number; falhas: number };
  extracaoPendente: number;
  /** Opcional: servidores mais antigos não mandam. */
  alertas?: { pendentesDeEnvio: number; falhasDeEnvio: number; semDestino: number; gruposAcompanhados: number };
  ultimosTurnos: { quando: string; pergunta: string | null; ferramentas: unknown; latenciaMs: number | null; respondido: boolean }[];
}

// ---------- Erros ----------

const MENSAGENS: Record<string, string> = {
  url_invalida: 'O endereço (URL) informado não é válido. Use um endereço https:// completo.',
  nome_ja_existe: 'Já existe uma Fonte com esse nome neste workspace.',
  dados_invalidos: 'Algum dado informado não é válido. Confira os campos e tente de novo.',
  sem_chave_de_criptografia:
    'O servidor não tem a variável ENCRYPTION_KEY configurada, então não dá para guardar nem usar segredos de Fontes. Configure-a no servidor e reinicie.',
  so_administrador: 'Só administradores podem fazer esta alteração.',
  tenant_nao_permitido: 'Você não tem acesso a este workspace.',
  falha_interna: 'O servidor teve um problema interno. Tente de novo em instantes.',
  sem_sessao: 'Sua sessão expirou. Peça um novo link no WhatsApp.',
  link_invalido_ou_expirado: 'Este link já foi usado ou expirou.',
  origem_invalida: 'O pedido foi recusado por vir de uma origem diferente da do painel.',
  nao_encontrada: 'Não encontrei este item. Ele pode ter sido apagado.',
  nao_encontrado: 'Não encontrei este item. Ele pode ter sido apagado.',
  nada_para_mudar: 'Não havia nada para alterar.',
  json_invalido: 'O servidor não entendeu o pedido (JSON inválido).',
  rede: 'Não consegui falar com o servidor. Confira sua conexão e tente de novo.',
};

export function mensagemDeErroPorCodigo(codigo: string, detalhe?: string): string {
  const base = MENSAGENS[codigo] ?? `Erro inesperado (${codigo}).`;
  return codigo === 'dados_invalidos' && detalhe ? `${base} (${detalhe})` : base;
}

export class ApiError extends Error {
  readonly status: number;
  readonly codigo: string;
  readonly detalhe?: string;
  constructor(status: number, codigo: string, detalhe?: string) {
    super(mensagemDeErroPorCodigo(codigo, detalhe));
    this.name = 'ApiError';
    this.status = status;
    this.codigo = codigo;
    this.detalhe = detalhe;
  }
}

export function mensagemDeErro(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Algo deu errado. Tente de novo.';
}

// ---------- Workspace escolhido e aviso de sessão expirada ----------

const CHAVE_WORKSPACE = 'poli_workspace';
let workspaceId: number | null | undefined;

export function lerWorkspaceGuardado(): number | null {
  try {
    const v = Number(localStorage.getItem(CHAVE_WORKSPACE));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function getWorkspace(): number | null {
  if (workspaceId === undefined) workspaceId = lerWorkspaceGuardado();
  return workspaceId;
}

export function setWorkspace(id: number | null): void {
  workspaceId = id;
  try {
    if (id === null) localStorage.removeItem(CHAVE_WORKSPACE);
    else localStorage.setItem(CHAVE_WORKSPACE, String(id));
  } catch {
    /* localStorage pode falhar (modo privado); segue só em memória */
  }
}

/** Só para testes: esquece o cache em memória. */
export function _resetarWorkspaceEmMemoria(): void {
  workspaceId = undefined;
}

type OuvinteSessao = () => void;
const ouvintes = new Set<OuvinteSessao>();
export function aoExpirarSessao(fn: OuvinteSessao): () => void {
  ouvintes.add(fn);
  return () => {
    ouvintes.delete(fn);
  };
}

// ---------- Núcleo ----------

interface Opcoes {
  corpo?: unknown;
  // /entrar devolve 401 para link inválido, o que não é "sessão expirada".
  tratar401?: boolean;
  semWorkspace?: boolean;
}

async function chamar<T>(metodo: string, caminho: string, op: Opcoes = {}): Promise<T> {
  const cabecalhos: Record<string, string> = { Accept: 'application/json' };
  if (op.corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
  const ws = op.semWorkspace ? null : getWorkspace();
  if (ws !== null) cabecalhos['x-workspace'] = String(ws);

  let resp: Response;
  try {
    resp = await fetch(`/api${caminho}`, {
      method: metodo,
      headers: cabecalhos,
      credentials: 'same-origin',
      body: op.corpo !== undefined ? JSON.stringify(op.corpo) : undefined,
    });
  } catch {
    throw new ApiError(0, 'rede');
  }

  let json: unknown = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }

  if (!resp.ok) {
    const j = (json ?? {}) as { erro?: string; detalhe?: string };
    const erro = new ApiError(resp.status, j.erro ?? (resp.status >= 500 ? 'falha_interna' : `http_${resp.status}`), j.detalhe);
    if (resp.status === 401 && op.tratar401 !== false) ouvintes.forEach((fn) => fn());
    throw erro;
  }
  return json as T;
}

const enc = encodeURIComponent;

export const api = {
  entrar: (token: string) => chamar<{ ok: true }>('POST', '/entrar', { corpo: { token }, tratar401: false, semWorkspace: true }),
  sair: () => chamar<{ ok: true }>('POST', '/sair', { tratar401: false }),
  eu: () => chamar<Eu>('GET', '/eu'),
  diagnostico: () => chamar<Diagnostico>('GET', '/diagnostico'),

  fontes: () => chamar<Fonte[]>('GET', '/fontes'),
  criarFonte: (d: FonteNova) => chamar<Fonte>('POST', '/fontes', { corpo: d }),
  editarFonte: (id: number, d: FontePatch) => chamar<Fonte>('PATCH', `/fontes/${id}`, { corpo: d }),
  apagarFonte: (id: number) => chamar<{ ok: true }>('DELETE', `/fontes/${id}`),
  testarFonte: (id: number) => chamar<ResultadoTeste>('POST', `/fontes/${id}/testar`),
  ligarFerramenta: (id: number, nome: string, ativa: boolean) =>
    chamar<{ ok: true }>('PATCH', `/fontes/${id}/ferramentas/${enc(nome)}`, { corpo: { ativa } }),

  grupos: () => chamar<Grupo[]>('GET', '/grupos'),
  editarGrupo: (id: number, d: { acompanhar?: boolean; intervaloMin?: number; grupoDosHeads?: boolean }) => chamar<{ ok: true }>('PATCH', `/grupos/${id}`, { corpo: d }),

  pessoas: () => chamar<Pessoa[]>('GET', '/pessoas'),
  editarPessoa: (id: number, d: PessoaPatch) => chamar<{ ok: true }>('PATCH', `/pessoas/${id}`, { corpo: d }),

  alertas: () => chamar<Alerta[]>('GET', '/alertas'),
};

export type TipoItem = 'link' | 'arquivo' | 'contato' | 'endereco';

export interface ItemExtraido {
  tipo: TipoItem;
  valor: string;
  dados: Record<string, unknown>;
  // Identifica o mesmo item em mensagens diferentes (o mesmo link mandado 5 vezes é um item só).
  chave: string;
}

export interface EntradaExtracao {
  mensagemId: number;
  tipo: string;
  texto: string | null;
  origem: string;
  // Anexo registrado para a mensagem, se houver.
  midia: { nomeArquivo: string | null } | null;
}

const MAX_ITENS = 20;
const semAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
const compactar = (s: string) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- Links ----------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|\b(?:wa\.me|chat\.whatsapp\.com|bit\.ly|tinyurl\.com|maps\.app\.goo\.gl|youtu\.be)\/[^\s<>"'`]+/gi;
const RASTREIO = /^(utm_|fbclid$|igshid$|gclid$|mc_)/i;

function limparFim(u: string): string {
  let s = u.replace(/[.,;:!?\]}»”’'"]+$/, '');
  // Parêntese de fechamento que não abriu dentro do link é da frase, não do link.
  while (s.endsWith(')') && !s.includes('(')) s = s.slice(0, -1).replace(/[.,;:!?]+$/, '');
  return s;
}

function tipoDoLink(host: string, caminho: string): string {
  if (host === 'chat.whatsapp.com') return 'convite_whatsapp';
  if (host === 'wa.me') return 'whatsapp';
  if (host === 'maps.app.goo.gl' || (host.endsWith('google.com') && caminho.startsWith('/maps'))) return 'mapa';
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
  if (host.endsWith('facebook.com')) return 'facebook';
  if (host === 'drive.google.com' || host === 'docs.google.com') return 'google_drive';
  return 'outro';
}

export function extrairLinks(texto: string): ItemExtraido[] {
  const vistos = new Map<string, ItemExtraido>();
  for (const bruto of texto.match(URL_RE) ?? []) {
    const limpo = limparFim(bruto);
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(limpo) ? limpo : `https://${limpo}`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.')) continue;
    for (const k of [...url.searchParams.keys()]) if (RASTREIO.test(k)) url.searchParams.delete(k);
    url.searchParams.sort();
    const caminho = url.pathname.replace(/\/+$/, '');
    const consulta = url.searchParams.toString();
    const normalizada = `https://${host}${caminho}${consulta ? `?${consulta}` : ''}`;
    const chave = `link|${normalizada.toLowerCase()}`;
    if (!vistos.has(chave)) {
      vistos.set(chave, { tipo: 'link', valor: normalizada, dados: { dominio: host, tipo: tipoDoLink(host, caminho) }, chave });
    }
  }
  return [...vistos.values()];
}

// ---------- Telefones e contatos ----------

const DDDS = new Set(
  '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '),
);

function cpfValido(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const dig = (n: number) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dig(9) === Number(d[9]) && dig(10) === Number(d[10]);
}

function formatarTelefone(ddd: string, parte1: string, parte2: string): string {
  return `(${ddd}) ${parte1}-${parte2}`;
}

const TEL_RE = /(?<!\d)(?:\+?55[\s.-]?)?\(?(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})(?!\d)/g;
const PALAVRAS_CONTATO = /^(tel|telefone|cel|celular|whats|whatsapp|zap|contato|fone|numero|número|ligar|chamar)$/i;

// Procura um nome logo antes do número: palavras com inicial maiúscula, na mesma linha.
function nomeAntes(antes: string): string | null {
  const linha = antes.split('\n').pop() ?? '';
  const tokens = linha
    .replace(/[:\-–—,()]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 0 && PALAVRAS_CONTATO.test(tokens[tokens.length - 1].replace(/\.$/, ''))) tokens.pop();
  const nome: string[] = [];
  for (let i = tokens.length - 1; i >= 0 && nome.length < 5; i--) {
    const t = tokens[i];
    if (/^\p{Lu}[\p{L}'.]*$/u.test(t)) nome.unshift(t);
    else if (/^(de|da|do|dos|das|e)$/i.test(t) && nome.length > 0) nome.unshift(t);
    else break;
  }
  while (nome.length > 0 && /^(de|da|do|dos|das|e)$/i.test(nome[0])) nome.shift();
  return nome.length > 0 ? nome.join(' ') : null;
}

export function extrairTelefones(texto: string): ItemExtraido[] {
  const vistos = new Map<string, ItemExtraido>();
  for (const m of texto.matchAll(TEL_RE)) {
    const [bruto, ddd, p1, p2] = m;
    const inicio = m.index ?? 0;
    if (!DDDS.has(ddd)) continue;
    // Celular tem 9 dígitos começando em 9; fixo tem 8 começando em 2 a 5.
    if (p1.length === 5 ? p1[0] !== '9' : !/[2-5]/.test(p1[0])) continue;
    const digitos = `${ddd}${p1}${p2}`;
    // CPF sem pontuação tem 11 dígitos, como um celular: não é telefone se o dígito verificador fecha.
    if (digitos.length === 11 && !/[\s().+-]/.test(bruto) && cpfValido(digitos)) continue;
    if (/cpf|cnpj/i.test(texto.slice(Math.max(0, inicio - 8), inicio))) continue;

    const e164 = `+55${digitos}`;
    const nome = nomeAntes(texto.slice(0, inicio));
    const chave = `contato|tel:${e164}`;
    if (vistos.has(chave)) continue;
    vistos.set(chave, {
      tipo: 'contato',
      valor: nome ? nome : formatarTelefone(ddd, p1, p2),
      dados: { ...(nome ? { nome } : {}), telefones: [e164], contexto: texto.trim().slice(0, 200), origem: 'texto' },
      chave,
    });
  }
  return [...vistos.values()];
}

interface Vcard {
  nome: string | null;
  telefones: string[];
  email: string | null;
  organizacao: string | null;
}

function normalizarFone(valor: string, waid?: string): string | null {
  const d = (waid ?? valor).replace(/\D/g, '');
  if (d.length < 8) return null;
  if (valor.trim().startsWith('+') || waid) return `+${d}`;
  return d.length === 10 || d.length === 11 ? `+55${d}` : `+${d}`;
}

export function parseVcards(texto: string): Vcard[] {
  const cartoes: Vcard[] = [];
  for (const bloco of texto.split(/BEGIN:VCARD/i).slice(1)) {
    const linhas = bloco.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const v: Vcard = { nome: null, telefones: [], email: null, organizacao: null };
    let nomeN: string | null = null;
    for (const linha of linhas) {
      const i = linha.indexOf(':');
      if (i < 0) continue;
      const [campo, ...params] = linha.slice(0, i).split(';');
      const valor = linha.slice(i + 1).trim();
      const chave = campo.toUpperCase().replace(/^ITEM\d+\./, '');
      if (chave === 'FN' && valor) v.nome = valor;
      else if (chave === 'N' && valor) {
        const [familia, dado] = valor.split(';');
        nomeN = [dado, familia].filter(Boolean).join(' ').trim() || null;
      } else if (chave === 'TEL') {
        const waid = params.map((p) => /waid=(\d+)/i.exec(p)?.[1]).find(Boolean);
        const fone = normalizarFone(valor, waid);
        if (fone && !v.telefones.includes(fone)) v.telefones.push(fone);
      } else if (chave === 'EMAIL' && valor && !v.email) v.email = valor;
      else if (chave === 'ORG' && valor) v.organizacao = valor.replace(/;+$/, '').replace(/;/g, ' ');
    }
    v.nome = v.nome ?? nomeN;
    if (v.nome || v.telefones.length > 0) cartoes.push(v);
  }
  return cartoes;
}

export function extrairContatosVcard(texto: string): ItemExtraido[] {
  return parseVcards(texto).map((v) => {
    const chave = v.telefones[0] ? `contato|tel:${v.telefones[0]}` : `contato|nome:${compactar(v.nome ?? '')}`;
    return {
      tipo: 'contato' as const,
      valor: v.nome ?? v.telefones[0],
      dados: {
        ...(v.nome ? { nome: v.nome } : {}),
        telefones: v.telefones,
        ...(v.email ? { email: v.email } : {}),
        ...(v.organizacao ? { organizacao: v.organizacao } : {}),
        origem: 'vcard',
      },
      chave,
    };
  });
}

// ---------- Endereços ----------

const NUMERO = '(?:\\d{1,5}[a-z]?|s\\/n)';
// Bairro e cidade depois do número: até 3 palavras por trecho, sem conjunção nem começo de link,
// para não engolir o resto da frase ("... 10 - Centro e depois ...").
const PARAR = '(?:e|ou|que|para|pra|com|em|na|no|nos|nas|se|mas|http|https|www)';
const PALAVRA = `(?!${PARAR}\\b)\\p{L}+`;
const RESTO = `(?:\\s*[,–-]\\s*${PALAVRA}(?: ${PALAVRA}){0,2}){0,2}`;
const ENDERECO_RE = new RegExp(
  `\\b(?:rua|r\\.|avenida|av\\.?|travessa|tv\\.|alameda|rodovia|rod\\.|estrada|pra[çc]a|largo|passagem|beco)\\s+[\\p{L}0-9ºª°'. -]{2,50}?(?<sep>\\s*,\\s*|\\s+(?:n[ºo°.]*\\s*)?)(?<num>${NUMERO})\\b${RESTO}(?:\\s*[,–-]?\\s*(?:cep\\s*)?\\d{5}-?\\d{3})?`,
  'giu',
);
const CEP_RE = /(?<![\d-])(\d{5})-(\d{3})(?!\d)/g;

export function extrairEnderecos(texto: string): ItemExtraido[] {
  const vistos = new Map<string, ItemExtraido>();
  const cobertos: [number, number][] = [];

  for (const m of texto.matchAll(ENDERECO_RE)) {
    const { sep, num } = m.groups as { sep: string; num: string };
    // "avenida central em 2026" não é endereço: ano sem vírgula nem "nº".
    if (/^(19|20)\d{2}$/.test(num) && !/[,nº°]/i.test(sep)) continue;
    const valor = m[0].replace(/\s+/g, ' ').replace(/[\s,–-]+$/, '').trim();
    const chave = `endereco|${compactar(valor)}`;
    cobertos.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    if (!vistos.has(chave)) vistos.set(chave, { tipo: 'endereco', valor, dados: { origem: 'texto' }, chave });
  }

  for (const m of texto.matchAll(CEP_RE)) {
    const ini = m.index ?? 0;
    if (cobertos.some(([a, b]) => ini >= a && ini < b)) continue;
    const chave = `endereco|cep:${m[1]}${m[2]}`;
    if (!vistos.has(chave)) vistos.set(chave, { tipo: 'endereco', valor: `CEP ${m[1]}-${m[2]}`, dados: { origem: 'texto', cep: `${m[1]}-${m[2]}` }, chave });
  }
  return [...vistos.values()];
}

// Mensagem de localização: "Nome — Endereço — lat,lng".
function enderecoDeLocalizacao(texto: string): ItemExtraido | null {
  const partes = texto.split(' — ').map((p) => p.trim()).filter(Boolean);
  const coord = partes.length > 0 ? /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(partes[partes.length - 1]) : null;
  const descricao = (coord ? partes.slice(0, -1) : partes).join(' — ');
  if (!descricao && !coord) return null;
  const valor = descricao || `${coord![1]},${coord![2]}`;
  return {
    tipo: 'endereco',
    valor,
    dados: { origem: 'localizacao', ...(coord ? { latitude: Number(coord[1]), longitude: Number(coord[2]) } : {}) },
    chave: coord ? `endereco|geo:${Number(coord[1]).toFixed(5)},${Number(coord[2]).toFixed(5)}` : `endereco|${compactar(valor)}`,
  };
}

// ---------- Entrada única ----------

const TIPOS_COM_ARQUIVO = new Set(['imagem', 'documento', 'audio', 'video']);

export function extrairItens(e: EntradaExtracao): ItemExtraido[] {
  const texto = e.texto ?? '';
  const itens: ItemExtraido[] = [];

  if (e.midia || TIPOS_COM_ARQUIVO.has(e.tipo)) {
    // Em exportações o anexo não vem junto: o texto da mensagem é o nome do arquivo.
    const nome = e.midia?.nomeArquivo ?? (texto.split(' — ')[0].trim() || null);
    itens.push({
      tipo: 'arquivo',
      valor: nome ?? `${e.tipo} sem nome`,
      dados: { tipoMensagem: e.tipo, disponivel: e.midia !== null, origem: e.origem },
      chave: `arquivo|msg:${e.mensagemId}`,
    });
  }

  if (texto) {
    const cartoes = e.tipo === 'contato' ? extrairContatosVcard(texto) : [];
    itens.push(...cartoes);
    if (cartoes.length === 0) itens.push(...extrairTelefones(texto));
    itens.push(...extrairLinks(texto));
    itens.push(...extrairEnderecos(texto));
    if (e.tipo === 'localizacao') {
      const loc = enderecoDeLocalizacao(texto);
      if (loc) itens.push(loc);
    }
  }
  return itens.slice(0, MAX_ITENS);
}

import type { Db } from '../migrate';

export type TipoMensagem =
  | 'texto'
  | 'imagem'
  | 'video'
  | 'audio'
  | 'documento'
  | 'contato'
  | 'localizacao'
  | 'sticker'
  | 'outro';

export interface MensagemNormalizada {
  waMessageId: string;
  grupoJid: string;
  autorJid: string | null;
  autorNome: string | null;
  enviadaEm: Date;
  tipo: TipoMensagem;
  texto: string | null;
  citadaWaId: string | null;
  // Anexo da mensagem (imagem, áudio, documento, vídeo), se houver.
  midia: { nomeArquivo: string | null; mime: string | null; bytes: number | null } | null;
  bruto: unknown;
}

// A Evolution manda "MESSAGES_UPSERT" ou "messages.upsert" conforme a configuração.
export function normalizarEvento(evento: unknown): string {
  return String(evento ?? '').toLowerCase().replace(/_/g, '.');
}

// messageTimestamp chega como número, texto ou objeto Long { low, high }.
function lerTimestamp(v: unknown): Date | null {
  let s: number | null = null;
  if (typeof v === 'number') s = v;
  else if (typeof v === 'string' && v.trim() !== '') s = Number(v);
  else if (v && typeof v === 'object' && 'low' in v) s = Number((v as { low: unknown }).low);
  if (s === null || !Number.isFinite(s) || s <= 0) return null;
  // Algumas versões mandam milissegundos.
  return new Date(s > 1e12 ? s : s * 1000);
}

// Mensagens podem vir embrulhadas (efêmera, visualização única, documento com legenda).
function desembrulhar(message: Record<string, any> | undefined): Record<string, any> | undefined {
  let atual = message;
  for (let i = 0; i < 4 && atual; i++) {
    const interno =
      atual.ephemeralMessage?.message ??
      atual.viewOnceMessage?.message ??
      atual.viewOnceMessageV2?.message ??
      atual.documentWithCaptionMessage?.message;
    if (!interno) break;
    atual = interno;
  }
  return atual;
}

function conteudo(m: Record<string, any>): { tipo: TipoMensagem; texto: string | null; citada: string | null } | null {
  if (m.conversation) return { tipo: 'texto', texto: String(m.conversation), citada: null };
  if (m.extendedTextMessage) {
    const e = m.extendedTextMessage;
    return { tipo: 'texto', texto: e.text ?? null, citada: e.contextInfo?.stanzaId ?? null };
  }
  if (m.imageMessage) return { tipo: 'imagem', texto: m.imageMessage.caption ?? null, citada: m.imageMessage.contextInfo?.stanzaId ?? null };
  if (m.videoMessage) return { tipo: 'video', texto: m.videoMessage.caption ?? null, citada: m.videoMessage.contextInfo?.stanzaId ?? null };
  if (m.audioMessage) return { tipo: 'audio', texto: null, citada: m.audioMessage.contextInfo?.stanzaId ?? null };
  if (m.documentMessage) {
    const d = m.documentMessage;
    const texto = [d.caption, d.fileName].filter(Boolean).join(' — ') || null;
    return { tipo: 'documento', texto, citada: d.contextInfo?.stanzaId ?? null };
  }
  if (m.contactMessage) {
    // O vCard fica no texto: o extrator de contatos lê dele depois.
    return { tipo: 'contato', texto: m.contactMessage.vcard ?? m.contactMessage.displayName ?? null, citada: null };
  }
  if (m.contactsArrayMessage) {
    const vcards = (m.contactsArrayMessage.contacts ?? []).map((c: any) => c.vcard).filter(Boolean);
    return { tipo: 'contato', texto: vcards.join('\n') || null, citada: null };
  }
  if (m.locationMessage) {
    const l = m.locationMessage;
    const texto = [l.name, l.address, `${l.degreesLatitude},${l.degreesLongitude}`].filter(Boolean).join(' — ');
    return { tipo: 'localizacao', texto, citada: null };
  }
  if (m.stickerMessage) return { tipo: 'sticker', texto: null, citada: null };
  // Reações, protocolo e distribuição de chaves não são conteúdo de conversa.
  if (m.reactionMessage || m.protocolMessage || m.senderKeyDistributionMessage) return null;
  return { tipo: 'outro', texto: null, citada: null };
}

// Tira qualquer base64 do payload bruto: mídia embutida estouraria o banco.
function semBase64(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(semBase64);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (k !== 'base64') out[k] = semBase64(val);
    return out;
  }
  return v;
}

function infoMidia(m: Record<string, any>): MensagemNormalizada['midia'] {
  const x = m.imageMessage ?? m.audioMessage ?? m.documentMessage ?? m.videoMessage;
  if (!x) return null;
  return {
    nomeArquivo: typeof x.fileName === 'string' && x.fileName ? x.fileName : null,
    mime: typeof x.mimetype === 'string' ? x.mimetype : null,
    bytes: Number(x.fileLength?.low ?? x.fileLength) || null,
  };
}

// Devolve null para o que a Poli não grava: privado, reação, sem id ou sem hora.
export function extrairMensagem(data: any): MensagemNormalizada | null {
  const key = data?.key;
  const grupoJid: unknown = key?.remoteJid;
  if (typeof grupoJid !== 'string' || !grupoJid.endsWith('@g.us')) return null;
  if (typeof key?.id !== 'string' || !key.id) return null;

  const enviadaEm = lerTimestamp(data.messageTimestamp);
  if (!enviadaEm) return null;

  const message = desembrulhar(data.message);
  if (!message) return null;
  const c = conteudo(message);
  if (!c) return null;

  return {
    waMessageId: key.id,
    grupoJid,
    autorJid: typeof key.participant === 'string' ? key.participant : null,
    autorNome: typeof data.pushName === 'string' && data.pushName ? data.pushName : null,
    enviadaEm,
    tipo: c.tipo,
    texto: c.texto,
    citadaWaId: c.citada,
    midia: infoMidia(message),
    bruto: semBase64(data),
  };
}

export type ResultadoGravacao = 'gravada' | 'duplicada' | 'instancia_desconhecida';

export async function gravarMensagem(
  db: Db,
  instancia: string,
  msg: MensagemNormalizada,
  // A importação de histórico não baixa anexos antigos (podem ter expirado na Evolution).
  opcoes: { criarMidia?: boolean } = {},
): Promise<ResultadoGravacao> {
  const ws = await db.query(
    'select workspace_id from instancias_wa where evolution_instance = $1 and ativa',
    [instancia],
  );
  if (ws.rows.length === 0) return 'instancia_desconhecida';
  const workspaceId = ws.rows[0].workspace_id as number;

  const grupo = await db.query(
    `insert into grupos (workspace_id, jid) values ($1, $2)
     on conflict (workspace_id, jid) do update set jid = excluded.jid
     returning id`,
    [workspaceId, msg.grupoJid],
  );
  const grupoId = grupo.rows[0].id as number;

  let pessoaId: number | null = null;
  if (msg.autorJid) {
    // Quem o sistema ainda não conhece entra como "outro": papel só se atribui no painel.
    const pessoa = await db.query(
      `insert into pessoas (workspace_id, jid, nome, papel) values ($1, $2, $3, 'outro')
       on conflict (workspace_id, jid) do update set nome = coalesce(excluded.nome, pessoas.nome)
       returning id`,
      [workspaceId, msg.autorJid, msg.autorNome],
    );
    pessoaId = pessoa.rows[0].id as number;
  }

  const inserida = await db.query(
    `insert into mensagens
       (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, autor_jid, enviada_em, tipo, texto, citada_wa_id, bruto)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (workspace_id, wa_message_id) do nothing
     returning id`,
    [
      workspaceId,
      grupoId,
      msg.waMessageId,
      pessoaId,
      msg.autorJid,
      msg.enviadaEm.toISOString(),
      msg.tipo,
      msg.texto,
      msg.citadaWaId,
      JSON.stringify(msg.bruto),
    ],
  );
  if (inserida.rows.length === 0) return 'duplicada';

  if (msg.midia && opcoes.criarMidia !== false) {
    // Vídeo só guarda os metadados (decisão do esquema); o resto entra na fila de download.
    await db.query(
      `insert into midias (workspace_id, mensagem_id, mime, bytes, nome_arquivo, estado)
       values ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, inserida.rows[0].id, msg.midia.mime, msg.midia.bytes, msg.midia.nomeArquivo, msg.tipo === 'video' ? 'ignorada' : 'pendente'],
    );
  }
  return 'gravada';
}

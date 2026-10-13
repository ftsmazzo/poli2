import type { Db } from '../migrate';
import type { MensagemNormalizada } from '../ingest/evolution';

// "5596...:12@s.whatsapp.net" -> "5596..." (sem sufixo de aparelho nem domínio).
export function numeroDe(jid: string | null | undefined): string {
  return (jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

// Número brasileiro aparece com e sem o nono dígito: compara DDI + DDD + últimos 8 dígitos.
export function chaveNumero(digitos: string): string {
  if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) {
    return `55${digitos.slice(2, 4)}${digitos.slice(-8)}`;
  }
  return digitos;
}

// Aceita "5516998480805", "(16) 99848-0805" etc.; devolve só dígitos com DDI 55 e descarta o que não parece número.
export function normalizarComandantes(lista: string[]): string[] {
  return lista
    .map((n) => n.replace(/\D/g, ''))
    .map((d) => (d.length === 10 || d.length === 11 ? `55${d}` : d))
    .filter((d) => d.length >= 12 && d.length <= 13);
}

export interface Pedido {
  workspaceId: number;
  instancia: string;
  grupoJid: string;
  grupoNome: string | null;
  autorNome: string | null;
  consulta: string;
  waMessageId: string;
}

// "detalhe" diz só o TIPO do identificador do autor (número ou LID), nunca o número: serve para diagnosticar.
export type Avaliacao =
  | { tipo: 'pedido'; pedido: Pedido }
  // "motivo" só existe quando vale diagnosticar: descreve a mensagem em sim/não, nunca o conteúdo nem números.
  | { tipo: 'ignorar'; motivo?: string }
  | { tipo: 'nao_autorizado'; detalhe: string };

const dominio = (jid: string | null) => (jid && jid.includes('@') ? jid.split('@')[1] : 'nenhum');

const CHAMADA_POR_NOME = /^\s*@?poli\s?2\b[\s,:!.\-]*/i;

// A Poli só responde quando é chamada: marcação do número dela, resposta a uma mensagem dela,
// ou frase começando por "Poli2". O nome "Poli" sozinho é da versão 1, que continua no grupo.
export function ativaPoli(
  msg: MensagemNormalizada,
  jidProprio: string | null,
  lidProprio: string | null = null,
): { ativa: boolean; consulta: string } {
  const texto = msg.texto ?? '';
  const proprio = numeroDe(jidProprio);
  const chave = proprio ? chaveNumero(proprio) : null;
  // O WhatsApp pode marcar a Poli pelo telefone ou pelo LID (id interno): vale qualquer um dos dois.
  const eu = (digitos: string) => digitos !== '' && ((lidProprio !== null && digitos === lidProprio) || (chave !== null && chaveNumero(digitos) === chave));

  const marcou = msg.mencionados.some((j) => eu(numeroDe(j)));
  const marcouNoTexto = [...texto.matchAll(/@(\d{8,15})/g)].some((m) => eu(m[1]));
  const respondeuPoli = msg.citadaAutor !== null && eu(numeroDe(msg.citadaAutor));
  const chamouPorNome = CHAMADA_POR_NOME.test(texto);

  const consulta = texto
    .replace(/@\d{8,15}/g, ' ')
    .replace(CHAMADA_POR_NOME, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { ativa: marcou || marcouNoTexto || respondeuPoli || chamouPorNome, consulta };
}

// O autor pode vir como número ou como LID (identificador interno do WhatsApp); o número real, quando
// existe, vem em outro campo. Vale qualquer um dos dois.
export function ehComandante(msg: MensagemNormalizada, comandantes: string[], telefonesConhecidos: string[] = []): boolean {
  const permitidos = new Set(comandantes.map(chaveNumero));
  // "telefonesConhecidos": telefones que a Poli já ligou ao LID do autor (tabela lids).
  return [msg.autorJid, msg.autorAlt, ...telefonesConhecidos].some((j) => {
    const n = numeroDe(j);
    return n !== '' && permitidos.has(chaveNumero(n));
  });
}

export async function avaliarPedido(
  db: Db,
  instancia: string,
  msg: MensagemNormalizada,
  comandantes: string[],
): Promise<Avaliacao> {
  if (msg.fromMe || msg.tipo !== 'texto' || !msg.texto) return { tipo: 'ignorar' };

  const inst = await db.query(
    'select workspace_id, jid_proprio, lid_proprio from instancias_wa where evolution_instance = $1 and ativa',
    [instancia],
  );
  if (inst.rows.length === 0) return { tipo: 'ignorar' };

  const chamada = ativaPoli(msg, inst.rows[0].jid_proprio, inst.rows[0].lid_proprio);
  if (!chamada.ativa) {
    const tipos = msg.mencionados.map((j) => dominio(j)).sort().join(',') || 'nenhum';
    return {
      tipo: 'ignorar',
      motivo:
        `não foi reconhecida como chamada (marcados: ${tipos}; número próprio ${inst.rows[0].jid_proprio ? 'conhecido' : 'DESCONHECIDO'}; ` +
        `@número no texto: ${/@\d{8,15}/.test(msg.texto) ? 'sim' : 'não'}; resposta a mensagem: ${msg.citadaAutor ? `sim (${dominio(msg.citadaAutor)})` : 'não'})`,
    };
  }
  // Autor que chega como LID: procura o telefone que a Poli já aprendeu para esse LID.
  const lids = [msg.autorJid, msg.autorAlt].filter((j): j is string => !!j && j.endsWith('@lid')).map(numeroDe);
  const conhecidos = lids.length
    ? (await db.query('select telefone from lids where workspace_id = $1 and lid = any($2)', [inst.rows[0].workspace_id, lids])).rows.map(
        (r) => r.telefone as string,
      )
    : [];
  if (!ehComandante(msg, comandantes, conhecidos)) {
    return { tipo: 'nao_autorizado', detalhe: `autor: ${dominio(msg.autorJid)}; alternativo: ${dominio(msg.autorAlt)}` };
  }

  const grupo = await db.query('select nome from grupos where workspace_id = $1 and jid = $2', [
    inst.rows[0].workspace_id,
    msg.grupoJid,
  ]);
  return {
    tipo: 'pedido',
    pedido: {
      workspaceId: Number(inst.rows[0].workspace_id),
      instancia,
      grupoJid: msg.grupoJid,
      grupoNome: grupo.rows[0]?.nome ?? null,
      autorNome: msg.autorNome,
      consulta: chamada.consulta || 'oi',
      waMessageId: msg.waMessageId,
    },
  };
}

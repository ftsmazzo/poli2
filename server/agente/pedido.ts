import type { Db } from '../migrate';
import type { MensagemNormalizada, MensagemPrivada } from '../ingest/evolution';

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

// Aceita "5511987654321", "(11) 98765-4321" etc.; devolve só dígitos com DDI 55 e descarta o que não parece número.
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
  // Telefone (só dígitos) de quem pediu, já conferido como autorizado: é para onde vai o link do painel.
  telefoneAutor: string | null;
  // Papel que o link do painel dá a quem pediu: admin só para o mantenedor (lista COMANDANTES do servidor).
  papelNoPainel?: 'admin' | 'head';
  // Pedido feito no privado: grupoJid é o contato, e a resposta volta para ele.
  privado?: boolean;
}

// "detalhe" diz só o TIPO do identificador do autor (número ou LID), nunca o número: serve para diagnosticar.
export type Avaliacao =
  | { tipo: 'pedido'; pedido: Pedido }
  // "motivo" só existe quando vale diagnosticar: descreve a mensagem em sim/não, nunca o conteúdo nem números.
  | { tipo: 'ignorar'; motivo?: string }
  | { tipo: 'nao_autorizado'; detalhe: string };

const dominio = (jid: string | null) => (jid && jid.includes('@') ? jid.split('@')[1] : 'nenhum');

const CHAMADA_POR_NOME = /^\s*@?poli\s?2\b[\s,:!.\-]*/i;

const semAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Quantos caracteres do começo do texto são o nome do perfil da Poli (com ou sem @, sem diferenciar
// maiúscula nem acento). Palavra inteira: "MapSolarium" não é "MapSolar".
function tamanhoDoNomeNoInicio(texto: string, nome: string | null): number {
  if (!nome) return 0;
  const prefixo = /^\s*@?/.exec(texto)?.[0].length ?? 0;
  const resto = texto.slice(prefixo);
  if (semAcento(resto.slice(0, nome.length)) !== semAcento(nome)) return 0;
  if (/^[\p{L}\p{N}]/u.test(resto.slice(nome.length))) return 0;
  return prefixo + nome.length;
}

// "5511987654321" -> "5511*****4321": o dono reconhece o próprio número e o log não expõe o resto.
function mascarar(digitos: string): string {
  return digitos.length >= 9 ? `${digitos.slice(0, 4)}${'*'.repeat(digitos.length - 8)}${digitos.slice(-4)}` : '***';
}

// A Poli só responde quando é chamada: marcação do número dela, resposta a uma mensagem dela,
// ou frase começando por "Poli2". O nome "Poli" sozinho é da versão 1, que continua no grupo.
export function ativaPoli(
  msg: MensagemNormalizada,
  jidProprio: string | null,
  lidProprio: string | null = null,
  nomePerfil: string | null = null,
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

  const nomeNoInicio = tamanhoDoNomeNoInicio(texto, nomePerfil);
  const aposONome = nomeNoInicio > 0 ? texto.slice(nomeNoInicio).replace(/^[\s,:!.\-]+/, '') : texto;
  const consulta = aposONome
    .replace(/@\d{8,15}/g, ' ')
    .replace(CHAMADA_POR_NOME, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { ativa: marcou || marcouNoTexto || respondeuPoli || chamouPorNome || nomeNoInicio > 0, consulta };
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

// Confere se quem escreveu pode pedir: os números do ambiente (ponto de partida) mais as pessoas marcadas como
// "pode comandar" no painel, pelo telefone guardado ou pelo que a Poli ligou ao LID delas.
async function conferirAutor(
  db: Db,
  workspaceId: number,
  autorJid: string | null,
  autorAlt: string | null,
  comandantes: string[],
): Promise<{ telefone: string; doServidor: boolean } | { negado: string }> {
  // Autor que chega como LID: procura o telefone que a Poli já aprendeu para esse LID.
  const lids = [autorJid, autorAlt].filter((j): j is string => !!j && j.endsWith('@lid')).map(numeroDe);
  const conhecidos = lids.length
    ? (await db.query('select telefone from lids where workspace_id = $1 and lid = any($2)', [workspaceId, lids])).rows.map((r) => r.telefone as string)
    : [];
  const doPainel = await db.query(
    `select coalesce(p.telefone, case when p.jid like '%@s.whatsapp.net' then split_part(p.jid, '@', 1) end, l.telefone) as fone
     from pessoas p left join lids l on l.workspace_id = p.workspace_id and p.jid = l.lid || '@lid'
     where p.workspace_id = $1 and p.pode_comandar`,
    [workspaceId],
  );
  const permitidos = [...comandantes, ...doPainel.rows.map((r) => r.fone as string | null).filter((f): f is string => !!f)].map(numeroDe).filter(Boolean);
  const autorizados = new Set(permitidos.map(chaveNumero));
  const candidato = [autorAlt, autorJid, ...conhecidos].map(numeroDe).find((d) => d !== '' && autorizados.has(chaveNumero(d)));
  if (candidato) {
    // "doServidor": o número está na lista COMANDANTES do servidor (o mantenedor). Quem só foi marcado no painel não.
    const doServidor = comandantes.map(numeroDe).filter(Boolean).some((c) => chaveNumero(c) === chaveNumero(candidato));
    return { telefone: permitidos.find((p) => chaveNumero(p) === chaveNumero(candidato)) ?? candidato, doServidor };
  }
  // O telefone sai mascarado (começo e 4 últimos dígitos): dá para o dono reconhecer o próprio número.
  const telefones = [...new Set([autorAlt, ...conhecidos].filter((t): t is string => !!t).map(numeroDe).filter(Boolean))];
  return { negado: `autor: ${dominio(autorJid)}; alternativo: ${dominio(autorAlt)}; telefone do autor: ${telefones.map(mascarar).join(', ') || 'desconhecido'}` };
}

// Conversa privada: não precisa chamar a Poli pelo nome (a conversa já é com ela), mas só atende quem tem permissão.
export async function avaliarPrivado(db: Db, instancia: string, dm: MensagemPrivada, comandantes: string[]): Promise<Avaliacao> {
  const inst = await db.query('select workspace_id from instancias_wa where evolution_instance = $1 and ativa', [instancia]);
  if (inst.rows.length === 0) return { tipo: 'ignorar' };
  const workspaceId = Number(inst.rows[0].workspace_id);
  const quem = await conferirAutor(db, workspaceId, dm.contatoJid, dm.contatoAlt, comandantes);
  if ('negado' in quem) return { tipo: 'nao_autorizado', detalhe: quem.negado };
  const consulta = dm.texto.replace(CHAMADA_POR_NOME, '').replace(/\s+/g, ' ').trim();
  return {
    tipo: 'pedido',
    pedido: {
      workspaceId,
      instancia,
      grupoJid: dm.contatoJid,
      grupoNome: null,
      autorNome: dm.nome,
      consulta: consulta || 'oi',
      waMessageId: dm.waMessageId,
      telefoneAutor: quem.telefone,
      papelNoPainel: quem.doServidor ? 'admin' : 'head',
      privado: true,
    },
  };
}

export async function avaliarPedido(
  db: Db,
  instancia: string,
  msg: MensagemNormalizada,
  comandantes: string[],
): Promise<Avaliacao> {
  if (msg.fromMe || msg.tipo !== 'texto' || !msg.texto) return { tipo: 'ignorar' };

  const inst = await db.query(
    'select workspace_id, jid_proprio, lid_proprio, nome_perfil from instancias_wa where evolution_instance = $1 and ativa',
    [instancia],
  );
  if (inst.rows.length === 0) return { tipo: 'ignorar' };

  const chamada = ativaPoli(msg, inst.rows[0].jid_proprio, inst.rows[0].lid_proprio, inst.rows[0].nome_perfil);
  if (!chamada.ativa) {
    const tipos = msg.mencionados.map((j) => dominio(j)).sort().join(',') || 'nenhum';
    return {
      tipo: 'ignorar',
      motivo:
        `não foi reconhecida como chamada (marcados: ${tipos}; número próprio ${inst.rows[0].jid_proprio ? 'conhecido' : 'DESCONHECIDO'}; ` +
        `@número no texto: ${/@\d{8,15}/.test(msg.texto) ? 'sim' : 'não'}; resposta a mensagem: ${msg.citadaAutor ? `sim (${dominio(msg.citadaAutor)})` : 'não'})`,
    };
  }
  const quem = await conferirAutor(db, Number(inst.rows[0].workspace_id), msg.autorJid, msg.autorAlt, comandantes);
  if ('negado' in quem) return { tipo: 'nao_autorizado', detalhe: quem.negado };
  const telefoneAutor = quem.telefone;
  const papelNoPainel = quem.doServidor ? ('admin' as const) : ('head' as const);

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
      telefoneAutor,
      papelNoPainel,
    },
  };
}

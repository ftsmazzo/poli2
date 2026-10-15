import type { Db } from '../migrate';
import { criarLinkDeLogin } from '../painel/auth';
import type { Pedido } from './pedido';

const semAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// "painel", "me manda o link do painel", "abrir o painel", "acesso ao painel", "login"...
// Só a frase inteira vale: "qual o painel solar de fulano?" é uma pergunta comum, não um pedido de acesso.
const PEDIDO_DE_PAINEL = /^(me )?(manda |mande |abre |abrir |quero |preciso d[oea] |da |dar )?(o |a )?(link |acesso |entrada )?(d[oe] |ao |no )?(painel|dashboard)( da poli)?$/;

export function ehPedidoDePainel(consulta: string): boolean {
  const limpa = semAcento(consulta).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return PEDIDO_DE_PAINEL.test(limpa) || limpa === 'login' || limpa === 'entrar';
}

export interface DepsPainel {
  db: Db;
  enviar: (instancia: string, destino: string, texto: string) => Promise<{ waMessageId: string | null }>;
  urlBase: string;
}

export type ResultadoPainel = 'enviado' | 'falhou';

// O link vai para o PRIVADO de quem pediu, nunca para o grupo: quem tem o link entra como essa pessoa.
// No banco fica só uma marca de que o link foi enviado, nunca o endereço com o token.
export async function entregarLinkDoPainel(deps: DepsPainel, p: Pedido): Promise<ResultadoPainel> {
  const { db } = deps;
  const registrar = (destino: string, tipo: 'privado' | 'grupo', texto: string, estado: 'enviada' | 'falhou') =>
    db.query(
      `insert into mensagens_saida (workspace_id, destino_jid, destino_tipo, origem, texto, estado, enviada_em)
       values ($1, $2, $3, 'aviso', $4, $5, case when $5 = 'enviada' then now() end)`,
      [p.workspaceId, destino, tipo, texto, estado],
    );

  if (!p.telefoneAutor) {
    await deps.enviar(p.instancia, p.grupoJid, 'Não consegui identificar o seu número para mandar o link.');
    return 'falhou';
  }

  try {
    const token = await criarLinkDeLogin(db, { workspaceId: p.workspaceId, telefone: p.telefoneAutor, papel: p.papelNoPainel ?? 'head' });
    const url = `${deps.urlBase.replace(/\/+$/, '')}/entrar?t=${token}`;
    await deps.enviar(p.instancia, p.telefoneAutor, `Seu acesso ao painel da Poli (vale 15 minutos e só funciona uma vez):\n${url}`);
    await registrar(p.telefoneAutor, 'privado', '[link de acesso ao painel]', 'enviada');
  } catch (err) {
    console.error('envio do link do painel falhou:', err instanceof Error ? err.message : err);
    await registrar(p.telefoneAutor, 'privado', '[link de acesso ao painel]', 'falhou');
    await deps.enviar(p.instancia, p.grupoJid, 'Não consegui mandar no seu privado. Mande uma mensagem para mim no privado e peça de novo.').catch(() => undefined);
    return 'falhou';
  }

  await deps.enviar(p.instancia, p.grupoJid, 'Mandei o link do painel no seu privado.').catch(() => undefined);
  await registrar(p.grupoJid, 'grupo', 'Mandei o link do painel no seu privado.', 'enviada');
  return 'enviado';
}

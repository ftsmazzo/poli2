import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../migrate';

export const VALIDADE_LINK_MS = 15 * 60_000;
export const VALIDADE_SESSAO_MS = 30 * 24 * 60 * 60_000;

// Só o hash do token vai para o banco: quem lê o banco não consegue entrar com ele.
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const novoToken = () => randomBytes(32).toString('base64url');

export interface Sessao {
  usuarioId: number;
  nome: string | null;
  telefone: string | null;
  workspaces: { id: number; nome: string; papel: 'admin' | 'head' }[];
}

// Link de acesso de uso único, válido por 15 minutos, para o telefone informado.
// O papel padrão é o menor: admin só quando quem chama garante que a pessoa é o mantenedor.
export async function criarLinkDeLogin(
  db: Db,
  p: { workspaceId: number; telefone: string; papel?: 'admin' | 'head' },
  agora = new Date(),
): Promise<string> {
  const token = novoToken();
  await db.query(
    'insert into login_links (workspace_id, telefone, token_hash, expira_em, papel) values ($1, $2, $3, $4, $5)',
    [p.workspaceId, p.telefone, hash(token), new Date(agora.getTime() + VALIDADE_LINK_MS).toISOString(), p.papel ?? 'head'],
  );
  return token;
}

// Troca o link por uma sessão. O "update ... returning" marca o link como usado e confere a validade
// numa só instrução: dois cliques ao mesmo tempo não conseguem usar o mesmo link duas vezes.
export async function consumirLink(db: Db, token: string, agora = new Date()): Promise<string | null> {
  const link = await db.query(
    `update login_links set usado_em = $2
     where token_hash = $1 and usado_em is null and expira_em > $2
     returning workspace_id, telefone, papel`,
    [hash(token), agora.toISOString()],
  );
  if (link.rows.length === 0) return null;
  const { workspace_id: workspaceId, telefone, papel } = link.rows[0];

  let usuario = await db.query('select id from usuarios where telefone = $1', [telefone]);
  if (usuario.rows.length === 0) {
    const nome = await db.query('select nome from pessoas where workspace_id = $1 and telefone = $2 order by id limit 1', [workspaceId, telefone]);
    usuario = await db.query('insert into usuarios (telefone, nome) values ($1, $2) returning id', [telefone, nome.rows[0]?.nome ?? null]);
  }
  const usuarioId = usuario.rows[0].id as number;

  // O papel é o que valia quando o link foi pedido (a Poli já reconheceu a pessoa como autorizada), e é
  // refeito a cada login: quem deixou de ser administrador não continua sendo.
  await db.query(
    `insert into usuario_workspaces (usuario_id, workspace_id, papel) values ($1, $2, $3)
     on conflict (usuario_id, workspace_id) do update set papel = excluded.papel`,
    [usuarioId, workspaceId, papel],
  );

  const sessao = novoToken();
  await db.query('insert into sessoes (usuario_id, token_hash, expira_em, ultimo_uso_em) values ($1, $2, $3, $4)', [
    usuarioId,
    hash(sessao),
    new Date(agora.getTime() + VALIDADE_SESSAO_MS).toISOString(),
    agora.toISOString(),
  ]);
  return sessao;
}

export async function carregarSessao(db: Db, token: string, agora = new Date()): Promise<Sessao | null> {
  const s = await db.query(
    `select s.id, u.id as usuario_id, u.nome, u.telefone
     from sessoes s join usuarios u on u.id = s.usuario_id
     where s.token_hash = $1 and s.expira_em > $2 and u.ativo`,
    [hash(token), agora.toISOString()],
  );
  if (s.rows.length === 0) return null;
  const { id, usuario_id: usuarioId, nome, telefone } = s.rows[0];
  await db.query('update sessoes set ultimo_uso_em = $2 where id = $1', [id, agora.toISOString()]);

  const ws = await db.query(
    `select w.id, w.nome, uw.papel from usuario_workspaces uw join workspaces w on w.id = uw.workspace_id
     where uw.usuario_id = $1 order by w.id`,
    [usuarioId],
  );
  return {
    usuarioId: Number(usuarioId),
    nome,
    telefone,
    workspaces: ws.rows.map((w) => ({ id: Number(w.id), nome: w.nome, papel: w.papel })),
  };
}

export async function encerrarSessao(db: Db, token: string): Promise<void> {
  await db.query('delete from sessoes where token_hash = $1', [hash(token)]);
}

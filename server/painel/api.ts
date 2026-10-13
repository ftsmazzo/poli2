import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { testarFonte, urlValida, type ConectorMcp } from '../fontes/mcp';
import type { Db } from '../migrate';
import { VALIDADE_SESSAO_MS, carregarSessao, consumirLink, encerrarSessao, type Sessao } from './auth';
import { cifrar } from './cripto';

export interface DepsApi {
  db: Db;
  conectar: ConectorMcp;
  // Sem ela não dá para guardar segredo de Fonte (nunca se guarda em texto puro).
  chaveCripto: string | undefined;
  cookieSeguro: boolean;
}

interface Contexto {
  sessao: Sessao;
  workspaceId: number;
  papel: 'admin' | 'head';
}

const COOKIE = 'poli_sessao';

function lerCookie(req: Request): string | null {
  for (const par of (req.headers.cookie ?? '').split(';')) {
    const [nome, ...resto] = par.trim().split('=');
    if (nome === COOKIE && resto.length > 0) return decodeURIComponent(resto.join('='));
  }
  return null;
}

function gravarCookie(res: Response, valor: string, maxAgeSegundos: number, seguro: boolean) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(valor)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSegundos}${seguro ? '; Secure' : ''}`);
}

// Pedido que muda dados só vale se vier da própria página do painel (o cookie é SameSite=Lax; isto é a segunda barreira).
function mesmaOrigem(req: Request): boolean {
  const origem = req.headers.origin;
  if (!origem) return true;
  try {
    const esperado = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
    return new URL(origem).host === esperado;
  } catch {
    return false;
  }
}

const tokenDeCabecalho = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,60}$/, 'nome de cabeçalho inválido');
const esquemaFonteNova = z.object({
  nome: z.string().trim().min(1).max(80),
  url: z.string().trim().max(500),
  segredo: z.string().max(2000).optional(),
  headerNome: tokenDeCabecalho.optional(),
  quandoUsar: z.string().max(500).optional(),
});
const esquemaFontePatch = z.object({
  nome: z.string().trim().min(1).max(80).optional(),
  url: z.string().trim().max(500).optional(),
  // "" apaga o segredo guardado; vazio/ausente não mexe.
  segredo: z.string().max(2000).optional(),
  headerNome: tokenDeCabecalho.optional(),
  quandoUsar: z.string().max(500).optional(),
  ativa: z.boolean().optional(),
});
const esquemaGrupoPatch = z.object({ acompanhar: z.boolean().optional(), intervaloMin: z.number().int().min(5).max(1440).optional() });
const esquemaPessoaPatch = z.object({
  nome: z.string().trim().max(120).optional(),
  telefone: z.string().max(30).optional(),
  papel: z.enum(['head', 'vip', 'equipe', 'outro']).optional(),
  podeComandar: z.boolean().optional(),
  podeConversar: z.boolean().optional(),
});

export function painelRouter(deps: DepsApi): Router {
  const { db } = deps;
  const r = Router();
  r.use(express.json({ limit: '100kb' }));

  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !mesmaOrigem(req)) {
      res.status(403).json({ erro: 'origem_invalida' });
      return;
    }
    next();
  });

  // O link do WhatsApp só abre a página; quem troca o link pela sessão é este POST, feito pela página.
  // Assim a pré-visualização do WhatsApp (que só faz GET) não gasta o link.
  r.post('/entrar', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const sessao = token ? await consumirLink(db, token) : null;
    if (!sessao) {
      res.status(401).json({ erro: 'link_invalido_ou_expirado' });
      return;
    }
    gravarCookie(res, sessao, Math.floor(VALIDADE_SESSAO_MS / 1000), deps.cookieSeguro);
    res.json({ ok: true });
  });

  r.post('/sair', async (req, res) => {
    const token = lerCookie(req);
    if (token) await encerrarSessao(db, token);
    gravarCookie(res, '', 0, deps.cookieSeguro);
    res.json({ ok: true });
  });

  // Confere a sessão e o tenant escolhido (cabeçalho x-workspace). O tenant NUNCA vem do corpo do pedido.
  const exigir = (soAdmin = false) => async (req: Request, res: Response, next: NextFunction) => {
    const token = lerCookie(req);
    const sessao = token ? await carregarSessao(db, token) : null;
    if (!sessao) {
      res.status(401).json({ erro: 'sem_sessao' });
      return;
    }
    const pedido = Number(req.headers['x-workspace']);
    const ws = Number.isFinite(pedido) && pedido > 0 ? sessao.workspaces.find((w) => w.id === pedido) : sessao.workspaces[0];
    if (!ws) {
      res.status(403).json({ erro: 'tenant_nao_permitido' });
      return;
    }
    if (soAdmin && ws.papel !== 'admin') {
      res.status(403).json({ erro: 'so_administrador' });
      return;
    }
    res.locals.ctx = { sessao, workspaceId: ws.id, papel: ws.papel } satisfies Contexto;
    next();
  };
  const ctx = (res: Response) => res.locals.ctx as Contexto;
  const idDaRota = (req: Request) => Number(req.params.id);

  r.get('/eu', exigir(), (_req, res) => {
    const { sessao, workspaceId } = ctx(res);
    res.json({
      usuario: { id: sessao.usuarioId, nome: sessao.nome, telefone: sessao.telefone },
      workspaces: sessao.workspaces,
      workspaceAtual: workspaceId,
    });
  });

  // ---------- Fontes ----------

  async function listarFontes(workspaceId: number, soUma?: number) {
    const f = await db.query(
      `select id, tipo, nome, config, quando_usar, escopo, ativa, status, ultimo_teste_em, ultimo_erro, latencia_ms,
              (segredo_enc is not null) as tem_segredo
       from fontes where workspace_id = $1 ${soUma ? 'and id = $2' : ''} order by id`,
      soUma ? [workspaceId, soUma] : [workspaceId],
    );
    const t = await db.query(
      `select ft.fonte_id, ft.nome, ft.descricao, ft.ativa, ft.somente_leitura
       from fonte_tools ft join fontes x on x.id = ft.fonte_id where x.workspace_id = $1 order by ft.nome`,
      [workspaceId],
    );
    return f.rows.map((x) => ({
      id: Number(x.id),
      tipo: x.tipo,
      nome: x.nome,
      url: x.config?.url ?? null,
      headerNome: x.config?.headerNome ?? null,
      quandoUsar: x.quando_usar,
      escopo: x.escopo,
      ativa: x.ativa,
      status: x.status,
      ultimoTesteEm: x.ultimo_teste_em,
      ultimoErro: x.ultimo_erro,
      latenciaMs: x.latencia_ms,
      temSegredo: x.tem_segredo,
      ferramentas: t.rows
        .filter((y) => Number(y.fonte_id) === Number(x.id))
        .map((y) => ({ nome: y.nome, descricao: y.descricao, ativa: y.ativa, somenteLeitura: y.somente_leitura })),
    }));
  }

  r.get('/fontes', exigir(), async (_req, res) => {
    res.json(await listarFontes(ctx(res).workspaceId));
  });

  r.post('/fontes', exigir(true), async (req, res) => {
    const p = esquemaFonteNova.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ erro: 'dados_invalidos', detalhe: p.error.issues[0]?.message });
      return;
    }
    if (!urlValida(p.data.url)) {
      res.status(400).json({ erro: 'url_invalida' });
      return;
    }
    if (p.data.segredo && !deps.chaveCripto) {
      res.status(400).json({ erro: 'sem_chave_de_criptografia' });
      return;
    }
    const { workspaceId } = ctx(res);
    try {
      const nova = await db.query(
        `insert into fontes (workspace_id, tipo, nome, config, segredo_enc, quando_usar)
         values ($1, 'mcp', $2, $3::jsonb, $4, $5) returning id`,
        [
          workspaceId,
          p.data.nome,
          JSON.stringify({ url: p.data.url, ...(p.data.headerNome ? { headerNome: p.data.headerNome } : {}) }),
          p.data.segredo ? cifrar(p.data.segredo, deps.chaveCripto!) : null,
          p.data.quandoUsar ?? '',
        ],
      );
      res.status(201).json((await listarFontes(workspaceId, Number(nova.rows[0].id)))[0]);
    } catch (err) {
      if (/unique|duplicate/i.test(err instanceof Error ? err.message : '')) {
        res.status(409).json({ erro: 'nome_ja_existe' });
        return;
      }
      throw err;
    }
  });

  r.patch('/fontes/:id', exigir(true), async (req, res) => {
    const p = esquemaFontePatch.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ erro: 'dados_invalidos', detalhe: p.error.issues[0]?.message });
      return;
    }
    if (p.data.url !== undefined && !urlValida(p.data.url)) {
      res.status(400).json({ erro: 'url_invalida' });
      return;
    }
    if (p.data.segredo && !deps.chaveCripto) {
      res.status(400).json({ erro: 'sem_chave_de_criptografia' });
      return;
    }
    const { workspaceId } = ctx(res);
    const atual = await db.query(`select config from fontes where id = $1 and workspace_id = $2`, [idDaRota(req), workspaceId]);
    if (atual.rows.length === 0) {
      res.status(404).json({ erro: 'nao_encontrada' });
      return;
    }
    const config = { ...atual.rows[0].config };
    if (p.data.url !== undefined) config.url = p.data.url;
    if (p.data.headerNome !== undefined) config.headerNome = p.data.headerNome;

    const sets: string[] = ['config = $3::jsonb'];
    const params: unknown[] = [idDaRota(req), workspaceId, JSON.stringify(config)];
    const campo = (coluna: string, valor: unknown) => {
      params.push(valor);
      sets.push(`${coluna} = $${params.length}`);
    };
    if (p.data.nome !== undefined) campo('nome', p.data.nome);
    if (p.data.quandoUsar !== undefined) campo('quando_usar', p.data.quandoUsar);
    if (p.data.ativa !== undefined) campo('ativa', p.data.ativa);
    if (p.data.segredo !== undefined) campo('segredo_enc', p.data.segredo === '' ? null : cifrar(p.data.segredo, deps.chaveCripto!));
    // Mudou o endereço ou a credencial: o último teste não vale mais.
    if (p.data.url !== undefined || p.data.segredo !== undefined) sets.push(`status = 'nunca_testada'`);
    try {
      await db.query(`update fontes set ${sets.join(', ')} where id = $1 and workspace_id = $2`, params);
    } catch (err) {
      if (/unique|duplicate/i.test(err instanceof Error ? err.message : '')) {
        res.status(409).json({ erro: 'nome_ja_existe' });
        return;
      }
      throw err;
    }
    res.json((await listarFontes(workspaceId, idDaRota(req)))[0]);
  });

  r.delete('/fontes/:id', exigir(true), async (req, res) => {
    const apagou = await db.query('delete from fontes where id = $1 and workspace_id = $2 returning id', [idDaRota(req), ctx(res).workspaceId]);
    if (apagou.rows.length === 0) {
      res.status(404).json({ erro: 'nao_encontrada' });
      return;
    }
    res.json({ ok: true });
  });

  r.post('/fontes/:id/testar', exigir(true), async (req, res) => {
    const { workspaceId } = ctx(res);
    // A chave só é necessária para decifrar o segredo de uma Fonte que tenha um: Fonte aberta testa sem ela.
    const resultado = await testarFonte(db, deps.conectar, deps.chaveCripto ?? '', workspaceId, idDaRota(req));
    if (!resultado) {
      res.status(404).json({ erro: 'nao_encontrada' });
      return;
    }
    res.json({ ...resultado, fonte: (await listarFontes(workspaceId, idDaRota(req)))[0] });
  });

  r.patch('/fontes/:id/ferramentas/:nome', exigir(true), async (req, res) => {
    const p = z.object({ ativa: z.boolean() }).safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ erro: 'dados_invalidos' });
      return;
    }
    const mudou = await db.query(
      `update fonte_tools set ativa = $4 where fonte_id = $1 and nome = $2
       and exists (select 1 from fontes f where f.id = $1 and f.workspace_id = $3) returning nome`,
      [idDaRota(req), req.params.nome, ctx(res).workspaceId, p.data.ativa],
    );
    if (mudou.rows.length === 0) {
      res.status(404).json({ erro: 'nao_encontrada' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------- Grupos ----------

  r.get('/grupos', exigir(), async (_req, res) => {
    const g = await db.query(
      `select g.id, g.jid, g.nome, g.acompanhar, g.intervalo_min, g.ultima_leitura_em, g.historico_importado_em,
              (select count(*)::int from mensagens m where m.grupo_id = g.id) as mensagens,
              (select max(m.enviada_em) from mensagens m where m.grupo_id = g.id) as ultima_mensagem_em
       from grupos g where g.workspace_id = $1 order by ultima_mensagem_em desc nulls last, g.id`,
      [ctx(res).workspaceId],
    );
    res.json(
      g.rows.map((x) => ({
        id: Number(x.id),
        nome: x.nome ?? x.jid,
        acompanhar: x.acompanhar,
        intervaloMin: x.intervalo_min,
        ultimaLeituraEm: x.ultima_leitura_em,
        historicoImportadoEm: x.historico_importado_em,
        mensagens: x.mensagens,
        ultimaMensagemEm: x.ultima_mensagem_em,
      })),
    );
  });

  r.patch('/grupos/:id', exigir(), async (req, res) => {
    const p = esquemaGrupoPatch.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ erro: 'dados_invalidos', detalhe: p.error.issues[0]?.message });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [idDaRota(req), ctx(res).workspaceId];
    if (p.data.acompanhar !== undefined) {
      params.push(p.data.acompanhar);
      sets.push(`acompanhar = $${params.length}`);
    }
    if (p.data.intervaloMin !== undefined) {
      params.push(p.data.intervaloMin);
      sets.push(`intervalo_min = $${params.length}`);
    }
    if (sets.length === 0) {
      res.status(400).json({ erro: 'nada_para_mudar' });
      return;
    }
    const mudou = await db.query(`update grupos set ${sets.join(', ')} where id = $1 and workspace_id = $2 returning id`, params);
    if (mudou.rows.length === 0) {
      res.status(404).json({ erro: 'nao_encontrado' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------- Pessoas ----------

  r.get('/pessoas', exigir(), async (_req, res) => {
    const p = await db.query(
      `select p.id, p.nome, p.telefone, p.jid, p.papel, p.pode_comandar, p.pode_conversar,
              (select count(*)::int from mensagens m where m.autor_pessoa_id = p.id) as mensagens
       from pessoas p where p.workspace_id = $1 order by p.pode_comandar desc, mensagens desc, p.id`,
      [ctx(res).workspaceId],
    );
    res.json(
      p.rows.map((x) => ({
        id: Number(x.id),
        nome: x.nome,
        telefone: x.telefone,
        papel: x.papel,
        podeComandar: x.pode_comandar,
        podeConversar: x.pode_conversar,
        mensagens: x.mensagens,
      })),
    );
  });

  r.patch('/pessoas/:id', exigir(true), async (req, res) => {
    const p = esquemaPessoaPatch.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ erro: 'dados_invalidos', detalhe: p.error.issues[0]?.message });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [idDaRota(req), ctx(res).workspaceId];
    const campo = (coluna: string, valor: unknown) => {
      params.push(valor);
      sets.push(`${coluna} = $${params.length}`);
    };
    if (p.data.nome !== undefined) campo('nome', p.data.nome || null);
    if (p.data.telefone !== undefined) campo('telefone', p.data.telefone.replace(/\D/g, '') || null);
    if (p.data.papel !== undefined) campo('papel', p.data.papel);
    if (p.data.podeComandar !== undefined) campo('pode_comandar', p.data.podeComandar);
    if (p.data.podeConversar !== undefined) campo('pode_conversar', p.data.podeConversar);
    if (sets.length === 0) {
      res.status(400).json({ erro: 'nada_para_mudar' });
      return;
    }
    const mudou = await db.query(`update pessoas set ${sets.join(', ')} where id = $1 and workspace_id = $2 returning id`, params);
    if (mudou.rows.length === 0) {
      res.status(404).json({ erro: 'nao_encontrada' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------- Alertas e diagnóstico ----------

  r.get('/alertas', exigir(), async (_req, res) => {
    const a = await db.query(
      `select a.id, a.severidade, a.texto, a.criado_em, a.enviado_em, g.nome as grupo
       from alertas a left join grupos g on g.id = a.grupo_id
       where a.workspace_id = $1 order by a.criado_em desc limit 100`,
      [ctx(res).workspaceId],
    );
    res.json(
      a.rows.map((x) => ({ id: Number(x.id), severidade: x.severidade, texto: x.texto, grupo: x.grupo, criadoEm: x.criado_em, enviadoEm: x.enviado_em })),
    );
  });

  r.get('/diagnostico', exigir(), async (_req, res) => {
    const ws = ctx(res).workspaceId;
    const um = async (sql: string) => (await db.query(sql, [ws])).rows[0];
    const [totais, inst, midias, pendentes, turnos] = await Promise.all([
      um(`select (select count(*)::int from mensagens where workspace_id = $1) as mensagens,
                 (select count(*)::int from itens where workspace_id = $1) as itens,
                 (select count(*)::int from grupos where workspace_id = $1) as grupos,
                 (select count(*)::int from pessoas where workspace_id = $1) as pessoas`),
      um(`select evolution_instance, nome_perfil, jid_proprio, lid_proprio from instancias_wa where workspace_id = $1 order by id limit 1`),
      um(`select count(*) filter (where estado = 'pendente')::int as pendentes, count(*) filter (where estado = 'falhou')::int as falhas
          from midias where workspace_id = $1`),
      um(`select count(*)::int as n from mensagens where workspace_id = $1 and itens_extraidos_em is null`),
      db.query(
        `select criado_em, pergunta, tools, latencia_ms, resposta from turnos where workspace_id = $1 order by criado_em desc limit 10`,
        [ws],
      ),
    ]);
    res.json({
      instancia: inst
        ? { nome: inst.evolution_instance, nomePerfil: inst.nome_perfil, numeroConhecido: !!inst.jid_proprio, lidConhecido: !!inst.lid_proprio }
        : null,
      totais,
      fontes: (await listarFontes(ws)).map((f) => ({ id: f.id, nome: f.nome, ativa: f.ativa, status: f.status, ultimoTesteEm: f.ultimoTesteEm, ultimoErro: f.ultimoErro, latenciaMs: f.latenciaMs })),
      midias,
      extracaoPendente: pendentes.n,
      ultimosTurnos: turnos.rows.map((t) => ({ quando: t.criado_em, pergunta: t.pergunta, ferramentas: t.tools, latenciaMs: t.latencia_ms, respondido: t.resposta !== null })),
    });
  });

  r.use((req, res) => {
    res.status(404).json({ erro: 'nao_encontrado' });
  });
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ erro: 'json_invalido' });
      return;
    }
    // Só a mensagem do erro: o corpo do pedido pode ter segredo (token de Fonte).
    console.error('api do painel falhou:', err instanceof Error ? err.message : err);
    res.status(500).json({ erro: 'falha_interna' });
  });
  return r;
}

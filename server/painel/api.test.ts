import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { ClienteMcp, ConectorMcp } from '../fontes/mcp';
import { migrate } from '../migrate';
import { criarLinkDeLogin } from './auth';
import { painelRouter } from './api';
import { decifrar } from './cripto';

const CHAVE = 'chave-de-teste-com-mais-de-16';
const TEL = '5516996480805';

const clienteFalso = (): ClienteMcp => ({
  listarFerramentas: async () => [
    { nome: 'buscar_votos', descricao: 'Votos', esquema: { type: 'object', properties: {} }, somenteLeitura: true },
    { nome: 'apagar_dados', descricao: 'Apaga', esquema: { type: 'object', properties: {} }, somenteLeitura: false },
  ],
  chamar: async () => 'x',
  fechar: async () => undefined,
});

describe('API do painel', () => {
  let db: PGlite;
  let server: Server;
  let base: string;
  let conectar: ConectorMcp;
  let comChave = true;

  async function subir() {
    const app = express();
    // "conectar" é lido a cada chamada, para os testes poderem trocar o conector depois de o servidor subir.
    app.use('/api', painelRouter({ db, conectar: (alvo) => conectar(alvo), chaveCripto: comChave ? CHAVE : undefined, cookieSeguro: false }));
    await new Promise<void>((ok) => {
      server = app.listen(0, () => ok());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }

  async function chamar(caminho: string, opcoes: { metodo?: string; corpo?: unknown; cookie?: string; workspace?: number; origem?: string } = {}) {
    const res = await fetch(`${base}${caminho}`, {
      method: opcoes.metodo ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(opcoes.cookie ? { cookie: opcoes.cookie } : {}),
        ...(opcoes.workspace ? { 'x-workspace': String(opcoes.workspace) } : {}),
        ...(opcoes.origem ? { origin: opcoes.origem } : {}),
      },
      ...(opcoes.corpo !== undefined ? { body: JSON.stringify(opcoes.corpo) } : {}),
    });
    const texto = await res.text();
    return { status: res.status, corpo: texto ? JSON.parse(texto) : null, cabecalhos: res.headers };
  }

  // Entra pelo link, como o navegador faz, e devolve o cookie.
  async function entrar(workspaceId: number, telefone = TEL): Promise<string> {
    const token = await criarLinkDeLogin(db, { workspaceId, telefone });
    const r = await chamar('/entrar', { metodo: 'POST', corpo: { token } });
    expect(r.status).toBe(200);
    return r.cabecalhos.get('set-cookie')!.split(';')[0];
  }

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A'), ('Tenant B')`);
    conectar = async () => clienteFalso();
    comChave = true;
    await subir();
  });

  afterEach(async () => {
    await new Promise((ok) => server.close(ok));
  });

  describe('entrada e sessão', () => {
    it('sem sessão nada abre', async () => {
      for (const c of ['/eu', '/fontes', '/grupos', '/pessoas', '/alertas', '/diagnostico']) {
        expect((await chamar(c)).status).toBe(401);
      }
      expect((await chamar('/eu', { cookie: 'poli_sessao=inventada' })).status).toBe(401);
    });

    it('o link entra uma vez, o cookie é HttpOnly e a sessão enxerga o tenant', async () => {
      const token = await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL });
      const r = await chamar('/entrar', { metodo: 'POST', corpo: { token } });
      const cookie = r.cabecalhos.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect((await chamar('/entrar', { metodo: 'POST', corpo: { token } })).status).toBe(401);

      const eu = await chamar('/eu', { cookie: cookie.split(';')[0] });
      expect(eu.corpo).toMatchObject({ usuario: { telefone: TEL }, workspaces: [{ id: 1, nome: 'Tenant A', papel: 'admin' }], workspaceAtual: 1 });
    });

    it('sair encerra a sessão', async () => {
      const cookie = await entrar(1);
      await chamar('/sair', { metodo: 'POST', cookie });
      expect((await chamar('/eu', { cookie })).status).toBe(401);
    });

    it('recusa pedido que muda dados vindo de outra origem', async () => {
      const cookie = await entrar(1);
      const r = await chamar('/fontes', { metodo: 'POST', cookie, origem: 'https://site-malicioso.com', corpo: { nome: 'X', url: 'https://a.com/mcp' } });
      expect(r.status).toBe(403);
    });
  });

  describe('tenants', () => {
    it('quem só é do tenant A não vê nem escolhe o B', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into grupos (workspace_id, jid, nome) values (2, '9@g.us', 'Grupo do B')`);
      expect((await chamar('/grupos', { cookie })).corpo).toEqual([]);
      expect((await chamar('/grupos', { cookie, workspace: 2 })).status).toBe(403);
    });

    it('um usuário nos dois tenants escolhe pelo cabeçalho e cada um mostra só o seu', async () => {
      const cookie = await entrar(1);
      await entrar(2);
      await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'Grupo do A'), (2, '2@g.us', 'Grupo do B')`);
      expect((await chamar('/grupos', { cookie, workspace: 1 })).corpo.map((g: any) => g.nome)).toEqual(['Grupo do A']);
      expect((await chamar('/grupos', { cookie, workspace: 2 })).corpo.map((g: any) => g.nome)).toEqual(['Grupo do B']);
    });
  });

  describe('Fontes', () => {
    it('cria a Fonte com o segredo cifrado e nunca o devolve', async () => {
      const cookie = await entrar(1);
      const r = await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'Urna TSE', url: 'https://mcp.exemplo.com/mcp', segredo: 'token-da-urna', quandoUsar: 'dados de votação' } });
      expect(r.status).toBe(201);
      expect(r.corpo).toMatchObject({ nome: 'Urna TSE', url: 'https://mcp.exemplo.com/mcp', temSegredo: true, status: 'nunca_testada', quandoUsar: 'dados de votação' });
      expect(JSON.stringify(r.corpo)).not.toContain('token-da-urna');

      const guardado = (await db.query<{ segredo_enc: string }>('select segredo_enc from fontes')).rows[0].segredo_enc;
      expect(guardado).not.toContain('token-da-urna');
      expect(decifrar(guardado, CHAVE)).toBe('token-da-urna');
    });

    it('valida endereço, nome repetido e falta de chave de criptografia', async () => {
      const cookie = await entrar(1);
      expect((await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'X', url: 'ftp://a.com' } })).corpo.erro).toBe('url_invalida');
      expect((await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: '', url: 'https://a.com/mcp' } })).status).toBe(400);
      await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'Urna', url: 'https://a.com/mcp' } });
      expect((await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'Urna', url: 'https://b.com/mcp' } })).status).toBe(409);

      await new Promise((ok) => server.close(ok));
      comChave = false;
      await subir();
      const c2 = await entrar(1);
      const semChave = await chamar('/fontes', { metodo: 'POST', cookie: c2, corpo: { nome: 'Com segredo', url: 'https://a.com/mcp', segredo: 'x' } });
      expect(semChave.corpo.erro).toBe('sem_chave_de_criptografia');
    });

    it('testa a Fonte, lista as ferramentas (escrita desligada) e deixa ligar e desligar cada uma', async () => {
      const cookie = await entrar(1);
      const { corpo: nova } = await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'Urna', url: 'https://a.com/mcp', segredo: 'tok' } });

      const t = await chamar(`/fontes/${nova.id}/testar`, { metodo: 'POST', cookie });
      expect(t.corpo).toMatchObject({ ok: true, ferramentas: 2, fonte: { status: 'ok' } });
      const ferramentas = Object.fromEntries(t.corpo.fonte.ferramentas.map((f: any) => [f.nome, f.ativa]));
      expect(ferramentas).toEqual({ apagar_dados: false, buscar_votos: true });

      expect((await chamar(`/fontes/${nova.id}/ferramentas/apagar_dados`, { metodo: 'PATCH', cookie, corpo: { ativa: true } })).status).toBe(200);
      const lista = (await chamar('/fontes', { cookie })).corpo[0].ferramentas;
      expect(lista.find((f: any) => f.nome === 'apagar_dados').ativa).toBe(true);
    });

    it('sem ENCRYPTION_KEY, Fonte sem segredo testa normalmente e Fonte com segredo explica o que falta', async () => {
      await new Promise((ok) => server.close(ok));
      comChave = false;
      await subir();
      const cookie = await entrar(1);
      const { corpo: aberta } = await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'Aberta', url: 'https://a.com/mcp' } });
      expect((await chamar(`/fontes/${aberta.id}/testar`, { metodo: 'POST', cookie })).corpo).toMatchObject({ ok: true, ferramentas: 2 });

      await db.query(`insert into fontes (workspace_id, tipo, nome, config, segredo_enc) values (1, 'mcp', 'Com segredo', '{"url":"https://b.com/mcp"}', $1)`, [
        (await import('./cripto')).cifrar('tok', CHAVE),
      ]);
      const id = (await db.query<{ id: number }>(`select id from fontes where nome = 'Com segredo'`)).rows[0].id;
      const t = await chamar(`/fontes/${id}/testar`, { metodo: 'POST', cookie });
      expect(t.corpo).toMatchObject({ ok: false });
      expect(t.corpo.erro).toContain('ENCRYPTION_KEY');
    });

    it('teste que falha mostra o erro e deixa a Fonte fora do ar', async () => {
      conectar = async () => {
        throw new Error('connect ECONNREFUSED');
      };
      const cookie = await entrar(1);
      const { corpo: nova } = await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'Urna', url: 'https://a.com/mcp' } });
      const t = await chamar(`/fontes/${nova.id}/testar`, { metodo: 'POST', cookie });
      expect(t.corpo).toMatchObject({ ok: false, erro: 'connect ECONNREFUSED', fonte: { status: 'erro', ultimoErro: 'connect ECONNREFUSED' } });
    });

    it('trocar o endereço ou o segredo invalida o último teste; apagar o segredo funciona', async () => {
      const cookie = await entrar(1);
      const { corpo: nova } = await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'Urna', url: 'https://a.com/mcp', segredo: 'tok' } });
      await chamar(`/fontes/${nova.id}/testar`, { metodo: 'POST', cookie });
      const p = await chamar(`/fontes/${nova.id}`, { metodo: 'PATCH', cookie, corpo: { url: 'https://b.com/mcp' } });
      expect(p.corpo).toMatchObject({ url: 'https://b.com/mcp', status: 'nunca_testada', temSegredo: true });
      const q = await chamar(`/fontes/${nova.id}`, { metodo: 'PATCH', cookie, corpo: { segredo: '' } });
      expect(q.corpo.temSegredo).toBe(false);
      const r = await chamar(`/fontes/${nova.id}`, { metodo: 'PATCH', cookie, corpo: { nome: 'Urna TSE', ativa: false, quandoUsar: 'votos' } });
      expect(r.corpo).toMatchObject({ nome: 'Urna TSE', ativa: false, quandoUsar: 'votos' });
    });

    it('apaga a Fonte e não mexe na de outro tenant', async () => {
      const cookieA = await entrar(1);
      const cookieB = await entrar(2, '5511999990000');
      const { corpo: doB } = await chamar('/fontes', { metodo: 'POST', cookie: cookieB, corpo: { nome: 'Do B', url: 'https://b.com/mcp' } });
      expect((await chamar(`/fontes/${doB.id}`, { metodo: 'DELETE', cookie: cookieA })).status).toBe(404);
      expect((await chamar(`/fontes/${doB.id}`, { metodo: 'PATCH', cookie: cookieA, corpo: { nome: 'Invadida' } })).status).toBe(404);
      expect((await chamar(`/fontes/${doB.id}/testar`, { metodo: 'POST', cookie: cookieA })).status).toBe(404);
      expect((await chamar(`/fontes/${doB.id}/ferramentas/x`, { metodo: 'PATCH', cookie: cookieA, corpo: { ativa: true } })).status).toBe(404);
      expect((await chamar(`/fontes/${doB.id}`, { metodo: 'DELETE', cookie: cookieB })).status).toBe(200);
    });

    it('quem é "head" lê as Fontes mas não mexe', async () => {
      const cookie = await entrar(1);
      await db.query(`update usuario_workspaces set papel = 'head'`);
      expect((await chamar('/fontes', { cookie })).status).toBe(200);
      const r = await chamar('/fontes', { metodo: 'POST', cookie, corpo: { nome: 'X', url: 'https://a.com/mcp' } });
      expect(r.status).toBe(403);
      expect((await chamar('/pessoas/1', { metodo: 'PATCH', cookie, corpo: { papel: 'head' } })).status).toBe(403);
    });
  });

  describe('Grupos e Pessoas', () => {
    it('lista os grupos com o total de mensagens e muda acompanhar e intervalo', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'IE')`);
      await db.query(`insert into mensagens (workspace_id, grupo_id, wa_message_id, enviada_em, texto) values (1, 1, 'M1', now(), 'oi'), (1, 1, 'M2', now(), 'tchau')`);
      const g = (await chamar('/grupos', { cookie })).corpo[0];
      expect(g).toMatchObject({ nome: 'IE', acompanhar: false, intervaloMin: 60, mensagens: 2 });

      expect((await chamar(`/grupos/${g.id}`, { metodo: 'PATCH', cookie, corpo: { acompanhar: true, intervaloMin: 30 } })).status).toBe(200);
      expect((await chamar('/grupos', { cookie })).corpo[0]).toMatchObject({ acompanhar: true, intervaloMin: 30 });
    });

    it('recusa intervalo curto demais e pedido vazio; head pode mexer em grupo', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'IE')`);
      expect((await chamar('/grupos/1', { metodo: 'PATCH', cookie, corpo: { intervaloMin: 2 } })).status).toBe(400);
      expect((await chamar('/grupos/1', { metodo: 'PATCH', cookie, corpo: {} })).status).toBe(400);
      await db.query(`update usuario_workspaces set papel = 'head'`);
      expect((await chamar('/grupos/1', { metodo: 'PATCH', cookie, corpo: { acompanhar: true } })).status).toBe(200);
    });

    it('só o administrador escolhe o Grupo dos Heads; o Head comum não', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'IE'), (1, '2@g.us', 'Heads')`);
      expect((await chamar('/grupos/2', { metodo: 'PATCH', cookie, corpo: { grupoDosHeads: true } })).status).toBe(200);
      const g = (await chamar('/grupos', { cookie })).corpo;
      expect(g.find((x: any) => x.nome === 'Heads').grupoDosHeads).toBe(true);
      expect(g.find((x: any) => x.nome === 'IE').grupoDosHeads).toBe(false);

      await db.query(`update usuario_workspaces set papel = 'head'`);
      expect((await chamar('/grupos/1', { metodo: 'PATCH', cookie, corpo: { grupoDosHeads: true } })).status).toBe(403);
      expect((await chamar('/grupos/1', { metodo: 'PATCH', cookie, corpo: { acompanhar: true } })).status).toBe(200);
    });

    it('o admin define papel e quem pode comandar; o telefone é guardado só com dígitos', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into pessoas (workspace_id, nome, papel) values (1, 'Fulano', 'outro')`);
      const id = (await chamar('/pessoas', { cookie })).corpo[0].id;
      const r = await chamar(`/pessoas/${id}`, { metodo: 'PATCH', cookie, corpo: { papel: 'head', podeComandar: true, telefone: '+55 (16) 99648-0805' } });
      expect(r.status).toBe(200);
      expect((await chamar('/pessoas', { cookie })).corpo[0]).toMatchObject({ papel: 'head', podeComandar: true, telefone: '5516996480805' });
      expect((await chamar(`/pessoas/${id}`, { metodo: 'PATCH', cookie, corpo: { papel: 'chefao' } })).status).toBe(400);
    });
  });

  describe('Diagnóstico e alertas', () => {
    it('resume o que a Poli tem e o que está pendente', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into instancias_wa (workspace_id, evolution_instance, jid_proprio, nome_perfil) values (1, 'poli', '5596900000000@s.whatsapp.net', 'MapSolar')`);
      await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'IE')`);
      await db.query(`insert into mensagens (workspace_id, grupo_id, wa_message_id, enviada_em, texto) values (1, 1, 'M1', now(), 'oi')`);
      await db.query(`insert into turnos (workspace_id, pergunta, tools, resposta, latencia_ms) values (1, 'link do plano', '["buscar_itens"]', 'x', 1200)`);
      const d = (await chamar('/diagnostico', { cookie })).corpo;
      expect(d.instancia).toEqual({ nome: 'poli', nomePerfil: 'MapSolar', numeroConhecido: true, lidConhecido: false, estadoConexao: null, estadoEm: null });
      expect(d.totais).toMatchObject({ mensagens: 1, grupos: 1, itens: 0 });
      expect(d.extracaoPendente).toBe(1);
      expect(d.ultimosTurnos[0]).toMatchObject({ pergunta: 'link do plano', ferramentas: ['buscar_itens'], respondido: true });
      expect(JSON.stringify(d)).not.toContain('5596900000000');
    });

    it('mostra o estado da conexão e as últimas leituras (o que a Poli concluiu), só do tenant', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into instancias_wa (workspace_id, evolution_instance, estado_conexao, estado_em) values (1, 'poli', 'open', now())`);
      await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'IE'), (2, '2@g.us', 'Do outro')`);
      await db.query(`insert into resumos (workspace_id, grupo_id, de_msg_id, ate_msg_id, de_em, ate_em, texto, importancia)
        values (1, 1, 1, 5, now(), now(), 'Falaram do boato.', 3), (2, 2, 1, 5, now(), now(), 'Segredo do outro tenant.', 2)`);
      const d = (await chamar('/diagnostico', { cookie })).corpo;
      expect(d.instancia).toMatchObject({ estadoConexao: 'open' });
      expect(d.ultimasLeituras).toHaveLength(1);
      expect(d.ultimasLeituras[0]).toMatchObject({ grupo: 'IE', importancia: 3, resumo: 'Falaram do boato.' });
      expect(JSON.stringify(d)).not.toContain('Segredo do outro tenant');
    });

    it('mostra os alertas esperando envio, os que desistiram e os que ficaram sem destino', async () => {
      const cookie = await entrar(1);
      await db.query(`insert into grupos (workspace_id, jid, nome, acompanhar) values (1, '1@g.us', 'IE', true)`);
      await db.query(`insert into alertas (workspace_id, grupo_id, severidade, texto, dedupe_key) values (1, 1, 3, 'a', 'k1'), (1, 1, 2, 'b', 'k2')`);
      await db.query(`insert into mensagens_saida (workspace_id, destino_jid, destino_tipo, origem, alerta_id, texto, estado)
        values (1, '5516996480805', 'privado', 'alerta', 1, 'x', 'pendente'), (1, '5596999990002', 'privado', 'alerta', 1, 'x', 'falhou')`);
      const d = (await chamar('/diagnostico', { cookie })).corpo;
      // O alerta 2 não tem nenhuma mensagem de saída: ficou sem destino.
      expect(d.alertas).toEqual({ pendentesDeEnvio: 1, falhasDeEnvio: 1, semDestino: 1, gruposAcompanhados: 1 });
    });

    it('lista alertas do tenant (vazio por enquanto)', async () => {
      const cookie = await entrar(1);
      expect((await chamar('/alertas', { cookie })).corpo).toEqual([]);
    });
  });

  it('rota inexistente e JSON quebrado respondem com erro claro', async () => {
    const cookie = await entrar(1);
    expect((await chamar('/nao-existe', { cookie })).status).toBe(404);
    const res = await fetch(`${base}/fontes`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{quebrado' });
    expect(res.status).toBe(400);
  });
});

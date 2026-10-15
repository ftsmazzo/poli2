import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { carregarSessao, consumirLink } from '../painel/auth';
import { entregarLinkDoPainel, ehPedidoDePainel } from './painel';
import type { Pedido } from './pedido';

describe('ehPedidoDePainel', () => {
  it('reconhece os jeitos de pedir o painel', () => {
    for (const t of ['painel', 'Painel!', 'me manda o link do painel', 'abrir o painel', 'acesso ao painel', 'dashboard', 'quero o painel', 'link do painel', 'login', 'Painel da Poli']) {
      expect(ehPedidoDePainel(t), t).toBe(true);
    }
  });

  it('não confunde com pergunta comum que cita a palavra', () => {
    for (const t of ['qual o painel solar de fulano?', 'resume o painel de ontem', 'painel solar', 'quem mexeu no painel do Zé', 'link do plano', 'oi']) {
      expect(ehPedidoDePainel(t), t).toBe(false);
    }
  });
});

describe('entregarLinkDoPainel', () => {
  let db: PGlite;
  let enviados: { destino: string; texto: string }[];
  const pedido = (extra: Partial<Pedido> = {}): Pedido => ({
    workspaceId: 1,
    instancia: 'poli',
    grupoJid: '1203@g.us',
    grupoNome: 'IE',
    autorNome: 'Dono',
    consulta: 'painel',
    waMessageId: 'P1',
    telefoneAutor: '5511912345678',
    ...extra,
  });
  const deps = (falharNo?: string) => ({
    db,
    urlBase: 'https://poli.exemplo.com/',
    enviar: async (_i: string, destino: string, texto: string) => {
      if (destino === falharNo) throw new Error('Evolution respondeu 400');
      enviados.push({ destino, texto });
      return { waMessageId: null };
    },
  });

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    enviados = [];
  });

  it('manda o link no privado de quem pediu e só avisa no grupo, sem o link', async () => {
    expect(await entregarLinkDoPainel(deps(), pedido())).toBe('enviado');
    const privado = enviados.find((e) => e.destino === '5511912345678')!;
    const grupo = enviados.find((e) => e.destino === '1203@g.us')!;
    expect(privado.texto).toMatch(/^Seu acesso ao painel da Poli .*\nhttps:\/\/poli\.exemplo\.com\/entrar\?t=[A-Za-z0-9_-]{40,}$/s);
    expect(grupo.texto).toBe('Mandei o link do painel no seu privado.');
    expect(grupo.texto).not.toContain('entrar?t=');
  });

  it('o link enviado entra no painel como a pessoa que pediu', async () => {
    await entregarLinkDoPainel(deps(), pedido());
    const token = /entrar\?t=([A-Za-z0-9_-]+)/.exec(enviados[0].texto)![1];
    expect(await consumirLink(db, token)).toBeTruthy();
    const u = await db.query<{ telefone: string }>('select telefone from usuarios');
    expect(u.rows).toEqual([{ telefone: '5511912345678' }]);
  });

  it('o banco guarda só a marca do envio, nunca o endereço com o token', async () => {
    await entregarLinkDoPainel(deps(), pedido());
    const s = await db.query<{ texto: string }>('select texto from mensagens_saida order by id');
    expect(JSON.stringify(s.rows)).not.toContain('entrar?t=');
    expect(s.rows.map((x) => x.texto)).toContain('[link de acesso ao painel]');
  });

  it('se o privado falhar, avisa no grupo sem o link e registra a falha', async () => {
    expect(await entregarLinkDoPainel(deps('5511912345678'), pedido())).toBe('falhou');
    expect(enviados).toHaveLength(1);
    expect(enviados[0].destino).toBe('1203@g.us');
    expect(enviados[0].texto).not.toContain('entrar?t=');
    const s = await db.query<{ estado: string }>(`select estado from mensagens_saida where destino_tipo = 'privado'`);
    expect(s.rows).toEqual([{ estado: 'falhou' }]);
  });

  it('o papel do link acompanha quem pediu: administrador só o mantenedor; os demais entram como head', async () => {
    await entregarLinkDoPainel(deps(), pedido({ papelNoPainel: 'admin' }));
    await entregarLinkDoPainel(deps(), pedido({ papelNoPainel: 'head', waMessageId: 'P2' }));
    await entregarLinkDoPainel(deps(), pedido({ waMessageId: 'P3' }));
    const r = await db.query<{ papel: string }>('select papel from login_links order by id');
    expect(r.rows.map((x) => x.papel)).toEqual(['admin', 'head', 'head']);

    const token = /entrar\?t=([A-Za-z0-9_-]+)/.exec(enviados.find((e) => e.destino === '5511912345678')!.texto)![1];
    const sessao = (await consumirLink(db, token))!;
    expect((await carregarSessao(db, sessao))?.workspaces[0].papel).toBe('admin');
  });

  it('sem número do autor, não gera link', async () => {
    expect(await entregarLinkDoPainel(deps(), pedido({ telefoneAutor: null }))).toBe('falhou');
    expect((await db.query<{ n: string }>('select count(*)::text as n from login_links')).rows[0].n).toBe('0');
  });
});

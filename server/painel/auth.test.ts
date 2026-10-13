import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import {
  VALIDADE_LINK_MS,
  VALIDADE_SESSAO_MS,
  carregarSessao,
  consumirLink,
  criarLinkDeLogin,
  encerrarSessao,
} from './auth';

const TEL = '5516996480805';

describe('login por link', () => {
  let db: PGlite;
  const t0 = new Date('2026-10-13T12:00:00Z');
  const depois = (ms: number) => new Date(t0.getTime() + ms);

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A'), ('Tenant B')`);
  });

  it('o link vira uma sessão que enxerga o tenant, como administrador', async () => {
    const link = await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0);
    const sessao = await consumirLink(db, link, depois(60_000));
    expect(sessao).toBeTruthy();
    const s = await carregarSessao(db, sessao!, depois(120_000));
    expect(s).toMatchObject({ telefone: TEL, workspaces: [{ id: 1, nome: 'Tenant A', papel: 'admin' }] });
  });

  it('só o hash vai para o banco: nem o link nem a sessão aparecem em texto', async () => {
    const link = await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0);
    const sessao = (await consumirLink(db, link, depois(1000)))!;
    const guardado = JSON.stringify([
      (await db.query('select * from login_links')).rows,
      (await db.query('select * from sessoes')).rows,
    ]);
    expect(guardado).not.toContain(link);
    expect(guardado).not.toContain(sessao);
  });

  it('o link vale uma vez só, mesmo se dois cliques chegarem ao mesmo tempo', async () => {
    const link = await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0);
    const [a, b] = await Promise.all([consumirLink(db, link, depois(1000)), consumirLink(db, link, depois(1000))]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await consumirLink(db, link, depois(2000))).toBeNull();
  });

  it('o link expira em 15 minutos', async () => {
    const link = await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0);
    expect(await consumirLink(db, link, depois(VALIDADE_LINK_MS + 1))).toBeNull();
    const outro = await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0);
    expect(await consumirLink(db, outro, depois(VALIDADE_LINK_MS - 1000))).toBeTruthy();
  });

  it('recusa link inventado', async () => {
    expect(await consumirLink(db, 'token-que-nao-existe', t0)).toBeNull();
    expect(await carregarSessao(db, 'sessao-que-nao-existe', t0)).toBeNull();
  });

  it('a sessão expira em 30 dias e sai ao encerrar', async () => {
    const sessao = (await consumirLink(db, await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0), t0))!;
    expect(await carregarSessao(db, sessao, depois(VALIDADE_SESSAO_MS + 1000))).toBeNull();
    expect(await carregarSessao(db, sessao, depois(1000))).toBeTruthy();
    await encerrarSessao(db, sessao);
    expect(await carregarSessao(db, sessao, depois(2000))).toBeNull();
  });

  it('o mesmo telefone em dois tenants é um usuário só, com os dois tenants', async () => {
    const a = (await consumirLink(db, await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0), t0))!;
    await consumirLink(db, await criarLinkDeLogin(db, { workspaceId: 2, telefone: TEL }, t0), t0);
    const s = await carregarSessao(db, a, depois(1000));
    expect(s?.workspaces.map((w) => w.id)).toEqual([1, 2]);
    expect((await db.query<{ n: string }>('select count(*)::text as n from usuarios')).rows[0].n).toBe('1');
  });

  it('usuário desativado não entra', async () => {
    const sessao = (await consumirLink(db, await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0), t0))!;
    await db.query('update usuarios set ativo = false');
    expect(await carregarSessao(db, sessao, depois(1000))).toBeNull();
  });

  it('usa o nome da pessoa já conhecida pelo telefone', async () => {
    await db.query(`insert into pessoas (workspace_id, nome, telefone, papel) values (1, 'Frederico', '${TEL}', 'head')`);
    const sessao = (await consumirLink(db, await criarLinkDeLogin(db, { workspaceId: 1, telefone: TEL }, t0), t0))!;
    expect((await carregarSessao(db, sessao, depois(1000)))?.nome).toBe('Frederico');
  });
});

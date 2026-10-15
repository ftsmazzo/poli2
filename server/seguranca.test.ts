import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { cabecalhosDeSeguranca, limitarTentativas } from './seguranca';

describe('segurança do servidor', () => {
  let server: Server;
  const subir = async (app: express.Express) => {
    await new Promise<void>((ok) => {
      server = app.listen(0, () => ok());
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  afterEach(async () => {
    await new Promise((ok) => server.close(ok));
  });

  it('põe os cabeçalhos que fecham o Referer, o clickjacking e a adivinhação de tipo', async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(cabecalhosDeSeguranca);
    app.get('/', (_req, res) => res.send('ok'));
    const r = await fetch(await subir(app));
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('strict-transport-security')).toContain('max-age=');
    expect(r.headers.get('x-powered-by')).toBeNull();
  });

  it('limita as tentativas por endereço e libera quando a janela passa', async () => {
    let agora = 1_000_000;
    const app = express();
    app.use(limitarTentativas({ janelaMs: 60_000, max: 3 }, () => agora));
    app.post('/entrar', (_req, res) => res.json({ ok: true }));
    const url = `${await subir(app)}/entrar`;

    for (let i = 0; i < 3; i++) expect((await fetch(url, { method: 'POST' })).status).toBe(200);
    const bloqueada = await fetch(url, { method: 'POST' });
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.headers.get('retry-after')).toBe('60');
    expect(await bloqueada.json()).toEqual({ erro: 'muitas_tentativas' });

    agora += 60_001;
    expect((await fetch(url, { method: 'POST' })).status).toBe(200);
  });

  it('cada endereço tem o seu limite (usa o endereço que o proxy informa)', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(limitarTentativas({ janelaMs: 60_000, max: 1 }));
    app.post('/entrar', (_req, res) => res.json({ ok: true }));
    const url = `${await subir(app)}/entrar`;
    const de = (ip: string) => fetch(url, { method: 'POST', headers: { 'x-forwarded-for': ip } });
    expect((await de('203.0.113.1')).status).toBe(200);
    expect((await de('203.0.113.1')).status).toBe(429);
    expect((await de('203.0.113.2')).status).toBe(200);
  });
});

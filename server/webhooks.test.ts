import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from './migrate';
import { webhookRouter, type AoReceberPrivado } from './webhooks';

const TOKEN = 'token-de-teste';
const GRUPO = '120363000000000000@g.us';

function corpo(id = 'M1') {
  return {
    event: 'MESSAGES_UPSERT',
    instance: 'inst-a',
    data: {
      key: { remoteJid: GRUPO, fromMe: false, id, participant: '5596999990000@s.whatsapp.net' },
      pushName: 'Teste',
      message: { conversation: 'rua das flores, 10' },
      messageTimestamp: 1790000000,
    },
  };
}

describe('webhook da Evolution', () => {
  let db: PGlite;
  let server: Server;
  let base: string;

  async function subir(token: string | undefined, comBanco = true, aoPrivado?: AoReceberPrivado) {
    const app = express();
    app.use('/webhooks', webhookRouter(() => (comBanco ? db : undefined), token, undefined, aoPrivado));
    await new Promise<void>((ok) => {
      server = app.listen(0, () => ok());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/evolution/inst-a`;
  }

  const enviar = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance) values (1, 'inst-a')`);
  });

  afterEach(async () => {
    await new Promise((ok) => server.close(ok));
  });

  it('recusa sem token e não grava nada', async () => {
    await subir(TOKEN);
    expect((await enviar(corpo())).status).toBe(401);
    expect((await enviar(corpo(), { 'x-webhook-token': 'errado' })).status).toBe(401);
    const r = await db.query<{ n: string }>('select count(*)::text as n from mensagens');
    expect(r.rows[0].n).toBe('0');
  });

  it('fica fechado quando o token não está configurado', async () => {
    await subir(undefined);
    expect((await enviar(corpo(), { 'x-webhook-token': '' })).status).toBe(503);
  });

  it('responde 503 se o banco ainda não está pronto', async () => {
    await subir(TOKEN, false);
    expect((await enviar(corpo(), { 'x-webhook-token': TOKEN })).status).toBe(503);
  });

  it('grava com o token certo e reconhece o reenvio', async () => {
    await subir(TOKEN);
    const h = { 'x-webhook-token': TOKEN };
    const primeira = await enviar(corpo(), h);
    expect(primeira.status).toBe(200);
    expect(await primeira.json()).toMatchObject({ gravadas: 1, duplicadas: 0 });
    const segunda = await enviar(corpo(), h);
    expect(await segunda.json()).toMatchObject({ gravadas: 0, duplicadas: 1 });
  });

  it('aceita uma lista de mensagens no mesmo envio', async () => {
    await subir(TOKEN);
    const lista = { ...corpo(), data: [corpo('A').data, corpo('B').data] };
    const r = await enviar(lista, { 'x-webhook-token': TOKEN });
    expect(await r.json()).toMatchObject({ gravadas: 2 });
  });

  it('ignora outros eventos com 200, para a Evolution não reenviar', async () => {
    await subir(TOKEN);
    const r = await enviar({ event: 'CONNECTION_UPDATE', data: {} }, { 'x-webhook-token': TOKEN });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ignorado: 'evento' });
  });

  it('mensagem privada vai para o atendimento e não é gravada', async () => {
    const recebidas: string[] = [];
    await subir(TOKEN, true, async (instancia, dm) => {
      recebidas.push(`${instancia}|${dm.contatoJid}|${dm.texto}`);
    });
    const privada = {
      event: 'MESSAGES_UPSERT',
      data: { key: { remoteJid: '5516998480805@s.whatsapp.net', fromMe: false, id: 'P1' }, pushName: 'Dono', message: { conversation: 'oi poli' }, messageTimestamp: 1790000000 },
    };
    expect((await enviar(privada, { 'x-webhook-token': TOKEN })).status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(recebidas).toEqual(['inst-a|5516998480805@s.whatsapp.net|oi poli']);
    expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens')).rows[0].n).toBe('0');
    expect((await db.query<{ n: string }>('select count(*)::text as n from grupos')).rows[0].n).toBe('0');
  });

  it('o que a própria Poli enviou no privado não vai para o atendimento', async () => {
    const recebidas: string[] = [];
    await subir(TOKEN, true, async (_i, dm) => {
      recebidas.push(dm.texto);
    });
    const dela = {
      event: 'MESSAGES_UPSERT',
      data: { key: { remoteJid: '5516998480805@s.whatsapp.net', fromMe: true, id: 'P2' }, message: { conversation: 'resposta' }, messageTimestamp: 1790000000 },
    };
    await enviar(dela, { 'x-webhook-token': TOKEN });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(recebidas).toEqual([]);
  });
});

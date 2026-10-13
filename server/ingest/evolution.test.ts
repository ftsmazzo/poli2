import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairMensagem, gravarMensagem, normalizarEvento } from './evolution';

const GRUPO = '120363000000000000@g.us';
const AUTOR = '5596999990000@s.whatsapp.net';

function upsert(extra: Record<string, unknown> = {}, message: Record<string, unknown> = { conversation: 'oi' }) {
  return {
    key: { remoteJid: GRUPO, fromMe: false, id: 'ABC123', participant: AUTOR },
    pushName: 'Teste',
    message,
    messageType: 'conversation',
    messageTimestamp: 1790000000,
    ...extra,
  };
}

describe('normalizarEvento', () => {
  it('aceita os dois formatos da Evolution', () => {
    expect(normalizarEvento('MESSAGES_UPSERT')).toBe('messages.upsert');
    expect(normalizarEvento('messages.upsert')).toBe('messages.upsert');
  });
});

describe('extrairMensagem', () => {
  it('lê texto simples com a hora real', () => {
    const m = extrairMensagem(upsert());
    expect(m?.tipo).toBe('texto');
    expect(m?.texto).toBe('oi');
    expect(m?.enviadaEm.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it('aceita timestamp em texto, em Long e em milissegundos', () => {
    expect(extrairMensagem(upsert({ messageTimestamp: '1790000000' }))?.enviadaEm.getTime()).toBe(1790000000000);
    expect(extrairMensagem(upsert({ messageTimestamp: { low: 1790000000, high: 0 } }))?.enviadaEm.getTime()).toBe(1790000000000);
    expect(extrairMensagem(upsert({ messageTimestamp: 1790000000000 }))?.enviadaEm.getTime()).toBe(1790000000000);
  });

  it('ignora privado, sem id, sem hora e reação', () => {
    expect(extrairMensagem(upsert({ key: { remoteJid: '5596999990000@s.whatsapp.net', id: 'X' } }))).toBeNull();
    expect(extrairMensagem(upsert({ key: { remoteJid: GRUPO } }))).toBeNull();
    expect(extrairMensagem(upsert({ messageTimestamp: undefined }))).toBeNull();
    expect(extrairMensagem(upsert({}, { reactionMessage: { text: '👍' } }))).toBeNull();
  });

  it('guarda o vCard no texto para o extrator de contatos', () => {
    const vcard = 'BEGIN:VCARD\nFN:Fulano\nTEL:+5596999990001\nEND:VCARD';
    const m = extrairMensagem(upsert({}, { contactMessage: { displayName: 'Fulano', vcard } }));
    expect(m?.tipo).toBe('contato');
    expect(m?.texto).toContain('TEL:+5596999990001');
  });

  it('lê a legenda de imagem e o nome do documento', () => {
    expect(extrairMensagem(upsert({}, { imageMessage: { caption: 'cartaz' } }))?.texto).toBe('cartaz');
    expect(extrairMensagem(upsert({}, { documentMessage: { fileName: 'plano.pdf' } }))?.texto).toBe('plano.pdf');
  });

  it('desembrulha mensagem efêmera', () => {
    const m = extrairMensagem(upsert({}, { ephemeralMessage: { message: { conversation: 'secreto' } } }));
    expect(m?.texto).toBe('secreto');
  });

  it('guarda o id da mensagem citada', () => {
    const m = extrairMensagem(upsert({}, { extendedTextMessage: { text: 'resposta', contextInfo: { stanzaId: 'ORIG1' } } }));
    expect(m?.citadaWaId).toBe('ORIG1');
  });

  it('remove base64 do payload bruto', () => {
    const m = extrairMensagem(upsert({}, { imageMessage: { caption: 'x', base64: 'AAAA'.repeat(1000) } }));
    expect(JSON.stringify(m?.bruto)).not.toContain('AAAA');
  });
});

describe('gravarMensagem', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A'), ('Tenant B')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance) values (1, 'inst-a'), (2, 'inst-b')`);
  });

  it('grava uma vez e reconhece o reenvio do webhook', async () => {
    const msg = extrairMensagem(upsert())!;
    expect(await gravarMensagem(db, 'inst-a', msg)).toBe('gravada');
    expect(await gravarMensagem(db, 'inst-a', msg)).toBe('duplicada');
    const r = await db.query<{ n: string }>('select count(*)::text as n from mensagens');
    expect(r.rows[0].n).toBe('1');
  });

  it('guarda a hora real do WhatsApp, não a de chegada', async () => {
    await gravarMensagem(db, 'inst-a', extrairMensagem(upsert())!);
    const r = await db.query<{ enviada_em: string; recebida_em: string }>('select enviada_em, recebida_em from mensagens');
    expect(new Date(r.rows[0].enviada_em).getTime()).toBe(1790000000000);
    expect(new Date(r.rows[0].recebida_em).getTime()).not.toBe(1790000000000);
  });

  it('cria grupo e pessoa como "outro", sem dar papel automático', async () => {
    await gravarMensagem(db, 'inst-a', extrairMensagem(upsert())!);
    const g = await db.query<{ jid: string; acompanhar: boolean }>('select jid, acompanhar from grupos');
    expect(g.rows).toEqual([{ jid: GRUPO, acompanhar: false }]);
    const p = await db.query<{ papel: string; pode_comandar: boolean; nome: string }>('select papel, pode_comandar, nome from pessoas');
    expect(p.rows).toEqual([{ papel: 'outro', pode_comandar: false, nome: 'Teste' }]);
  });

  it('não grava instância desconhecida', async () => {
    expect(await gravarMensagem(db, 'nao-existe', extrairMensagem(upsert())!)).toBe('instancia_desconhecida');
    const r = await db.query<{ n: string }>('select count(*)::text as n from mensagens');
    expect(r.rows[0].n).toBe('0');
  });

  it('isola os tenants: a mesma mensagem em duas instâncias vira duas linhas, cada uma no seu tenant', async () => {
    const msg = extrairMensagem(upsert())!;
    expect(await gravarMensagem(db, 'inst-a', msg)).toBe('gravada');
    expect(await gravarMensagem(db, 'inst-b', msg)).toBe('gravada');
    const r = await db.query<{ workspace_id: number }>('select workspace_id from mensagens order by workspace_id');
    expect(r.rows.map((x) => x.workspace_id)).toEqual([1, 2]);
    const g = await db.query<{ workspace_id: number }>('select workspace_id from grupos order by workspace_id');
    expect(g.rows.map((x) => x.workspace_id)).toEqual([1, 2]);
  });

  it('o autor sem nome novo não apaga o nome já conhecido', async () => {
    await gravarMensagem(db, 'inst-a', extrairMensagem(upsert())!);
    await gravarMensagem(db, 'inst-a', extrairMensagem(upsert({ pushName: undefined, key: { remoteJid: GRUPO, id: 'OUTRA', participant: AUTOR } }))!);
    const p = await db.query<{ nome: string }>('select nome from pessoas');
    expect(p.rows[0].nome).toBe('Teste');
  });
});

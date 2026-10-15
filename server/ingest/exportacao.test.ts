import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { strToU8, zipSync } from 'fflate';
import { migrate } from '../migrate';
import { extrairTextoExportacao, importarExportacao, parseExportacao, pareceExportacao } from './exportacao';

const ANDROID = [
  '12/10/2026 09:00 - As mensagens e ligações são protegidas com a criptografia de ponta a ponta.',
  '12/10/2026 09:01 - Fulano: bom dia, pessoal',
  '12/10/2026 09:02 - Beltrano: o endereço é Rua das Flores, 10',
  'perto da praça central',
  '12/10/2026 09:03 - Fulano: <Mídia oculta>',
  '12/10/2026 09:04 - Beltrano: IMG-20261012-WA0001.jpg (arquivo anexado)',
  '12/10/2026 09:05 - Fulano: Esta mensagem foi apagada',
  '12/10/2026 09:06 - Beltrano entrou usando o link de convite',
].join('\n');

const IPHONE = [
  '‎[12/10/2026 14:35:20] Fulano: tudo certo?',
  '‎[12/10/2026 14:36:05] Beltrano: ‎<anexado: 00000012-PHOTO-2026-10-12.jpg>',
].join('\n');

describe('parseExportacao', () => {
  it('lê o formato Android, junta linhas e ignora avisos do sistema', () => {
    const l = parseExportacao(ANDROID);
    expect(l.map((x) => [x.autor, x.texto, x.tipo])).toEqual([
      ['Fulano', 'bom dia, pessoal', 'texto'],
      ['Beltrano', 'o endereço é Rua das Flores, 10\nperto da praça central', 'texto'],
      ['Fulano', null, 'outro'],
      ['Beltrano', 'IMG-20261012-WA0001.jpg', 'imagem'],
    ]);
  });

  it('interpreta data e hora como horário de Brasília (UTC-3)', () => {
    const [primeira] = parseExportacao(ANDROID);
    expect(primeira.enviadaEm.toISOString()).toBe('2026-10-12T12:01:00.000Z');
  });

  it('lê o formato iPhone, com segundos e caracteres invisíveis', () => {
    const l = parseExportacao(IPHONE);
    expect(l).toHaveLength(2);
    expect(l[0].texto).toBe('tudo certo?');
    expect(l[0].enviadaEm.toISOString()).toBe('2026-10-12T17:35:20.000Z');
    expect(l[1]).toMatchObject({ autor: 'Beltrano', texto: '00000012-PHOTO-2026-10-12.jpg', tipo: 'imagem' });
  });

  it('aceita ano com dois dígitos e BOM no início', () => {
    const l = parseExportacao('﻿12/10/26 09:01 - Fulano: oi');
    expect(l[0].enviadaEm.toISOString()).toBe('2026-10-12T12:01:00.000Z');
  });

  it('devolve vazio para texto que não é exportação', () => {
    expect(parseExportacao('qualquer coisa\noutra linha')).toEqual([]);
  });
});

describe('pareceExportacao e extrairTextoExportacao', () => {
  it('reconhece os nomes que o WhatsApp gera', () => {
    expect(pareceExportacao('Conversa do WhatsApp com Inteligência Eleitoral.zip')).toBe(true);
    expect(pareceExportacao('WhatsApp Chat - Grupo.zip')).toBe(true);
    expect(pareceExportacao('plano-de-campanha.pdf')).toBe(false);
    expect(pareceExportacao('relatorio.zip')).toBe(false);
    expect(pareceExportacao(null)).toBe(false);
  });

  it('abre o .zip e lê só o texto, ignorando as fotos', () => {
    const zip = zipSync({
      'Conversa do WhatsApp com Grupo A.txt': strToU8('12/10/2026 09:01 - Fulano: oi'),
      'IMG-1.jpg': new Uint8Array(5000).fill(7),
    });
    expect(extrairTextoExportacao(zip)).toContain('Fulano: oi');
  });

  it('aceita o .txt direto e devolve null para zip sem texto', () => {
    expect(extrairTextoExportacao(strToU8('12/10/2026 09:01 - Fulano: oi'))).toContain('oi');
    expect(extrairTextoExportacao(zipSync({ 'foto.jpg': new Uint8Array(10) }))).toBeNull();
  });
});

describe('importarExportacao', () => {
  let db: PGlite;
  const params = (texto: string, ref = 'ARQ1') => ({ workspaceId: 1, grupoId: 1, grupoJid: '1203@g.us', ref, texto });

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1203@g.us', 'Grupo A')`);
  });

  it('grava as mensagens com a hora original e marca a origem', async () => {
    const r = await importarExportacao(db, params(ANDROID));
    expect(r).toEqual({ linhas: 4, gravadas: 4, jaExistiam: 0 });
    const m = await db.query<{ origem: string; importacao_ref: string; enviada_em: string }>(
      `select origem, importacao_ref, enviada_em from mensagens order by enviada_em limit 1`,
    );
    expect(m.rows[0].origem).toBe('exportacao');
    expect(m.rows[0].importacao_ref).toBe('ARQ1');
    expect(new Date(m.rows[0].enviada_em).toISOString()).toBe('2026-10-12T12:01:00.000Z');
  });

  it('é idempotente: reimportar o mesmo arquivo não duplica', async () => {
    await importarExportacao(db, params(ANDROID));
    const de_novo = await importarExportacao(db, params(ANDROID));
    expect(de_novo).toMatchObject({ gravadas: 0, jaExistiam: 4 });
    const n = await db.query<{ n: string }>('select count(*)::text as n from mensagens');
    expect(n.rows[0].n).toBe('4');
  });

  it('reconhece o que o webhook já gravou e não duplica', async () => {
    await db.query(
      `insert into mensagens (workspace_id, grupo_id, wa_message_id, enviada_em, texto)
       values (1, 1, 'REAL1', '2026-10-12T09:01:23-03:00', 'bom dia, pessoal')`,
    );
    const r = await importarExportacao(db, params(ANDROID));
    expect(r).toMatchObject({ gravadas: 3, jaExistiam: 1 });
  });

  it('mantém duas mensagens iguais no mesmo minuto como mensagens diferentes', async () => {
    const texto = ['12/10/2026 09:01 - Fulano: ok', '12/10/2026 09:01 - Fulano: ok'].join('\n');
    const r = await importarExportacao(db, params(texto));
    expect(r.gravadas).toBe(2);
    expect((await importarExportacao(db, params(texto))).gravadas).toBe(0);
  });

  it('liga o autor a quem já existe pelo nome e cria quem não existe, sem repetir', async () => {
    await db.query(
      `insert into pessoas (workspace_id, jid, nome, papel) values (1, '5596999990000@s.whatsapp.net', 'Fulano', 'head')`,
    );
    await importarExportacao(db, params(ANDROID));
    const p = await db.query<{ nome: string; papel: string }>('select nome, papel from pessoas order by id');
    expect(p.rows).toEqual([
      { nome: 'Fulano', papel: 'head' },
      { nome: 'Beltrano', papel: 'outro' },
    ]);
    const m = await db.query<{ autor_jid: string | null }>(
      `select m.autor_jid from mensagens m join pessoas p on p.id = m.autor_pessoa_id where p.nome = 'Fulano' limit 1`,
    );
    expect(m.rows[0].autor_jid).toBe('5596999990000@s.whatsapp.net');
  });

  it('ignora os avisos do sistema, que vêm com o nome do grupo como autor, e não cria "pessoa" com o nome do grupo', async () => {
    const texto = ['12/10/2026 09:00 - Grupo A: As mensagens e ligações são protegidas com a criptografia de ponta a ponta.', '12/10/2026 09:01 - Fulano: bom dia'].join('\n');
    const r = await importarExportacao(db, params(texto));
    expect(r).toMatchObject({ linhas: 1, gravadas: 1 });
    expect((await db.query<{ nome: string }>('select nome from pessoas order by id')).rows).toEqual([{ nome: 'Fulano' }]);
  });

  it('liga o autor à pessoa real de mesmo nome (a que tem número), ignorando o "~" do WhatsApp, em vez de criar outro cadastro', async () => {
    await db.query(`insert into pessoas (workspace_id, nome, papel) values (1, 'Beltrano', 'outro')`); // cadastro antigo, só pelo nome
    await db.query(`insert into pessoas (workspace_id, jid, nome, telefone, papel) values (1, '5511999990000@s.whatsapp.net', 'Beltrano', '5511999990000', 'head')`);
    const texto = ['12/10/2026 09:01 - ~Beltrano: oi', '12/10/2026 09:02 - Beltrano: tudo bem?'].join('\n');
    await importarExportacao(db, params(texto));
    const m = await db.query<{ telefone: string | null; n: string }>(
      `select p.telefone, count(*)::text as n from mensagens m join pessoas p on p.id = m.autor_pessoa_id group by p.telefone`,
    );
    expect(m.rows).toEqual([{ telefone: '5511999990000', n: '2' }]);
    expect((await db.query<{ n: string }>('select count(*)::text as n from pessoas')).rows[0].n).toBe('2');
  });

  it('autor novo entra sem o "~" no nome', async () => {
    await importarExportacao(db, params('12/10/2026 09:01 - ~Fernanda: oi'));
    expect((await db.query<{ nome: string }>('select nome from pessoas')).rows).toEqual([{ nome: 'Fernanda' }]);
  });

  it('devolve zeros para um arquivo sem mensagens', async () => {
    expect(await importarExportacao(db, params('nada aqui'))).toEqual({ linhas: 0, gravadas: 0, jaExistiam: 0 });
  });
});

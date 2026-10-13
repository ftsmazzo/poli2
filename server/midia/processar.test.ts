import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { strToU8, zipSync } from 'fflate';
import { migrate } from '../migrate';
import { extrairMensagem, gravarMensagem } from '../ingest/evolution';
import { LIMITES_PADRAO, processarMidiasPendentes } from './processar';

const EVO = { url: 'http://evolution:8080', apiKey: 'chave-de-teste' };
const GRUPO = '120363000000000001@g.us';
const AUTOR = '5596999990000@s.whatsapp.net';

const EXPORTACAO = [
  '12/10/2026 09:01 - Fulano: bom dia',
  '12/10/2026 09:02 - Beltrano: o endereço é Rua das Flores, 10',
].join('\n');

function zipDeExportacao(): Buffer {
  return Buffer.from(zipSync({ 'Conversa do WhatsApp com Grupo A.txt': strToU8(EXPORTACAO) }));
}

function mensagemComArquivo(id: string, nome: string, extra: Record<string, unknown> = {}) {
  return extrairMensagem({
    key: { remoteJid: GRUPO, fromMe: false, id, participant: AUTOR },
    pushName: 'Teste',
    message: { documentMessage: { fileName: nome, mimetype: 'application/zip', fileLength: '1234', ...extra } },
    messageTimestamp: 1790000000,
  })!;
}

describe('processarMidiasPendentes', () => {
  let db: PGlite;
  let dir: string;
  let arquivos: Record<string, Buffer>;
  let chamadas: string[];
  let falhar: Set<string>;
  let opc: { mediaDir: string; limiteBytes: number; limiteExportacaoBytes: number; maxTentativas: number };

  // Evolution falsa: devolve o arquivo da mensagem em base64, como a v2.
  const f = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const id = JSON.parse(init.body).message.key.id as string;
    chamadas.push(`${url.pathname} ${id}`);
    if (falhar.has(id)) return new Response('{}', { status: 500 });
    const dados = arquivos[id];
    if (!dados) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ base64: dados.toString('base64'), mimetype: 'application/zip' }), { status: 200 });
  }) as typeof fetch;

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance) values (1, 'inst-a')`);
    dir = await mkdtemp(path.join(tmpdir(), 'poli2-midia-'));
    opc = { mediaDir: dir, ...LIMITES_PADRAO };
    arquivos = {};
    chamadas = [];
    falhar = new Set();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('baixa a exportação, guarda o arquivo e importa as mensagens do grupo', async () => {
    arquivos.ARQ1 = zipDeExportacao();
    await gravarMensagem(db, 'inst-a', mensagemComArquivo('ARQ1', 'Conversa do WhatsApp com Grupo A.zip'));

    const r = await processarMidiasPendentes(db, EVO, opc, f);
    expect(r).toMatchObject({ baixadas: 1, ignoradas: 0, falhas: 0 });
    expect(r.exportacoes).toEqual([{ linhas: 2, gravadas: 2, jaExistiam: 0 }]);

    const m = await db.query<{ estado: string; sha256: string; caminho: string; bytes: string }>(
      'select estado, sha256, caminho, bytes::text from midias',
    );
    expect(m.rows[0].estado).toBe('baixada');
    expect(m.rows[0].caminho).toBe(path.join(dir, '1', m.rows[0].sha256));
    expect((await readFile(m.rows[0].caminho)).equals(arquivos.ARQ1)).toBe(true);

    const msgs = await db.query<{ n: string }>(`select count(*)::text as n from mensagens where origem = 'exportacao'`);
    expect(msgs.rows[0].n).toBe('2');
  });

  it('um arquivo comum só é guardado, sem importar nada', async () => {
    arquivos.DOC1 = Buffer.from('conteudo do plano');
    await gravarMensagem(db, 'inst-a', mensagemComArquivo('DOC1', 'plano-de-campanha.pdf'));
    const r = await processarMidiasPendentes(db, EVO, opc, f);
    expect(r).toMatchObject({ baixadas: 1, exportacoes: [] });
    const n = await db.query<{ n: string }>(`select count(*)::text as n from mensagens where origem = 'exportacao'`);
    expect(n.rows[0].n).toBe('0');
  });

  it('o mesmo conteúdo enviado duas vezes vira um arquivo só em disco', async () => {
    arquivos.A = Buffer.from('igual');
    arquivos.B = Buffer.from('igual');
    await gravarMensagem(db, 'inst-a', mensagemComArquivo('A', 'a.pdf'));
    await gravarMensagem(db, 'inst-a', mensagemComArquivo('B', 'b.pdf'));
    const r = await processarMidiasPendentes(db, EVO, opc, f);
    expect(r.baixadas).toBe(2);
    expect(await readdir(path.join(dir, '1'))).toHaveLength(1);
  });

  it('tenta de novo se falhar e desiste depois de 3 tentativas', async () => {
    falhar.add('RUIM');
    await gravarMensagem(db, 'inst-a', mensagemComArquivo('RUIM', 'x.pdf'));
    for (let i = 0; i < 3; i++) await processarMidiasPendentes(db, EVO, opc, f);
    const m = await db.query<{ estado: string; tentativas: number; erro: string }>('select estado, tentativas, erro from midias');
    expect(m.rows[0]).toMatchObject({ estado: 'falhou', tentativas: 3 });
    expect(m.rows[0].erro).toContain('500');
    const antes = chamadas.length;
    await processarMidiasPendentes(db, EVO, opc, f);
    expect(chamadas.length).toBe(antes);
  });

  it('não baixa o que já se sabe que passa do limite', async () => {
    await gravarMensagem(db, 'inst-a', mensagemComArquivo('GRANDE', 'enorme.pdf', { fileLength: String(30 * 1024 * 1024) }));
    const r = await processarMidiasPendentes(db, EVO, opc, f);
    expect(r.ignoradas).toBe(1);
    expect(chamadas).toEqual([]);
    const m = await db.query<{ estado: string }>('select estado from midias');
    expect(m.rows[0].estado).toBe('ignorada');
  });

  it('vídeo guarda só os metadados e a importação de histórico não baixa anexos', async () => {
    const video = extrairMensagem({
      key: { remoteJid: GRUPO, fromMe: false, id: 'V1', participant: AUTOR },
      message: { videoMessage: { mimetype: 'video/mp4', fileLength: '999' } },
      messageTimestamp: 1790000001,
    })!;
    await gravarMensagem(db, 'inst-a', video);
    await gravarMensagem(db, 'inst-a', mensagemComArquivo('H1', 'antigo.pdf'), { criarMidia: false });
    const m = await db.query<{ estado: string }>('select estado from midias');
    expect(m.rows).toEqual([{ estado: 'ignorada' }]);
    expect((await processarMidiasPendentes(db, EVO, opc, f)).baixadas).toBe(0);
  });
});

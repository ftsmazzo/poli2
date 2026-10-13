import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairItensPendentes } from './persistir';

const VCARD = 'BEGIN:VCARD\nFN:Fulano de Tal\nTEL;waid=5596991234567:+55 96 99123-4567\nEMAIL:fulano@exemplo.com\nEND:VCARD';

describe('extrairItensPendentes', () => {
  let db: PGlite;

  async function msg(id: string, tipo: string, texto: string | null, quando: string, origem = 'whatsapp') {
    const r = await db.query<{ id: number }>(
      `insert into mensagens (workspace_id, grupo_id, wa_message_id, enviada_em, tipo, texto, origem)
       values (1, 1, $1, $2, $3, $4, $5) returning id`,
      [id, quando, tipo, texto, origem],
    );
    return r.rows[0].id;
  }

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into grupos (workspace_id, jid) values (1, '1203@g.us')`);
  });

  it('extrai os itens de cada mensagem e marca como processada', async () => {
    await msg('M1', 'texto', 'Rua das Flores, 10 - Centro e https://exemplo.com/a', '2026-10-12T09:00:00-03:00');
    await msg('M2', 'texto', 'bom dia', '2026-10-12T09:01:00-03:00');

    expect(await extrairItensPendentes(db)).toEqual({ mensagens: 2, itens: 2 });
    const i = await db.query<{ tipo: string; valor: string }>('select tipo, valor from itens order by tipo');
    expect(i.rows).toEqual([
      { tipo: 'endereco', valor: 'Rua das Flores, 10 - Centro' },
      { tipo: 'link', valor: 'https://exemplo.com/a' },
    ]);
    const pend = await db.query<{ n: string }>('select count(*)::text as n from mensagens where itens_extraidos_em is null');
    expect(pend.rows[0].n).toBe('0');
  });

  it('só processa cada mensagem uma vez', async () => {
    await msg('M1', 'texto', 'https://exemplo.com/a', '2026-10-12T09:00:00-03:00');
    await extrairItensPendentes(db);
    expect(await extrairItensPendentes(db)).toEqual({ mensagens: 0, itens: 0 });
    const v = await db.query<{ dados: { vezes: number } }>('select dados from itens');
    expect(v.rows[0].dados.vezes).toBe(1);
  });

  it('respeita o tamanho do lote', async () => {
    for (let i = 0; i < 5; i++) await msg(`M${i}`, 'texto', `https://exemplo.com/${i}`, '2026-10-12T09:00:00-03:00');
    expect((await extrairItensPendentes(db, 2)).mensagens).toBe(2);
    expect((await extrairItensPendentes(db, 2)).mensagens).toBe(2);
    expect((await extrairItensPendentes(db, 2)).mensagens).toBe(1);
  });

  it('o mesmo link em várias mensagens é um item que aponta para a mais antiga e conta as vezes', async () => {
    await msg('M2', 'texto', 'olha https://exemplo.com/a?utm_source=x', '2026-10-12T10:00:00-03:00');
    const antiga = await msg('M1', 'texto', 'https://exemplo.com/a', '2026-10-12T09:00:00-03:00');
    await extrairItensPendentes(db);
    const i = await db.query<{ mensagem_id: number; dados: { vezes: number } }>('select mensagem_id, dados from itens');
    expect(i.rows).toHaveLength(1);
    expect(i.rows[0].mensagem_id).toBe(antiga);
    expect(i.rows[0].dados.vezes).toBe(2);
  });

  it('o cartão de contato completa o telefone escrito no texto, com o nome e o e-mail', async () => {
    await msg('M1', 'texto', 'liga no 96 99123-4567', '2026-10-12T09:00:00-03:00');
    await msg('M2', 'contato', VCARD, '2026-10-12T09:05:00-03:00');
    await extrairItensPendentes(db);
    const c = await db.query<{ valor: string; dados: { nome: string; email: string; vezes: number } }>(`select valor, dados from itens where tipo = 'contato'`);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].valor).toBe('Fulano de Tal');
    expect(c.rows[0].dados).toMatchObject({ nome: 'Fulano de Tal', email: 'fulano@exemplo.com', vezes: 2 });
  });

  it('o telefone escrito depois do cartão não apaga o nome do cartão', async () => {
    await msg('M1', 'contato', VCARD, '2026-10-12T09:00:00-03:00');
    await msg('M2', 'texto', 'liga no 96 99123-4567', '2026-10-12T09:05:00-03:00');
    await extrairItensPendentes(db);
    const c = await db.query<{ valor: string; dados: { origem: string } }>(`select valor, dados from itens where tipo = 'contato'`);
    expect(c.rows[0].valor).toBe('Fulano de Tal');
    expect(c.rows[0].dados.origem).toBe('vcard');
  });

  it('registra o arquivo com o nome do anexo baixado e liga ao autor', async () => {
    await db.query(`insert into pessoas (workspace_id, nome, papel) values (1, 'Fulano', 'outro')`);
    const id = await msg('D1', 'documento', 'plano.pdf', '2026-10-12T09:00:00-03:00');
    await db.query(`update mensagens set autor_pessoa_id = 1 where id = $1`, [id]);
    await db.query(`insert into midias (workspace_id, mensagem_id, nome_arquivo, estado) values (1, $1, 'plano.pdf', 'baixada')`, [id]);
    await extrairItensPendentes(db);
    const a = await db.query<{ valor: string; autor_pessoa_id: number; dados: { disponivel: boolean } }>(`select valor, autor_pessoa_id, dados from itens where tipo = 'arquivo'`);
    expect(a.rows[0]).toMatchObject({ valor: 'plano.pdf', autor_pessoa_id: 1 });
    expect(a.rows[0].dados.disponivel).toBe(true);
  });

  it('também extrai das mensagens que vieram de uma exportação', async () => {
    await msg('exp-1', 'texto', 'Beltrano 96 98888-7777', '2026-10-01T09:00:00-03:00', 'exportacao');
    await extrairItensPendentes(db);
    const c = await db.query<{ valor: string }>(`select valor from itens where tipo = 'contato'`);
    expect(c.rows).toEqual([{ valor: 'Beltrano' }]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { descobrirIdentificadores } from './lids';
import { marcarEstaPoli, sincronizarMembros, type GrupoLido } from './membros';

const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';
const POLI = '5596900000000';

const ary = { lid: '222222222222222', telefone: '5511987654321', admin: true };
const fred = { lid: '333333333333333', telefone: '5511912345678', admin: false };
const leo = { lid: '444444444444444', telefone: '5511955550001', admin: false };

describe('membros dos grupos', () => {
  let db: PGlite;

  const membrosDe = async (grupo: string) =>
    (
      await db.query<{ telefone: string | null; ativo: boolean; admin: boolean }>(
        `select p.telefone, gm.ativo, gm.admin from grupo_membros gm join pessoas p on p.id = gm.pessoa_id join grupos g on g.id = gm.grupo_id
         where g.jid = $1 order by p.telefone`,
        [grupo],
      )
    ).rows;
  const contagem = async (tabela: string) => Number((await db.query<{ n: string }>(`select count(*)::text as n from ${tabela}`)).rows[0].n);

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('A'), ('B')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance, jid_proprio) values (1, 'inst-a', '${POLI}@s.whatsapp.net')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '${G1}', 'Inteligência Eleitoral'), (1, '${G2}', 'Heads'), (2, '1@g.us', 'Outro tenant')`);
  });

  describe('sincronizarMembros', () => {
    it('vincula cada pessoa aos grupos em que está, e quem está em dois grupos continua sendo UMA pessoa', async () => {
      const grupos: GrupoLido[] = [
        { jid: G1, membros: [ary, fred, leo] },
        { jid: G2, membros: [ary, fred] },
      ];
      expect(await sincronizarMembros(db, 1, grupos)).toEqual({ membros: 5, saidas: 0 });

      expect(await contagem('pessoas')).toBe(3);
      expect(await membrosDe(G1)).toEqual([
        { telefone: '5511912345678', ativo: true, admin: false },
        { telefone: '5511955550001', ativo: true, admin: false },
        { telefone: '5511987654321', ativo: true, admin: true },
      ]);
      expect((await membrosDe(G2)).map((m) => m.telefone)).toEqual(['5511912345678', '5511987654321']);
    });

    it('usa a pessoa que já existe (pelo LID ou pelo número) e completa o telefone, sem duplicar', async () => {
      await db.query(`insert into pessoas (workspace_id, jid, nome, papel) values (1, '${ary.lid}@lid', 'Ary Engracia', 'head')`);
      await db.query(`insert into pessoas (workspace_id, jid, nome, telefone) values (1, '${fred.telefone}@s.whatsapp.net', 'Frederico', '${fred.telefone}')`);
      await sincronizarMembros(db, 1, [{ jid: G1, membros: [ary, { lid: null, telefone: fred.telefone, admin: false }] }]);

      expect(await contagem('pessoas')).toBe(2);
      const a = await db.query<{ telefone: string; papel: string }>(`select telefone, papel from pessoas where nome = 'Ary Engracia'`);
      expect(a.rows).toEqual([{ telefone: ary.telefone, papel: 'head' }]);
    });

    it('quem saiu do grupo fica marcado como "saiu", com o histórico guardado; se voltar, volta a ser membro', async () => {
      await sincronizarMembros(db, 1, [{ jid: G1, membros: [ary, fred, leo] }]);
      const r = await sincronizarMembros(db, 1, [{ jid: G1, membros: [ary, fred] }]);
      expect(r.saidas).toBe(1);
      expect(await membrosDe(G1)).toEqual([
        { telefone: '5511912345678', ativo: true, admin: false },
        { telefone: '5511955550001', ativo: false, admin: false },
        { telefone: '5511987654321', ativo: true, admin: true },
      ]);
      expect(await contagem('pessoas')).toBe(3); // a pessoa que saiu continua cadastrada
      const saiu = await db.query<{ saiu_em: string | null }>(`select gm.saiu_em from grupo_membros gm join pessoas p on p.id = gm.pessoa_id where p.telefone = '${leo.telefone}'`);
      expect(saiu.rows[0].saiu_em).not.toBeNull();

      await sincronizarMembros(db, 1, [{ jid: G1, membros: [ary, fred, leo] }]);
      const voltou = await db.query<{ ativo: boolean; saiu_em: string | null }>(`select gm.ativo, gm.saiu_em from grupo_membros gm join pessoas p on p.id = gm.pessoa_id where p.telefone = '${leo.telefone}'`);
      expect(voltou.rows).toEqual([{ ativo: true, saiu_em: null }]);
    });

    it('sair de um grupo não afeta a participação em outro', async () => {
      await sincronizarMembros(db, 1, [{ jid: G1, membros: [ary, leo] }, { jid: G2, membros: [ary, leo] }]);
      await sincronizarMembros(db, 1, [{ jid: G1, membros: [ary] }, { jid: G2, membros: [ary, leo] }]);
      expect((await membrosDe(G1)).find((m) => m.telefone === leo.telefone)?.ativo).toBe(false);
      expect((await membrosDe(G2)).find((m) => m.telefone === leo.telefone)?.ativo).toBe(true);
    });

    it('lista vazia da Evolution não é "todo mundo saiu": nada muda', async () => {
      await sincronizarMembros(db, 1, [{ jid: G1, membros: [ary, fred] }]);
      const r = await sincronizarMembros(db, 1, [{ jid: G1, membros: [] }]);
      expect(r).toEqual({ membros: 0, saidas: 0 });
      expect((await membrosDe(G1)).every((m) => m.ativo)).toBe(true);
    });

    it('ignora grupo que a Poli não conhece e participante sem número nem LID', async () => {
      const r = await sincronizarMembros(db, 1, [{ jid: '999@g.us', membros: [ary] }, { jid: G1, membros: [{ lid: null, telefone: null, admin: false }, fred] }]);
      expect(r.membros).toBe(1);
      expect(await contagem('pessoas')).toBe(1);
    });

    it('não vincula ninguém a grupo de outro tenant', async () => {
      await sincronizarMembros(db, 2, [{ jid: G1, membros: [ary] }]); // G1 é do tenant 1: o tenant 2 não o vê
      expect(await contagem('grupo_membros')).toBe(0);
    });
  });

  describe('marcarEstaPoli', () => {
    it('marca o número e o LID da própria Poli, sem tocar nas outras pessoas', async () => {
      await db.query(`insert into pessoas (workspace_id, jid, nome, telefone) values (1, '${POLI}@s.whatsapp.net', 'MapSolar', '${POLI}'), (1, '111@lid', 'MapSolar', null), (1, '${ary.lid}@lid', 'Ary', null)`);
      await marcarEstaPoli(db, 1, POLI, '111');
      const r = await db.query<{ nome: string; tipo_conta: string }>('select nome, tipo_conta from pessoas order by id');
      expect(r.rows).toEqual([
        { nome: 'MapSolar', tipo_conta: 'esta_poli' },
        { nome: 'MapSolar', tipo_conta: 'esta_poli' },
        { nome: 'Ary', tipo_conta: 'pessoa' },
      ]);
    });
  });

  describe('descobrirIdentificadores (do começo ao fim)', () => {
    const evolution = (grupos: unknown[]): typeof fetch =>
      (async (input: any) => {
        const url = new URL(String(input));
        const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status });
        if (url.pathname.startsWith('/group/fetchAllGroups/')) return json(grupos);
        return json({}, 404);
      }) as typeof fetch;
    const EVO = { url: 'http://evolution:8080', apiKey: 'chave-de-teste' };
    const part = (p: { lid: string; telefone: string; admin: boolean }) => ({ id: `${p.lid}@lid`, phoneNumber: `${p.telefone}@s.whatsapp.net`, admin: p.admin ? 'admin' : null });
    const poli = { id: '111111111111111@lid', phoneNumber: `${POLI}@s.whatsapp.net`, admin: null };

    it('vincula os membros, marca a própria Poli, e une o cadastro antigo (só LID e só nome) à pessoa certa', async () => {
      // O que o sistema já tinha: Ary pelo LID (webhook) e Ary pelo nome (conversa exportada), com mensagens.
      const a1 = await db.query<{ id: number }>(`insert into pessoas (workspace_id, jid, nome) values (1, '${ary.lid}@lid', 'Ary Engracia') returning id`);
      const a2 = await db.query<{ id: number }>(`insert into pessoas (workspace_id, nome) values (1, 'Ary Engracia') returning id`);
      await db.query(`insert into mensagens (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, enviada_em, texto) values (1, 1, 'A', $1, now(), 'oi'), (1, 1, 'B', $2, now(), 'oi')`, [a1.rows[0].id, a2.rows[0].id]);

      const r = await descobrirIdentificadores(
        db,
        EVO,
        'inst-a',
        evolution([
          { id: G1, subject: 'Inteligência Eleitoral', participants: [part(ary), part(fred), part(leo), poli] },
          { id: G2, subject: 'Heads', participants: [part(ary), part(fred), poli] },
        ]),
      );
      expect(r).toMatchObject({ membros: 7, saidas: 0, lidProprio: '111111111111111' });
      expect(r.unidas).toBe(1);

      // Ary é uma só (com as 2 mensagens), com telefone, e está nos dois grupos.
      const aryDb = await db.query<{ telefone: string; mensagens: string; grupos: string }>(
        `select p.telefone,
                (select count(*)::text from mensagens m where m.autor_pessoa_id = p.id) as mensagens,
                (select count(*)::text from grupo_membros gm where gm.pessoa_id = p.id and gm.ativo) as grupos
         from pessoas p where p.nome = 'Ary Engracia'`,
      );
      expect(aryDb.rows).toEqual([{ telefone: ary.telefone, mensagens: '2', grupos: '2' }]);

      const tipos = await db.query<{ tipo_conta: string; n: string }>('select tipo_conta, count(*)::text as n from pessoas group by tipo_conta order by tipo_conta');
      expect(tipos.rows).toEqual([{ tipo_conta: 'esta_poli', n: '1' }, { tipo_conta: 'pessoa', n: '3' }]);
    });
  });
});

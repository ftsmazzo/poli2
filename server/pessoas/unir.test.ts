import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { nomeNormalizado, unificarPessoas, unirPessoas } from './unir';

describe('unir pessoas', () => {
  let db: PGlite;
  let wa = 0;

  const pessoa = async (campos: { ws?: number; jid?: string | null; nome?: string | null; telefone?: string | null; papel?: string; comandar?: boolean; conversar?: boolean; conta?: string }) => {
    const r = await db.query<{ id: number }>(
      `insert into pessoas (workspace_id, jid, nome, telefone, papel, pode_comandar, pode_conversar, tipo_conta) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [campos.ws ?? 1, campos.jid ?? null, campos.nome ?? null, campos.telefone ?? null, campos.papel ?? 'outro', campos.comandar ?? false, campos.conversar ?? false, campos.conta ?? 'pessoa'],
    );
    return Number(r.rows[0].id);
  };
  const mensagem = (autor: number, grupo = 1, ws = 1) =>
    db.query(`insert into mensagens (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, enviada_em, texto) values ($1, $2, $3, $4, now(), 'oi')`, [ws, grupo, `W${++wa}`, autor]);
  const membro = (grupo: number, pessoaId: number, ativo = true, admin = false) =>
    db.query(`insert into grupo_membros (grupo_id, pessoa_id, ativo, admin, saiu_em) values ($1, $2, $3, $4, $5)`, [grupo, pessoaId, ativo, admin, ativo ? null : new Date().toISOString()]);
  const pessoas = async () => (await db.query<{ id: number; nome: string | null; telefone: string | null; jid: string | null; papel: string }>('select id, nome, telefone, jid, papel from pessoas order by id')).rows;

  beforeEach(async () => {
    wa = 0;
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('A'), ('B')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'Inteligência Eleitoral'), (1, '2@g.us', 'Heads'), (2, '3@g.us', 'Outro')`);
  });

  describe('unirPessoas', () => {
    it('passa mensagens, itens e participação nos grupos para o destino e apaga a origem', async () => {
      const real = await pessoa({ jid: '5511987654321@s.whatsapp.net', nome: 'Ary Engracia', telefone: '5511987654321' });
      const fantasma = await pessoa({ nome: 'Ary Engracia' });
      await mensagem(real);
      await mensagem(fantasma);
      await mensagem(fantasma);
      const m = await db.query<{ id: number }>('select id from mensagens order by id limit 1');
      await db.query(`insert into itens (workspace_id, grupo_id, mensagem_id, tipo, valor, autor_pessoa_id, enviada_em, dedupe_key) values (1, 1, $1, 'link', 'https://a.com', $2, now(), 'k1')`, [m.rows[0].id, fantasma]);
      await membro(1, real);
      await membro(2, fantasma);

      expect(await unirPessoas(db, 1, fantasma, real)).toBe(true);

      expect((await pessoas()).map((p) => p.id)).toEqual([real]);
      expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens where autor_pessoa_id = $1', [real])).rows[0].n).toBe('3');
      expect((await db.query<{ autor_pessoa_id: number }>('select autor_pessoa_id from itens')).rows[0].autor_pessoa_id).toBe(real);
      const grupos = await db.query<{ grupo_id: number; ativo: boolean }>('select grupo_id, ativo from grupo_membros where pessoa_id = $1 order by grupo_id', [real]);
      expect(grupos.rows).toEqual([{ grupo_id: 1, ativo: true }, { grupo_id: 2, ativo: true }]);
    });

    it('completa o que o destino não sabia e fica com o papel e as permissões maiores', async () => {
      const destino = await pessoa({ jid: '111@lid', nome: null, papel: 'outro' });
      const origem = await pessoa({ jid: '5511987654321@s.whatsapp.net', nome: 'Ary', telefone: '5511987654321', papel: 'head', comandar: true, conversar: true });
      await unirPessoas(db, 1, origem, destino);
      const p = (await db.query<{ nome: string; telefone: string; jid: string; papel: string; pode_comandar: boolean; pode_conversar: boolean }>('select * from pessoas')).rows;
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ nome: 'Ary', telefone: '5511987654321', jid: '111@lid', papel: 'head', pode_comandar: true, pode_conversar: true });
    });

    it('quem saiu de um grupo e está em outro continua ativo no outro; o histórico do que saiu fica', async () => {
      const a = await pessoa({ jid: '1@lid', nome: 'A' });
      const b = await pessoa({ jid: '2@lid', nome: 'B' });
      await membro(1, a, false);
      await membro(1, b, true, true);
      await membro(2, a, true);
      await unirPessoas(db, 1, a, b);
      const r = await db.query<{ grupo_id: number; ativo: boolean; admin: boolean }>('select grupo_id, ativo, admin from grupo_membros where pessoa_id = $1 order by grupo_id', [b]);
      expect(r.rows).toEqual([{ grupo_id: 1, ativo: true, admin: true }, { grupo_id: 2, ativo: true, admin: false }]);
    });

    it('não une pessoa de outro tenant nem consigo mesma', async () => {
      const a = await pessoa({ nome: 'A' });
      const deOutro = await pessoa({ ws: 2, nome: 'B' });
      expect(await unirPessoas(db, 1, a, deOutro)).toBe(false);
      expect(await unirPessoas(db, 1, a, a)).toBe(false);
      expect(await unirPessoas(db, 1, a, 99999)).toBe(false);
      expect(await pessoas()).toHaveLength(2);
    });
  });

  describe('unificarPessoas (automático)', () => {
    it('une dois cadastros com o mesmo telefone', async () => {
      const a = await pessoa({ jid: '1@lid', nome: 'Leonardo', telefone: '5511955550001' });
      await pessoa({ jid: '5511955550001@s.whatsapp.net', nome: 'Leonardo Tamburus', telefone: '5511955550001' });
      expect(await unificarPessoas(db, 1)).toEqual({ unidas: 1 });
      expect(await pessoas()).toHaveLength(1);
      expect((await pessoas())[0].id).toBe(a);
    });

    it('une o cadastro só com LID ao que tem o número, quando o WhatsApp informou o par', async () => {
      await db.query(`insert into lids (workspace_id, lid, telefone) values (1, '222222', '5511987654321')`);
      await pessoa({ jid: '222222@lid', nome: 'Ary Engracia' });
      await pessoa({ jid: '5511987654321@s.whatsapp.net', nome: 'Ary', telefone: '5511987654321' });
      expect((await unificarPessoas(db, 1)).unidas).toBe(1);
      expect(await pessoas()).toHaveLength(1);
    });

    it('une o cadastro feito só pelo nome (conversa exportada) à pessoa real, ignorando o "~"', async () => {
      await pessoa({ jid: '5511987654321@s.whatsapp.net', nome: 'Ary Engracia', telefone: '5511987654321' });
      const fantasma = await pessoa({ nome: '~Ary Engracia' });
      await mensagem(fantasma);
      await mensagem(fantasma);
      expect((await unificarPessoas(db, 1)).unidas).toBe(1);
      const p = await pessoas();
      expect(p).toHaveLength(1);
      expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens where autor_pessoa_id = $1', [p[0].id])).rows[0].n).toBe('2');
    });

    it('o cenário completo: LID, número e nome do arquivo viram uma pessoa só', async () => {
      await db.query(`insert into lids (workspace_id, lid, telefone) values (1, '222222', '5511987654321')`);
      await pessoa({ jid: '222222@lid', nome: 'Ary Engracia' }); // chegou pelo webhook como LID
      await pessoa({ jid: '5511987654321@s.whatsapp.net', nome: 'Ary Engracia', telefone: '5511987654321' }); // chegou com o número
      await pessoa({ nome: 'Ary Engracia' }); // veio só pelo nome da conversa exportada
      expect((await unificarPessoas(db, 1)).unidas).toBe(2);
      expect(await pessoas()).toHaveLength(1);
    });

    it('NÃO une duas pessoas reais com o mesmo nome (podem ser homônimas)', async () => {
      await pessoa({ jid: '5511111111111@s.whatsapp.net', nome: 'João Silva', telefone: '5511111111111' });
      await pessoa({ jid: '5522222222222@s.whatsapp.net', nome: 'João Silva', telefone: '5522222222222' });
      expect((await unificarPessoas(db, 1)).unidas).toBe(0);
      expect(await pessoas()).toHaveLength(2);
    });

    it('NÃO une o cadastro só pelo nome quando há duas pessoas reais com aquele nome (não dá para saber qual)', async () => {
      await pessoa({ jid: '5511111111111@s.whatsapp.net', nome: 'João Silva', telefone: '5511111111111' });
      await pessoa({ jid: '5522222222222@s.whatsapp.net', nome: 'João Silva', telefone: '5522222222222' });
      await pessoa({ nome: 'João Silva' });
      expect((await unificarPessoas(db, 1)).unidas).toBe(0);
      expect(await pessoas()).toHaveLength(3);
    });

    it('nunca mistura tenants', async () => {
      await pessoa({ ws: 1, jid: '5511987654321@s.whatsapp.net', nome: 'Ary', telefone: '5511987654321' });
      await pessoa({ ws: 2, jid: '5511987654321@s.whatsapp.net', nome: 'Ary', telefone: '5511987654321' });
      await pessoa({ ws: 2, nome: 'Ary' });
      expect((await unificarPessoas(db, 1)).unidas).toBe(0);
      expect((await db.query<{ n: string }>('select count(*)::text as n from pessoas')).rows[0].n).toBe('3');
    });

    it('sem nada a unir, não faz nada', async () => {
      await pessoa({ jid: '1@lid', nome: 'A' });
      expect(await unificarPessoas(db, 1)).toEqual({ unidas: 0 });
    });
  });

  describe('nomeNormalizado', () => {
    it('tira o "~" do WhatsApp, espaços e maiúsculas', () => {
      expect(nomeNormalizado('~ Léo ')).toBe('léo');
      expect(nomeNormalizado('Ary Engracia')).toBe('ary engracia');
      expect(nomeNormalizado(null)).toBe('');
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairItensPendentes } from '../extrair/persistir';
import { criarFerramentas, formatarQuando, instante, type Ferramentas } from './ferramentas';

describe('datas', () => {
  it('mostra no horário de Brasília e entende data pura', () => {
    expect(formatarQuando('2026-10-12T12:01:00Z')).toBe('2026-10-12 09:01');
    expect(instante('2026-10-12')).toBe('2026-10-12T03:00:00.000Z');
    // "ate" com data pura vale até o fim do dia.
    expect(instante('2026-10-12', true)).toBe('2026-10-13T03:00:00.000Z');
    expect(instante('2026-10-12 09:30')).toBe('2026-10-12T12:30:00.000Z');
    expect(instante('lixo')).toBeNull();
    expect(instante(undefined)).toBeNull();
  });
});

describe('ferramentas de busca', () => {
  let db: PGlite;
  let f: Ferramentas;
  const ids: Record<string, number> = {};

  async function msg(chave: string, ws: number, grupo: number, pessoa: number, quando: string, texto: string) {
    const r = await db.query<{ id: number }>(
      `insert into mensagens (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, enviada_em, tipo, texto)
       values ($1, $2, $3, $4, $5, 'texto', $6) returning id`,
      [ws, grupo, chave, pessoa, quando, texto],
    );
    ids[chave] = r.rows[0].id;
  }
  const rodar = async (nome: string, args: unknown) => (await f.executar(nome, JSON.stringify(args))) as any;

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A'), ('Tenant B')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values
      (1, '1@g.us', 'Inteligência Eleitoral'), (1, '2@g.us', 'Equipe de Campo'), (2, '3@g.us', 'Outro Tenant')`);
    await db.query(`insert into pessoas (workspace_id, nome, papel) values
      (1, 'Fulano', 'outro'), (1, 'Beltrano', 'outro'), (1, 'Ana', 'outro'), (2, 'Zé', 'outro')`);
    await msg('m1', 1, 1, 1, '2026-10-10T09:00:00-03:00', 'O plano de campanha está em https://exemplo.com/plano?utm_source=zap');
    await msg('m2', 1, 1, 2, '2026-10-11T10:00:00-03:00', 'Reunião no endereço Rua das Flores, 10 - Centro, Macapá às 15h');
    await msg('m3', 1, 1, 1, '2026-10-12T09:01:00-03:00', 'Contato do coordenador: Maria Souza 96 99123-4567');
    await msg('m4', 1, 2, 3, '2026-10-12T11:00:00-03:00', 'codigo ab12cd confirmado');
    await msg('m5', 1, 1, 2, '2026-10-12T12:00:00-03:00', 'Agenda do evento atualizada');
    await msg('m6', 2, 3, 4, '2026-10-12T09:00:00-03:00', 'plano secreto do outro tenant https://outro.com/segredo 96 98888-0000');
    await extrairItensPendentes(db);
    f = criarFerramentas(db, 1);
  });

  describe('buscar_mensagens', () => {
    it('acha pelo assunto, com autor e data no horário local', async () => {
      const r = await rodar('buscar_mensagens', { consulta: 'plano campanha' });
      expect(r.mensagens[0]).toMatchObject({ id: ids.m1, autor: 'Fulano', grupo: 'Inteligência Eleitoral', quando: '2026-10-10 09:00' });
    });

    it('nunca devolve mensagem de outro tenant', async () => {
      const r = await rodar('buscar_mensagens', { consulta: 'plano secreto segredo tenant' });
      expect(r.mensagens.map((m: any) => m.id)).not.toContain(ids.m6);
      expect(JSON.stringify(r)).not.toContain('outro.com');
    });

    it('filtra por grupo e por data', async () => {
      expect((await rodar('buscar_mensagens', { consulta: 'confirmado', grupo: 'Campo' })).mensagens.map((m: any) => m.id)).toEqual([ids.m4]);
      expect((await rodar('buscar_mensagens', { consulta: 'confirmado', grupo: 'Inteligência' })).total).toBe(0);
      const dia = await rodar('buscar_mensagens', { consulta: 'endereço reunião', de: '2026-10-11', ate: '2026-10-11' });
      expect(dia.mensagens.map((m: any) => m.id)).toEqual([ids.m2]);
    });

    it('se a busca por palavra inteira não acha, busca por pedaço de palavra', async () => {
      const r = await rodar('buscar_mensagens', { consulta: 'ab12' });
      expect(r.mensagens.map((m: any) => m.id)).toEqual([ids.m4]);
    });

    it('pede palavras quando a consulta é vazia', async () => {
      expect((await rodar('buscar_mensagens', { consulta: '  a  ' })).erro).toBeTruthy();
    });

    it('texto do modelo nunca vira SQL', async () => {
      const r = await rodar('buscar_mensagens', { consulta: 'plano', grupo: "'; drop table mensagens; --" });
      expect(r.total).toBe(0);
      expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens')).rows[0].n).toBe('6');
    });
  });

  describe('buscar_itens', () => {
    it('acha endereço, contato e link, sem trazer os do outro tenant', async () => {
      expect((await rodar('buscar_itens', { tipo: 'endereco' })).itens[0]).toMatchObject({
        valor: 'Rua das Flores, 10 - Centro, Macapá',
        autor: 'Beltrano',
        mensagem_id: ids.m2,
      });
      const contato = await rodar('buscar_itens', { tipo: 'contato', termo: 'Maria' });
      expect(contato.total).toBe(1);
      expect(contato.itens[0].dados.telefones).toEqual(['+5596991234567']);
      expect(contato.itens[0].dados.contexto).toBeUndefined();

      const links = await rodar('buscar_itens', { tipo: 'link' });
      expect(links.itens.map((i: any) => i.valor)).toEqual(['https://exemplo.com/plano']);
    });

    it('sem filtro traz do mais recente ao mais antigo', async () => {
      const r = await rodar('buscar_itens', {});
      const quando = r.itens.map((i: any) => i.quando);
      expect([...quando].sort().reverse()).toEqual(quando);
    });
  });

  describe('contexto_mensagem', () => {
    it('traz as mensagens em volta, só do mesmo grupo e em ordem', async () => {
      const r = await rodar('contexto_mensagem', { mensagem_id: ids.m3, antes: 1, depois: 1 });
      expect(r.mensagens.map((m: any) => m.id)).toEqual([ids.m2, ids.m3, ids.m5]);
    });

    it('não lê mensagem de outro tenant', async () => {
      expect((await rodar('contexto_mensagem', { mensagem_id: ids.m6 })).erro).toBeTruthy();
    });
  });

  describe('mensagens_do_periodo', () => {
    it('lista em ordem, no formato de leitura, com filtro de grupo', async () => {
      const r = await rodar('mensagens_do_periodo', { de: '2026-10-12' });
      expect(r.total).toBe(3);
      expect(r.linhas[0]).toBe('[2026-10-12 09:01] Fulano: Contato do coordenador: Maria Souza 96 99123-4567');
      const so = await rodar('mensagens_do_periodo', { de: '2026-10-12', grupo: 'Inteligência' });
      expect(so.linhas).toHaveLength(2);
    });

    it('exige a data inicial', async () => {
      expect((await rodar('mensagens_do_periodo', {})).erro).toBeTruthy();
    });
  });

  it('listar_grupos mostra só os grupos do tenant', async () => {
    const r = await rodar('listar_grupos', {});
    expect(r.grupos.map((g: any) => g.nome).sort()).toEqual(['Equipe de Campo', 'Inteligência Eleitoral']);
  });

  it('trata argumento inválido e ferramenta desconhecida sem quebrar', async () => {
    expect((await f.executar('buscar_itens', '{não é json')) as any).toMatchObject({ erro: expect.any(String) });
    expect((await f.executar('apagar_tudo', '{}')) as any).toMatchObject({ erro: expect.stringContaining('desconhecida') });
  });
});

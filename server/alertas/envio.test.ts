import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { dentroDoHorario, enviarPendentes, horaLocal, prepararEnvios, reprocessarSemDestino } from './envio';

// 23:00 em Belém/Amapá (UTC-3) e 10:00.
const NOITE = new Date('2026-10-14T02:00:00Z');
const MANHA = new Date('2026-10-14T13:00:00Z');

describe('horário', () => {
  it('converte para o horário de Brasília e só segura alerta de importância menor que 3 à noite', () => {
    expect(horaLocal(NOITE)).toBe(23);
    expect(horaLocal(MANHA)).toBe(10);
    expect(dentroDoHorario(MANHA, 2)).toBe(true);
    expect(dentroDoHorario(NOITE, 2)).toBe(false);
    expect(dentroDoHorario(new Date('2026-10-14T09:30:00Z'), 2)).toBe(false); // 06:30
    expect(dentroDoHorario(NOITE, 3)).toBe(true);
  });
});

describe('alertas aos Heads', () => {
  let db: PGlite;
  let enviados: { instancia: string; destino: string; texto: string }[];
  const enviar = async (instancia: string, destino: string, texto: string) => {
    enviados.push({ instancia, destino, texto });
    return { waMessageId: `W${enviados.length}` };
  };

  async function alerta(severidade = 3, texto = 'Boato sobre o local de votação circulando', chave = 'k1') {
    const r = await db.query<{ id: number }>(
      `insert into alertas (workspace_id, grupo_id, severidade, texto, dedupe_key) values (1, 1, $1, $2, $3) returning id`,
      [severidade, texto, chave],
    );
    return r.rows[0].id;
  }

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    enviados = [];
    await db.query(`insert into workspaces (nome) values ('Tenant A'), ('Tenant B')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance) values (1, 'poli')`);
    await db.query(`insert into grupos (workspace_id, jid, nome, eh_heads) values (1, '1@g.us', 'Inteligência Eleitoral', false), (1, '2@g.us', 'Heads', true), (2, '3@g.us', 'Outro', true)`);
    await db.query(`insert into pessoas (workspace_id, nome, telefone, papel) values
      (1, 'Chefe 1', '5516996480805', 'head'), (1, 'Chefe 2', '5596999990002', 'head'),
      (1, 'Sem telefone', null, 'head'), (1, 'Equipe', '5596999990003', 'equipe'), (2, 'Do outro', '5511999990000', 'head')`);
  });

  describe('prepararEnvios', () => {
    it('cria um envio para o privado de cada Head com telefone e para o grupo dos Heads, só do tenant', async () => {
      const id = await alerta();
      expect(await prepararEnvios(db, id)).toBe(3);
      const s = await db.query<{ destino_jid: string; destino_tipo: string; texto: string; estado: string }>(
        'select destino_jid, destino_tipo, texto, estado from mensagens_saida order by id',
      );
      expect(s.rows.map((x) => [x.destino_jid, x.destino_tipo])).toEqual([
        ['5516996480805', 'privado'],
        ['5596999990002', 'privado'],
        ['2@g.us', 'grupo'],
      ]);
      expect(s.rows[0].texto).toBe('*ALERTA* · Inteligência Eleitoral\nBoato sobre o local de votação circulando');
      expect(s.rows.every((x) => x.estado === 'pendente')).toBe(true);
    });

    it('chamar de novo não duplica e só cria o que faltava', async () => {
      const id = await alerta();
      await prepararEnvios(db, id);
      expect(await prepararEnvios(db, id)).toBe(0);
      await db.query(`insert into pessoas (workspace_id, nome, telefone, papel) values (1, 'Chefe 3', '5596999990004', 'head')`);
      expect(await prepararEnvios(db, id)).toBe(1);
    });

    it('sem nenhum Head nem grupo marcado, não cria envio; reprocessar acha depois que alguém for marcado', async () => {
      await db.query(`update pessoas set papel = 'equipe'`);
      await db.query(`update grupos set eh_heads = false`);
      const id = await alerta();
      expect(await prepararEnvios(db, id)).toBe(0);
      expect(await reprocessarSemDestino(db, MANHA)).toBe(0);
      await db.query(`update pessoas set papel = 'head' where nome = 'Chefe 1'`);
      expect(await reprocessarSemDestino(db, MANHA)).toBe(1);
    });
  });

  describe('enviarPendentes', () => {
    it('envia pela instância do tenant, marca como enviada e registra o horário no alerta', async () => {
      const id = await alerta();
      await prepararEnvios(db, id);
      const r = await enviarPendentes(db, enviar, MANHA);
      expect(r).toEqual({ enviadas: 3, falhas: 0, adiadas: 0 });
      expect(enviados.map((e) => e.instancia)).toEqual(['poli', 'poli', 'poli']);
      expect(enviados[0].destino).toBe('5516996480805');
      const a = await db.query<{ enviado_em: string | null }>('select enviado_em from alertas');
      expect(a.rows[0].enviado_em).not.toBeNull();
      expect((await enviarPendentes(db, enviar, MANHA)).enviadas).toBe(0);
    });

    it('à noite segura o de importância 2 e deixa passar o de importância 3', async () => {
      await prepararEnvios(db, await alerta(2, 'Pedido sem resposta', 'k2'));
      expect(await enviarPendentes(db, enviar, NOITE)).toEqual({ enviadas: 0, falhas: 0, adiadas: 3 });
      expect(enviados).toEqual([]);
      await prepararEnvios(db, await alerta(3, 'Vazamento de documento', 'k3'));
      const r = await enviarPendentes(db, enviar, NOITE);
      expect(r.enviadas).toBe(3);
      expect(enviados.every((e) => e.texto.includes('Vazamento'))).toBe(true);
      // De manhã o que estava segurado sai.
      expect((await enviarPendentes(db, enviar, MANHA)).enviadas).toBe(3);
    });

    it('se o envio falhar tenta de novo e desiste na terceira, sem travar os outros', async () => {
      await prepararEnvios(db, await alerta());
      const falha5516 = async (i: string, destino: string, t: string) => {
        if (destino === '5516996480805') throw new Error('Evolution POST respondeu 400');
        return enviar(i, destino, t);
      };
      expect(await enviarPendentes(db, falha5516, MANHA)).toEqual({ enviadas: 2, falhas: 1, adiadas: 0 });
      await enviarPendentes(db, falha5516, MANHA);
      await enviarPendentes(db, falha5516, MANHA);
      const s = await db.query<{ estado: string; tentativas: number }>(`select estado, tentativas from mensagens_saida where destino_jid = '5516996480805'`);
      expect(s.rows).toEqual([{ estado: 'falhou', tentativas: 3 }]);
      expect((await enviarPendentes(db, falha5516, MANHA)).falhas).toBe(0);
    });

    it('sem instância ativa para o tenant, adia em vez de perder', async () => {
      await prepararEnvios(db, await alerta());
      await db.query('update instancias_wa set ativa = false');
      expect(await enviarPendentes(db, enviar, MANHA)).toEqual({ enviadas: 0, falhas: 0, adiadas: 3 });
    });
  });
});

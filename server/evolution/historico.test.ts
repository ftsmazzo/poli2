import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { importarHistoricoPendente } from './historico';

const EVO = { url: 'http://evolution:8080', apiKey: 'chave-de-teste' };
const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';
const AUTOR = '5596999990000@s.whatsapp.net';

function registro(grupo: string, id: string, texto: string, ts: number) {
  return {
    key: { remoteJid: grupo, fromMe: false, id, participant: AUTOR },
    pushName: 'Teste',
    message: { conversation: texto },
    messageTimestamp: ts,
  };
}

interface Estado {
  grupos: { id: string; subject: string }[];
  mensagens: Record<string, any[]>;
  chamadas: string[];
  quebrar?: Set<string>;
}

// Evolution falsa: lista grupos e entrega as mensagens em páginas, como a v2.
function evolutionFalsa(estado: Estado): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    estado.chamadas.push(`${init.method ?? 'GET'} ${url.pathname}`);
    const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
    if (init.headers?.apikey !== EVO.apiKey) return json({}, 401);

    if (url.pathname.startsWith('/group/fetchAllGroups/')) return json(estado.grupos);
    if (url.pathname.startsWith('/chat/findMessages/')) {
      const corpo = JSON.parse(init.body);
      const jid: string = corpo.where.key.remoteJid;
      if (estado.quebrar?.has(jid)) return json({ erro: 'quebrou' }, 500);
      const todas = estado.mensagens[jid] ?? [];
      const inicio = (corpo.page - 1) * corpo.offset;
      const records = todas.slice(inicio, inicio + corpo.offset);
      return json({ messages: { total: todas.length, pages: Math.max(1, Math.ceil(todas.length / corpo.offset)), currentPage: corpo.page, records } });
    }
    return json({}, 404);
  }) as typeof fetch;
}

describe('importarHistoricoPendente', () => {
  let db: PGlite;
  let estado: Estado;
  const opcoes = { porPagina: 2, maxPaginas: 50 };

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance) values (1, 'inst-a')`);
    estado = {
      grupos: [
        { id: G1, subject: 'Grupo A' },
        { id: G2, subject: 'Grupo B' },
        { id: '5596999990000@s.whatsapp.net', subject: 'não é grupo' },
      ],
      mensagens: {
        [G1]: [1, 2, 3, 4, 5].map((n) => registro(G1, `A${n}`, `mensagem ${n}`, 1790000000 + n)),
        [G2]: [registro(G2, 'B1', 'oi', 1790000100)],
      },
      chamadas: [],
    };
  });

  it('importa todas as páginas de cada grupo e guarda o nome', async () => {
    const r = await importarHistoricoPendente(db, EVO, 'inst-a', evolutionFalsa(estado), opcoes);
    expect(r).toMatchObject({ grupos: 2, gruposImportados: 2, gravadas: 6, duplicadas: 0, erros: [] });

    const g = await db.query<{ nome: string; historico_mensagens: number }>(
      'select nome, historico_mensagens from grupos order by nome',
    );
    expect(g.rows).toEqual([
      { nome: 'Grupo A', historico_mensagens: 5 },
      { nome: 'Grupo B', historico_mensagens: 1 },
    ]);
    const m = await db.query<{ n: string }>('select count(*)::text as n from mensagens');
    expect(m.rows[0].n).toBe('6');
  });

  it('guarda a hora real de cada mensagem importada', async () => {
    await importarHistoricoPendente(db, EVO, 'inst-a', evolutionFalsa(estado), opcoes);
    const r = await db.query<{ enviada_em: string }>(`select enviada_em from mensagens where wa_message_id = 'A3'`);
    expect(new Date(r.rows[0].enviada_em).getTime()).toBe((1790000000 + 3) * 1000);
  });

  it('importa cada grupo uma vez só', async () => {
    const f = evolutionFalsa(estado);
    await importarHistoricoPendente(db, EVO, 'inst-a', f, opcoes);
    estado.chamadas.length = 0;
    const r = await importarHistoricoPendente(db, EVO, 'inst-a', f, opcoes);
    expect(r.gruposImportados).toBe(0);
    expect(r.gravadas).toBe(0);
    expect(estado.chamadas.some((c) => c.includes('findMessages'))).toBe(false);
  });

  it('não duplica o que o webhook já gravou antes da importação', async () => {
    await db.query(`insert into grupos (workspace_id, jid) values (1, '${G1}')`);
    await db.query(
      `insert into mensagens (workspace_id, grupo_id, wa_message_id, enviada_em, texto) values (1, 1, 'A2', now(), 'já estava aqui')`,
    );
    const r = await importarHistoricoPendente(db, EVO, 'inst-a', evolutionFalsa(estado), opcoes);
    expect(r.duplicadas).toBe(1);
    expect(r.gravadas).toBe(5);
  });

  it('um grupo com erro não trava o outro e fica para tentar de novo', async () => {
    estado.quebrar = new Set([G1]);
    const f = evolutionFalsa(estado);
    const r = await importarHistoricoPendente(db, EVO, 'inst-a', f, opcoes);
    expect(r.gruposImportados).toBe(1);
    expect(r.erros).toHaveLength(1);
    expect(r.erros[0]).toContain(G1);
    expect(r.erros[0]).not.toContain('quebrou');

    estado.quebrar = undefined;
    const de_novo = await importarHistoricoPendente(db, EVO, 'inst-a', f, opcoes);
    expect(de_novo.gruposImportados).toBe(1);
    expect(de_novo.gravadas).toBe(5);
  });

  it('ignora instância que não pertence a nenhum tenant', async () => {
    const r = await importarHistoricoPendente(db, EVO, 'outra', evolutionFalsa(estado), opcoes);
    expect(r.grupos).toBe(0);
    expect(estado.chamadas).toEqual([]);
  });
});

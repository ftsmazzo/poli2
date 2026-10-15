import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairMensagem, gravarMensagem } from '../ingest/evolution';
import { avaliarPedido } from '../agente/pedido';
import { descobrirIdentificadores } from './lids';

const EVO = { url: 'http://evolution:8080', apiKey: 'chave-de-teste' };
const GRUPO = '120363000000000001@g.us';
const POLI_TEL = '5596900000000@s.whatsapp.net';
const DONO_TEL = '5511987654321';

interface Estado {
  participantes: any[];
  numeros?: any[] | 'quebrar';
  chamadas: string[];
}

function evolutionFalsa(estado: Estado): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    estado.chamadas.push(`${init.method ?? 'GET'} ${url.pathname}`);
    const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
    if (url.pathname.startsWith('/group/fetchAllGroups/')) return json([{ id: GRUPO, subject: 'G', participants: estado.participantes }]);
    if (url.pathname.startsWith('/chat/whatsappNumbers/')) {
      if (estado.numeros === 'quebrar') return json({}, 404);
      return json(estado.numeros ?? []);
    }
    return json({}, 404);
  }) as typeof fetch;
}

function msgDeGrupo(texto: string, participant: string, participantAlt?: string, mencionados: string[] = []) {
  return extrairMensagem({
    key: { remoteJid: GRUPO, fromMe: false, id: `ID-${Math.random().toString(36).slice(2)}`, participant, ...(participantAlt ? { participantAlt } : {}) },
    pushName: 'Dono',
    message: { extendedTextMessage: { text: texto, contextInfo: mencionados.length ? { mentionedJid: mencionados } : {} } },
    messageTimestamp: 1790000000,
  })!;
}

describe('LID <-> telefone', () => {
  let db: PGlite;
  let estado: Estado;

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance, jid_proprio) values (1, 'inst-a', '${POLI_TEL}')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '${GRUPO}', 'G')`);
    estado = { participantes: [], chamadas: [] };
  });

  describe('descobrirIdentificadores', () => {
    it('aprende os pares da lista de participantes e acha o LID da própria Poli', async () => {
      estado.participantes = [
        { id: '111111111111111@lid', phoneNumber: POLI_TEL, admin: null },
        { id: '222222222222222@lid', phoneNumber: `${DONO_TEL}@s.whatsapp.net`, admin: 'admin' },
        { id: '5511999990000@s.whatsapp.net', admin: null },
      ];
      const r = await descobrirIdentificadores(db, EVO, 'inst-a', evolutionFalsa(estado));
      expect(r).toMatchObject({ participantes: 3, comLid: 2, pares: 2, lidProprio: '111111111111111', via: 'participantes' });
      expect(r.campos).toEqual(['admin', 'id', 'phoneNumber']);

      const lids = await db.query<{ lid: string; telefone: string }>('select lid, telefone from lids order by lid');
      expect(lids.rows).toEqual([
        { lid: '111111111111111', telefone: '5596900000000' },
        { lid: '222222222222222', telefone: DONO_TEL },
      ]);
      const i = await db.query<{ lid_proprio: string }>('select lid_proprio from instancias_wa');
      expect(i.rows[0].lid_proprio).toBe('111111111111111');
    });

    it('sem telefone na lista, tenta o plano B (consulta do número) e relata os campos que existem', async () => {
      estado.participantes = [{ id: '222222222222222@lid', admin: 'admin' }];
      estado.numeros = [{ jid: POLI_TEL, exists: true, lid: '111111111111111@lid' }];
      const r = await descobrirIdentificadores(db, EVO, 'inst-a', evolutionFalsa(estado));
      expect(r).toMatchObject({ pares: 0, comTelefone: 0, lidProprio: '111111111111111', via: 'consulta', campos: ['admin', 'id'] });
    });

    it('se nada informa o LID, não inventa e não quebra', async () => {
      estado.participantes = [{ id: '222222222222222@lid' }];
      estado.numeros = 'quebrar';
      const r = await descobrirIdentificadores(db, EVO, 'inst-a', evolutionFalsa(estado));
      expect(r).toMatchObject({ lidProprio: null, via: 'nenhum' });
      const i = await db.query<{ lid_proprio: string | null }>('select lid_proprio from instancias_wa');
      expect(i.rows[0].lid_proprio).toBeNull();
    });

    it('conta quantos números autorizados estão de fato nos grupos', async () => {
      estado.participantes = [
        { id: '111111111111111@lid', phoneNumber: POLI_TEL },
        { id: '222222222222222@lid', phoneNumber: `${DONO_TEL}@s.whatsapp.net` },
      ];
      const f = evolutionFalsa(estado);
      expect((await descobrirIdentificadores(db, EVO, 'inst-a', f, [DONO_TEL])).comandantesPresentes).toBe(1);
      expect((await descobrirIdentificadores(db, EVO, 'inst-a', f, ['5511888880000'])).comandantesPresentes).toBe(0);
      expect((await descobrirIdentificadores(db, EVO, 'inst-a', f)).comandantesPresentes).toBe(0);
    });

    it('ignora instância que não é de nenhum tenant', async () => {
      const r = await descobrirIdentificadores(db, EVO, 'outra', evolutionFalsa(estado));
      expect(r.participantes).toBe(0);
      expect(estado.chamadas).toEqual([]);
    });
  });

  describe('aprender das mensagens', () => {
    it('guarda o par quando o autor vem como LID e a mensagem traz o telefone', async () => {
      await gravarMensagem(db, 'inst-a', msgDeGrupo('oi', '222222222222222@lid', `${DONO_TEL}@s.whatsapp.net`));
      const l = await db.query<{ lid: string; telefone: string }>('select lid, telefone from lids');
      expect(l.rows).toEqual([{ lid: '222222222222222', telefone: DONO_TEL }]);
    });

    it('não guarda nada quando não há telefone para ligar', async () => {
      await gravarMensagem(db, 'inst-a', msgDeGrupo('oi', '222222222222222@lid'));
      expect((await db.query<{ n: string }>('select count(*)::text as n from lids')).rows[0].n).toBe('0');
    });
  });

  describe('reconhecer o pedido quando tudo chega como LID', () => {
    const dono = [DONO_TEL];

    it('reconhece a marcação pelo LID da Poli e autoriza o autor pelo par aprendido', async () => {
      await db.query(`update instancias_wa set lid_proprio = '111111111111111'`);
      await db.query(`insert into lids (workspace_id, lid, telefone) values (1, '222222222222222', '${DONO_TEL}')`);
      const m = msgDeGrupo('@111111111111111 link do Flaviômetro', '222222222222222@lid', undefined, ['111111111111111@lid']);
      const r = await avaliarPedido(db, 'inst-a', m, dono);
      expect(r).toMatchObject({ tipo: 'pedido', pedido: { consulta: 'link do Flaviômetro' } });
    });

    it('marcação de outro LID não ativa a Poli', async () => {
      await db.query(`update instancias_wa set lid_proprio = '111111111111111'`);
      await db.query(`insert into lids (workspace_id, lid, telefone) values (1, '222222222222222', '${DONO_TEL}')`);
      const m = msgDeGrupo('@999999999999999 vê isso', '222222222222222@lid', undefined, ['999999999999999@lid']);
      expect((await avaliarPedido(db, 'inst-a', m, dono)).tipo).toBe('ignorar');
    });

    it('sem o par aprendido, o LID do autor não é autorizado (e o log só mostra o tipo)', async () => {
      await db.query(`update instancias_wa set lid_proprio = '111111111111111'`);
      const m = msgDeGrupo('Poli2 oi', '222222222222222@lid');
      const r = await avaliarPedido(db, 'inst-a', m, dono);
      expect(r.tipo).toBe('nao_autorizado');
    });

    it('o par de outro tenant não autoriza este', async () => {
      await db.query(`insert into workspaces (nome) values ('Tenant B')`);
      await db.query(`insert into lids (workspace_id, lid, telefone) values (2, '222222222222222', '${DONO_TEL}')`);
      const m = msgDeGrupo('Poli2 oi', '222222222222222@lid');
      expect((await avaliarPedido(db, 'inst-a', m, dono)).tipo).toBe('nao_autorizado');
    });
  });
});

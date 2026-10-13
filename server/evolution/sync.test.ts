import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { sincronizarInstancias } from './sync';

const EVO = { url: 'http://evolution:8080', apiKey: 'chave-de-teste' };
const OPC = { webhookBase: 'http://poli2_app:3000', token: 'token-de-teste' };

interface Estado {
  instancias: string[];
  webhooks: Record<string, any>;
  chamadas: string[];
  quebrar?: Set<string>;
  soFormatoPlano?: boolean;
}

// Evolution falsa: guarda os webhooks que recebe e responde o que a v2 responderia.
function evolutionFalsa(estado: Estado): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const metodo = init.method ?? 'GET';
    estado.chamadas.push(`${metodo} ${url.pathname}`);
    const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

    if (init.headers?.apikey !== EVO.apiKey) return json({ erro: 'sem chave' }, 401);
    if (url.pathname === '/instance/fetchInstances') {
      return json(estado.instancias.map((name) => ({ name, connectionStatus: 'open' })));
    }
    const nome = decodeURIComponent(url.pathname.split('/').pop()!);
    if (estado.quebrar?.has(nome)) return json({ erro: 'quebrou' }, 500);
    if (url.pathname.startsWith('/webhook/find/')) return json(estado.webhooks[nome] ?? null);
    if (url.pathname.startsWith('/webhook/set/')) {
      const corpo = JSON.parse(init.body);
      if (estado.soFormatoPlano && corpo.webhook) return json({ erro: 'formato' }, 400);
      estado.webhooks[nome] = corpo.webhook ?? corpo;
      return json({ ok: true });
    }
    return json({}, 404);
  }) as typeof fetch;
}

describe('sincronizarInstancias', () => {
  let db: PGlite;
  let estado: Estado;

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    estado = { instancias: ['inst-a', 'inst-b'], webhooks: {}, chamadas: [] };
  });

  it('cria um tenant por instância e aponta o webhook para dentro da rede do projeto', async () => {
    const r = await sincronizarInstancias(db, EVO, OPC, evolutionFalsa(estado));
    expect(r.tenantsCriados).toEqual(['inst-a', 'inst-b']);
    expect(r.webhooksConfigurados).toEqual(['inst-a', 'inst-b']);
    expect(r.erros).toEqual([]);

    const t = await db.query<{ nome: string; evolution_instance: string }>(
      'select w.nome, i.evolution_instance from workspaces w join instancias_wa i on i.workspace_id = w.id order by w.id',
    );
    expect(t.rows.map((x) => x.evolution_instance)).toEqual(['inst-a', 'inst-b']);

    const wh = estado.webhooks['inst-a'];
    expect(wh.url).toBe('http://poli2_app:3000/webhooks/evolution/inst-a');
    expect(wh.headers['x-webhook-token']).toBe('token-de-teste');
    expect(wh.events).toEqual(['MESSAGES_UPSERT']);
    expect(wh.enabled).toBe(true);
  });

  it('é idempotente: na segunda rodada não cria nem reconfigura nada', async () => {
    const f = evolutionFalsa(estado);
    await sincronizarInstancias(db, EVO, OPC, f);
    estado.chamadas.length = 0;
    const r = await sincronizarInstancias(db, EVO, OPC, f);
    expect(r.tenantsCriados).toEqual([]);
    expect(r.webhooksConfigurados).toEqual([]);
    expect(estado.chamadas.some((c) => c.startsWith('POST /webhook/set'))).toBe(false);
    const n = await db.query<{ n: string }>('select count(*)::text as n from workspaces');
    expect(n.rows[0].n).toBe('2');
  });

  it('reconfigura se alguém mudou o endereço do webhook', async () => {
    const f = evolutionFalsa(estado);
    await sincronizarInstancias(db, EVO, OPC, f);
    estado.webhooks['inst-a'].url = 'http://outro-lugar/hook';
    const r = await sincronizarInstancias(db, EVO, OPC, f);
    expect(r.webhooksConfigurados).toEqual(['inst-a']);
    expect(estado.webhooks['inst-a'].url).toBe('http://poli2_app:3000/webhooks/evolution/inst-a');
  });

  it('usa o formato plano se a Evolution não aceita o embrulhado', async () => {
    estado.soFormatoPlano = true;
    const r = await sincronizarInstancias(db, EVO, OPC, evolutionFalsa(estado));
    expect(r.erros).toEqual([]);
    expect(estado.webhooks['inst-a'].url).toBe('http://poli2_app:3000/webhooks/evolution/inst-a');
  });

  it('uma instância com erro não trava as outras e o erro não vaza o corpo da resposta', async () => {
    estado.quebrar = new Set(['inst-a']);
    const r = await sincronizarInstancias(db, EVO, OPC, evolutionFalsa(estado));
    expect(r.webhooksConfigurados).toEqual(['inst-b']);
    expect(r.erros).toHaveLength(1);
    expect(r.erros[0]).toContain('inst-a');
    expect(r.erros[0]).not.toContain('quebrou');
  });

  it('não reaproveita o tenant de outra instância', async () => {
    await db.query(`insert into workspaces (nome) values ('Campanha existente')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance) values (1, 'inst-a')`);
    const r = await sincronizarInstancias(db, EVO, OPC, evolutionFalsa(estado));
    expect(r.tenantsCriados).toEqual(['inst-b']);
    const nome = await db.query<{ nome: string }>(`select w.nome from workspaces w join instancias_wa i on i.workspace_id = w.id where i.evolution_instance = 'inst-a'`);
    expect(nome.rows[0].nome).toBe('Campanha existente');
  });
});

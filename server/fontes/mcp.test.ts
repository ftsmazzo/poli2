import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { cifrar } from '../painel/cripto';
import { adaptar, cabecalhosDaFonte, ferramentasMcp, pareceLeitura, testarFonte, urlValida, type ConectorMcp } from './mcp';

const CHAVE = 'chave-de-teste-com-mais-de-16';

// Servidor MCP de verdade, ligado ao cliente por um canal em memória.
function servidorDeTeste() {
  const chamadas: string[] = [];
  const conexoes: { headers: Record<string, string> }[] = [];
  let ferramentas: 'todas' | 'sem_escrita' = 'todas';

  const novoServidor = () => {
    const s = new McpServer({ name: 'urna', version: '1.0.0' });
    s.tool('buscar_votos', 'Votos de um município', { municipio: z.string() }, async ({ municipio }) => {
      chamadas.push(`buscar_votos:${municipio}`);
      return { content: [{ type: 'text' as const, text: `votos em ${municipio}: 1234` }] };
    });
    if (ferramentas === 'todas') {
      s.tool('apagar_dados', 'Apaga tudo', async () => ({ content: [{ type: 'text' as const, text: 'apagado' }] }));
    }
    s.tool('processar_lote', 'Roda um processamento só de leitura', {}, { readOnlyHint: true }, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    s.tool('quebrada', 'Sempre falha', async () => ({ isError: true, content: [{ type: 'text' as const, text: 'base fora do ar' }] }));
    return s;
  };

  const conectar: ConectorMcp = async ({ headers }) => {
    conexoes.push({ headers });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await novoServidor().connect(st);
    const client = new Client({ name: 'teste', version: '1.0.0' });
    await client.connect(ct);
    return adaptar(client);
  };
  return { conectar, chamadas, conexoes, remover: () => (ferramentas = 'sem_escrita') };
}

describe('pareceLeitura e urlValida', () => {
  it('a dica do servidor vale mais que o nome', () => {
    expect(pareceLeitura('processar_lote', { readOnlyHint: true })).toBe(true);
    expect(pareceLeitura('buscar_votos', { destructiveHint: true })).toBe(false);
  });

  it('pelo nome: leitura liga, escrita ou dúvida desliga', () => {
    for (const n of ['buscar_votos', 'get_candidato', 'listar_municipios', 'search']) expect(pareceLeitura(n)).toBe(true);
    for (const n of ['apagar_dados', 'delete_row', 'enviar_mensagem', 'create_user', 'processar_lote', 'update_get']) expect(pareceLeitura(n)).toBe(false);
  });

  it('aceita http(s) e recusa o resto e o endereço de metadados da nuvem', () => {
    expect(urlValida('https://mcp.exemplo.com/mcp')).toBe(true);
    expect(urlValida('http://poli2_mcp:3000/mcp')).toBe(true);
    expect(urlValida('ftp://x.com')).toBe(false);
    expect(urlValida('http://169.254.169.254/latest')).toBe(false);
    expect(urlValida('não é url')).toBe(false);
  });
});

describe('cabecalhosDaFonte', () => {
  it('põe Bearer no Authorization, respeita cabeçalho próprio e não inventa sem segredo', () => {
    expect(cabecalhosDaFonte({}, cifrar('abc123', CHAVE), CHAVE)).toEqual({ Authorization: 'Bearer abc123' });
    expect(cabecalhosDaFonte({}, cifrar('Bearer ja-tem', CHAVE), CHAVE)).toEqual({ Authorization: 'Bearer ja-tem' });
    expect(cabecalhosDaFonte({ headerNome: 'X-Api-Key' }, cifrar('abc123', CHAVE), CHAVE)).toEqual({ 'X-Api-Key': 'abc123' });
    expect(cabecalhosDaFonte({}, null, CHAVE)).toEqual({});
  });
});

describe('Fontes MCP', () => {
  let db: PGlite;

  async function fonte(ws: number, nome: string, extra: { segredo?: string; escopo?: unknown; status?: string; ativa?: boolean; url?: string; quando?: string } = {}) {
    const r = await db.query<{ id: number }>(
      `insert into fontes (workspace_id, tipo, nome, config, segredo_enc, quando_usar, escopo, status, ativa)
       values ($1, 'mcp', $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8) returning id`,
      [
        ws,
        nome,
        JSON.stringify({ url: extra.url ?? 'https://mcp.exemplo.com/mcp' }),
        extra.segredo ? cifrar(extra.segredo, CHAVE) : null,
        extra.quando ?? '',
        JSON.stringify(extra.escopo ?? { papeis: ['head', 'vip'], grupos: 'todos' }),
        extra.status ?? 'nunca_testada',
        extra.ativa ?? true,
      ],
    );
    return r.rows[0].id;
  }

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A'), ('Tenant B')`);
  });

  describe('adaptar', () => {
    it('lista as ferramentas com esquema e leitura/escrita, e chama uma delas', async () => {
      const s = servidorDeTeste();
      const c = await s.conectar({ url: 'x', headers: {} });
      const lista = await c.listarFerramentas();
      expect(lista.map((t) => [t.nome, t.somenteLeitura])).toEqual(
        expect.arrayContaining([['buscar_votos', true], ['apagar_dados', false], ['processar_lote', true]]),
      );
      expect(lista.find((t) => t.nome === 'buscar_votos')?.esquema).toMatchObject({ type: 'object', properties: { municipio: { type: 'string' } } });
      expect(await c.chamar('buscar_votos', { municipio: 'Macapá' })).toBe('votos em Macapá: 1234');
      expect(await c.chamar('quebrada', {})).toBe('Erro da fonte: base fora do ar');
      await c.fechar();
    });
  });

  describe('testarFonte', () => {
    it('conecta com o segredo decifrado, guarda as ferramentas e marca a Fonte como ok', async () => {
      const s = servidorDeTeste();
      const id = await fonte(1, 'Urna TSE', { segredo: 'token-da-urna' });
      const r = await testarFonte(db, s.conectar, CHAVE, 1, id);
      expect(r).toMatchObject({ ok: true, ferramentas: 4 });
      expect(s.conexoes[0].headers).toEqual({ Authorization: 'Bearer token-da-urna' });

      const f = await db.query<{ status: string; ultimo_erro: string | null; latencia_ms: number }>('select status, ultimo_erro, latencia_ms from fontes');
      expect(f.rows[0]).toMatchObject({ status: 'ok', ultimo_erro: null });
      expect(f.rows[0].latencia_ms).toBeGreaterThanOrEqual(0);

      const t = await db.query<{ nome: string; ativa: boolean }>('select nome, ativa from fonte_tools order by nome');
      // Leitura liga sozinha; o que escreve (ou é dúvida) nasce desligado.
      expect(Object.fromEntries(t.rows.map((x) => [x.nome, x.ativa]))).toEqual({ apagar_dados: false, buscar_votos: true, processar_lote: true, quebrada: false });
    });

    it('guarda o que o admin ligou ou desligou e some com ferramenta que deixou de existir', async () => {
      const s = servidorDeTeste();
      const id = await fonte(1, 'Urna TSE');
      await testarFonte(db, s.conectar, CHAVE, 1, id);
      await db.query(`update fonte_tools set ativa = true where nome = 'apagar_dados'`);
      await db.query(`update fonte_tools set ativa = false where nome = 'buscar_votos'`);
      s.remover();
      await testarFonte(db, s.conectar, CHAVE, 1, id);
      const t = await db.query<{ nome: string; ativa: boolean }>('select nome, ativa from fonte_tools order by nome');
      expect(Object.fromEntries(t.rows.map((x) => [x.nome, x.ativa]))).toEqual({ buscar_votos: false, processar_lote: true, quebrada: false });
    });

    it('se não conectar, registra o erro e a Fonte fica fora do ar', async () => {
      const id = await fonte(1, 'Fora do ar', { status: 'ok' });
      const r = await testarFonte(db, async () => { throw new Error('connect ECONNREFUSED'); }, CHAVE, 1, id);
      expect(r).toMatchObject({ ok: false, erro: 'connect ECONNREFUSED' });
      const f = await db.query<{ status: string; ultimo_erro: string }>('select status, ultimo_erro from fontes');
      expect(f.rows[0]).toEqual({ status: 'erro', ultimo_erro: 'connect ECONNREFUSED' });
    });

    it('recusa endereço inválido sem tentar conectar, e não testa Fonte de outro tenant', async () => {
      let tentou = false;
      const id = await fonte(1, 'Ruim', { url: 'http://169.254.169.254/x' });
      const r = await testarFonte(db, async () => { tentou = true; throw new Error('x'); }, CHAVE, 1, id);
      expect(r).toMatchObject({ ok: false, erro: 'Endereço da Fonte inválido' });
      expect(tentou).toBe(false);
      expect(await testarFonte(db, async () => { throw new Error('x'); }, CHAVE, 2, id)).toBeNull();
    });
  });

  describe('ferramentasMcp', () => {
    async function pronta(ws = 1, nome = 'Urna TSE', extra = {}) {
      const s = servidorDeTeste();
      const id = await fonte(ws, nome, extra);
      await testarFonte(db, s.conectar, CHAVE, ws, id);
      return { s, id };
    }

    it('entrega só as ferramentas ligadas de Fontes ativas e testadas, com o nome da Fonte na descrição', async () => {
      const { s } = await pronta(1, 'Urna TSE', { quando: 'dados de votação' });
      const f = await ferramentasMcp(db, s.conectar, CHAVE, 1, null);
      const nomes = f.specs.map((x) => x.function.name);
      expect(nomes.some((n) => n.endsWith('__buscar_votos'))).toBe(true);
      expect(nomes.some((n) => n.endsWith('__apagar_dados'))).toBe(false);
      expect(nomes.every((n) => /^f\d+__[a-zA-Z0-9_-]+$/.test(n) && n.length <= 64)).toBe(true);
      const votos = f.specs.find((x) => x.function.name.endsWith('__buscar_votos'))!;
      expect(votos.function.description).toContain('[Fonte: Urna TSE]');
      // O "Quando usar" não se repete em cada ferramenta: vai uma vez só, em "orientacoes", com os nomes das ferramentas da Fonte.
      expect(votos.function.description).not.toContain('Quando usar');
      expect(f.orientacoes).toContain('Fonte "Urna TSE"');
      expect(f.orientacoes).toContain('Quando usar: dados de votação');
      expect(f.orientacoes).toContain(votos.function.name);
      expect(f.orientacoes.match(/Quando usar/g)).toHaveLength(1);
      expect(votos.function.parameters).toMatchObject({ type: 'object', properties: { municipio: { type: 'string' } } });
    });

    it('chama a ferramenta e devolve o resultado como dado, identificando a Fonte', async () => {
      const { s } = await pronta();
      const f = await ferramentasMcp(db, s.conectar, CHAVE, 1, null);
      const nome = f.specs.find((x) => x.function.name.endsWith('__buscar_votos'))!.function.name;
      expect(f.ehMinha(nome)).toBe(true);
      expect(await f.executar(nome, JSON.stringify({ municipio: 'Macapá' }))).toEqual({ fonte: 'Urna TSE', dados: 'votos em Macapá: 1234' });
      await f.fechar();
    });

    it('não entrega Fonte desligada, nunca testada, com erro, nem de outro tenant', async () => {
      await pronta(1, 'Desligada', { ativa: false });
      await fonte(1, 'Nunca testada');
      await fonte(1, 'Com erro', { status: 'erro' });
      const { s } = await pronta(2, 'Do outro tenant');
      const f = await ferramentasMcp(db, s.conectar, CHAVE, 1, null);
      expect(f.specs).toEqual([]);
    });

    it('respeita o escopo de grupos da Fonte', async () => {
      const { s } = await pronta(1, 'Só grupo 7', { escopo: { papeis: ['head'], grupos: [7] } });
      expect((await ferramentasMcp(db, s.conectar, CHAVE, 1, 7)).specs.length).toBeGreaterThan(0);
      expect((await ferramentasMcp(db, s.conectar, CHAVE, 1, 8)).specs).toEqual([]);
      expect((await ferramentasMcp(db, s.conectar, CHAVE, 1, null)).specs).toEqual([]);
    });

    it('se a Fonte cair no meio do turno, devolve o erro em vez de quebrar', async () => {
      const { s } = await pronta();
      const f = await ferramentasMcp(db, async () => { throw new Error('timeout'); }, CHAVE, 1, null);
      const nome = f.specs[0].function.name;
      expect(await f.executar(nome, '{}')).toEqual({ fonte: 'Urna TSE', erro: 'Falha ao consultar a fonte: timeout' });
      expect(await f.executar('f999__x', '{}')).toMatchObject({ erro: expect.stringContaining('desconhecida') });
      expect(await f.executar(nome, '{ruim')).toMatchObject({ erro: expect.stringContaining('inválidos') });
      void s;
    });
  });
});

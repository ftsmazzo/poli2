import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairItensPendentes } from '../extrair/persistir';
import { aplicarGates, SEM_RESULTADO } from './gates';
import type { Chat, RespostaChat } from './llm';
import type { Pedido } from './pedido';
import { responderPedido } from './turno';

const GRUPO = '1203@g.us';

const pedido = (id = 'PED1', consulta = 'link do plano'): Pedido => ({
  workspaceId: 1,
  instancia: 'inst-a',
  grupoJid: GRUPO,
  grupoNome: 'Inteligência Eleitoral',
  autorNome: 'Dono',
  consulta,
  waMessageId: id,
});

const chamada = (nome: string, args: unknown, id = 't1') => ({
  id,
  type: 'function' as const,
  function: { name: nome, arguments: JSON.stringify(args) },
});

describe('aplicarGates', () => {
  const evidencia = JSON.stringify({ itens: [{ valor: 'https://exemplo.com/plano', dados: { telefones: ['+5596991234567'] } }], texto: 'ligue (96) 99123-4567' });

  it('mantém link e telefone que estão nas evidências, mesmo escritos de outro jeito', () => {
    const r = aplicarGates('Plano: www.exemplo.com/plano?utm_source=x\nTelefone: 96 99123-4567', evidencia);
    expect(r).toContain('exemplo.com/plano');
    expect(r).toContain('96 99123-4567');
  });

  it('corta a linha com link ou telefone que o modelo inventou', () => {
    const r = aplicarGates('Plano: https://exemplo.com/plano\nOutro: https://inventado.com/x\nFale: 96 98888-7777', evidencia);
    expect(r).toBe('Plano: https://exemplo.com/plano');
  });

  it('sem nada que reste, devolve a frase padrão', () => {
    expect(aplicarGates('Veja https://inventado.com/x', evidencia)).toBe(SEM_RESULTADO);
    expect(aplicarGates('   ', evidencia)).toBe(SEM_RESULTADO);
  });

  it('tira o travessão e limita o tamanho', () => {
    expect(aplicarGates('Achei — e é isso', evidencia)).toBe('Achei - e é isso');
    const longa = Array.from({ length: 200 }, (_, i) => `linha número ${i} com algum texto`).join('\n');
    const r = aplicarGates(longa, evidencia);
    expect(r.length).toBeLessThanOrEqual(1530);
    expect(r.endsWith('(resposta cortada)')).toBe(true);
  });
});

describe('responderPedido', () => {
  let db: PGlite;
  let enviados: { instancia: string; jid: string; texto: string }[];
  let chamadasPorModelo: Record<string, number>;
  let mensagensAoRedator: string[];

  function chat(roteiro: { orquestrador: (n: number) => RespostaChat; redatora: (conversa: string) => RespostaChat }): Chat {
    return async ({ model, messages }) => {
      chamadasPorModelo[model] = (chamadasPorModelo[model] ?? 0) + 1;
      if (model === 'orq') return roteiro.orquestrador(chamadasPorModelo[model] - 1);
      const conversa = messages.map((m) => m.content ?? '').join('\n');
      mensagensAoRedator.push(conversa);
      return roteiro.redatora(conversa);
    };
  }
  const deps = (c: Chat, enviar?: (i: string, j: string, t: string) => Promise<{ waMessageId: string | null }>) => ({
    db,
    chat: c,
    modelos: { orquestrador: 'orq', redatora: 'red' },
    enviar:
      enviar ??
      (async (instancia: string, jid: string, texto: string) => {
        enviados.push({ instancia, jid, texto });
        return { waMessageId: 'ENV1' };
      }),
  });
  const buscaDeLink = (n: number): RespostaChat =>
    n === 0
      ? { content: null, toolCalls: [chamada('buscar_itens', { tipo: 'link', termo: 'plano' })] }
      : { content: 'Achei o link do plano.', toolCalls: [] };

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    enviados = [];
    chamadasPorModelo = {};
    mensagensAoRedator = [];
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '${GRUPO}', 'Inteligência Eleitoral')`);
    await db.query(`insert into pessoas (workspace_id, nome, papel) values (1, 'Fulano', 'outro')`);
    await db.query(
      `insert into mensagens (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, enviada_em, tipo, texto)
       values (1, 1, 'M1', 1, '2026-10-10T09:00:00-03:00', 'texto', 'O plano de campanha está em https://exemplo.com/plano')`,
    );
    await extrairItensPendentes(db);
  });

  it('busca, redige com as evidências, corta o que o modelo inventou, responde no grupo e registra', async () => {
    const c = chat({
      orquestrador: buscaDeLink,
      redatora: () => ({ content: 'O plano está aqui (Fulano, 10/10 09:00):\nhttps://exemplo.com/plano\nOutro: https://inventado.com/x', toolCalls: [] }),
    });
    expect(await responderPedido(deps(c), pedido())).toBe('respondido');

    expect(enviados).toEqual([{ instancia: 'inst-a', jid: GRUPO, texto: 'O plano está aqui (Fulano, 10/10 09:00):\nhttps://exemplo.com/plano' }]);
    // O redator recebeu o pedido, as notas e a evidência com o link real.
    expect(mensagensAoRedator[0]).toContain('link do plano');
    expect(mensagensAoRedator[0]).toContain('Achei o link do plano.');
    expect(mensagensAoRedator[0]).toContain('https://exemplo.com/plano');

    const t = await db.query<{ tools: string[]; resposta: string; latencia_ms: number; modelo: string }>('select tools, resposta, latencia_ms, modelo from turnos');
    expect(t.rows[0]).toMatchObject({ tools: ['buscar_itens'], modelo: 'red', resposta: enviados[0].texto });
    expect(t.rows[0].latencia_ms).toBeGreaterThanOrEqual(0);
    const s = await db.query<{ estado: string; origem: string; wa_message_id: string }>('select estado, origem, wa_message_id from mensagens_saida');
    expect(s.rows).toEqual([{ estado: 'enviada', origem: 'resposta', wa_message_id: 'ENV1' }]);
  });

  it('nunca responde duas vezes ao mesmo pedido', async () => {
    const c = chat({ orquestrador: buscaDeLink, redatora: () => ({ content: 'https://exemplo.com/plano', toolCalls: [] }) });
    expect(await responderPedido(deps(c), pedido('PED1'))).toBe('respondido');
    expect(await responderPedido(deps(c), pedido('PED1'))).toBe('duplicado');
    expect(enviados).toHaveLength(1);
    expect(await responderPedido(deps(c), pedido('PED2'))).toBe('respondido');
    expect(enviados).toHaveLength(2);
  });

  it('se o modelo falhar, avisa que não deu e registra o erro', async () => {
    const c: Chat = async () => {
      throw new Error('OpenRouter respondeu 500');
    };
    expect(await responderPedido(deps(c), pedido())).toBe('erro');
    expect(enviados[0].texto).toBe('Não consegui responder agora. Tenta de novo em instantes.');
  });

  it('se o envio falhar, registra a mensagem como falha', async () => {
    const c = chat({ orquestrador: buscaDeLink, redatora: () => ({ content: 'https://exemplo.com/plano', toolCalls: [] }) });
    const r = await responderPedido(
      deps(c, async () => {
        throw new Error('Evolution POST /message/sendText respondeu 500');
      }),
      pedido(),
    );
    expect(r).toBe('erro');
    const s = await db.query<{ estado: string; tentativas: number }>('select estado, tentativas from mensagens_saida');
    expect(s.rows).toEqual([{ estado: 'falhou', tentativas: 1 }]);
  });

  it('para de buscar depois de 6 passos e ainda assim responde', async () => {
    const c = chat({
      orquestrador: () => ({ content: null, toolCalls: [chamada('listar_grupos', {})] }),
      redatora: () => ({ content: 'Só consegui listar os grupos.', toolCalls: [] }),
    });
    expect(await responderPedido(deps(c), pedido())).toBe('respondido');
    expect(chamadasPorModelo.orq).toBe(6);
    expect(enviados[0].texto).toBe('Só consegui listar os grupos.');
  });

  it('ferramenta desconhecida pedida pelo modelo não derruba o turno', async () => {
    const c = chat({
      orquestrador: (n) => (n === 0 ? { content: null, toolCalls: [chamada('apagar_tudo', {})] } : { content: 'nada', toolCalls: [] }),
      redatora: () => ({ content: 'Não achei.', toolCalls: [] }),
    });
    expect(await responderPedido(deps(c), pedido())).toBe('respondido');
    expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens')).rows[0].n).toBe('1');
  });
});

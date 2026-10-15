import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairItensPendentes } from '../extrair/persistir';
import type { Chat } from './llm';
import { ehPedidoDeMd, entregarMdDoDia, gerarMdDoDia, type DepsMd } from './md';
import type { Pedido } from './pedido';

const AGORA = new Date('2026-10-15T18:00:00-03:00');
const HOJE = '2026-10-15';

describe('ehPedidoDeMd', () => {
  it('reconhece pedidos curtos de MD, com hoje como padrão', () => {
    expect(ehPedidoDeMd('gera o MD de hoje')).toEqual({ quando: 'hoje' });
    expect(ehPedidoDeMd('md do dia')).toEqual({ quando: 'hoje' });
    expect(ehPedidoDeMd('Manda o markdown de ontem, por favor!')).toEqual({ quando: 'ontem' });
    expect(ehPedidoDeMd('MD')).toEqual({ quando: 'hoje' });
  });

  it('não confunde com pergunta comum', () => {
    expect(ehPedidoDeMd('resume o grupo de hoje')).toBeNull();
    expect(ehPedidoDeMd('qual o link do plano?')).toBeNull();
    expect(ehPedidoDeMd('o Dr. Silva do MD falou que a reunião do comitê muda de lugar amanhã cedo')).toBeNull();
  });
});

describe('MD do dia', () => {
  let db: PGlite;
  let wa = 0;

  const msg = (ws: number, grupo: number, texto: string | null, quando: string, autor: number | null = 1) =>
    db.query(
      `insert into mensagens (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, enviada_em, tipo, texto) values ($1, $2, $3, $4, $5, 'texto', $6)`,
      [ws, grupo, `W${++wa}`, autor, quando, texto],
    );
  const pedido: Pedido = { workspaceId: 1, instancia: 'inst-a', grupoJid: '9@g.us', grupoNome: null, autorNome: 'Dono', consulta: 'md de hoje', waMessageId: 'P1', telefoneAutor: null };

  const resumoDoModelo = '### Principais assuntos\n- Reunião marcada para sábado (Ary, 14:20)\nVeja https://inventado.com/x\n### Pendências e prazos\n- Ary ficou de levantar o endereço do comitê';
  const chatOk: Chat = async () => ({ content: resumoDoModelo, toolCalls: [] });

  beforeEach(async () => {
    wa = 0;
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('A'), ('B')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'Inteligência Eleitoral'), (1, '2@g.us', 'Grupo parado'), (2, '3@g.us', 'Outro Tenant')`);
    await db.query(`insert into pessoas (workspace_id, nome, papel) values (1, 'Ary', 'outro'), (2, 'Beto', 'outro')`);
  });

  describe('gerarMdDoDia', () => {
    it('monta o resumo do dia por grupo, com links do banco e sem o que o modelo inventou', async () => {
      await msg(1, 1, 'Reunião marcada para sábado', '2026-10-15T14:20:00-03:00');
      await msg(1, 1, 'O plano está em https://exemplo.com/plano', '2026-10-15T15:00:00-03:00');
      await extrairItensPendentes(db);

      const md = await gerarMdDoDia(db, chatOk, 'modelo', 1, HOJE, AGORA);
      expect(md).not.toBeNull();
      expect(md!.nomeArquivo).toBe('poli-md-2026-10-15.md');
      expect(md!.grupos).toBe(1);
      expect(md!.mensagens).toBe(2);
      const t = md!.markdown;
      expect(t).toContain('# Resumo do dia: quinta-feira, 15/10/2026');
      expect(t).toContain('## Inteligência Eleitoral (2 mensagens)');
      expect(t).toContain('Reunião marcada para sábado (Ary, 14:20)');
      expect(t).toContain('### Pendências e prazos');
      // O link que o modelo inventou some; o link real aparece na lista, com quem mandou e a hora.
      expect(t).not.toContain('inventado.com');
      expect(t).toContain('**Links**\n- https://exemplo.com/plano (Ary, 15:00)');
    });

    it('usa o dia de Belém: 01:00 do dia 15 entra, 23:30 do dia 14 não', async () => {
      await msg(1, 1, 'madrugada do dia 15', '2026-10-15T01:00:00-03:00');
      await msg(1, 1, 'noite do dia 14', '2026-10-14T23:30:00-03:00');
      let visto = '';
      const chat: Chat = async ({ messages }) => {
        visto = messages.map((m) => m.content ?? '').join('\n');
        return { content: '- ok', toolCalls: [] };
      };
      const md = await gerarMdDoDia(db, chat, 'modelo', 1, HOJE, AGORA);
      expect(md!.mensagens).toBe(1);
      expect(visto).toContain('madrugada do dia 15');
      expect(visto).not.toContain('noite do dia 14');
    });

    it('deixa de fora grupo sem mensagem no dia e nunca mistura outro tenant', async () => {
      await msg(1, 1, 'conversa de hoje do tenant A', '2026-10-15T10:00:00-03:00');
      await msg(1, 2, 'conversa antiga', '2026-10-10T10:00:00-03:00');
      await msg(2, 3, 'conversa de hoje do tenant B', '2026-10-15T10:00:00-03:00', 2);
      const vistas: string[] = [];
      const chat: Chat = async ({ messages }) => {
        vistas.push(messages.map((m) => m.content ?? '').join('\n'));
        return { content: '- ok', toolCalls: [] };
      };
      const md = await gerarMdDoDia(db, chat, 'modelo', 1, HOJE, AGORA);
      expect(md!.markdown).toContain('Inteligência Eleitoral');
      expect(md!.markdown).not.toContain('Grupo parado');
      expect(md!.markdown).not.toContain('Outro Tenant');
      expect(vistas.join('\n')).not.toContain('tenant B');
    });

    it('sem nenhuma mensagem no dia, não gera arquivo', async () => {
      expect(await gerarMdDoDia(db, chatOk, 'modelo', 1, HOJE, AGORA)).toBeNull();
    });

    it('se o modelo falhar em um grupo, o arquivo sai mesmo assim, com os links', async () => {
      await msg(1, 1, 'veja https://exemplo.com/plano', '2026-10-15T15:00:00-03:00');
      await extrairItensPendentes(db);
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const md = await gerarMdDoDia(
        db,
        async () => {
          throw new Error('fora do ar');
        },
        'modelo',
        1,
        HOJE,
        AGORA,
      );
      erro.mockRestore();
      expect(md!.markdown).toContain('Não consegui resumir este grupo agora');
      expect(md!.markdown).toContain('https://exemplo.com/plano');
    });
  });

  describe('entregarMdDoDia', () => {
    const montar = (sobre: Partial<DepsMd> = {}) => {
      const textos: string[] = [];
      const docs: { destino: string; nomeArquivo: string; mime: string; conteudo: string }[] = [];
      const deps: DepsMd = {
        db,
        chat: chatOk,
        modelo: 'modelo',
        agora: () => AGORA,
        enviarTexto: async (_i, _d, t) => {
          textos.push(t);
          return { waMessageId: 'T1' };
        },
        enviarDocumento: async (_i, destino, d) => {
          docs.push({ destino, nomeArquivo: d.nomeArquivo, mime: d.mime, conteudo: d.conteudo });
          return { waMessageId: 'D1' };
        },
        ...sobre,
      };
      return { deps, textos, docs };
    };

    it('avisa que começou, manda o arquivo .md para quem pediu e registra o envio', async () => {
      await msg(1, 1, 'Reunião marcada para sábado', '2026-10-15T14:20:00-03:00');
      const { deps, textos, docs } = montar();
      expect(await entregarMdDoDia(deps, pedido, 'hoje')).toBe('enviado');
      expect(textos).toEqual(['Gerando o MD de hoje, um instante.']);
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ destino: '9@g.us', nomeArquivo: 'poli-md-2026-10-15.md', mime: 'text/markdown' });
      expect(docs[0].conteudo).toContain('## Inteligência Eleitoral');
      const s = await db.query<{ origem: string; estado: string; destino_tipo: string }>('select origem, estado, destino_tipo from mensagens_saida');
      expect(s.rows).toEqual([{ origem: 'md', estado: 'enviada', destino_tipo: 'grupo' }]);
    });

    it('"ontem" usa o dia anterior', async () => {
      await msg(1, 1, 'conversa de ontem', '2026-10-14T10:00:00-03:00');
      const { deps, docs } = montar();
      expect(await entregarMdDoDia(deps, pedido, 'ontem')).toBe('enviado');
      expect(docs[0].nomeArquivo).toBe('poli-md-2026-10-14.md');
    });

    it('no privado, registra como privado e responde para o próprio contato', async () => {
      await msg(1, 1, 'conversa de hoje', '2026-10-15T10:00:00-03:00');
      const { deps, docs } = montar();
      await entregarMdDoDia(deps, { ...pedido, grupoJid: '5511987654321@s.whatsapp.net', privado: true }, 'hoje');
      expect(docs[0].destino).toBe('5511987654321@s.whatsapp.net');
      const s = await db.query<{ destino_tipo: string }>('select destino_tipo from mensagens_saida');
      expect(s.rows[0].destino_tipo).toBe('privado');
    });

    it('se o WhatsApp recusar o arquivo, manda o texto em vez de ficar sem nada', async () => {
      await msg(1, 1, 'Reunião marcada para sábado', '2026-10-15T14:20:00-03:00');
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { deps, textos } = montar({
        enviarDocumento: async () => {
          throw new Error('recusou');
        },
      });
      expect(await entregarMdDoDia(deps, pedido, 'hoje')).toBe('texto');
      erro.mockRestore();
      expect(textos[1]).toContain('# Resumo do dia');
      const s = await db.query<{ texto: string; estado: string }>('select texto, estado from mensagens_saida');
      expect(s.rows).toEqual([{ texto: '[MD enviado como texto]', estado: 'enviada' }]);
    });

    it('sem mensagens no dia, avisa em uma frase e não manda arquivo', async () => {
      const { deps, textos, docs } = montar();
      expect(await entregarMdDoDia(deps, pedido, 'hoje')).toBe('vazio');
      expect(docs).toEqual([]);
      expect(textos[1]).toMatch(/Não houve mensagens de texto nos grupos em quinta-feira, 15\/10\/2026/);
    });
  });
});

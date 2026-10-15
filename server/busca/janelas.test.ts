import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { criarFerramentas } from '../agente/ferramentas';
import { DIMENSOES, criarEmbedderOpenRouter, type Embedder } from './embeddings';
import { indexarJanelas, MENSAGENS_POR_JANELA, PAUSA_PARA_FECHAR_MS } from './janelas';

const AGORA = new Date('2026-10-15T12:00:00-03:00');

// Vetor de mentira: o assunto decide a posição. Mesmo assunto = mesmo vetor = parecidos; assuntos diferentes = distantes.
const assunto = (texto: string) => (/encontro|reuni/i.test(texto) ? 0 : /plano|saúde/i.test(texto) ? 1 : 2);
const embedFalso: Embedder = async (textos) =>
  textos.map((t) => {
    const v = new Array<number>(DIMENSOES).fill(0);
    v[assunto(t)] = 1;
    return v;
  });

describe('janelas e busca por significado', () => {
  let db: PGlite;
  let n = 0;

  async function msg(ws: number, grupo: number, texto: string | null, quando: string, tipo = 'texto') {
    n++;
    await db.query(
      `insert into mensagens (workspace_id, grupo_id, wa_message_id, enviada_em, tipo, texto) values ($1, $2, $3, $4, $5, $6)`,
      [ws, grupo, `W${n}`, quando, tipo, texto],
    );
  }
  const muitas = async (ws: number, grupo: number, quantas: number, texto: (i: number) => string, quando = '2026-10-14T09:00:00-03:00') => {
    for (let i = 0; i < quantas; i++) await msg(ws, grupo, texto(i), quando);
  };
  const janelas = async () =>
    (await db.query<{ de_msg_id: string; ate_msg_id: string; texto: string; workspace_id: string }>('select de_msg_id, ate_msg_id, texto, workspace_id from janelas order by id')).rows;

  beforeEach(async () => {
    n = 0;
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('A'), ('B')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '1@g.us', 'Inteligência Eleitoral'), (2, '2@g.us', 'Outro Tenant')`);
  });

  describe('indexarJanelas', () => {
    it('agrupa as mensagens de 10 em 10, fecha a última incompleta quando o grupo ficou parado e guarda o vetor', async () => {
      await muitas(1, 1, 25, (i) => `mensagem ${i} sobre o plano`);
      expect(await indexarJanelas(db, embedFalso, AGORA)).toEqual({ janelas: 3 });
      const j = await janelas();
      expect(j.map((x) => [Number(x.de_msg_id), Number(x.ate_msg_id)])).toEqual([[1, 10], [11, 20], [21, 25]]);
      const comVetor = await db.query<{ n: string }>('select count(*)::text as n from janelas where embedding is not null');
      expect(comVetor.rows[0].n).toBe('3');
      expect(j[0].texto).toContain('mensagem 0 sobre o plano');
    });

    it('não fecha a janela incompleta enquanto a conversa está andando, e fecha depois da pausa', async () => {
      await muitas(1, 1, 4, (i) => `mensagem ${i}`, new Date(AGORA.getTime() - 5 * 60_000).toISOString());
      expect(await indexarJanelas(db, embedFalso, AGORA)).toEqual({ janelas: 0 });
      expect(await indexarJanelas(db, embedFalso, new Date(AGORA.getTime() + PAUSA_PARA_FECHAR_MS))).toEqual({ janelas: 1 });
    });

    it('é idempotente e só indexa o que chegou depois da última janela', async () => {
      await muitas(1, 1, MENSAGENS_POR_JANELA, (i) => `antiga ${i}`);
      await indexarJanelas(db, embedFalso, AGORA);
      expect(await indexarJanelas(db, embedFalso, AGORA)).toEqual({ janelas: 0 });
      await muitas(1, 1, MENSAGENS_POR_JANELA, (i) => `nova ${i}`);
      expect(await indexarJanelas(db, embedFalso, AGORA)).toEqual({ janelas: 1 });
      const j = await janelas();
      expect(j).toHaveLength(2);
      expect(j[1].texto).toContain('nova 0');
      expect(j[1].texto).not.toContain('antiga');
    });

    it('ignora mensagem sem texto e figurinha', async () => {
      await muitas(1, 1, 8, (i) => `texto ${i}`);
      await msg(1, 1, null, '2026-10-14T09:00:00-03:00', 'imagem');
      await msg(1, 1, 'sticker', '2026-10-14T09:00:00-03:00', 'sticker');
      await indexarJanelas(db, embedFalso, AGORA);
      const j = await janelas();
      expect(j).toHaveLength(1);
      expect(j[0].texto.split('\n')).toHaveLength(8);
    });

    it('cada janela fica no tenant e no grupo da mensagem', async () => {
      await muitas(1, 1, 10, () => 'do tenant A');
      await muitas(2, 2, 10, () => 'do tenant B');
      await indexarJanelas(db, embedFalso, AGORA);
      const j = await janelas();
      expect(Number(j.find((x) => x.texto.includes('tenant A'))?.workspace_id)).toBe(1);
      expect(Number(j.find((x) => x.texto.includes('tenant B'))?.workspace_id)).toBe(2);
    });
  });

  describe('buscar_mensagens com significado', () => {
    const buscar = async (ws: number, consulta: string, embed?: Embedder) =>
      (await criarFerramentas(db, ws, embed).executar('buscar_mensagens', JSON.stringify({ consulta }))) as {
        mensagens: unknown[];
        trechos_parecidos?: { grupo: string; parecido: number; texto: string; mensagem_id: number }[];
      };

    it('acha a conversa pelo assunto mesmo sem nenhuma palavra em comum', async () => {
      await muitas(1, 1, 10, (i) => `O encontro com lideranças será sábado às 9h no comitê (${i})`);
      await indexarJanelas(db, embedFalso, AGORA);
      const r = await buscar(1, 'reunião de campanha', embedFalso);
      expect(r.mensagens).toEqual([]);
      expect(r.trechos_parecidos).toHaveLength(1);
      expect(r.trechos_parecidos![0]).toMatchObject({ grupo: 'Inteligência Eleitoral', parecido: 1, mensagem_id: 1 });
      expect(r.trechos_parecidos![0].texto).toContain('encontro com lideranças');
    });

    it('só devolve o que se parece de verdade', async () => {
      await muitas(1, 1, 10, () => 'O plano de saúde foi discutido');
      await indexarJanelas(db, embedFalso, AGORA);
      expect((await buscar(1, 'reunião de campanha', embedFalso)).trechos_parecidos).toEqual([]);
    });

    it('nunca mostra conversa de outro tenant', async () => {
      await muitas(1, 1, 10, () => 'encontro do tenant A');
      await muitas(2, 2, 10, () => 'encontro do tenant B');
      await indexarJanelas(db, embedFalso, AGORA);
      const r = await buscar(1, 'reunião', embedFalso);
      expect(r.trechos_parecidos).toHaveLength(1);
      expect(r.trechos_parecidos![0].grupo).toBe('Inteligência Eleitoral');
      expect(JSON.stringify(r)).not.toContain('tenant B');
    });

    it('se a busca por significado falhar, a busca por palavras continua funcionando', async () => {
      await msg(1, 1, 'O plano de saúde sai amanhã', '2026-10-14T09:00:00-03:00');
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await buscar(1, 'plano de saúde', async () => {
        throw new Error('fora do ar');
      });
      expect(r.mensagens).toHaveLength(1);
      expect(r.trechos_parecidos).toEqual([]);
      erro.mockRestore();
    });

    it('sem embedder, a resposta é a de sempre (sem trechos_parecidos)', async () => {
      await msg(1, 1, 'O plano de saúde sai amanhã', '2026-10-14T09:00:00-03:00');
      const r = await buscar(1, 'plano de saúde');
      expect(r.mensagens).toHaveLength(1);
      expect(r).not.toHaveProperty('trechos_parecidos');
    });
  });

  describe('criarEmbedderOpenRouter', () => {
    const resposta = (corpo: unknown, ok = true, status = 200) => async () => ({ ok, status, json: async () => corpo }) as Response;
    const vetorDe = (x: number) => Array.from({ length: DIMENSOES }, () => x);

    it('devolve os vetores na ordem dos textos', async () => {
      const f = resposta({ data: [{ index: 1, embedding: vetorDe(2) }, { index: 0, embedding: vetorDe(1) }] });
      const v = await criarEmbedderOpenRouter('k', 'modelo', f as typeof fetch)(['a', 'b']);
      expect(v[0][0]).toBe(1);
      expect(v[1][0]).toBe(2);
    });

    it('o erro leva só o status, nunca o corpo da resposta', async () => {
      const f = resposta({ erro: 'texto da conversa de terceiros' }, false, 429);
      await expect(criarEmbedderOpenRouter('k', 'modelo', f as typeof fetch)(['a'])).rejects.toThrow(/429/);
      await expect(criarEmbedderOpenRouter('k', 'modelo', f as typeof fetch)(['a'])).rejects.not.toThrow(/terceiros/);
    });

    it('recusa vetor com tamanho errado', async () => {
      const f = resposta({ data: [{ index: 0, embedding: [1, 2, 3] }] });
      await expect(criarEmbedderOpenRouter('k', 'modelo', f as typeof fetch)(['a'])).rejects.toThrow(/inesperados/);
    });
  });
});

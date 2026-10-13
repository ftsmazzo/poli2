import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Chat } from '../agente/llm';
import { migrate } from '../migrate';
import { LIMITE_DIARIO_IMPORTANCIA_2, lerGrupo, lerGruposVencidos, lerResposta } from './leitura';

const AGORA = new Date('2026-10-14T13:00:00Z'); // 10:00 em Belém

describe('lerResposta', () => {
  it('lê o JSON mesmo com texto em volta e converte a importância escrita como texto', () => {
    expect(lerResposta('Claro!\n{"resumo":"Nada de novo","importancia":"1","alerta":null}\nFim')).toEqual({ resumo: 'Nada de novo', importancia: 1, alerta: null });
  });

  it('recusa o que não é JSON válido ou foge dos limites', () => {
    for (const t of [null, '', 'sem json', '{"resumo":""}', '{"resumo":"x","importancia":7}', '{"resumo":"x","importancia":-1}', '{quebrado']) {
      expect(lerResposta(t as string | null), String(t)).toBeNull();
    }
  });
});

describe('leitura de grupos', () => {
  let db: PGlite;
  let chamadas: number;
  let resposta: (conversa: string) => string;
  const chat: Chat = async ({ messages }) => {
    chamadas++;
    return { content: resposta(messages.map((m) => m.content ?? '').join('\n')), toolCalls: [] };
  };
  const json = (importancia: number, alerta: string | null = null, resumo = 'Resumo do período.') => JSON.stringify({ resumo, importancia, alerta });

  async function msg(texto: string, quando = '2026-10-14T09:00:00-03:00', grupo = 1) {
    const id = `M${Math.random().toString(36).slice(2)}`;
    await db.query(`insert into mensagens (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, enviada_em, tipo, texto) values (1, $1, $2, 1, $3, 'texto', $4)`, [grupo, id, quando, texto]);
  }
  const grupo = async () => (await db.query<any>('select * from grupos where id = 1')).rows[0];
  const ler = async (agora = AGORA) => {
    const g = await grupo();
    return lerGrupo(db, chat, 'modelo-barato', { id: 1, workspace_id: 1, nome: g.nome, ultima_leitura_msg_id: g.ultima_leitura_msg_id === null ? null : Number(g.ultima_leitura_msg_id) }, agora);
  };

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    chamadas = 0;
    resposta = () => json(0);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into grupos (workspace_id, jid, nome, acompanhar, intervalo_min) values (1, '1@g.us', 'Inteligência Eleitoral', true, 30), (1, '2@g.us', 'Heads', false, 30)`);
    await db.query(`update grupos set eh_heads = true where id = 2`);
    await db.query(`insert into pessoas (workspace_id, nome, telefone, papel) values (1, 'Ary', '5596999990001', 'head')`);
  });

  describe('ao ligar o acompanhamento (resumo inicial)', () => {
    it('resume as últimas 24 horas, ignora o que é mais velho e nunca gera alerta sobre coisa antiga', async () => {
      await msg('conversa de três dias atrás', '2026-10-11T09:00:00-03:00');
      await msg('o boato do local de votação começou hoje cedo', '2026-10-14T08:00:00-03:00');
      let visto = '';
      resposta = (c) => ((visto = c), json(3, 'Boato sobre o local de votação.', 'Falaram do boato desde cedo.'));

      expect(await ler()).toBe('inicio');
      expect(chamadas).toBe(1);
      expect(visto).toContain('RESUMO INICIAL');
      expect(visto).toContain('o boato do local de votação começou hoje cedo');
      expect(visto).not.toContain('três dias atrás');

      const r = await db.query<{ texto: string; importancia: number }>('select texto, importancia from resumos');
      expect(r.rows).toEqual([{ texto: 'Falaram do boato desde cedo.', importancia: 3 }]);
      // O resumo inicial aparece para a equipe, mas não dispara alerta: a notícia já é velha.
      expect((await db.query<{ n: string }>('select count(*)::text as n from alertas')).rows[0].n).toBe('0');
      expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens_saida')).rows[0].n).toBe('0');
    });

    it('o que existia antes não é lido de novo: só o que chegar depois', async () => {
      await msg('conversa de hoje cedo', '2026-10-14T08:00:00-03:00');
      await ler();
      const g = await grupo();
      expect(Number(g.ultima_leitura_msg_id)).toBeGreaterThan(0);
      expect(g.ultima_leitura_em).not.toBeNull();
      const antes = chamadas;
      expect(await ler()).toBe('sem_novidade');
      expect(chamadas).toBe(antes);
    });

    it('sem nada nas últimas 24 horas não chama o modelo, mas o acompanhamento começa', async () => {
      await msg('conversa de três dias atrás', '2026-10-11T09:00:00-03:00');
      expect(await ler()).toBe('inicio');
      expect(chamadas).toBe(0);
      expect((await db.query<{ n: string }>('select count(*)::text as n from resumos')).rows[0].n).toBe('0');
      expect(Number((await grupo()).ultima_leitura_msg_id)).toBeGreaterThan(0);
    });

    it('se o resumo inicial falhar, o acompanhamento começa assim mesmo', async () => {
      await msg('conversa de hoje cedo', '2026-10-14T08:00:00-03:00');
      const quebra: Chat = async () => {
        throw new Error('OpenRouter respondeu 500');
      };
      const g = await grupo();
      const s = await lerGrupo(db, quebra, 'm', { id: 1, workspace_id: 1, nome: g.nome, ultima_leitura_msg_id: null }, AGORA);
      expect(s).toBe('inicio');
      expect(Number((await grupo()).ultima_leitura_msg_id)).toBeGreaterThan(0);
      expect((await db.query<{ n: string }>('select count(*)::text as n from resumos')).rows[0].n).toBe('0');
    });
  });

  it('com mensagens novas importantes: guarda o resumo, cria o alerta e prepara o envio aos Heads', async () => {
    await ler();
    await msg('Gente, o boato sobre o local de votação mudar está se espalhando!');
    resposta = () => json(3, 'Boato de que o local de votação mudou está circulando no grupo.', 'Falaram do boato.');
    expect(await ler()).toBe('alerta');

    const r = await db.query<{ texto: string; importancia: number }>('select texto, importancia from resumos');
    expect(r.rows).toEqual([{ texto: 'Falaram do boato.', importancia: 3 }]);
    const a = await db.query<{ severidade: number; texto: string; resumo_id: number | null }>('select severidade, texto, resumo_id from alertas');
    expect(a.rows).toMatchObject([{ severidade: 3, texto: 'Boato de que o local de votação mudou está circulando no grupo.' }]);
    expect(a.rows[0].resumo_id).not.toBeNull();
    const s = await db.query<{ destino_jid: string }>('select destino_jid from mensagens_saida order by id');
    expect(s.rows.map((x) => x.destino_jid)).toEqual(['5596999990001', '2@g.us']);
  });

  it('o modelo recebe só as mensagens novas, com autor e hora local, e a instrução de analista', async () => {
    await ler();
    await msg('mensagem nova do Ary', '2026-10-14T09:30:00-03:00');
    let visto = '';
    resposta = (c) => ((visto = c), json(0));
    await ler();
    expect(visto).toContain('[2026-10-14 09:30] Ary: mensagem nova do Ary');
    expect(visto).toContain('Responda SOMENTE com um JSON');
    expect(visto).not.toContain('conversa antiga');
  });

  it('importância baixa só guarda o resumo; sem mensagens novas não chama o modelo', async () => {
    await ler();
    await msg('bom dia pessoal');
    resposta = () => json(1, null, 'Cumprimentos.');
    expect(await ler()).toBe('lido');
    expect((await db.query<{ n: string }>('select count(*)::text as n from alertas')).rows[0].n).toBe('0');
    const antes = chamadas;
    expect(await ler()).toBe('sem_novidade');
    expect(chamadas).toBe(antes);
  });

  it('o mesmo alerta no mesmo dia não se repete nem manda de novo aos Heads', async () => {
    await ler();
    resposta = () => json(3, 'Boato sobre o local de votação circulando.');
    await msg('boato 1');
    expect(await ler()).toBe('alerta');
    await msg('boato 2, de novo');
    expect(await ler()).toBe('lido');
    expect((await db.query<{ n: string }>('select count(*)::text as n from alertas')).rows[0].n).toBe('1');
    expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens_saida')).rows[0].n).toBe('2');
  });

  it('resposta inválida: tenta de novo uma vez; se continuar inválida, não avança e lê as mesmas mensagens depois', async () => {
    await ler();
    await msg('algo importante');
    let tentativa = 0;
    resposta = () => (++tentativa === 1 ? 'não sei responder em JSON' : json(0, null, 'Segunda tentativa deu certo.'));
    expect(await ler()).toBe('lido');
    expect(tentativa).toBe(2);

    await msg('outra coisa');
    resposta = () => 'sempre inválido';
    const antes = Number((await grupo()).ultima_leitura_msg_id);
    expect(await ler()).toBe('falha');
    expect(Number((await grupo()).ultima_leitura_msg_id)).toBe(antes);
    resposta = () => json(0, null, 'Agora foi.');
    expect(await ler()).toBe('lido');
    expect(Number((await grupo()).ultima_leitura_msg_id)).toBeGreaterThan(antes);
  });

  it('alerta com link, telefone ou cifra que não está nas mensagens é cortado (o resumo fica)', async () => {
    await ler();
    await msg('vi um boato sobre o local de votação');
    resposta = () => json(3, 'Boato no site https://golpe.com e ligue 96 98888-7777, 99999 votos.', 'Falaram de um boato.');
    expect(await ler()).toBe('lido');
    expect((await db.query<{ n: string }>('select count(*)::text as n from alertas')).rows[0].n).toBe('0');
    expect((await db.query<{ n: string }>('select count(*)::text as n from resumos')).rows[0].n).toBe('1');
  });

  it('limita a 5 alertas de importância 2 por dia, mas os de importância 3 sempre passam', async () => {
    await ler();
    for (let i = 1; i <= LIMITE_DIARIO_IMPORTANCIA_2 + 1; i++) {
      await msg(`assunto ${i}`);
      resposta = () => json(2, `Pendência número ${i} precisa de resposta.`);
      await ler();
    }
    const dois = await db.query<{ n: string }>('select count(*)::text as n from alertas where severidade = 2');
    expect(Number(dois.rows[0].n)).toBe(LIMITE_DIARIO_IMPORTANCIA_2);

    await msg('crise');
    resposta = () => json(3, 'Crise urgente no grupo.');
    expect(await ler()).toBe('alerta');
  });

  it('um alerta sem Head cadastrado fica guardado, sem envio', async () => {
    await db.query(`update pessoas set papel = 'equipe'`);
    await db.query(`update grupos set eh_heads = false`);
    await ler();
    await msg('boato');
    resposta = () => json(3, 'Boato circulando agora.');
    expect(await ler()).toBe('alerta');
    expect((await db.query<{ n: string }>('select count(*)::text as n from mensagens_saida')).rows[0].n).toBe('0');
  });

  describe('lerGruposVencidos', () => {
    it('lê só os grupos acompanhados cujo intervalo venceu', async () => {
      await db.query(`update grupos set acompanhar = true where id = 2`);
      let r = await lerGruposVencidos(db, chat, 'm', AGORA);
      expect(r).toMatchObject({ inicios: 2, lidos: 0 });

      // 10 minutos depois nada venceu (intervalo de 30).
      r = await lerGruposVencidos(db, chat, 'm', new Date(AGORA.getTime() + 10 * 60_000));
      expect(r).toEqual({ lidos: 0, alertas: 0, falhas: 0, inicios: 0 });
      expect(chamadas).toBe(0);

      // 31 minutos depois venceu: lê o grupo que tem mensagem nova.
      await msg('novidade');
      resposta = () => json(1);
      r = await lerGruposVencidos(db, chat, 'm', new Date(AGORA.getTime() + 31 * 60_000));
      expect(r.lidos).toBe(1);
      expect(chamadas).toBe(1);
    });

    it('não lê grupo que não está sendo acompanhado', async () => {
      await db.query(`update grupos set acompanhar = false`);
      expect(await lerGruposVencidos(db, chat, 'm', AGORA)).toEqual({ lidos: 0, alertas: 0, falhas: 0, inicios: 0 });
    });

    it('erro em um grupo não trava os outros', async () => {
      await db.query(`update grupos set acompanhar = true where id = 2`);
      await lerGruposVencidos(db, chat, 'm', AGORA);
      await msg('novidade no 1', '2026-10-14T09:00:00-03:00', 1);
      await msg('novidade no 2', '2026-10-14T09:00:00-03:00', 2);
      let n = 0;
      const quebraNoPrimeiro: Chat = async (a) => {
        if (++n === 1) throw new Error('OpenRouter respondeu 500');
        return chat(a);
      };
      resposta = () => json(1);
      const r = await lerGruposVencidos(db, quebraNoPrimeiro, 'm', new Date(AGORA.getTime() + 40 * 60_000));
      expect(r.falhas).toBe(1);
      expect(r.lidos).toBe(1);
    });
  });
});

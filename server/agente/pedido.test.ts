import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairMensagem, type MensagemNormalizada, type MensagemPrivada } from '../ingest/evolution';
import { ativaPoli, avaliarPedido, avaliarPrivado,chaveNumero, ehComandante, normalizarComandantes, numeroDe } from './pedido';

const GRUPO = '120363000000000001@g.us';
const POLI = '5596900000000@s.whatsapp.net';
const DONO = '5511987654321@s.whatsapp.net';

function msg(texto: string, extra: { participant?: string; participantAlt?: string; fromMe?: boolean; mencionados?: string[]; citadaAutor?: string; tipo?: 'texto' | 'imagem' } = {}): MensagemNormalizada {
  const contextInfo = {
    ...(extra.mencionados ? { mentionedJid: extra.mencionados } : {}),
    ...(extra.citadaAutor ? { participant: extra.citadaAutor, stanzaId: 'ORIG' } : {}),
  };
  const mensagem =
    extra.tipo === 'imagem'
      ? { imageMessage: { caption: texto, contextInfo } }
      : { extendedTextMessage: { text: texto, contextInfo } };
  return extrairMensagem({
    key: {
      remoteJid: GRUPO,
      fromMe: extra.fromMe ?? false,
      id: `ID-${Math.random().toString(36).slice(2)}`,
      participant: extra.participant ?? DONO,
      ...(extra.participantAlt ? { participantAlt: extra.participantAlt } : {}),
    },
    pushName: 'Dono',
    message: mensagem,
    messageTimestamp: 1790000000,
  })!;
}

describe('números', () => {
  it('tira domínio e sufixo de aparelho', () => {
    expect(numeroDe('5596999990000:12@s.whatsapp.net')).toBe('5596999990000');
    expect(numeroDe(null)).toBe('');
  });

  it('o mesmo número com e sem o nono dígito tem a mesma chave', () => {
    expect(chaveNumero('5511987654321')).toBe(chaveNumero('551187654321'));
    expect(chaveNumero('5511987654321')).not.toBe(chaveNumero('5511987654322'));
  });

  it('normaliza a lista de comandantes e descarta o que não é número', () => {
    expect(normalizarComandantes(['(11) 98765-4321', 'abc', '123', '5596999990000'])).toEqual(['5511987654321', '5596999990000']);
    expect(normalizarComandantes([''])).toEqual([]);
  });
});

describe('ativaPoli', () => {
  it('responde quando o número dela é marcado', () => {
    expect(ativaPoli(msg('@5596900000000 qual o endereço?', { mencionados: [POLI] }), POLI)).toEqual({ ativa: true, consulta: 'qual o endereço?' });
  });

  it('responde à marcação escrita no texto mesmo sem a lista de marcados', () => {
    expect(ativaPoli(msg('@5596900000000 resume o grupo'), POLI)).toMatchObject({ ativa: true, consulta: 'resume o grupo' });
  });

  it('responde quando respondem a uma mensagem dela', () => {
    expect(ativaPoli(msg('e o telefone?', { citadaAutor: POLI }), POLI)).toMatchObject({ ativa: true, consulta: 'e o telefone?' });
  });

  it('responde ao nome "Poli2" no começo da frase', () => {
    expect(ativaPoli(msg('Poli2, resume ontem'), POLI)).toEqual({ ativa: true, consulta: 'resume ontem' });
    expect(ativaPoli(msg('@poli 2 link do plano'), POLI)).toMatchObject({ ativa: true, consulta: 'link do plano' });
  });

  it('não responde ao nome "Poli" (é da versão 1), nem a conversa comum, nem a marcação de outra pessoa', () => {
    expect(ativaPoli(msg('poli resume o grupo'), POLI).ativa).toBe(false);
    expect(ativaPoli(msg('bom dia pessoal'), POLI).ativa).toBe(false);
    expect(ativaPoli(msg('@5511999990000 oi', { mencionados: ['5511999990000@s.whatsapp.net'] }), POLI).ativa).toBe(false);
    expect(ativaPoli(msg('e o telefone?', { citadaAutor: DONO }), POLI).ativa).toBe(false);
  });

  it('responde ao nome do perfil dela no começo da frase, com ou sem @, sem diferenciar maiúscula nem acento', () => {
    expect(ativaPoli(msg('@MapSolar link do Flaviômetro'), POLI, null, 'MapSolar')).toEqual({ ativa: true, consulta: 'link do Flaviômetro' });
    expect(ativaPoli(msg('mapsolar, resume ontem'), POLI, null, 'MapSolar')).toMatchObject({ ativa: true, consulta: 'resume ontem' });
    expect(ativaPoli(msg('  mapsolar: oi'), POLI, null, 'Map Sólar'.replace(' ', ''))).toMatchObject({ ativa: true, consulta: 'oi' });
  });

  it('o nome do perfil só vale no começo e como palavra inteira', () => {
    expect(ativaPoli(msg('MapSolarium link do plano'), POLI, null, 'MapSolar').ativa).toBe(false);
    expect(ativaPoli(msg('alguém viu o MapSolar hoje?'), POLI, null, 'MapSolar').ativa).toBe(false);
    expect(ativaPoli(msg('@MapSolar oi'), POLI, null, null).ativa).toBe(false);
  });

  it('sem saber o próprio número, só o nome "Poli2" funciona', () => {
    expect(ativaPoli(msg('@5596900000000 oi', { mencionados: [POLI] }), null).ativa).toBe(false);
    expect(ativaPoli(msg('Poli2 oi'), null).ativa).toBe(true);
  });
});

describe('ehComandante', () => {
  const dono = ['5511987654321'];

  it('autoriza pelo número do autor, com ou sem o nono dígito', () => {
    expect(ehComandante(msg('x'), dono)).toBe(true);
    expect(ehComandante(msg('x', { participant: '551187654321@s.whatsapp.net' }), dono)).toBe(true);
  });

  it('autoriza pelo número alternativo quando o autor vem como LID', () => {
    expect(ehComandante(msg('x', { participant: '123456789012345@lid', participantAlt: DONO }), dono)).toBe(true);
  });

  it('recusa outro número, LID sem número real e lista vazia', () => {
    expect(ehComandante(msg('x', { participant: '5511999990000@s.whatsapp.net' }), dono)).toBe(false);
    expect(ehComandante(msg('x', { participant: '123456789012345@lid' }), dono)).toBe(false);
    expect(ehComandante(msg('x'), [])).toBe(false);
  });
});

describe('avaliarPedido', () => {
  let db: PGlite;
  const dono = ['5511987654321'];

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector } });
    await migrate(db);
    await db.query(`insert into workspaces (nome) values ('Tenant A')`);
    await db.query(`insert into instancias_wa (workspace_id, evolution_instance, jid_proprio) values (1, 'inst-a', '${POLI}')`);
    await db.query(`insert into grupos (workspace_id, jid, nome) values (1, '${GRUPO}', 'Inteligência Eleitoral')`);
  });

  it('monta o pedido quando a Poli é chamada por quem pode', async () => {
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2 link do plano'), dono);
    expect(r).toMatchObject({
      tipo: 'pedido',
      pedido: { workspaceId: 1, instancia: 'inst-a', grupoJid: GRUPO, grupoNome: 'Inteligência Eleitoral', consulta: 'link do plano', autorNome: 'Dono' },
    });
  });

  it('devolve o telefone autorizado de quem pediu, completo, mesmo se o WhatsApp mandou sem o nono dígito', async () => {
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2 painel', { participant: '551187654321@s.whatsapp.net' }), dono);
    expect(r).toMatchObject({ tipo: 'pedido', pedido: { telefoneAutor: '5511987654321' } });
  });

  it('autoriza quem foi marcado como "pode comandar" no painel, mesmo fora do ambiente', async () => {
    await db.query(`insert into pessoas (workspace_id, jid, nome, telefone, papel, pode_comandar) values (1, '5511999990000@s.whatsapp.net', 'Beltrano', '5511999990000', 'head', true)`);
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2 oi', { participant: '5511999990000@s.whatsapp.net' }), []);
    expect(r).toMatchObject({ tipo: 'pedido', pedido: { telefoneAutor: '5511999990000' } });
  });

  it('quem não foi marcado como "pode comandar" continua recusado', async () => {
    await db.query(`insert into pessoas (workspace_id, jid, nome, telefone, papel, pode_comandar) values (1, '5511999990000@s.whatsapp.net', 'Beltrano', '5511999990000', 'head', false)`);
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2 oi', { participant: '5511999990000@s.whatsapp.net' }), []);
    expect(r.tipo).toBe('nao_autorizado');
  });

  it('pessoa cadastrada só pelo LID e marcada no painel é reconhecida pelo par que a Poli aprendeu', async () => {
    await db.query(`insert into pessoas (workspace_id, jid, nome, papel, pode_comandar) values (1, '222222222222222@lid', 'Beltrano', 'head', true)`);
    await db.query(`insert into lids (workspace_id, lid, telefone) values (1, '222222222222222', '5511999990000')`);
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2 painel', { participant: '222222222222222@lid' }), []);
    expect(r).toMatchObject({ tipo: 'pedido', pedido: { telefoneAutor: '5511999990000' } });
  });

  describe('papel no painel', () => {
    it('quem está na lista do servidor (o mantenedor) entra como admin; quem foi marcado só no painel, como head', async () => {
      await db.query(`insert into pessoas (workspace_id, jid, nome, telefone, papel, pode_comandar) values (1, '5511999990000@s.whatsapp.net', 'Beltrano', '5511999990000', 'head', true)`);
      const dono1 = await avaliarPedido(db, 'inst-a', msg('Poli2 painel'), dono);
      expect(dono1).toMatchObject({ tipo: 'pedido', pedido: { papelNoPainel: 'admin' } });
      const marcado = await avaliarPedido(db, 'inst-a', msg('Poli2 painel', { participant: '5511999990000@s.whatsapp.net' }), dono);
      expect(marcado).toMatchObject({ tipo: 'pedido', pedido: { papelNoPainel: 'head' } });
    });

    it('o mesmo vale no privado', async () => {
      await db.query(`insert into pessoas (workspace_id, jid, nome, telefone, papel, pode_comandar) values (1, '5511999990000@s.whatsapp.net', 'Beltrano', '5511999990000', 'head', true)`);
      const dm = (contatoJid: string) => ({ waMessageId: 'DM9', contatoJid, contatoAlt: null, nome: 'X', texto: 'painel' });
      expect(await avaliarPrivado(db, 'inst-a', dm('5511987654321@s.whatsapp.net'), dono)).toMatchObject({ pedido: { papelNoPainel: 'admin' } });
      expect(await avaliarPrivado(db, 'inst-a', dm('5511999990000@s.whatsapp.net'), dono)).toMatchObject({ pedido: { papelNoPainel: 'head' } });
    });
  });

  describe('no privado', () => {
    const dm = (texto: string, extra: Partial<MensagemPrivada> = {}): MensagemPrivada => ({
      waMessageId: 'DM1',
      contatoJid: '5511987654321@s.whatsapp.net',
      contatoAlt: null,
      nome: 'Dono',
      texto,
      ...extra,
    });

    it('atende quem pode, sem precisar chamar a Poli pelo nome, e responde para o próprio contato', async () => {
      const r = await avaliarPrivado(db, 'inst-a', dm('qual o link do plano?'), dono);
      expect(r).toMatchObject({
        tipo: 'pedido',
        pedido: { workspaceId: 1, grupoJid: '5511987654321@s.whatsapp.net', consulta: 'qual o link do plano?', privado: true, telefoneAutor: '5511987654321' },
      });
    });

    it('aceita o "Poli2" no começo e o tira da pergunta', async () => {
      const r = await avaliarPrivado(db, 'inst-a', dm('Poli2 painel'), dono);
      expect(r).toMatchObject({ tipo: 'pedido', pedido: { consulta: 'painel' } });
    });

    it('reconhece quem aparece como LID pelo par que a Poli aprendeu', async () => {
      await db.query(`insert into lids (workspace_id, lid, telefone) values (1, '111111111111111', '5511987654321')`);
      const r = await avaliarPrivado(db, 'inst-a', dm('oi', { contatoJid: '111111111111111@lid' }), dono);
      expect(r).toMatchObject({ tipo: 'pedido', pedido: { telefoneAutor: '5511987654321' } });
    });

    it('recusa quem não tem permissão', async () => {
      const r = await avaliarPrivado(db, 'inst-a', dm('oi', { contatoJid: '5511999990000@s.whatsapp.net' }), dono);
      expect(r.tipo).toBe('nao_autorizado');
    });

    it('ignora instância desconhecida', async () => {
      expect((await avaliarPrivado(db, 'outra', dm('oi'), dono)).tipo).toBe('ignorar');
    });
  });

  it('chamada vazia vira um "oi"', async () => {
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2'), dono);
    expect(r).toMatchObject({ tipo: 'pedido', pedido: { consulta: 'oi' } });
  });

  it('ignora a própria Poli, mensagem que não é texto, conversa comum e instância desconhecida', async () => {
    expect((await avaliarPedido(db, 'inst-a', msg('Poli2 oi', { fromMe: true }), dono)).tipo).toBe('ignorar');
    expect((await avaliarPedido(db, 'inst-a', msg('Poli2 oi', { tipo: 'imagem' }), dono)).tipo).toBe('ignorar');
    expect((await avaliarPedido(db, 'inst-a', msg('bom dia'), dono)).tipo).toBe('ignorar');
    expect((await avaliarPedido(db, 'outra', msg('Poli2 oi'), dono)).tipo).toBe('ignorar');
  });

  it('atende pelo nome do perfil guardado para a instância', async () => {
    await db.query(`update instancias_wa set nome_perfil = 'MapSolar'`);
    const r = await avaliarPedido(db, 'inst-a', msg('@MapSolar link do Flaviômetro'), dono);
    expect(r).toMatchObject({ tipo: 'pedido', pedido: { consulta: 'link do Flaviômetro' } });
  });

  it('quando recusa, mostra o telefone do autor mascarado para o dono se reconhecer, sem expor o número', async () => {
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2 oi', { participant: '123456789012345@lid', participantAlt: '5511999990000@s.whatsapp.net' }), dono);
    expect(r.tipo).toBe('nao_autorizado');
    if (r.tipo === 'nao_autorizado') {
      expect(r.detalhe).toContain('5511*****0000');
      expect(r.detalhe).not.toContain('5511999990000');
    }
  });

  it('recusa quem não está autorizado e diz só o tipo do identificador, sem número', async () => {
    const r = await avaliarPedido(db, 'inst-a', msg('Poli2 oi', { participant: '123456789012345@lid' }), dono);
    expect(r.tipo).toBe('nao_autorizado');
    if (r.tipo === 'nao_autorizado') {
      expect(r.detalhe).toContain('lid');
      expect(r.detalhe).not.toMatch(/\d{6,}/);
    }
  });
});

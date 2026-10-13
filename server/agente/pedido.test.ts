import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { migrate } from '../migrate';
import { extrairMensagem, type MensagemNormalizada } from '../ingest/evolution';
import { ativaPoli, avaliarPedido, chaveNumero, ehComandante, normalizarComandantes, numeroDe } from './pedido';

const GRUPO = '120363000000000001@g.us';
const POLI = '5596900000000@s.whatsapp.net';
const DONO = '5516998480805@s.whatsapp.net';

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
    expect(chaveNumero('5516998480805')).toBe(chaveNumero('551698480805'));
    expect(chaveNumero('5516998480805')).not.toBe(chaveNumero('5516998480806'));
  });

  it('normaliza a lista de comandantes e descarta o que não é número', () => {
    expect(normalizarComandantes(['(16) 99848-0805', 'abc', '123', '5596999990000'])).toEqual(['5516998480805', '5596999990000']);
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
  const dono = ['5516998480805'];

  it('autoriza pelo número do autor, com ou sem o nono dígito', () => {
    expect(ehComandante(msg('x'), dono)).toBe(true);
    expect(ehComandante(msg('x', { participant: '551698480805@s.whatsapp.net' }), dono)).toBe(true);
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
  const dono = ['5516998480805'];

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

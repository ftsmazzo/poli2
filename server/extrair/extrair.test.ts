import { describe, expect, it } from 'vitest';
import {
  extrairEnderecos,
  extrairItens,
  extrairLinks,
  extrairTelefones,
  parseVcards,
} from './extrair';

const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Silva;Maria;;;',
  'FN:Maria Silva',
  'ORG:Prefeitura;',
  'TEL;type=CELL;waid=5596991234567:+55 96 99123-4567',
  'TEL;type=WORK:(96) 3222-1234',
  'EMAIL:maria@exemplo.com',
  'END:VCARD',
].join('\n');

describe('extrairLinks', () => {
  it('limpa a pontuação do fim e tira os parâmetros de rastreamento', () => {
    const [l] = extrairLinks('veja https://exemplo.com.br/plano?utm_source=zap&id=3.');
    expect(l.valor).toBe('https://exemplo.com.br/plano?id=3');
    expect(l.dados).toMatchObject({ dominio: 'exemplo.com.br', tipo: 'outro' });
  });

  it('aceita www sem https e tira o parêntese que é da frase', () => {
    expect(extrairLinks('(confira www.site.com/pagina)')[0].valor).toBe('https://site.com/pagina');
  });

  it('o mesmo link em formas diferentes é um item só', () => {
    const l = extrairLinks('https://Exemplo.com/a/ e www.exemplo.com/a e https://exemplo.com/a?utm_medium=x');
    expect(l).toHaveLength(1);
  });

  it('reconhece convite de grupo, mapa e rede social', () => {
    const tipos = extrairLinks('chat.whatsapp.com/ABC123 https://maps.app.goo.gl/xyz https://instagram.com/perfil').map((x) => x.dados.tipo);
    expect(tipos).toEqual(['convite_whatsapp', 'mapa', 'instagram']);
  });

  it('não inventa link onde não há', () => {
    expect(extrairLinks('arquivo plano.pdf e a versão 2.0 saiu')).toEqual([]);
  });
});

describe('extrairTelefones', () => {
  it('lê celular com a pessoa citada antes do número', () => {
    const [c] = extrairTelefones('Fulano de Tal - 96 99123-4567');
    expect(c.valor).toBe('Fulano de Tal');
    expect(c.dados).toMatchObject({ nome: 'Fulano de Tal', telefones: ['+5596991234567'], origem: 'texto' });
  });

  it('lê fixo, número com +55 e número sem pontuação', () => {
    expect(extrairTelefones('(96) 3222-1234')[0].dados.telefones).toEqual(['+559632221234']);
    expect(extrairTelefones('+55 96 99123-4567')[0].dados.telefones).toEqual(['+5596991234567']);
    expect(extrairTelefones('manda no 96991234567')[0].dados.telefones).toEqual(['+5596991234567']);
  });

  it('sem nome por perto, o valor é o próprio número', () => {
    expect(extrairTelefones('Tel: 96 99123-4567')[0].valor).toBe('(96) 99123-4567');
  });

  it('para o nome na primeira palavra que não é nome', () => {
    expect(extrairTelefones('ligar para o Beltrano 96 98888-7777')[0].dados.nome).toBe('Beltrano');
  });

  it('acha vários números na mesma mensagem, sem repetir', () => {
    const t = extrairTelefones('Ana 96 99123-4567, Bia 96 98888-7777, de novo Ana 96 99123-4567');
    expect(t.map((x) => x.dados.telefones)).toEqual([['+5596991234567'], ['+5596988887777']]);
  });

  it('não confunde CPF, data, número sem DDD ou DDD que não existe', () => {
    expect(extrairTelefones('meu cpf 12345678909')).toEqual([]);
    expect(extrairTelefones('CPF 123.456.789-09')).toEqual([]);
    expect(extrairTelefones('reunião 12/10/2026 14:35')).toEqual([]);
    expect(extrairTelefones('o número é 1234-5678')).toEqual([]);
    expect(extrairTelefones('10 99123-4567')).toEqual([]);
  });
});

describe('vCard', () => {
  it('lê nome, telefones (inclusive o waid), e-mail e organização', () => {
    const [v] = parseVcards(VCARD);
    expect(v).toEqual({
      nome: 'Maria Silva',
      telefones: ['+5596991234567', '+559632221234'],
      email: 'maria@exemplo.com',
      organizacao: 'Prefeitura',
    });
  });

  it('usa o campo N quando não há FN, e lê vários cartões', () => {
    const dois = `BEGIN:VCARD\nN:Souza;João\nTEL:96988887777\nEND:VCARD\n${VCARD}`;
    const v = parseVcards(dois);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ nome: 'João Souza', telefones: ['+5596988887777'] });
  });

  it('numa mensagem de contato, o cartão vira um contato só, sem repetir o telefone do texto', () => {
    const itens = extrairItens({ mensagemId: 1, tipo: 'contato', texto: VCARD, origem: 'whatsapp', midia: null });
    const contatos = itens.filter((i) => i.tipo === 'contato');
    expect(contatos).toHaveLength(1);
    expect(contatos[0]).toMatchObject({ valor: 'Maria Silva', chave: 'contato|tel:+5596991234567' });
    expect(contatos[0].dados).toMatchObject({ origem: 'vcard', email: 'maria@exemplo.com' });
  });
});

describe('extrairEnderecos', () => {
  it('lê rua, número, bairro e cidade', () => {
    expect(extrairEnderecos('o endereço é Rua das Flores, 10 - Centro, Macapá')[0].valor).toBe('Rua das Flores, 10 - Centro, Macapá');
  });

  it('lê abreviação, sem número e rua com número no nome', () => {
    expect(extrairEnderecos('Av. FAB, s/n')[0].valor).toBe('Av. FAB, s/n');
    expect(extrairEnderecos('fica na Rua 7 de Setembro, 100')[0].valor).toBe('Rua 7 de Setembro, 100');
  });

  it('lê CEP sozinho e não repete o CEP que já está no endereço', () => {
    expect(extrairEnderecos('CEP 68900-000')[0]).toMatchObject({ valor: 'CEP 68900-000' });
    const e = extrairEnderecos('Rua A, 5 - Centro, 68900-000');
    expect(e).toHaveLength(1);
  });

  it('não trata ano ou frase comum como endereço', () => {
    expect(extrairEnderecos('na avenida central em 2026 vamos agir')).toEqual([]);
    expect(extrairEnderecos('a rua está cheia hoje')).toEqual([]);
  });
});

describe('extrairItens', () => {
  it('registra o arquivo pelo nome e marca se o original está disponível', () => {
    const [a] = extrairItens({ mensagemId: 7, tipo: 'documento', texto: 'plano.pdf', origem: 'whatsapp', midia: { nomeArquivo: 'plano.pdf' } });
    expect(a).toMatchObject({ tipo: 'arquivo', valor: 'plano.pdf', chave: 'arquivo|msg:7' });
    expect(a.dados).toMatchObject({ disponivel: true });
  });

  it('numa exportação o anexo não vem junto: o texto é o nome do arquivo', () => {
    const [a] = extrairItens({ mensagemId: 8, tipo: 'imagem', texto: 'IMG-20261012-WA0001.jpg', origem: 'exportacao', midia: null });
    expect(a).toMatchObject({ valor: 'IMG-20261012-WA0001.jpg' });
    expect(a.dados).toMatchObject({ disponivel: false, origem: 'exportacao' });
  });

  it('mensagem de localização vira endereço com coordenadas', () => {
    const itens = extrairItens({ mensagemId: 9, tipo: 'localizacao', texto: 'Praça Central — 0.0349,-51.0664', origem: 'whatsapp', midia: null });
    const loc = itens.find((i) => i.dados.origem === 'localizacao');
    expect(loc).toMatchObject({ tipo: 'endereco', valor: 'Praça Central' });
    expect(loc?.dados).toMatchObject({ latitude: 0.0349, longitude: -51.0664 });
  });

  it('junta link, contato e endereço da mesma mensagem e limita a 20 itens', () => {
    const itens = extrairItens({
      mensagemId: 1,
      tipo: 'texto',
      texto: 'Beltrano 96 98888-7777, Rua das Flores, 10, detalhes em https://exemplo.com/a',
      origem: 'whatsapp',
      midia: null,
    });
    expect(itens.map((i) => i.tipo).sort()).toEqual(['contato', 'endereco', 'link']);
    const muitos = Array.from({ length: 30 }, (_, i) => `https://exemplo.com/${i}`).join(' ');
    expect(extrairItens({ mensagemId: 2, tipo: 'texto', texto: muitos, origem: 'whatsapp', midia: null })).toHaveLength(20);
  });

  it('mensagem sem nada para extrair devolve vazio', () => {
    expect(extrairItens({ mensagemId: 3, tipo: 'texto', texto: 'bom dia, pessoal', origem: 'whatsapp', midia: null })).toEqual([]);
    expect(extrairItens({ mensagemId: 4, tipo: 'texto', texto: null, origem: 'whatsapp', midia: null })).toEqual([]);
  });
});

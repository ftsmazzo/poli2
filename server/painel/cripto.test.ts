import { describe, expect, it } from 'vitest';
import { cifrar, decifrar } from './cripto';

const CHAVE = 'chave-de-teste-com-mais-de-16';

describe('cripto', () => {
  it('cifra e decifra de volta, inclusive acentos e texto vazio', () => {
    for (const t of ['token-secreto-123', 'ação: çãõ ñ 日本', '']) {
      expect(decifrar(cifrar(t, CHAVE), CHAVE)).toBe(t);
    }
  });

  it('o mesmo texto cifrado duas vezes dá resultados diferentes e não mostra o original', () => {
    const a = cifrar('token-secreto-123', CHAVE);
    const b = cifrar('token-secreto-123', CHAVE);
    expect(a).not.toBe(b);
    expect(a).not.toContain('token-secreto-123');
    expect(a.startsWith('v1:')).toBe(true);
  });

  it('não decifra com a chave errada nem se o conteúdo for alterado', () => {
    const c = cifrar('token-secreto-123', CHAVE);
    expect(() => decifrar(c, 'outra-chave-com-mais-de-16')).toThrow();
    const partes = c.split(':');
    partes[3] = Buffer.from('adulterado').toString('base64');
    expect(() => decifrar(partes.join(':'), CHAVE)).toThrow();
    expect(() => decifrar('lixo', CHAVE)).toThrow();
  });

  it('recusa chave ausente ou curta', () => {
    expect(() => cifrar('x', '')).toThrow(/ENCRYPTION_KEY/);
    expect(() => cifrar('x', 'curta')).toThrow(/ENCRYPTION_KEY/);
  });
});

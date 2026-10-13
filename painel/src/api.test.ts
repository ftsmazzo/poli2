import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, _resetarWorkspaceEmMemoria, aoExpirarSessao, api, mensagemDeErroPorCodigo, setWorkspace } from './api';
import { simularFetch } from './test/helpers';

beforeEach(() => {
  _resetarWorkspaceEmMemoria();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cliente de API', () => {
  it('401 avisa que a sessão expirou e lança ApiError', async () => {
    simularFetch(() => ({ status: 401, json: { erro: 'sem_sessao' } }));
    const aviso = vi.fn();
    const parar = aoExpirarSessao(aviso);
    await expect(api.eu()).rejects.toMatchObject({ status: 401, codigo: 'sem_sessao' });
    expect(aviso).toHaveBeenCalledTimes(1);
    parar();
  });

  it('401 em /entrar NÃO é sessão expirada (é link inválido)', async () => {
    simularFetch(() => ({ status: 401, json: { erro: 'link_invalido_ou_expirado' } }));
    const aviso = vi.fn();
    const parar = aoExpirarSessao(aviso);
    await expect(api.entrar('abc')).rejects.toMatchObject({ status: 401 });
    expect(aviso).not.toHaveBeenCalled();
    parar();
  });

  it('manda x-workspace em todas as chamadas quando há tenant escolhido, e usa cookie same-origin', async () => {
    const chamadas = simularFetch(() => ({ json: [] }));
    setWorkspace(7);
    await api.grupos();
    await api.fontes();
    expect(chamadas).toHaveLength(2);
    for (const c of chamadas) {
      expect(c.cabecalhos['x-workspace']).toBe('7');
      expect(c.credentials).toBe('same-origin');
      expect(c.caminho.startsWith('/api/')).toBe(true);
    }
    expect(localStorage.getItem('poli_workspace')).toBe('7');
  });

  it('não manda x-workspace quando nada foi escolhido', async () => {
    const chamadas = simularFetch(() => ({ json: [] }));
    await api.grupos();
    expect(chamadas[0].cabecalhos['x-workspace']).toBeUndefined();
  });

  it('funciona mesmo se o localStorage falhar', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('bloqueado');
    };
    try {
      expect(() => setWorkspace(3)).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it.each([
    ['url_invalida', /endereço/i],
    ['nome_ja_existe', /já existe/i],
    ['dados_invalidos', /dado/i],
    ['sem_chave_de_criptografia', /ENCRYPTION_KEY/],
    ['so_administrador', /administradores/i],
    ['tenant_nao_permitido', /acesso a este workspace/i],
    ['falha_interna', /problema interno/i],
  ])('mapeia o erro %s para português legível', async (codigo, esperado) => {
    simularFetch(() => ({ status: 400, json: { erro: codigo } }));
    const e = await api.fontes().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toMatch(esperado);
    expect((e as ApiError).codigo).toBe(codigo);
  });

  it('inclui o detalhe de dados_invalidos e trata falha de rede', async () => {
    expect(mensagemDeErroPorCodigo('dados_invalidos', 'nome muito longo')).toContain('nome muito longo');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(api.eu()).rejects.toMatchObject({ codigo: 'rede', status: 0 });
  });

  it('codifica o nome da ferramenta na URL e envia só { ativa }', async () => {
    const chamadas = simularFetch(() => ({ json: { ok: true } }));
    await api.ligarFerramenta(4, 'buscar/x y', true);
    expect(chamadas[0].caminho).toBe('/api/fontes/4/ferramentas/buscar%2Fx%20y');
    expect(chamadas[0].metodo).toBe('PATCH');
    expect(chamadas[0].corpo).toEqual({ ativa: true });
  });
});

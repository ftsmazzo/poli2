import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simularFetch } from '../test/helpers';
import { Entrar } from './Entrar';

function Arvore({ url }: { url: string }) {
  return (
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/entrar" element={<Entrar />} />
        <Route path="/" element={<p>Tela inicial</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function montar(url: string) {
  window.history.replaceState(null, '', url);
  return render(<Arvore url={url} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('página /entrar', () => {
  it('faz POST /api/entrar com o token, limpa a URL e vai para a tela inicial', async () => {
    const chamadas = simularFetch(() => ({ json: { ok: true } }));
    montar('/entrar?t=TOKEN123');
    expect(await screen.findByText('Tela inicial')).toBeInTheDocument();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ metodo: 'POST', caminho: '/api/entrar', corpo: { token: 'TOKEN123' } });
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain('TOKEN123');
  });

  it('só faz POST (nunca GET do token)', async () => {
    const chamadas = simularFetch(() => ({ json: { ok: true } }));
    montar('/entrar?t=A');
    await screen.findByText('Tela inicial');
    expect(chamadas.every((c) => c.metodo === 'POST')).toBe(true);
  });

  it('mostra mensagem clara quando o link é inválido (401) e limpa a URL', async () => {
    simularFetch(() => ({ status: 401, json: { erro: 'link_invalido_ou_expirado' } }));
    montar('/entrar?t=VELHO');
    expect(await screen.findByRole('alert')).toHaveTextContent('Este link já foi usado ou expirou. Peça outro no WhatsApp escrevendo: MapSolar painel');
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByText('Tela inicial')).not.toBeInTheDocument();
  });

  it('sem token na URL mostra o erro sem chamar a API', async () => {
    const chamadas = simularFetch(() => ({ json: { ok: true } }));
    montar('/entrar');
    expect(await screen.findByRole('alert')).toHaveTextContent('MapSolar painel');
    expect(chamadas).toHaveLength(0);
  });
});

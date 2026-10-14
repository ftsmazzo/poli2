import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fonte } from '../api';
import { simularFetch, type Chamada } from '../test/helpers';
import { Fontes } from './Fontes';

vi.mock('../sessao', () => ({ useSessao: () => ({ ehAdmin: true }) }));

const SEGREDO = 'sk-super-secreto-123';

const base: Fonte = {
  id: 1,
  tipo: 'mcp',
  nome: 'Urna',
  url: 'https://urna.exemplo.com/mcp',
  headerNome: null,
  quandoUsar: 'resultados de eleição',
  escopo: null,
  ativa: true,
  status: 'nunca_testada',
  ultimoTesteEm: null,
  ultimoErro: null,
  latenciaMs: null,
  temSegredo: true,
  ferramentas: [],
};
const comFerramentas: Fonte = {
  ...base,
  status: 'ok',
  latenciaMs: 120,
  ferramentas: [
    { nome: 'consultar_votos', descricao: 'Lê votos', ativa: true, somenteLeitura: true },
    { nome: 'apagar_registro', descricao: 'Apaga algo', ativa: false, somenteLeitura: false },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('tela de Fontes', () => {
  it('mostra o estado vazio explicando o que é uma Fonte', async () => {
    simularFetch(() => ({ json: [] }));
    render(<Fontes />);
    expect(await screen.findByText('Nenhuma Fonte cadastrada')).toBeInTheDocument();
    expect(screen.getByText('urna')).toBeInTheDocument();
  });

  it('cria uma Fonte, envia o segredo no POST e nunca o exibe depois', async () => {
    const user = userEvent.setup();
    const chamadas = simularFetch((c) => {
      if (c.metodo === 'GET') return { json: [] };
      return { status: 201, json: base };
    });
    render(<Fontes />);
    await screen.findByText('Nenhuma Fonte cadastrada');
    await user.click(screen.getAllByRole('button', { name: 'Nova Fonte' })[0]);

    const gaveta = screen.getByRole('dialog');
    const campoSegredo = within(gaveta).getByLabelText('Token / segredo');
    expect(campoSegredo).toHaveAttribute('type', 'password');
    await user.type(within(gaveta).getByLabelText('Nome'), 'Urna');
    await user.type(within(gaveta).getByLabelText('URL do MCP'), 'https://urna.exemplo.com/mcp');
    await user.type(campoSegredo, SEGREDO);
    await user.type(within(gaveta).getByLabelText('Quando usar'), 'resultados de eleição');
    await user.click(within(gaveta).getByRole('button', { name: 'Criar Fonte' }));

    await screen.findByRole('heading', { name: 'Urna' });
    const post = chamadas.find((c) => c.metodo === 'POST') as Chamada;
    expect(post.caminho).toBe('/api/fontes');
    expect(post.corpo).toMatchObject({ nome: 'Urna', url: 'https://urna.exemplo.com/mcp', segredo: SEGREDO, quandoUsar: 'resultados de eleição' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SEGREDO);
    expect(screen.getByText('Guardado (não exibido)')).toBeInTheDocument();
  });

  it('ao editar, o segredo vem vazio e "Remover segredo" envia segredo vazio', async () => {
    const user = userEvent.setup();
    const chamadas = simularFetch((c) => (c.metodo === 'GET' ? { json: [base] } : { json: { ...base, temSegredo: false } }));
    render(<Fontes />);
    await user.click(await screen.findByRole('button', { name: 'Editar' }));
    const gaveta = screen.getByRole('dialog');
    expect(within(gaveta).getByLabelText('Token / segredo')).toHaveValue('');
    await user.click(within(gaveta).getByRole('button', { name: 'Remover segredo' }));
    await user.click(within(gaveta).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patch = chamadas.find((c) => c.metodo === 'PATCH') as Chamada;
    expect(patch.caminho).toBe('/api/fontes/1');
    expect((patch.corpo as { segredo: string }).segredo).toBe('');
  });

  it('explica a falta de ENCRYPTION_KEY quando a API recusa o segredo', async () => {
    const user = userEvent.setup();
    simularFetch((c) => (c.metodo === 'GET' ? { json: [] } : { status: 400, json: { erro: 'sem_chave_de_criptografia' } }));
    render(<Fontes />);
    await screen.findByText('Nenhuma Fonte cadastrada');
    await user.click(screen.getAllByRole('button', { name: 'Nova Fonte' })[0]);
    const gaveta = screen.getByRole('dialog');
    await user.type(within(gaveta).getByLabelText('Nome'), 'X');
    await user.type(within(gaveta).getByLabelText('URL do MCP'), 'https://x.com/mcp');
    await user.type(within(gaveta).getByLabelText('Token / segredo'), 'abc');
    await user.click(within(gaveta).getByRole('button', { name: 'Criar Fonte' }));
    expect(await within(gaveta).findByRole('alert')).toHaveTextContent('ENCRYPTION_KEY');
  });

  it('"Testar" mostra spinner, depois o resultado e a lista de ferramentas', async () => {
    const user = userEvent.setup();
    let liberar: (v: { json: unknown }) => void = () => undefined;
    simularFetch((c) => {
      if (c.metodo === 'GET') return { json: [base] };
      return new Promise((r) => {
        liberar = r;
      });
    });
    render(<Fontes />);
    await user.click(await screen.findByRole('button', { name: 'Testar' }));
    expect(await screen.findByRole('button', { name: /Testando/ })).toBeDisabled();
    liberar({ json: { ok: true, latenciaMs: 120, ferramentas: 2, fonte: comFerramentas } });
    expect(await screen.findByText(/Conexão ok em 120 ms/)).toBeInTheDocument();
    expect(screen.getByText('consultar_votos')).toBeInTheDocument();
    expect(screen.getByText('apagar_registro')).toBeInTheDocument();
    expect(screen.getByText('Pode alterar dados')).toBeInTheDocument();
  });

  it('com muitas ferramentas começa recolhido, mostra quantas existem e quantas estão ligadas, e expande ao clicar', async () => {
    const user = userEvent.setup();
    const muitas: Fonte = {
      ...comFerramentas,
      ferramentas: Array.from({ length: 12 }, (_, i) => ({ nome: `ferr_${i}`, descricao: `descrição ${i}`, ativa: i >= 2, somenteLeitura: true })),
    };
    simularFetch(() => ({ json: [muitas] }));
    render(<Fontes />);
    const titulo = await screen.findByRole('button', { name: /Ferramentas \(12\)/ });
    expect(titulo).toHaveTextContent('10 ligadas');
    expect(titulo).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('ferr_0')).not.toBeInTheDocument();

    await user.click(titulo);
    expect(titulo).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('ferr_0')).toBeInTheDocument();
    expect(screen.getAllByRole('switch', { name: /^Ferramenta ferr_/ })).toHaveLength(12);

    await user.click(titulo);
    expect(screen.queryByText('ferr_0')).not.toBeInTheDocument();
  });

  it('com poucas ferramentas já aparece aberto', async () => {
    simularFetch(() => ({ json: [comFerramentas] }));
    render(<Fontes />);
    expect(await screen.findByText('consultar_votos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ferramentas \(2\)/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('ligar ferramenta que escreve pede confirmação; cancelar não chama a API', async () => {
    const user = userEvent.setup();
    const chamadas = simularFetch((c) => (c.metodo === 'GET' ? { json: [comFerramentas] } : { json: { ok: true } }));
    render(<Fontes />);
    const interruptor = await screen.findByRole('switch', { name: 'Ferramenta apagar_registro' });
    expect(interruptor).not.toBeChecked();
    await user.click(interruptor);
    const confirmacao = await screen.findByRole('dialog', { name: /Ligar ferramenta que altera dados/ });
    expect(chamadas.some((c) => c.metodo === 'PATCH')).toBe(false);
    await user.click(within(confirmacao).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'PATCH')).toBe(false);
    expect(screen.getByRole('switch', { name: 'Ferramenta apagar_registro' })).not.toBeChecked();
  });

  it('ligar ferramenta que escreve, depois de confirmar, faz o PATCH', async () => {
    const user = userEvent.setup();
    const chamadas = simularFetch((c) => (c.metodo === 'GET' ? { json: [comFerramentas] } : { json: { ok: true } }));
    render(<Fontes />);
    await user.click(await screen.findByRole('switch', { name: 'Ferramenta apagar_registro' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Ligar mesmo assim' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Ferramenta apagar_registro' })).toBeChecked());
    const patch = chamadas.find((c) => c.metodo === 'PATCH') as Chamada;
    expect(patch.caminho).toBe('/api/fontes/1/ferramentas/apagar_registro');
    expect(patch.corpo).toEqual({ ativa: true });
  });

  it('ligar ferramenta somente leitura não pede confirmação', async () => {
    const user = userEvent.setup();
    const fonte: Fonte = { ...comFerramentas, ferramentas: [{ nome: 'ler', descricao: null, ativa: false, somenteLeitura: true }] };
    const chamadas = simularFetch((c) => (c.metodo === 'GET' ? { json: [fonte] } : { json: { ok: true } }));
    render(<Fontes />);
    await user.click(await screen.findByRole('switch', { name: 'Ferramenta ler' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PATCH')).toBe(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

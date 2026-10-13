import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, aoExpirarSessao, api, getWorkspace, setWorkspace, mensagemDeErro, type Eu } from './api';
import { AcessoPeloWhatsApp } from './paginas/AcessoPeloWhatsApp';
import { Carregando, ErroCarga } from './components/Estados';

interface ContextoSessao {
  eu: Eu;
  workspaceAtual: number;
  ehAdmin: boolean;
  trocarWorkspace: (id: number) => void;
  sair: () => Promise<void>;
}

const Ctx = createContext<ContextoSessao | null>(null);

export function useSessao(): ContextoSessao {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSessao fora do ProvedorSessao');
  return c;
}

type Estado = { tipo: 'carregando' } | { tipo: 'sem_sessao' } | { tipo: 'erro'; mensagem: string } | { tipo: 'ok'; eu: Eu; workspaceAtual: number };

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>({ tipo: 'carregando' });

  const carregar = useCallback(async () => {
    setEstado({ tipo: 'carregando' });
    try {
      let eu: Eu;
      try {
        eu = await api.eu();
      } catch (e) {
        // A escolha guardada pode ser de um workspace que o usuário não acessa mais: volta ao padrão.
        if (e instanceof ApiError && e.codigo === 'tenant_nao_permitido') {
          setWorkspace(null);
          eu = await api.eu();
        } else throw e;
      }
      const guardado = getWorkspace();
      const valido = eu.workspaces.some((w) => w.id === guardado);
      const atual = valido && guardado !== null ? guardado : eu.workspaceAtual;
      if (!valido) setWorkspace(null);
      setEstado({ tipo: 'ok', eu, workspaceAtual: atual });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setEstado({ tipo: 'sem_sessao' });
      else setEstado({ tipo: 'erro', mensagem: mensagemDeErro(e) });
    }
  }, []);

  useEffect(() => {
    void carregar();
    return aoExpirarSessao(() => setEstado({ tipo: 'sem_sessao' }));
  }, [carregar]);

  const valor = useMemo<ContextoSessao | null>(() => {
    if (estado.tipo !== 'ok') return null;
    const { eu, workspaceAtual } = estado;
    return {
      eu,
      workspaceAtual,
      ehAdmin: eu.workspaces.find((w) => w.id === workspaceAtual)?.papel === 'admin',
      trocarWorkspace: (id) => {
        setWorkspace(id);
        setEstado({ tipo: 'ok', eu, workspaceAtual: id });
      },
      sair: async () => {
        try {
          await api.sair();
        } finally {
          setEstado({ tipo: 'sem_sessao' });
        }
      },
    };
  }, [estado]);

  if (estado.tipo === 'carregando') return <Carregando texto="Abrindo o painel…" tela />;
  if (estado.tipo === 'sem_sessao') return <AcessoPeloWhatsApp />;
  if (estado.tipo === 'erro') return <ErroCarga mensagem={estado.mensagem} aoTentar={() => void carregar()} tela />;
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { api, mensagemDeErro, type Diagnostico } from './api';
import { IconeAviso, IconeMenu } from './components/Icones';
import { DiagnosticoCtx, problemasDoDiagnostico } from './diagnosticoCtx';
import { useSessao } from './sessao';
import { guardarTema, lerTema, type Tema } from './tema';

const MENU = [
  { para: '/', rotulo: 'Diagnóstico', fim: true },
  { para: '/fontes', rotulo: 'Fontes' },
  { para: '/grupos', rotulo: 'Grupos' },
  { para: '/pessoas', rotulo: 'Pessoas' },
  { para: '/alertas', rotulo: 'Alertas' },
];

export function Layout() {
  const { eu, workspaceAtual, trocarWorkspace, sair } = useSessao();
  const local = useLocation();
  const [menuAberto, setMenuAberto] = useState(false);
  const [tema, setTema] = useState<Tema>(lerTema);

  const [diagnostico, setDiagnostico] = useState<Diagnostico | null>(null);
  const [erroDiag, setErroDiag] = useState<string | null>(null);
  const [carregandoDiag, setCarregandoDiag] = useState(true);
  const contador = useRef(0);

  const recarregar = useCallback(() => {
    const id = ++contador.current;
    api.diagnostico().then(
      (d) => {
        if (id !== contador.current) return;
        setDiagnostico(d);
        setErroDiag(null);
        setCarregandoDiag(false);
      },
      (e: unknown) => {
        if (id !== contador.current) return;
        setErroDiag(mensagemDeErro(e));
        setCarregandoDiag(false);
      },
    );
  }, []);

  // Atualiza ao trocar de tela ou de workspace e a cada 60 s.
  useEffect(() => {
    recarregar();
  }, [recarregar, local.pathname, workspaceAtual]);
  useEffect(() => {
    const t = window.setInterval(recarregar, 60_000);
    return () => window.clearInterval(t);
  }, [recarregar]);

  useEffect(() => {
    setMenuAberto(false);
  }, [local.pathname]);

  const valorDiag = useMemo(() => ({ diagnostico, erro: erroDiag, carregando: carregandoDiag, recarregar }), [diagnostico, erroDiag, carregandoDiag, recarregar]);
  const problemas = diagnostico ? problemasDoDiagnostico(diagnostico) : [];

  return (
    <DiagnosticoCtx.Provider value={valorDiag}>
      <a className="pular" href="#conteudo">
        Pular para o conteúdo
      </a>
      {problemas.length > 0 && (
        <div className="faixa-falha" role="alert">
          <IconeAviso />
          <div>
            <strong>Falha de conexão.</strong>
            <ul>
              {problemas.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className={`app${menuAberto ? ' menu-aberto' : ''}`}>
        <aside className="lateral" id="menu-lateral" aria-label="Navegação principal">
          <p className="marca">Poli 2.0</p>
          <nav>
            <ul>
              {MENU.map((m) => (
                <li key={m.para}>
                  <NavLink to={m.para} end={m.fim}>
                    {m.rotulo}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <div className="principal">
          <header className="topo">
            <button type="button" className="btn btn-menu" aria-expanded={menuAberto} aria-controls="menu-lateral" onClick={() => setMenuAberto((v) => !v)}>
              <IconeMenu /> Menu
            </button>
            <div className="topo-espaco" />
            {eu.workspaces.length > 1 && (
              <label className="campo-inline">
                <span>Workspace</span>
                <select value={workspaceAtual} onChange={(e) => trocarWorkspace(Number(e.target.value))}>
                  {eu.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {typeof w.nome === 'string' && w.nome ? w.nome : `Workspace ${w.id}`} ({w.papel === 'admin' ? 'admin' : 'head'})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="campo-inline">
              <span>Tema</span>
              <select
                value={tema}
                onChange={(e) => {
                  const t = e.target.value as Tema;
                  setTema(t);
                  guardarTema(t);
                }}
              >
                <option value="sistema">Sistema</option>
                <option value="claro">Claro</option>
                <option value="escuro">Escuro</option>
              </select>
            </label>
            <span className="usuario">{eu.usuario.nome ?? eu.usuario.telefone ?? 'Usuário'}</span>
            <button type="button" className="btn" onClick={() => void sair()}>
              Sair
            </button>
          </header>
          <main id="conteudo" className="conteudo" tabIndex={-1} key={workspaceAtual}>
            <Outlet />
          </main>
        </div>
      </div>
    </DiagnosticoCtx.Provider>
  );
}

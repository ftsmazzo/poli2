import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { api, mensagemDeErro, type Diagnostico } from './api';
import { IconeAviso, IconeFonte, IconeGrupo, IconeLua, IconeMenu, IconePessoa, IconePulso, IconeSair, IconeSino, IconeSistema, IconeSol, MarcaPrumo } from './components/Icones';
import { DiagnosticoCtx, problemasDoDiagnostico } from './diagnosticoCtx';
import { useSessao } from './sessao';
import { guardarTema, lerTema, type Tema } from './tema';

interface ItemDeMenu {
  para: string;
  rotulo: string;
  icone: ReactNode;
  fim?: boolean;
  // Quantos itens pedem ação naquela tela (aparece como um número no menu).
  contador?: (d: Diagnostico) => number;
}

const MENU: ItemDeMenu[] = [
  { para: '/', rotulo: 'Diagnóstico', icone: <IconePulso />, fim: true },
  { para: '/fontes', rotulo: 'Fontes', icone: <IconeFonte />, contador: (d) => d.fontes.filter((f) => f.ativa && f.status === 'erro').length },
  { para: '/grupos', rotulo: 'Grupos', icone: <IconeGrupo /> },
  { para: '/pessoas', rotulo: 'Pessoas', icone: <IconePessoa /> },
  { para: '/alertas', rotulo: 'Alertas', icone: <IconeSino />, contador: (d) => (d.alertas ? d.alertas.semDestino + d.alertas.falhasDeEnvio : 0) },
];

const PROXIMO_TEMA: Record<Tema, Tema> = { sistema: 'claro', claro: 'escuro', escuro: 'sistema' };
const ROTULO_TEMA: Record<Tema, string> = { sistema: 'do sistema', claro: 'claro', escuro: 'escuro' };
const ICONE_TEMA: Record<Tema, ReactNode> = { sistema: <IconeSistema />, claro: <IconeSol />, escuro: <IconeLua /> };

const iniciais = (nome: string) =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';

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
  const nomeDoUsuario = eu.usuario.nome ?? eu.usuario.telefone ?? 'Usuário';
  const temaSeguinte = PROXIMO_TEMA[tema];
  const papelAtual = eu.workspaces.find((w) => w.id === workspaceAtual)?.papel;

  return (
    <DiagnosticoCtx.Provider value={valorDiag}>
      <a className="pular" href="#conteudo">
        Pular para o conteúdo
      </a>
      <div className={`app${menuAberto ? ' menu-aberto' : ''}`}>
        {menuAberto && <button type="button" className="cortina-menu" aria-label="Fechar o menu" onClick={() => setMenuAberto(false)} />}
        <aside className="lateral" id="menu-lateral" aria-label="Navegação principal">
          <div className="marca-lateral">
            <MarcaPrumo balanca={problemas.length > 0} />
            <p>
              Poli <span>2.0</span>
            </p>
          </div>
          <nav>
            <ul>
              {MENU.map((m) => {
                const n = diagnostico && m.contador ? m.contador(diagnostico) : 0;
                return (
                  <li key={m.para}>
                    <NavLink to={m.para} end={m.fim}>
                      {m.icone}
                      <span className="menu-rotulo">{m.rotulo}</span>
                      {n > 0 && (
                        <span className="menu-contador" title={`${n} ${n === 1 ? 'ponto pede' : 'pontos pedem'} atenção`}>
                          {n}
                        </span>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="lateral-rodape">
            {eu.workspaces.length > 1 && (
              <label className="campo-lateral">
                <span>Campanha</span>
                <select value={workspaceAtual} onChange={(e) => trocarWorkspace(Number(e.target.value))}>
                  {eu.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {typeof w.nome === 'string' && w.nome ? w.nome : `Workspace ${w.id}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="usuario-caixa">
              <span className="avatar" aria-hidden="true">
                {iniciais(nomeDoUsuario)}
              </span>
              <span className="usuario-nome">
                {nomeDoUsuario}
                <small>{papelAtual === 'admin' ? 'Administrador' : 'Head'}</small>
              </span>
              <button
                type="button"
                className="btn-icone"
                aria-label={`Tema ${ROTULO_TEMA[tema]}. Mudar para ${ROTULO_TEMA[temaSeguinte]}.`}
                title={`Tema ${ROTULO_TEMA[tema]} (clique para mudar)`}
                onClick={() => {
                  setTema(temaSeguinte);
                  guardarTema(temaSeguinte);
                }}
              >
                {ICONE_TEMA[tema]}
              </button>
              <button type="button" className="btn-icone" aria-label="Sair" title="Sair" onClick={() => void sair()}>
                <IconeSair />
              </button>
            </div>
          </div>
        </aside>
        <div className="principal">
          <header className="topo">
            <button type="button" className="btn btn-menu" aria-expanded={menuAberto} aria-controls="menu-lateral" onClick={() => setMenuAberto((v) => !v)}>
              <IconeMenu /> Menu
            </button>
            <p className="topo-marca">
              Poli <span>2.0</span>
            </p>
          </header>
          {/* No Diagnóstico o próprio destaque já diz o que houve: o aviso só aparece nas outras telas. */}
          {problemas.length > 0 && local.pathname !== '/' && (
            <div className="faixa-falha" role="alert">
              <IconeAviso />
              <p>
                <strong>{problemas.length === 1 ? 'Um ponto pede atenção:' : `${problemas.length} pontos pedem atenção:`}</strong> {problemas[0]}
              </p>
              <NavLink to="/" className="faixa-link">
                Ver tudo
              </NavLink>
            </div>
          )}
          <main id="conteudo" className="conteudo" tabIndex={-1} key={workspaceAtual}>
            <Outlet />
          </main>
        </div>
      </div>
    </DiagnosticoCtx.Provider>
  );
}

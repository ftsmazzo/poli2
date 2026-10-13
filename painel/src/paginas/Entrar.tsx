import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiError, api } from '../api';
import { Carregando } from '../components/Estados';

const TEXTO_LINK_INVALIDO = 'Este link já foi usado ou expirou. Peça outro no WhatsApp escrevendo: MapSolar painel';

// A página só abre o link; quem troca o token pela sessão é este POST, feito por JavaScript.
// Assim a pré-visualização de links do WhatsApp (que só faz GET) não gasta o link.
export function Entrar() {
  const [params] = useSearchParams();
  const navegar = useNavigate();
  const token = params.get('t') ?? '';
  const [erro, setErro] = useState<string | null>(null);
  const jaDisparou = useRef(false);

  useEffect(() => {
    if (jaDisparou.current) return;
    jaDisparou.current = true;
    if (!token) {
      setErro(TEXTO_LINK_INVALIDO);
      return;
    }
    // O token sai da barra de endereço logo de saída, para não ficar no histórico nem ser copiado por engano.
    window.history.replaceState(null, '', window.location.pathname);
    api.entrar(token).then(
      () => navegar('/', { replace: true }),
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setErro(TEXTO_LINK_INVALIDO);
        else setErro(e instanceof ApiError ? e.message : 'Não consegui entrar. Tente de novo.');
      },
    );
  }, [token, navegar]);

  if (!erro) {
    return (
      <main className="tela-central">
        <Carregando texto="Entrando…" />
      </main>
    );
  }
  return (
    <main className="tela-central">
      <section className="cartao cartao-central" aria-labelledby="t-entrar">
        <p className="marca">Poli 2.0</p>
        <h1 id="t-entrar">Não foi possível entrar</h1>
        <p className="aviso aviso-erro" role="alert">
          {erro}
        </p>
        <p className="suave">O link vale 15 minutos e só funciona uma vez.</p>
      </section>
    </main>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  titulo: string;
  aoFechar: () => void;
  children: ReactNode;
  lado?: 'direita' | 'centro';
  rodape?: ReactNode;
}

/** Gaveta lateral ou diálogo central: foco preso, fecha com Esc, devolve o foco a quem abriu. */
export function Dialogo({ titulo, aoFechar, children, lado = 'direita', rodape }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const idTitulo = useId();
  const fecharRef = useRef(aoFechar);
  fecharRef.current = aoFechar;

  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    const caixa = ref.current;
    const focaveis = () => (caixa ? Array.from(caixa.querySelectorAll<HTMLElement>(FOCAVEIS)) : []);
    const primeiroCampo = caixa?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea') ?? focaveis()[0];
    (primeiroCampo ?? caixa)?.focus();

    function tecla(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        fecharRef.current();
        return;
      }
      if (e.key !== 'Tab' || !caixa) return;
      const lista = focaveis();
      if (lista.length === 0) {
        e.preventDefault();
        return;
      }
      const primeiro = lista[0];
      const ultimo = lista[lista.length - 1];
      const ativo = document.activeElement;
      if (e.shiftKey && (ativo === primeiro || !caixa.contains(ativo))) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (ativo === ultimo || !caixa.contains(ativo))) {
        e.preventDefault();
        primeiro.focus();
      }
    }
    document.addEventListener('keydown', tecla, true);
    return () => {
      document.removeEventListener('keydown', tecla, true);
      anterior?.focus?.();
    };
  }, []);

  return (
    <div className="cortina" onMouseDown={(e) => e.target === e.currentTarget && aoFechar()}>
      <div ref={ref} className={`dialogo dialogo-${lado}`} role="dialog" aria-modal="true" aria-labelledby={idTitulo} tabIndex={-1}>
        <header className="dialogo-topo">
          <h2 id={idTitulo}>{titulo}</h2>
          <button type="button" className="btn btn-sutil" onClick={aoFechar} aria-label="Fechar">
            Fechar
          </button>
        </header>
        <div className="dialogo-corpo">{children}</div>
        {rodape && <footer className="dialogo-rodape">{rodape}</footer>}
      </div>
    </div>
  );
}

interface ConfirmarProps {
  titulo: string;
  mensagem: ReactNode;
  rotuloConfirmar: string;
  perigo?: boolean;
  ocupado?: boolean;
  aoConfirmar: () => void;
  aoCancelar: () => void;
}

export function Confirmar({ titulo, mensagem, rotuloConfirmar, perigo, ocupado, aoConfirmar, aoCancelar }: ConfirmarProps) {
  return (
    <Dialogo
      titulo={titulo}
      lado="centro"
      aoFechar={aoCancelar}
      rodape={
        <>
          <button type="button" className="btn" onClick={aoCancelar}>
            Cancelar
          </button>
          <button type="button" className={perigo ? 'btn btn-perigo' : 'btn btn-primario'} onClick={aoConfirmar} disabled={ocupado}>
            {rotuloConfirmar}
          </button>
        </>
      }
    >
      <div>{mensagem}</div>
    </Dialogo>
  );
}

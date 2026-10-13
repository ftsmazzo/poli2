import type { ReactNode } from 'react';

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Carregando({ texto = 'Carregando…', tela = false }: { texto?: string; tela?: boolean }) {
  return (
    <div className={tela ? 'estado estado-tela' : 'estado'} role="status">
      <Spinner />
      <span>{texto}</span>
    </div>
  );
}

export function ErroCarga({ mensagem, aoTentar, tela = false }: { mensagem: string; aoTentar?: () => void; tela?: boolean }) {
  return (
    <div className={tela ? 'estado estado-tela' : 'estado'} role="alert">
      <p className="estado-titulo">Não foi possível carregar</p>
      <p>{mensagem}</p>
      {aoTentar && (
        <button type="button" className="btn" onClick={aoTentar}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export function Vazio({ titulo, children }: { titulo: string; children?: ReactNode }) {
  return (
    <div className="estado vazio">
      <p className="estado-titulo">{titulo}</p>
      {children}
    </div>
  );
}

export function Aviso({ tipo = 'erro', children, aoFechar }: { tipo?: 'erro' | 'info'; children: ReactNode; aoFechar?: () => void }) {
  return (
    <div className={`aviso aviso-${tipo}`} role={tipo === 'erro' ? 'alert' : 'status'}>
      <span>{children}</span>
      {aoFechar && (
        <button type="button" className="btn btn-sutil" onClick={aoFechar} aria-label="Dispensar aviso">
          Dispensar
        </button>
      )}
    </div>
  );
}

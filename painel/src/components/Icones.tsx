import type { ReactNode } from 'react';

function Svg({ children, tamanho = 16 }: { children: ReactNode; tamanho?: number }) {
  return (
    <svg className="icone" width={tamanho} height={tamanho} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const IconeOk = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M5.2 8.3l2 2 3.6-4" />
  </Svg>
);
export const IconeErro = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
  </Svg>
);
export const IconeNunca = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.2" strokeDasharray="2.2 2.2" />
  </Svg>
);
export const IconeAviso = () => (
  <Svg>
    <path d="M8 2.2l6 10.6H2z" />
    <path d="M8 6.6v3M8 11.4v.1" />
  </Svg>
);
export const IconeInfo = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.4v3.4M8 5.2v.1" />
  </Svg>
);
export const IconeRelogio = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.6V8l2.4 1.4" />
  </Svg>
);
export const IconeMenu = () => (
  <Svg>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);

// Menu lateral (18 px).
export const IconePulso = () => (
  <Svg tamanho={18}>
    <path d="M1.5 8.5h3l1.6-4.5 3 8 1.9-5.5 1 2h2.5" />
  </Svg>
);
export const IconeFonte = () => (
  <Svg tamanho={18}>
    <path d="M5.5 2.5v3M10.5 2.5v3M4 5.5h8v2.2a4 4 0 0 1-8 0zM8 11.7v2" />
  </Svg>
);
export const IconeGrupo = () => (
  <Svg tamanho={18}>
    <circle cx="5.6" cy="5.8" r="2.1" />
    <circle cx="11" cy="6.6" r="1.7" />
    <path d="M1.8 12.8c0-2 1.7-3.4 3.8-3.4s3.8 1.4 3.8 3.4M10 9.6c2 0 3.8 1 4.2 3" />
  </Svg>
);
export const IconePessoa = () => (
  <Svg tamanho={18}>
    <circle cx="8" cy="5.4" r="2.6" />
    <path d="M2.8 13.6c.5-2.5 2.4-3.9 5.2-3.9s4.7 1.4 5.2 3.9" />
  </Svg>
);
export const IconeSino = () => (
  <Svg tamanho={18}>
    <path d="M3.6 11.2c.9-.9 1.1-2 1.1-3.3a3.3 3.3 0 0 1 6.6 0c0 1.3.2 2.4 1.1 3.3zM6.6 13.4a1.5 1.5 0 0 0 2.8 0" />
  </Svg>
);
export const IconeSol = () => (
  <Svg tamanho={17}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" />
  </Svg>
);
export const IconeLua = () => (
  <Svg tamanho={17}>
    <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
  </Svg>
);
export const IconeSair = () => (
  <Svg tamanho={17}>
    <path d="M6.5 2.5h-3v11h3M6 8h7.5M11 5.5L13.5 8 11 10.5" />
  </Svg>
);
export const IconeSistema = () => (
  <Svg tamanho={17}>
    <rect x="2" y="3" width="12" height="8" rx="1.4" />
    <path d="M5.5 13.5h5M8 11v2.5" />
  </Svg>
);

// A marca: um prumo (fio com peso). "balanca" faz o peso oscilar quando algo pede atenção.
export function MarcaPrumo({ balanca = false }: { balanca?: boolean }) {
  return (
    <svg className={`marca-prumo${balanca ? ' balanca' : ''}`} width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
      <circle cx="13" cy="3.6" r="1.6" fill="currentColor" />
      <g className="prumo-fio">
        <path d="M13 5.2v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <path d="M13 22.8l-4.2-6.2a2.6 2.6 0 0 1 0-2.9c.8-1.1 2.3-1.7 4.2-1.7s3.4.6 4.2 1.7a2.6 2.6 0 0 1 0 2.9z" fill="currentColor" />
      </g>
    </svg>
  );
}

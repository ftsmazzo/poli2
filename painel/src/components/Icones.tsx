import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="icone" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
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

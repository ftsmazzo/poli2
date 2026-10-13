export type Tema = 'sistema' | 'claro' | 'escuro';
const CHAVE = 'poli_tema';

export function lerTema(): Tema {
  try {
    const v = localStorage.getItem(CHAVE);
    if (v === 'claro' || v === 'escuro' || v === 'sistema') return v;
  } catch {
    /* ignora */
  }
  return 'sistema';
}

export function aplicarTema(t: Tema): void {
  const el = document.documentElement;
  if (t === 'sistema') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t === 'escuro' ? 'dark' : 'light');
}

export function guardarTema(t: Tema): void {
  try {
    localStorage.setItem(CHAVE, t);
  } catch {
    /* ignora */
  }
  aplicarTema(t);
}

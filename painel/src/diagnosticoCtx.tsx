import { createContext, useContext } from 'react';
import type { Diagnostico } from './api';

export interface ContextoDiagnostico {
  diagnostico: Diagnostico | null;
  erro: string | null;
  carregando: boolean;
  recarregar: () => void;
}

export const DiagnosticoCtx = createContext<ContextoDiagnostico | null>(null);

export function useDiagnostico(): ContextoDiagnostico {
  const c = useContext(DiagnosticoCtx);
  if (!c) throw new Error('useDiagnostico fora do Layout');
  return c;
}

/** Lista o que está errado e exige a faixa vermelha. Vazia = tudo certo. */
export function problemasDoDiagnostico(d: Diagnostico): string[] {
  const p: string[] = [];
  if (!d.instancia) p.push('Nenhum número de WhatsApp está conectado a este workspace.');
  else if (!d.instancia.numeroConhecido) p.push('O número do WhatsApp conectado ainda não foi identificado.');
  for (const f of d.fontes) {
    if (f.ativa && f.status === 'erro') p.push(`A Fonte "${f.nome}" está com erro${f.ultimoErro ? `: ${f.ultimoErro}` : '.'}`);
  }
  return p;
}

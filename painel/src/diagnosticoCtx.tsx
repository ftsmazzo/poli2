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
  if (d.instancia?.estadoConexao && d.instancia.estadoConexao !== 'open') {
    p.push(`O número da Poli está desconectado do WhatsApp (estado: ${d.instancia.estadoConexao}). Sem conexão ela não recebe mensagens nem responde: reconecte lendo o QR code na Evolution.`);
  }
  for (const f of d.fontes) {
    if (f.ativa && f.status === 'erro') p.push(`A Fonte "${f.nome}" está com erro${f.ultimoErro ? `: ${f.ultimoErro}` : '.'}`);
  }
  if (d.alertas && d.alertas.semDestino > 0) {
    p.push('Há alerta recente que não foi enviado porque não tem para quem ir: marque pelo menos um Head com telefone em Pessoas, ou escolha o Grupo dos Heads em Grupos.');
  }
  if (d.alertas && d.alertas.falhasDeEnvio > 0) {
    p.push(`${d.alertas.falhasDeEnvio} envio(s) de alerta aos Heads falharam (o WhatsApp recusou depois de 3 tentativas).`);
  }
  return p;
}

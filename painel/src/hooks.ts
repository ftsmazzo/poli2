import { useCallback, useEffect, useRef, useState } from 'react';
import { mensagemDeErro } from './api';

export interface Carga<T> {
  dados: T | null;
  erro: string | null;
  carregando: boolean;
  recarregar: () => void;
  definir: (fn: (atual: T | null) => T | null) => void;
}

/** Carrega dados de uma função assíncrona; ignora respostas de pedidos antigos. */
export function useCarregar<T>(buscar: () => Promise<T>): Carga<T> {
  const [dados, setDados] = useState<T | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const contador = useRef(0);
  const buscarRef = useRef(buscar);
  buscarRef.current = buscar;

  const recarregar = useCallback(() => {
    const id = ++contador.current;
    setCarregando(true);
    setErro(null);
    buscarRef.current().then(
      (d) => {
        if (id !== contador.current) return;
        setDados(d);
        setCarregando(false);
      },
      (e: unknown) => {
        if (id !== contador.current) return;
        setErro(mensagemDeErro(e));
        setCarregando(false);
      },
    );
  }, []);

  useEffect(() => {
    recarregar();
    return () => {
      contador.current++;
    };
  }, [recarregar]);

  return { dados, erro, carregando, recarregar, definir: (fn) => setDados((a) => fn(a)) };
}

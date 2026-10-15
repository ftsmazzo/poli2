import type { RequestHandler } from 'express';

// Cabeçalhos que fecham portas comuns: o link do painel não vaza pelo "Referer", a página não abre dentro de
// outro site (clickjacking) e o navegador não adivinha tipo de arquivo.
export const cabecalhosDeSeguranca: RequestHandler = (_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
};

// Limite de tentativas por endereço, em memória: basta para uma instância só. Passou do limite, responde 429.
export function limitarTentativas(opcoes: { janelaMs: number; max: number }, agora: () => number = Date.now): RequestHandler {
  const visitas = new Map<string, number[]>();
  return (req, res, next) => {
    const t = agora();
    const chave = req.ip ?? 'desconhecido';
    const recentes = (visitas.get(chave) ?? []).filter((x) => t - x < opcoes.janelaMs);
    if (recentes.length >= opcoes.max) {
      visitas.set(chave, recentes);
      res.setHeader('Retry-After', String(Math.ceil(opcoes.janelaMs / 1000)));
      res.status(429).json({ erro: 'muitas_tentativas' });
      return;
    }
    recentes.push(t);
    visitas.set(chave, recentes);
    // Não deixa o mapa crescer para sempre.
    if (visitas.size > 5000) for (const [k, v] of visitas) if (v.every((x) => t - x >= opcoes.janelaMs)) visitas.delete(k);
    next();
  };
}

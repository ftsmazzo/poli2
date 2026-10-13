import { defineConfig } from 'vitest/config';

// Os testes do servidor rodam aqui. O painel (painel/) tem a própria configuração, com jsdom.
export default defineConfig({
  test: { include: ['server/**/*.test.ts'] },
});

// Variável vazia no EasyPanel vale como não configurada.
function lerEnv(env: NodeJS.ProcessEnv, nome: string): string | undefined {
  const v = env[nome]?.trim();
  return v ? v : undefined;
}

export interface Config {
  port: number;
  databaseUrl?: string;
  webhookToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 3000,
    databaseUrl: lerEnv(env, 'DATABASE_URL'),
    webhookToken: lerEnv(env, 'EVOLUTION_WEBHOOK_TOKEN'),
  };
}

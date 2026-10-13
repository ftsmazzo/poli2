// Variável vazia no EasyPanel vale como não configurada.
function lerEnv(env: NodeJS.ProcessEnv, nome: string): string | undefined {
  const v = env[nome]?.trim();
  return v ? v : undefined;
}

export interface Config {
  port: number;
  databaseUrl?: string;
  webhookToken?: string;
  evolutionUrl?: string;
  evolutionApiKey?: string;
  // Como a Evolution enxerga este app dentro da rede do projeto (não passa pela internet).
  webhookBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 3000,
    databaseUrl: lerEnv(env, 'DATABASE_URL'),
    webhookToken: lerEnv(env, 'EVOLUTION_WEBHOOK_TOKEN'),
    evolutionUrl: lerEnv(env, 'EVOLUTION_URL'),
    evolutionApiKey: lerEnv(env, 'EVOLUTION_API_KEY'),
    webhookBaseUrl: lerEnv(env, 'WEBHOOK_BASE_URL') ?? 'http://poli2_app:3000',
  };
}

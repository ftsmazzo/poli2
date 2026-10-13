import { normalizarComandantes } from './agente/pedido';

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
  // Volume onde os arquivos originais ficam guardados.
  mediaDir: string;
  openrouterKey?: string;
  modeloOrquestrador: string;
  modeloRedatora: string;
  // Números que podem pedir coisas à Poli (só dígitos, com DDI). Vem do ambiente: nunca fica no repositório.
  comandantes: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 3000,
    databaseUrl: lerEnv(env, 'DATABASE_URL'),
    webhookToken: lerEnv(env, 'EVOLUTION_WEBHOOK_TOKEN'),
    evolutionUrl: lerEnv(env, 'EVOLUTION_URL'),
    evolutionApiKey: lerEnv(env, 'EVOLUTION_API_KEY'),
    webhookBaseUrl: lerEnv(env, 'WEBHOOK_BASE_URL') ?? 'http://poli2_app:3000',
    mediaDir: lerEnv(env, 'MEDIA_DIR') ?? '/data/midia',
    openrouterKey: lerEnv(env, 'OPENROUTER_API_KEY'),
    modeloOrquestrador: lerEnv(env, 'OPENROUTER_ORCH_MODEL') ?? 'anthropic/claude-haiku-5.5',
    modeloRedatora: lerEnv(env, 'OPENROUTER_REDATORA_MODEL') ?? 'anthropic/claude-sonnet-5.5',
    comandantes: normalizarComandantes((lerEnv(env, 'COMANDANTES') ?? '').split(/[,;\s]+/)),
  };
}

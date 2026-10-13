import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Segredos das Fontes (tokens de MCP, por exemplo) ficam criptografados no banco com AES-256-GCM.
// A chave vem do ambiente (ENCRYPTION_KEY) e nunca do repositório. Formato: v1:iv:tag:texto (base64).
const VERSAO = 'v1';

function derivar(chave: string): Buffer {
  if (!chave || chave.length < 16) throw new Error('ENCRYPTION_KEY ausente ou curta demais (mínimo 16 caracteres)');
  return createHash('sha256').update(chave).digest();
}

export function cifrar(texto: string, chave: string): string {
  const iv = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', derivar(chave), iv);
  const dados = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
  return [VERSAO, iv.toString('base64'), cifra.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

// Lança erro se a chave estiver errada ou se o valor tiver sido alterado (o GCM autentica o conteúdo).
export function decifrar(valor: string, chave: string): string {
  const [versao, iv, tag, dados] = valor.split(':');
  if (versao !== VERSAO || !iv || !tag || dados === undefined) throw new Error('Segredo em formato desconhecido');
  const decifra = createDecipheriv('aes-256-gcm', derivar(chave), Buffer.from(iv, 'base64'));
  decifra.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decifra.update(Buffer.from(dados, 'base64')), decifra.final()]).toString('utf8');
}

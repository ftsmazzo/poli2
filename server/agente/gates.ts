import { extrairLinks, extrairTelefones } from '../extrair/extrair';

export const SEM_RESULTADO = 'Não encontrei isso nas mensagens do grupo.';
const LIMITE_CARACTERES = 1500;

// Trava aplicada DEPOIS do modelo: o que a Poli manda não pode conter link nem telefone que não esteja
// no que as buscas devolveram. O modelo pode errar um dígito ou inventar um link; o código não deixa passar.
export function aplicarGates(resposta: string, evidencia: string): string {
  const chavesLinks = new Set(extrairLinks(evidencia).map((i) => i.chave));
  const chavesTelefones = new Set(extrairTelefones(evidencia).map((i) => i.chave));

  const linhasBoas = resposta
    .replace(/\s*[—–]\s*/g, ' - ')
    .split('\n')
    .filter((linha) => {
      const linksOk = extrairLinks(linha).every((i) => chavesLinks.has(i.chave));
      const fonesOk = extrairTelefones(linha).every((i) => chavesTelefones.has(i.chave));
      return linksOk && fonesOk;
    });

  let texto = linhasBoas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!texto) return SEM_RESULTADO;

  if (texto.length > LIMITE_CARACTERES) {
    const corte = texto.lastIndexOf('\n', LIMITE_CARACTERES);
    texto = `${texto.slice(0, corte > 200 ? corte : LIMITE_CARACTERES).trimEnd()}\n(resposta cortada)`;
  }
  return texto;
}

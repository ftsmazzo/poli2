import { extrairLinks, extrairTelefones } from '../extrair/extrair';

export const SEM_RESULTADO = 'Não encontrei isso nas mensagens do grupo.';
const LIMITE_CARACTERES = 1500;

// Números com 4 dígitos ou mais (votos, valores, protocolos) e sem ser ano. "1.234" e "1234" valem o mesmo.
function numerosGrandes(texto: string): string[] {
  return (texto.match(/\d[\d.,]*\d|\d/g) ?? [])
    .map((t) => t.replace(/[.,]/g, ''))
    .filter((t) => t.length >= 4 && !/^(19|20)\d{2}$/.test(t));
}

// Trava aplicada DEPOIS do modelo. O que a Poli manda não pode conter link, telefone nem cifra grande que não
// esteja no que as buscas devolveram: o modelo pode errar um dígito, arredondar ou inventar; o código não deixa passar.
export function filtrarLinhas(resposta: string, evidencia: string): string {
  const chavesLinks = new Set(extrairLinks(evidencia).map((i) => i.chave));
  const chavesTelefones = new Set(extrairTelefones(evidencia).map((i) => i.chave));
  const numerosDaEvidencia = numerosGrandes(evidencia);
  // Vale o número inteiro ou um pedaço dele (o telefone "99123-4567" aparece na evidência como "+5596991234567").
  const naEvidencia = (n: string) => numerosDaEvidencia.some((e) => e === n || e.includes(n));

  return resposta
    .replace(/\s*[—–]\s*/g, ' - ')
    .split('\n')
    .filter((linha) => {
      const linksOk = extrairLinks(linha).every((i) => chavesLinks.has(i.chave));
      const fonesOk = extrairTelefones(linha).every((i) => chavesTelefones.has(i.chave));
      const numerosOk = numerosGrandes(linha).every(naEvidencia);
      return linksOk && fonesOk && numerosOk;
    })
    .join('\n');
}

export function aplicarGates(resposta: string, evidencia: string): string {
  let texto = filtrarLinhas(resposta, evidencia).replace(/\n{3,}/g, '\n\n').trim();
  if (!texto) return SEM_RESULTADO;

  if (texto.length > LIMITE_CARACTERES) {
    const corte = texto.lastIndexOf('\n', LIMITE_CARACTERES);
    texto = `${texto.slice(0, corte > 200 ? corte : LIMITE_CARACTERES).trimEnd()}\n(resposta cortada)`;
  }
  return texto;
}

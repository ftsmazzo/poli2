import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { Db } from '../migrate';
import type { TipoMensagem } from './evolution';

export interface LinhaExportada {
  enviadaEm: Date;
  autor: string;
  texto: string | null;
  tipo: TipoMensagem;
}

// A exportação não traz fuso: assume o horário de Brasília/Amapá.
const FUSO = '-03:00';
const INVISIVEIS = /[‎‏‪-‮]/g;

// Android: "12/10/2026 14:35 - Fulano: texto"   iPhone: "[12/10/2026 14:35:20] Fulano: texto"
const ANDROID = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? - (.*)$/;
const IPHONE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\] (.*)$/;

const p2 = (v: string) => v.padStart(2, '0');

function cabecalho(linha: string): { data: Date; resto: string } | null {
  const m = ANDROID.exec(linha) ?? IPHONE.exec(linha);
  if (!m) return null;
  const [, dia, mes, a, hora, min, seg, resto] = m;
  const ano = a.length === 2 ? 2000 + Number(a) : Number(a);
  const data = new Date(`${ano}-${p2(mes)}-${p2(dia)}T${p2(hora)}:${min}:${p2(seg ?? '0')}${FUSO}`);
  return Number.isNaN(data.getTime()) ? null : { data, resto };
}

function tipoPorExtensao(nome: string): TipoMensagem {
  const ext = nome.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'imagem';
  if (['mp4', 'mov', '3gp'].includes(ext)) return 'video';
  if (['opus', 'ogg', 'm4a', 'mp3', 'aac', 'amr'].includes(ext)) return 'audio';
  if (ext === 'vcf') return 'contato';
  return 'documento';
}

const APAGADA = /^(esta mensagem foi apagada|você apagou esta mensagem|mensagem apagada)\.?$/i;
const MIDIA_OCULTA = /^<(mídia oculta|media omitted)>$/i;
const ANEXO = [/^<anexado: (.+)>$/i, /^(.+?) \(arquivo anexado\)$/i];

function montarLinha(data: Date, autor: string, partes: string[]): LinhaExportada | null {
  const texto = partes.join('\n').trim();
  if (!texto || APAGADA.test(texto)) return null;
  if (MIDIA_OCULTA.test(texto)) return { enviadaEm: data, autor, texto: null, tipo: 'outro' };

  const [primeira, ...resto] = texto.split('\n');
  for (const re of ANEXO) {
    const m = re.exec(primeira.trim());
    if (m) {
      const legenda = resto.join('\n').trim();
      return { enviadaEm: data, autor, texto: [m[1], legenda].filter(Boolean).join(' — '), tipo: tipoPorExtensao(m[1]) };
    }
  }
  return { enviadaEm: data, autor, texto, tipo: 'texto' };
}

// Lê o texto de uma exportação (Android ou iPhone). Mensagens de várias linhas viram uma só;
// avisos do sistema (criptografia, entrada em grupo etc.) não têm autor e são ignorados.
export function parseExportacao(conteudo: string): LinhaExportada[] {
  const linhas: LinhaExportada[] = [];
  let atual: { data: Date; autor: string; partes: string[] } | null = null;

  const fechar = () => {
    if (!atual) return;
    const l = montarLinha(atual.data, atual.autor, atual.partes);
    if (l) linhas.push(l);
    atual = null;
  };

  for (const bruta of conteudo.replace(/^﻿/, '').split(/\r?\n/)) {
    const linha = bruta.replace(INVISIVEIS, '');
    const c = cabecalho(linha);
    if (c) {
      fechar();
      const i = c.resto.indexOf(': ');
      atual = i > 0 ? { data: c.data, autor: c.resto.slice(0, i).trim(), partes: [c.resto.slice(i + 2)] } : null;
    } else if (atual) {
      atual.partes.push(linha);
    }
  }
  fechar();
  return linhas;
}

export function pareceExportacao(nomeArquivo: string | null): boolean {
  if (!nomeArquivo) return false;
  return /(conversa do whatsapp|whatsapp chat)/i.test(nomeArquivo) && /\.(zip|txt)$/i.test(nomeArquivo);
}

// Aceita o .txt direto ou um .zip (abre só os .txt, sem inflar fotos e vídeos).
export function extrairTextoExportacao(dados: Uint8Array): string | null {
  const ehZip = dados[0] === 0x50 && dados[1] === 0x4b;
  let bytes: Uint8Array | undefined = ehZip ? undefined : dados;
  if (ehZip) {
    const arquivos = unzipSync(dados, { filter: (f) => /\.txt$/i.test(f.name) });
    const entradas = Object.entries(arquivos);
    if (entradas.length === 0) return null;
    // Prefere o que se chama "conversa"/"chat"; senão o maior.
    entradas.sort(([na, a], [nb, b]) => {
      const pa = /(conversa|chat)/i.test(na) ? 1 : 0;
      const pb = /(conversa|chat)/i.test(nb) ? 1 : 0;
      return pb - pa || b.length - a.length;
    });
    bytes = entradas[0][1];
  }
  return bytes ? new TextDecoder('utf-8').decode(bytes) : null;
}

export interface ParamsImportacao {
  workspaceId: number;
  grupoId: number;
  grupoJid: string;
  // Id da mensagem do arquivo no WhatsApp: liga cada mensagem importada ao arquivo de origem.
  ref: string;
  texto: string;
}

export interface ResultadoImportacao {
  linhas: number;
  gravadas: number;
  jaExistiam: number;
}

const MINUTO = 60_000;

// Importa uma exportação para o grupo. É idempotente: reimportar o mesmo arquivo não duplica nada,
// e o que o webhook já gravou (mesmo texto na mesma hora, com 1 minuto de folga) é reconhecido e pulado.
export async function importarExportacao(db: Db, p: ParamsImportacao): Promise<ResultadoImportacao> {
  const linhas = parseExportacao(p.texto);
  const resultado: ResultadoImportacao = { linhas: linhas.length, gravadas: 0, jaExistiam: 0 };
  if (linhas.length === 0) return resultado;

  let menor = Infinity;
  let maior = -Infinity;
  for (const l of linhas) {
    const t = l.enviadaEm.getTime();
    if (t < menor) menor = t;
    if (t > maior) maior = t;
  }
  const existentes = await db.query(
    `select texto, enviada_em from mensagens
     where grupo_id = $1 and origem = 'whatsapp' and texto is not null and enviada_em between $2 and $3`,
    [p.grupoId, new Date(menor - 2 * MINUTO).toISOString(), new Date(maior + 2 * MINUTO).toISOString()],
  );
  const vistas = new Set<string>();
  for (const r of existentes.rows) vistas.add(`${r.texto}|${Math.floor(new Date(r.enviada_em).getTime() / MINUTO)}`);

  const pessoas = new Map<string, { id: number; jid: string | null }>();
  async function pessoaPorNome(nome: string) {
    const chave = nome.toLowerCase();
    const cache = pessoas.get(chave);
    if (cache) return cache;
    const achada = await db.query(
      'select id, jid from pessoas where workspace_id = $1 and lower(nome) = $2 order by id limit 1',
      [p.workspaceId, chave],
    );
    let pessoa: { id: number; jid: string | null };
    if (achada.rows.length > 0) {
      pessoa = { id: achada.rows[0].id, jid: achada.rows[0].jid };
    } else {
      const nova = await db.query(
        `insert into pessoas (workspace_id, nome, papel) values ($1, $2, 'outro') returning id`,
        [p.workspaceId, nome],
      );
      pessoa = { id: nova.rows[0].id, jid: null };
    }
    pessoas.set(chave, pessoa);
    return pessoa;
  }

  // Mensagens idênticas no mesmo minuto ganham número de ordem, para o id continuar único e estável.
  const ocorrencias = new Map<string, number>();

  for (const l of linhas) {
    if (l.texto !== null) {
      const b = Math.floor(l.enviadaEm.getTime() / MINUTO);
      if (vistas.has(`${l.texto}|${b - 1}`) || vistas.has(`${l.texto}|${b}`) || vistas.has(`${l.texto}|${b + 1}`)) {
        resultado.jaExistiam++;
        continue;
      }
    }
    const base = createHash('sha1')
      .update(`${p.grupoJid}|${l.enviadaEm.toISOString()}|${l.autor}|${l.texto ?? ''}`)
      .digest('hex');
    const n = (ocorrencias.get(base) ?? 0) + 1;
    ocorrencias.set(base, n);

    const pessoa = await pessoaPorNome(l.autor);
    const inserida = await db.query(
      `insert into mensagens
         (workspace_id, grupo_id, wa_message_id, autor_pessoa_id, autor_jid, enviada_em, tipo, texto, origem, importacao_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'exportacao', $9)
       on conflict (workspace_id, wa_message_id) do nothing
       returning id`,
      [p.workspaceId, p.grupoId, `exp-${base}-${n}`, pessoa.id, pessoa.jid, l.enviadaEm.toISOString(), l.tipo, l.texto, p.ref],
    );
    if (inserida.rows.length > 0) resultado.gravadas++;
    else resultado.jaExistiam++;
  }
  return resultado;
}

import type { Db } from '../migrate';
import { formatarQuando } from './ferramentas';
import { filtrarLinhas } from './gates';
import type { Chat } from './llm';
import type { Pedido } from './pedido';
import { promptMdDoDia } from './prompts';

const FUSO = 'America/Belem';
const MAX_GRUPOS = 8;
const MAX_MENSAGENS_POR_GRUPO = 400;
const LIMITE_TEXTO_DE_CONTINGENCIA = 3500;

const semAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// "gera o MD de hoje", "md do dia", "manda o markdown de ontem". Só frase curta: "MD" no meio de uma pergunta longa é outra coisa.
export function ehPedidoDeMd(consulta: string): { quando: 'hoje' | 'ontem' } | null {
  const limpa = semAcento(consulta).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(md|markdown)\b/.test(limpa) || limpa.split(' ').length > 8) return null;
  return { quando: /\bontem\b/.test(limpa) ? 'ontem' : 'hoje' };
}

// "AAAA-MM-DD" do horário de Belém.
const diaEmBelem = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: FUSO });
function somarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return diaEmBelem(d);
}
const porExtenso = (dia: string) =>
  new Date(`${dia}T12:00:00-03:00`).toLocaleDateString('pt-BR', { timeZone: FUSO, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

export interface MdGerado {
  nomeArquivo: string;
  markdown: string;
  grupos: number;
  mensagens: number;
}

const SECOES: Record<string, string> = { link: 'Links', contato: 'Contatos', endereco: 'Endereços', arquivo: 'Arquivos' };

// Resumo do dia em Markdown: para cada grupo, o que o modelo concluiu das mensagens e, à parte, os links, contatos,
// endereços e arquivos que o banco já extraiu (esses não passam pelo modelo, então não podem ser inventados).
export async function gerarMdDoDia(db: Db, chat: Chat, modelo: string, workspaceId: number, dia: string, agora = new Date()): Promise<MdGerado | null> {
  const inicio = new Date(`${dia}T00:00:00-03:00`).toISOString();
  const fim = new Date(`${somarDias(dia, 1)}T00:00:00-03:00`).toISOString();

  const grupos = await db.query(
    `select g.id, coalesce(g.nome, g.jid) as nome, count(*)::int as n
     from mensagens m join grupos g on g.id = m.grupo_id
     where m.workspace_id = $1 and m.texto is not null and m.tipo <> 'sticker' and m.enviada_em >= $2 and m.enviada_em < $3
     group by g.id order by n desc limit ${MAX_GRUPOS}`,
    [workspaceId, inicio, fim],
  );
  if (grupos.rows.length === 0) return null;

  const blocos: string[] = [];
  let total = 0;
  for (const g of grupos.rows) {
    total += Number(g.n);
    const msgs = await db.query(
      `select * from (
         select m.id, m.enviada_em, coalesce(p.nome, 'alguém') as autor, left(m.texto, 500) as texto
         from mensagens m left join pessoas p on p.id = m.autor_pessoa_id
         where m.grupo_id = $1 and m.texto is not null and m.tipo <> 'sticker' and m.enviada_em >= $2 and m.enviada_em < $3
         order by m.id desc limit ${MAX_MENSAGENS_POR_GRUPO}
       ) t order by id`,
      [g.id, inicio, fim],
    );
    const linhas = msgs.rows.map((m) => `[${formatarQuando(m.enviada_em).slice(11)}] ${m.autor}: ${String(m.texto).replace(/\s+/g, ' ')}`).join('\n');

    let resumo: string;
    try {
      const r = await chat({
        model: modelo,
        messages: [
          { role: 'system', content: promptMdDoDia() },
          { role: 'user', content: `Grupo: ${g.nome}\nDia: ${porExtenso(dia)}\n\nMensagens:\n${linhas}` },
        ],
      });
      // A trava corta linha com link, telefone ou número grande que não esteja nas mensagens.
      resumo = filtrarLinhas(r.content ?? '', linhas).replace(/\n{3,}/g, '\n\n').trim();
    } catch (err) {
      console.error('resumo do dia falhou:', err instanceof Error ? err.message : err);
      resumo = '';
    }

    const itens = await db.query(
      `select i.tipo, i.valor, i.dados, i.enviada_em, coalesce(p.nome, 'alguém') as autor
       from itens i left join pessoas p on p.id = i.autor_pessoa_id
       where i.workspace_id = $1 and i.grupo_id = $2 and i.enviada_em >= $3 and i.enviada_em < $4
       order by i.enviada_em`,
      [workspaceId, g.id, inicio, fim],
    );
    const secoes: string[] = [];
    for (const [tipo, titulo] of Object.entries(SECOES)) {
      const vistos = new Set<string>();
      const linhasDoTipo: string[] = [];
      for (const i of itens.rows.filter((x) => x.tipo === tipo)) {
        const valor = String(i.valor);
        if (vistos.has(valor)) continue;
        vistos.add(valor);
        const nome = typeof i.dados?.nome === 'string' && i.dados.nome ? `${i.dados.nome}: ` : '';
        linhasDoTipo.push(`- ${nome}${valor} (${i.autor}, ${formatarQuando(i.enviada_em).slice(11)})`);
      }
      if (linhasDoTipo.length) secoes.push(`**${titulo}**\n${linhasDoTipo.join('\n')}`);
    }

    blocos.push(
      [`## ${g.nome} (${g.n} ${Number(g.n) === 1 ? 'mensagem' : 'mensagens'})`, resumo || '_Não consegui resumir este grupo agora._', ...secoes].join('\n\n'),
    );
  }

  const cabecalho = [
    `# Resumo do dia: ${porExtenso(dia)}`,
    `Gerado pela Poli às ${formatarQuando(agora).slice(11)} (horário de Brasília). Cobre ${grupos.rows.length} ${grupos.rows.length === 1 ? 'grupo' : 'grupos'} e ${total} mensagens de texto.`,
  ].join('\n\n');
  return { nomeArquivo: `poli-md-${dia}.md`, markdown: `${cabecalho}\n\n${blocos.join('\n\n')}\n`, grupos: grupos.rows.length, mensagens: total };
}

export interface DepsMd {
  db: Db;
  chat: Chat;
  modelo: string;
  enviarTexto: (instancia: string, destino: string, texto: string) => Promise<{ waMessageId: string | null }>;
  enviarDocumento: (instancia: string, destino: string, doc: { nomeArquivo: string; conteudo: string; mime: string; legenda?: string }) => Promise<{ waMessageId: string | null }>;
  agora?: () => Date;
}

export type ResultadoMd = 'enviado' | 'texto' | 'vazio' | 'erro';

// Gera o MD do dia e manda o arquivo para quem pediu (no grupo ou no privado, onde foi pedido).
export async function entregarMdDoDia(deps: DepsMd, p: Pedido, quando: 'hoje' | 'ontem'): Promise<ResultadoMd> {
  const { db } = deps;
  const agora = deps.agora?.() ?? new Date();
  const dia = quando === 'hoje' ? diaEmBelem(agora) : somarDias(diaEmBelem(agora), -1);
  const tipo = p.privado ? 'privado' : 'grupo';
  const registrar = (texto: string, estado: 'enviada' | 'falhou', waMessageId: string | null = null) =>
    db.query(
      `insert into mensagens_saida (workspace_id, destino_jid, destino_tipo, origem, texto, estado, wa_message_id, enviada_em)
       values ($1, $2, $3, 'md', $4, $5, $6, case when $5 = 'enviada' then now() end)`,
      [p.workspaceId, p.grupoJid, tipo, texto, estado, waMessageId],
    );

  // Resumir vários grupos leva um minuto: avisa que começou.
  await deps.enviarTexto(p.instancia, p.grupoJid, `Gerando o MD de ${quando === 'hoje' ? 'hoje' : 'ontem'}, um instante.`).catch(() => undefined);

  let md: MdGerado | null;
  try {
    md = await gerarMdDoDia(db, deps.chat, deps.modelo, p.workspaceId, dia, agora);
  } catch (err) {
    console.error('MD do dia falhou:', err instanceof Error ? err.message : err);
    await deps.enviarTexto(p.instancia, p.grupoJid, 'Não consegui gerar o MD agora. Tenta de novo em instantes.').catch(() => undefined);
    return 'erro';
  }
  if (!md) {
    await deps.enviarTexto(p.instancia, p.grupoJid, `Não houve mensagens de texto nos grupos em ${porExtenso(dia)}.`).catch(() => undefined);
    return 'vazio';
  }

  try {
    const r = await deps.enviarDocumento(p.instancia, p.grupoJid, {
      nomeArquivo: md.nomeArquivo,
      conteudo: md.markdown,
      mime: 'text/markdown',
      legenda: `Resumo do dia, ${md.grupos} ${md.grupos === 1 ? 'grupo' : 'grupos'}, ${md.mensagens} mensagens.`,
    });
    await registrar(`[arquivo ${md.nomeArquivo}]`, 'enviada', r.waMessageId);
    return 'enviado';
  } catch (err) {
    console.error('envio do MD como arquivo falhou:', err instanceof Error ? err.message : err);
  }

  // Contingência: se o WhatsApp recusar o arquivo, manda o começo como texto, em vez de ficar sem nada.
  try {
    const texto = md.markdown.length > LIMITE_TEXTO_DE_CONTINGENCIA ? `${md.markdown.slice(0, LIMITE_TEXTO_DE_CONTINGENCIA).trimEnd()}\n(texto cortado: não consegui mandar o arquivo)` : md.markdown;
    const r = await deps.enviarTexto(p.instancia, p.grupoJid, texto);
    await registrar('[MD enviado como texto]', 'enviada', r.waMessageId);
    return 'texto';
  } catch (err) {
    console.error('envio do MD como texto falhou:', err instanceof Error ? err.message : err);
    await registrar('[MD não enviado]', 'falhou');
    return 'erro';
  }
}

import type { Db } from '../migrate';
import { comoVetor, type Embedder } from '../busca/embeddings';
import type { EspecFerramenta } from './llm';

const FUSO = 'America/Belem';

// "2026-10-12 14:35" no horário de Brasília/Amapá: é assim que o modelo lê e escreve datas.
export function formatarQuando(d: Date | string): string {
  return new Date(d).toLocaleString('sv-SE', { timeZone: FUSO }).slice(0, 16);
}

// Aceita "AAAA-MM-DD" ou "AAAA-MM-DD HH:mm" no horário de Brasília. Data pura no "ate" vale até o fim do dia.
export function instante(valor: unknown, fimDoDia = false): string | null {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  const v = valor.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00-03:00`);
    if (Number.isNaN(d.getTime())) return null;
    if (fimDoDia) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  const d = new Date(/(z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v.replace(' ', 'T')}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function palavras(texto: unknown): string[] {
  if (typeof texto !== 'string') return [];
  const unicas = new Set(
    texto
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((p) => p.length >= 3),
  );
  return [...unicas].slice(0, 8);
}

const limite = (v: unknown, padrao: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : padrao;
};

// Monta "where" com parâmetros numerados, sem nunca colocar texto do modelo dentro do SQL.
class Consulta {
  readonly condicoes: string[] = [];
  readonly params: unknown[] = [];
  param(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  onde(c: string) {
    this.condicoes.push(c);
  }
  get where() {
    return this.condicoes.join(' and ');
  }
}

export interface Ferramentas {
  specs: EspecFerramenta[];
  executar(nome: string, argumentosJson: string): Promise<unknown>;
}

// Quantas conversas parecidas voltam, e o quanto precisam se parecer (0 a 1) para valer a pena mostrar.
const TRECHOS_PARECIDOS = 5;
const PARECIDO_MINIMO = 0.25;

export function criarFerramentas(db: Db, workspaceId: number, embed?: Embedder): Ferramentas {
  const filtrosComuns = (c: Consulta, a: any, colunaData: string, colunaGrupo: string) => {
    if (typeof a.grupo === 'string' && a.grupo.trim()) c.onde(`${colunaGrupo} ilike ${c.param(`%${a.grupo.trim()}%`)}`);
    const de = instante(a.de);
    const ate = instante(a.ate, true);
    if (de) c.onde(`${colunaData} >= ${c.param(de)}`);
    if (ate) c.onde(`${colunaData} < ${c.param(ate)}`);
  };

  async function buscarMensagens(a: any) {
    const termos = palavras(a.consulta);
    if (termos.length === 0) return { erro: 'Informe palavras para buscar em "consulta".' };
    const max = limite(a.limite, 15, 30);

    const rodar = async (modo: 'texto' | 'parte') => {
      const c = new Consulta();
      c.onde(`m.workspace_id = ${c.param(workspaceId)}`);
      c.onde('m.texto is not null');
      let ordem = 'm.enviada_em desc';
      if (modo === 'texto') {
        const q = c.param(termos.join(' or '));
        c.onde(`m.tsv @@ websearch_to_tsquery('portuguese', ${q})`);
        ordem = `ts_rank(m.tsv, websearch_to_tsquery('portuguese', ${q})) desc, m.enviada_em desc`;
      } else {
        c.onde(`m.texto ilike any(${c.param(termos.map((t) => `%${t}%`))})`);
      }
      filtrosComuns(c, a, 'm.enviada_em', 'g.nome');
      const r = await db.query(
        `select m.id, g.nome as grupo, coalesce(p.nome, m.autor_jid, 'desconhecido') as autor,
                m.enviada_em, m.tipo, left(m.texto, 600) as texto
         from mensagens m
         left join grupos g on g.id = m.grupo_id
         left join pessoas p on p.id = m.autor_pessoa_id
         where ${c.where}
         order by ${ordem}
         limit ${c.param(max)}`,
        c.params,
      );
      return r.rows;
    };

    // Busca por palavra inteira (português, com radical); se nada vier, busca por pedaço de palavra.
    let rows = await rodar('texto');
    if (rows.length === 0) rows = await rodar('parte');
    const mensagens = rows.map((r) => ({ id: Number(r.id), grupo: r.grupo, autor: r.autor, quando: formatarQuando(r.enviada_em), texto: r.texto }));
    if (!embed) return { total: rows.length, mensagens };
    // Busca por significado: acha a conversa mesmo sem a palavra exata. Se falhar, a busca por palavras segue valendo.
    let trechosParecidos: unknown[] = [];
    try {
      trechosParecidos = await buscarTrechos(a);
    } catch (err) {
      console.error('busca por significado falhou:', err instanceof Error ? err.message : err);
    }
    return { total: rows.length, mensagens, trechos_parecidos: trechosParecidos };
  }

  // Conversas (janelas de mensagens seguidas) parecidas em significado com a consulta, da mais parecida à menos.
  async function buscarTrechos(a: any) {
    const [vetor] = await embed!([String(a.consulta).slice(0, 2000)]);
    const c = new Consulta();
    c.onde(`j.workspace_id = ${c.param(workspaceId)}`);
    c.onde('j.embedding is not null');
    filtrosComuns(c, a, 'j.inicio_em', 'g.nome');
    const v = c.param(comoVetor(vetor));
    const r = await db.query(
      `select j.de_msg_id, g.nome as grupo, j.inicio_em, j.texto, 1 - (j.embedding <=> ${v}::vector) as parecido
       from janelas j join grupos g on g.id = j.grupo_id
       where ${c.where}
       order by j.embedding <=> ${v}::vector
       limit ${c.param(TRECHOS_PARECIDOS)}`,
      c.params,
    );
    return r.rows
      .filter((x) => Number(x.parecido) >= PARECIDO_MINIMO)
      .map((x) => ({
        grupo: x.grupo,
        quando: formatarQuando(x.inicio_em),
        parecido: Math.round(Number(x.parecido) * 100) / 100,
        mensagem_id: Number(x.de_msg_id),
        texto: String(x.texto).slice(0, 1500),
      }));
  }

  async function buscarItens(a: any) {
    const c = new Consulta();
    c.onde(`i.workspace_id = ${c.param(workspaceId)}`);
    if (['link', 'contato', 'endereco', 'arquivo'].includes(a.tipo)) c.onde(`i.tipo = ${c.param(a.tipo)}`);
    const termos = palavras(a.termo);
    if (termos.length > 0) {
      const padroes = c.param(termos.map((t) => `%${t}%`));
      c.onde(`(i.valor ilike any(${padroes}) or i.dados::text ilike any(${padroes}) or m.texto ilike any(${padroes}))`);
    }
    filtrosComuns(c, a, 'i.enviada_em', 'g.nome');
    const r = await db.query(
      `select i.tipo, i.valor, i.dados, i.enviada_em, i.mensagem_id, g.nome as grupo,
              coalesce(p.nome, 'desconhecido') as autor, left(m.texto, 300) as trecho
       from itens i
       join mensagens m on m.id = i.mensagem_id
       left join grupos g on g.id = i.grupo_id
       left join pessoas p on p.id = i.autor_pessoa_id
       where ${c.where}
       order by i.enviada_em desc
       limit ${c.param(limite(a.limite, 10, 30))}`,
      c.params,
    );
    return {
      total: r.rows.length,
      itens: r.rows.map((x) => {
        const { contexto: _contexto, ...dados } = x.dados ?? {};
        return {
          tipo: x.tipo,
          valor: x.valor,
          dados,
          grupo: x.grupo,
          autor: x.autor,
          quando: formatarQuando(x.enviada_em),
          mensagem_id: Number(x.mensagem_id),
          trecho: x.trecho,
        };
      }),
    };
  }

  async function contextoMensagem(a: any) {
    const id = Number(a.mensagem_id);
    if (!Number.isFinite(id)) return { erro: 'Informe mensagem_id.' };
    const alvo = await db.query('select grupo_id, enviada_em from mensagens where id = $1 and workspace_id = $2', [id, workspaceId]);
    if (alvo.rows.length === 0) return { erro: 'Mensagem não encontrada.' };
    const { grupo_id: grupoId, enviada_em: quando } = alvo.rows[0];
    const colunas = `m.id, coalesce(p.nome, m.autor_jid, 'desconhecido') as autor, m.enviada_em, left(m.texto, 400) as texto`;
    const base = `from mensagens m left join pessoas p on p.id = m.autor_pessoa_id where m.workspace_id = $1 and m.grupo_id = $2`;
    const antes = await db.query(
      `select ${colunas} ${base} and m.enviada_em <= $3 order by m.enviada_em desc, m.id desc limit $4`,
      [workspaceId, grupoId, quando, limite(a.antes, 5, 15) + 1],
    );
    const depois = await db.query(
      `select ${colunas} ${base} and m.enviada_em > $3 order by m.enviada_em asc, m.id asc limit $4`,
      [workspaceId, grupoId, quando, limite(a.depois, 5, 15)],
    );
    const linhas = [...antes.rows.reverse(), ...depois.rows];
    return { mensagens: linhas.map((r) => ({ id: Number(r.id), autor: r.autor, quando: formatarQuando(r.enviada_em), texto: r.texto })) };
  }

  async function mensagensDoPeriodo(a: any) {
    if (!instante(a.de)) return { erro: 'Informe "de" no formato AAAA-MM-DD.' };
    const c = new Consulta();
    c.onde(`m.workspace_id = ${c.param(workspaceId)}`);
    c.onde(`m.texto is not null`);
    filtrosComuns(c, a, 'm.enviada_em', 'g.nome');
    const total = await db.query(
      `select count(*)::int as n from mensagens m left join grupos g on g.id = m.grupo_id where ${c.where}`,
      c.params,
    );
    const max = limite(a.limite, 1500, 2500);
    const r = await db.query(
      `select coalesce(p.nome, m.autor_jid, 'desconhecido') as autor, m.enviada_em, left(m.texto, 500) as texto, g.nome as grupo
       from mensagens m
       left join grupos g on g.id = m.grupo_id
       left join pessoas p on p.id = m.autor_pessoa_id
       where ${c.where}
       order by m.enviada_em asc
       limit ${c.param(max)}`,
      c.params,
    );
    return {
      total: total.rows[0].n,
      mostradas: r.rows.length,
      linhas: r.rows.map((x) => `[${formatarQuando(x.enviada_em)}] ${x.autor}: ${String(x.texto).replace(/\s+/g, ' ')}`),
    };
  }

  async function listarGrupos() {
    const r = await db.query(
      `select g.nome, g.jid, count(m.id)::int as mensagens, max(m.enviada_em) as ultima
       from grupos g left join mensagens m on m.grupo_id = g.id
       where g.workspace_id = $1
       group by g.id order by max(m.enviada_em) desc nulls last`,
      [workspaceId],
    );
    return { grupos: r.rows.map((x) => ({ nome: x.nome ?? x.jid, mensagens: x.mensagens, ultima: x.ultima ? formatarQuando(x.ultima) : null })) };
  }

  const objeto = (propriedades: Record<string, unknown>, obrigatorios: string[] = []) => ({
    type: 'object',
    properties: propriedades,
    required: obrigatorios,
  });
  const comuns = {
    grupo: { type: 'string', description: 'Parte do nome do grupo (opcional).' },
    de: { type: 'string', description: 'Data inicial AAAA-MM-DD, horário de Brasília (opcional).' },
    ate: { type: 'string', description: 'Data final AAAA-MM-DD, inclusive (opcional).' },
    limite: { type: 'number', description: 'Máximo de resultados (opcional).' },
  };

  const specs: EspecFerramenta[] = [
    {
      type: 'function',
      function: {
        name: 'buscar_itens',
        description: 'Busca links, contatos/telefones, endereços ou arquivos que foram citados nas conversas dos grupos, do mais recente ao mais antigo.',
        parameters: objeto({ tipo: { type: 'string', enum: ['link', 'contato', 'endereco', 'arquivo'] }, termo: { type: 'string', description: 'Nome, assunto ou palavra para filtrar (opcional).' }, ...comuns }),
      },
    },
    {
      type: 'function',
      function: {
        name: 'buscar_mensagens',
        description:
          'Busca mensagens dos grupos por assunto ou palavras. Devolve as mais relevantes, com autor, data e id. Também devolve "trechos_parecidos": conversas inteiras que falam do mesmo assunto mesmo com outras palavras (use quando as mensagens exatas não aparecerem ou para entender o contexto).',
        parameters: objeto({ consulta: { type: 'string', description: 'Palavras-chave do assunto.' }, ...comuns }, ['consulta']),
      },
    },
    {
      type: 'function',
      function: {
        name: 'mensagens_do_periodo',
        description: 'Traz as mensagens de um período, em ordem, para resumir o que aconteceu em um grupo.',
        parameters: objeto(comuns, ['de']),
      },
    },
    {
      type: 'function',
      function: {
        name: 'contexto_mensagem',
        description: 'Traz as mensagens em volta de uma mensagem já encontrada, para entender a conversa.',
        parameters: objeto({ mensagem_id: { type: 'number' }, antes: { type: 'number' }, depois: { type: 'number' } }, ['mensagem_id']),
      },
    },
    {
      type: 'function',
      function: { name: 'listar_grupos', description: 'Lista os grupos que a Poli acompanha, com o total de mensagens.', parameters: objeto({}) },
    },
  ];

  const funcoes: Record<string, (a: any) => Promise<unknown>> = {
    buscar_itens: buscarItens,
    buscar_mensagens: buscarMensagens,
    mensagens_do_periodo: mensagensDoPeriodo,
    contexto_mensagem: contextoMensagem,
    listar_grupos: () => listarGrupos(),
  };

  return {
    specs,
    async executar(nome, argumentosJson) {
      const fn = funcoes[nome];
      if (!fn) return { erro: `Ferramenta desconhecida: ${nome}` };
      let args: unknown = {};
      try {
        args = argumentosJson ? JSON.parse(argumentosJson) : {};
      } catch {
        return { erro: 'Argumentos inválidos (JSON).' };
      }
      try {
        return await fn(args && typeof args === 'object' ? args : {});
      } catch (err) {
        return { erro: `Falha na busca: ${err instanceof Error ? err.message : 'erro'}` };
      }
    },
  };
}

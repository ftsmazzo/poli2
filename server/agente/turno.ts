import type { Embedder } from '../busca/embeddings';
import { ferramentasMcp, type ConectorMcp, type FerramentasMcp } from '../fontes/mcp';
import type { Db } from '../migrate';
import { criarFerramentas } from './ferramentas';
import { aplicarGates } from './gates';
import type { Chat, MensagemChat } from './llm';
import type { Pedido } from './pedido';
import { promptOrquestrador, promptRedatora } from './prompts';

export interface DepsTurno {
  db: Db;
  chat: Chat;
  modelos: { orquestrador: string; redatora: string };
  enviar: (instancia: string, grupoJid: string, texto: string) => Promise<{ waMessageId: string | null }>;
  agora?: () => Date;
  // Fontes MCP cadastradas no painel. Sem os dois, o agente usa só as mensagens dos grupos.
  conectorMcp?: ConectorMcp;
  chaveCripto?: string;
  // Busca por significado nas conversas. Sem ele, só a busca por palavras.
  embed?: Embedder;
}

const MAX_PASSOS = 6;
const MAX_TURNOS_ANTERIORES = 3;
const MAX_RESULTADO = 15_000;
const MAX_EVIDENCIA = 60_000;
const FALHA = 'Não consegui responder agora. Tenta de novo em instantes.';

export type SituacaoTurno = 'respondido' | 'duplicado' | 'erro';

// Um pedido, do início ao fim: busca (modelo barato com ferramentas), redação (modelo melhor, só com as
// evidências), trava de segurança, envio e registro. O mesmo pedido nunca é respondido duas vezes.
export async function responderPedido(deps: DepsTurno, p: Pedido): Promise<SituacaoTurno> {
  const { db } = deps;
  const inicio = Date.now();

  const novo = await db.query(
    `insert into turnos (workspace_id, grupo_id, pergunta, wa_message_id, contato)
     values ($1, (select id from grupos where workspace_id = $1 and jid = $2), $3, $4, $2)
     on conflict (workspace_id, wa_message_id) where wa_message_id is not null do nothing
     returning id`,
    [p.workspaceId, p.grupoJid, p.consulta, p.waMessageId],
  );
  if (novo.rows.length === 0) return 'duplicado';
  const turnoId = novo.rows[0].id as number;
  const destinoTipo = p.privado ? 'privado' : 'grupo';

  const usadas: string[] = [];
  let situacao: SituacaoTurno = 'respondido';
  let resposta: string;
  let mcp: FerramentasMcp | null = null;

  try {
    const ferramentas = criarFerramentas(db, p.workspaceId, deps.embed);
    if (deps.conectorMcp) {
      const grupo = await db.query('select id from grupos where workspace_id = $1 and jid = $2', [p.workspaceId, p.grupoJid]);
      // Sem chave, só as Fontes sem segredo funcionam (decifrar o resto falha com erro claro).
      mcp = await ferramentasMcp(db, deps.conectorMcp, deps.chaveCripto ?? '', p.workspaceId, grupo.rows[0] ? Number(grupo.rows[0].id) : null);
    }
    const agora = (deps.agora?.() ?? new Date()).toLocaleString('pt-BR', {
      timeZone: 'America/Belem',
      dateStyle: 'full',
      timeStyle: 'short',
    });

    // O que foi pedido e respondido há pouco neste mesmo grupo ou privado: sem isso, "Onde procurou?" ou
    // "e a saúde?" não fazem sentido para a Poli. Só os turnos já respondidos, dos últimos 30 minutos.
    const anteriores = (
      await db.query(
        `select pergunta, resposta from turnos
         where workspace_id = $1 and contato = $2 and id < $3 and resposta is not null and criado_em > now() - interval '30 minutes'
         order by id desc limit ${MAX_TURNOS_ANTERIORES}`,
        [p.workspaceId, p.grupoJid, turnoId],
      )
    ).rows.reverse() as { pergunta: string; resposta: string }[];
    const recente = anteriores.length
      ? `Conversa recente com esta pessoa/grupo (use só para entender o pedido atual):\n${anteriores.map((t) => `Pedido: ${t.pergunta}\nPoli respondeu: ${t.resposta}`).join('\n\n')}\n\n`
      : '';

    const conversa: MensagemChat[] = [
      {
        role: 'system',
        content: promptOrquestrador(agora) + (mcp?.orientacoes ? `\n\nOrientações das Fontes conectadas (escritas pela equipe; quando mais de uma servir, combine):\n${mcp.orientacoes}` : ''),
      },
      {
        role: 'user',
        content:
          recente +
          (p.privado
            ? `Pedido de ${p.autorNome ?? 'alguém'} no privado: ${p.consulta}`
            : `Pedido de ${p.autorNome ?? 'alguém'} no grupo "${p.grupoNome ?? p.grupoJid}": ${p.consulta}`),
      },
    ];
    const evidencias: string[] = [];
    let notas = '';

    for (let passo = 0; passo < MAX_PASSOS; passo++) {
      const r = await deps.chat({ model: deps.modelos.orquestrador, messages: conversa, tools: [...ferramentas.specs, ...(mcp?.specs ?? [])] });
      if (r.toolCalls.length === 0) {
        notas = r.content ?? '';
        break;
      }
      conversa.push({ role: 'assistant', content: r.content, tool_calls: r.toolCalls });
      for (const chamada of r.toolCalls) {
        usadas.push(chamada.function.name);
        const executor = mcp?.ehMinha(chamada.function.name) ? mcp : ferramentas;
        const bruto = JSON.stringify(await executor.executar(chamada.function.name, chamada.function.arguments));
        const saida = bruto.slice(0, MAX_RESULTADO);
        // Rastro de como a Poli consultou (ferramenta, argumentos e tamanho): sem ele não dá para saber por que uma busca falhou.
        console.log(`consulta: ${chamada.function.name} ${chamada.function.arguments.slice(0, 300)} -> ${bruto.length} caracteres${bruto.length > MAX_RESULTADO ? ' (cortado)' : ''}`);
        evidencias.push(saida);
        conversa.push({ role: 'tool', tool_call_id: chamada.id, content: saida });
      }
    }

    const evidencia = evidencias.join('\n').slice(0, MAX_EVIDENCIA);
    const redacao = await deps.chat({
      model: deps.modelos.redatora,
      messages: [
        { role: 'system', content: promptRedatora() },
        {
          role: 'user',
          content: `${recente}Pedido: ${p.consulta}\n\nNotas da busca:\n${notas || '(sem notas)'}\n\nEvidências:\n${evidencia || '(nenhuma busca devolveu resultado)'}`,
        },
      ],
    });
    resposta = aplicarGates(redacao.content ?? '', evidencia);
  } catch (err) {
    situacao = 'erro';
    resposta = FALHA;
    // Só a mensagem do erro: nunca o pedido nem o conteúdo das conversas.
    console.error('turno falhou:', err instanceof Error ? err.message : err);
  } finally {
    await mcp?.fechar();
  }

  try {
    const enviada = await deps.enviar(p.instancia, p.grupoJid, resposta);
    await db.query(
      `insert into mensagens_saida (workspace_id, destino_jid, destino_tipo, origem, texto, estado, wa_message_id, enviada_em)
       values ($1, $2, $5, 'resposta', $3, 'enviada', $4, now())`,
      [p.workspaceId, p.grupoJid, resposta, enviada.waMessageId, destinoTipo],
    );
  } catch (err) {
    situacao = 'erro';
    console.error('envio da resposta falhou:', err instanceof Error ? err.message : err);
    await db.query(
      `insert into mensagens_saida (workspace_id, destino_jid, destino_tipo, origem, texto, estado, tentativas)
       values ($1, $2, $4, 'resposta', $3, 'falhou', 1)`,
      [p.workspaceId, p.grupoJid, resposta, destinoTipo],
    );
  }

  await db.query(
    `update turnos set tools = $2::jsonb, resposta = $3, modelo = $4, latencia_ms = $5 where id = $1`,
    [turnoId, JSON.stringify(usadas), resposta, deps.modelos.redatora, Date.now() - inicio],
  );
  return situacao;
}

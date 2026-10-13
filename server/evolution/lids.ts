import { chaveNumero, numeroDe } from '../agente/pedido';
import type { Db } from '../migrate';
import { consultarNumeros, listarParticipantes, type EvolutionCfg } from './client';

export interface ResultadoIdentificadores {
  participantes: number;
  comLid: number;
  comTelefone: number;
  pares: number;
  // Nomes dos campos que a Evolution devolve por participante (só os nomes, nunca os valores).
  campos: string[];
  lidProprio: string | null;
  via: 'participantes' | 'consulta' | 'nenhum';
  // Quantos dos números autorizados a pedir estão de fato nos grupos (0 = o número configurado não está lá).
  comandantesPresentes: number;
}

const ehLid = (v: unknown): v is string => typeof v === 'string' && v.endsWith('@lid');
const ehTelefone = (v: unknown): v is string =>
  typeof v === 'string' && (v.endsWith('@s.whatsapp.net') || /^\d{12,13}$/.test(v));

// Cada versão da Evolution devolve o participante de um jeito; aceita os formatos conhecidos.
function parDoParticipante(p: any): { lid: string | null; telefone: string | null } {
  const lid = [p?.lid, p?.id].find(ehLid);
  const telefone = [p?.phoneNumber, p?.jid, p?.pn, p?.number, p?.id].find(ehTelefone);
  return { lid: lid ? numeroDe(lid) : null, telefone: telefone ? numeroDe(telefone) : null };
}

export async function guardarPar(db: Db, workspaceId: number, lid: string, telefone: string): Promise<void> {
  await db.query(
    `insert into lids (workspace_id, lid, telefone) values ($1, $2, $3)
     on conflict (workspace_id, lid) do update set telefone = excluded.telefone, atualizado_em = now()`,
    [workspaceId, lid, telefone],
  );
  // Quem já está cadastrado só pelo LID ganha o telefone: o painel mostra e a autorização usa.
  await db.query(
    `update pessoas set telefone = $3 where workspace_id = $1 and jid = $2 || '@lid' and telefone is null`,
    [workspaceId, lid, telefone],
  );
}

// Aprende a ligação LID <-> telefone com a própria Evolution (lista de participantes dos grupos) e descobre
// o LID da própria Poli, para saber quando ela é marcada. O que não der para descobrir fica de fora.
export async function descobrirIdentificadores(
  db: Db,
  evo: EvolutionCfg,
  instancia: string,
  f: typeof fetch = fetch,
  comandantes: string[] = [],
): Promise<ResultadoIdentificadores> {
  const r: ResultadoIdentificadores = {
    participantes: 0,
    comLid: 0,
    comTelefone: 0,
    pares: 0,
    campos: [],
    lidProprio: null,
    via: 'nenhum',
    comandantesPresentes: 0,
  };
  const chavesComandantes = new Set(comandantes.map(chaveNumero));
  const presentes = new Set<string>();

  const inst = await db.query('select workspace_id, jid_proprio from instancias_wa where evolution_instance = $1 and ativa', [instancia]);
  if (inst.rows.length === 0) return r;
  const workspaceId = Number(inst.rows[0].workspace_id);
  const proprio = numeroDe(inst.rows[0].jid_proprio);
  const chaveProprio = proprio ? chaveNumero(proprio) : null;

  const participantes = await listarParticipantes(evo, instancia, f);
  r.participantes = participantes.length;
  const campos = new Set<string>();
  const vistos = new Set<string>();

  for (const p of participantes) {
    for (const k of Object.keys(p ?? {})) campos.add(k);
    const { lid, telefone } = parDoParticipante(p);
    if (lid) r.comLid++;
    if (telefone) {
      r.comTelefone++;
      if (chavesComandantes.has(chaveNumero(telefone))) presentes.add(chaveNumero(telefone));
    }
    if (!lid || !telefone) continue;
    if (chaveProprio && chaveNumero(telefone) === chaveProprio) r.lidProprio = lid;
    if (vistos.has(lid)) continue;
    vistos.add(lid);
    await guardarPar(db, workspaceId, lid, telefone);
    r.pares++;
  }
  r.campos = [...campos].sort();
  r.comandantesPresentes = presentes.size;
  if (r.lidProprio) r.via = 'participantes';

  // Plano B: perguntar à Evolution como o WhatsApp conhece o número da Poli.
  if (!r.lidProprio && proprio) {
    try {
      for (const item of await consultarNumeros(evo, instancia, [proprio], f)) {
        const lid = [item?.lid, item?.lidJid].find(ehLid);
        if (lid) {
          r.lidProprio = numeroDe(lid);
          r.via = 'consulta';
          break;
        }
      }
    } catch {
      // Nem toda versão tem esse endpoint: sem ele, fica sem o plano B.
    }
  }

  if (r.lidProprio) {
    await db.query(
      'update instancias_wa set lid_proprio = $2 where evolution_instance = $1 and lid_proprio is distinct from $2',
      [instancia, r.lidProprio],
    );
  }
  return r;
}

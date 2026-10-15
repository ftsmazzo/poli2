import type { Db } from '../migrate';

export interface MembroLido {
  // Identificador interno do WhatsApp (só dígitos) e telefone (só dígitos): a Evolution pode trazer um, outro ou os dois.
  lid: string | null;
  telefone: string | null;
  admin: boolean;
}

export interface GrupoLido {
  jid: string;
  membros: MembroLido[];
}

// Grava quem está em cada grupo AGORA, a partir da lista oficial de participantes do WhatsApp. Quem estava e não está
// mais fica marcado como "saiu" (o histórico dele continua guardado). Uma pessoa pode estar em vários grupos.
export async function sincronizarMembros(db: Db, workspaceId: number, grupos: GrupoLido[]): Promise<{ membros: number; saidas: number }> {
  let membros = 0;
  let saidas = 0;
  for (const g of grupos) {
    // Lista vazia é resposta estranha da Evolution, não "todo mundo saiu": não mexe.
    if (g.membros.length === 0) continue;
    const grupo = await db.query('select id from grupos where workspace_id = $1 and jid = $2', [workspaceId, g.jid]);
    if (grupo.rows.length === 0) continue; // grupo que a Poli ainda não conhece
    const grupoId = Number(grupo.rows[0].id);

    const vistos: number[] = [];
    for (const m of g.membros) {
      if (!m.lid && !m.telefone) continue;
      const jids = [m.lid ? `${m.lid}@lid` : null, m.telefone ? `${m.telefone}@s.whatsapp.net` : null].filter((j): j is string => j !== null);
      const achada = await db.query(
        `select id from pessoas
         where workspace_id = $1 and (jid = any($2::text[]) or ($3::text is not null and telefone = $3))
         order by (telefone is null), id limit 1`,
        [workspaceId, jids, m.telefone],
      );
      let pessoaId: number;
      if (achada.rows.length > 0) {
        pessoaId = Number(achada.rows[0].id);
        if (m.telefone) await db.query('update pessoas set telefone = $2 where id = $1 and telefone is null', [pessoaId, m.telefone]);
      } else {
        const nova = await db.query(
          `insert into pessoas (workspace_id, jid, papel, telefone) values ($1, $2, 'outro', $3)
           on conflict (workspace_id, jid) do update set telefone = coalesce(pessoas.telefone, excluded.telefone)
           returning id`,
          [workspaceId, jids[0], m.telefone],
        );
        pessoaId = Number(nova.rows[0].id);
      }
      await db.query(
        `insert into grupo_membros (grupo_id, pessoa_id, admin, ativo, visto_em, saiu_em) values ($1, $2, $3, true, now(), null)
         on conflict (grupo_id, pessoa_id) do update set admin = excluded.admin, ativo = true, visto_em = now(), saiu_em = null`,
        [grupoId, pessoaId, m.admin],
      );
      vistos.push(pessoaId);
      membros++;
    }
    if (vistos.length === 0) continue;

    const saiu = await db.query(
      `update grupo_membros set ativo = false, saiu_em = coalesce(saiu_em, now())
       where grupo_id = $1 and ativo and pessoa_id <> all($2::bigint[]) returning pessoa_id`,
      [grupoId, vistos],
    );
    saidas += saiu.rows.length;
  }
  return { membros, saidas };
}

// O número e o LID da própria Poli: aparecem nos grupos como qualquer participante, mas não são uma pessoa da equipe.
export async function marcarEstaPoli(db: Db, workspaceId: number, telefone: string | null, lid: string | null): Promise<void> {
  const jids = [lid ? `${lid}@lid` : null, telefone ? `${telefone}@s.whatsapp.net` : null].filter((j): j is string => j !== null);
  if (jids.length === 0 && !telefone) return;
  await db.query(
    `update pessoas set tipo_conta = 'esta_poli'
     where workspace_id = $1 and tipo_conta = 'pessoa' and (jid = any($2::text[]) or ($3::text is not null and telefone = $3))`,
    [workspaceId, jids, telefone],
  );
}

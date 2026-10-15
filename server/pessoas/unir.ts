import type { Db } from '../migrate';

const PESO_DO_PAPEL: Record<string, number> = { head: 3, vip: 2, equipe: 1, outro: 0 };

// Une o cadastro "origem" ao "destino": a mesma pessoa que apareceu duas vezes (uma pelo número, outra pelo
// identificador interno do WhatsApp, outra só pelo nome numa conversa exportada). Nada se perde: mensagens, itens,
// perguntas e participação nos grupos passam para o destino, e o que um cadastro sabia e o outro não é completado.
export async function unirPessoas(db: Db, workspaceId: number, origemId: number, destinoId: number): Promise<boolean> {
  if (origemId === destinoId) return false;
  const achadas = await db.query('select * from pessoas where workspace_id = $1 and id = any($2::bigint[])', [workspaceId, [origemId, destinoId]]);
  const origem = achadas.rows.find((p) => Number(p.id) === origemId);
  const destino = achadas.rows.find((p) => Number(p.id) === destinoId);
  if (!origem || !destino) return false;

  await db.query('update mensagens set autor_pessoa_id = $2 where autor_pessoa_id = $1', [origemId, destinoId]);
  await db.query('update itens set autor_pessoa_id = $2 where autor_pessoa_id = $1', [origemId, destinoId]);
  await db.query('update turnos set pessoa_id = $2 where pessoa_id = $1', [origemId, destinoId]);

  // Participação nos grupos: quem está ativo em um dos dois cadastros está ativo.
  await db.query(
    `insert into grupo_membros (grupo_id, pessoa_id, admin, ativo, visto_em, saiu_em)
     select grupo_id, $2, admin, ativo, visto_em, saiu_em from grupo_membros where pessoa_id = $1
     on conflict (grupo_id, pessoa_id) do update set
       admin = grupo_membros.admin or excluded.admin,
       ativo = grupo_membros.ativo or excluded.ativo,
       visto_em = greatest(grupo_membros.visto_em, excluded.visto_em),
       saiu_em = case when grupo_membros.ativo or excluded.ativo then null else greatest(grupo_membros.saiu_em, excluded.saiu_em) end`,
    [origemId, destinoId],
  );
  await db.query('delete from grupo_membros where pessoa_id = $1', [origemId]);
  // Apaga a origem antes de passar o jid dela para o destino: (workspace, jid) é único.
  await db.query('delete from pessoas where id = $1', [origemId]);

  const papel = (PESO_DO_PAPEL[origem.papel] ?? 0) > (PESO_DO_PAPEL[destino.papel] ?? 0) ? origem.papel : destino.papel;
  await db.query(
    `update pessoas set
       nome = coalesce(nome, $2),
       telefone = coalesce(telefone, $3),
       jid = coalesce(jid, $4),
       papel = $5,
       pode_comandar = pode_comandar or $6,
       pode_conversar = pode_conversar or $7,
       tipo_conta = case when tipo_conta <> 'pessoa' then tipo_conta else $8 end
     where id = $1`,
    [destinoId, origem.nome, origem.telefone, origem.jid, papel, Boolean(origem.pode_comandar), Boolean(origem.pode_conversar), origem.tipo_conta],
  );
  return true;
}

// Primeiro nome sem o "~" que o WhatsApp põe antes de quem não está nos contatos.
export const nomeNormalizado = (nome: string | null | undefined): string => (nome ?? '').replace(/^[~\s]+/, '').trim().toLowerCase();

// Une sozinho o que é claramente a mesma pessoa:
//  1. o mesmo telefone em dois cadastros;
//  2. o cadastro que só tem o identificador interno (LID) e o que tem o número, quando o WhatsApp informou o par;
//  3. o cadastro feito só pelo nome (conversa exportada) e a pessoa real de mesmo nome, se houver uma só.
// Nome igual entre duas pessoas reais NÃO une: podem ser homônimos. Para esses, o painel tem o botão "Unir".
export async function unificarPessoas(db: Db, workspaceId: number): Promise<{ unidas: number }> {
  let unidas = 0;
  const consultas: { sql: string; params: unknown[] }[] = [
    {
      sql: `select b.id as origem, a.id as destino
            from pessoas a join pessoas b on b.workspace_id = a.workspace_id and b.telefone = a.telefone and b.id > a.id
            where a.workspace_id = $1 and a.telefone is not null order by a.id, b.id limit 1`,
      params: [workspaceId],
    },
    {
      sql: `select o.id as origem, d.id as destino
            from lids l
            join pessoas o on o.workspace_id = l.workspace_id and o.jid = l.lid || '@lid'
            join pessoas d on d.workspace_id = l.workspace_id and d.id <> o.id and (d.telefone = l.telefone or d.jid = l.telefone || '@s.whatsapp.net')
            where l.workspace_id = $1 order by o.id, d.id limit 1`,
      params: [workspaceId],
    },
    {
      sql: `select g.id as origem, min(r.id) as destino
            from pessoas g
            join pessoas r on r.workspace_id = g.workspace_id and r.id <> g.id and r.jid is not null
              and lower(regexp_replace(r.nome, '^[~\\s]+', '')) = lower(regexp_replace(g.nome, '^[~\\s]+', ''))
            where g.workspace_id = $1 and g.jid is null and g.telefone is null and g.nome is not null
            group by g.id having count(*) = 1 order by g.id limit 1`,
      params: [workspaceId],
    },
  ];

  // Cada união muda o cenário (e pode revelar outra): repete até não haver mais nada a unir.
  for (let volta = 0; volta < 200; volta++) {
    let achou = false;
    for (const c of consultas) {
      const r = await db.query(c.sql, c.params);
      if (r.rows.length === 0) continue;
      if (await unirPessoas(db, workspaceId, Number(r.rows[0].origem), Number(r.rows[0].destino))) {
        unidas++;
        achou = true;
        break;
      }
    }
    if (!achou) break;
  }
  return { unidas };
}

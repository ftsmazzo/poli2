-- Quem está (e quem já esteve) em cada grupo. Uma pessoa pode estar em vários grupos: o vínculo é por grupo.
create table grupo_membros (
  grupo_id   bigint not null references grupos(id) on delete cascade,
  pessoa_id  bigint not null references pessoas(id) on delete cascade,
  admin      boolean not null default false,
  ativo      boolean not null default true,
  visto_em   timestamptz not null default now(),
  saiu_em    timestamptz,
  primary key (grupo_id, pessoa_id)
);
create index grupo_membros_pessoa on grupo_membros (pessoa_id);

-- "esta_poli": o próprio número da Poli; "robo": outra automação no grupo (ex.: a Poli da versão 1).
alter table pessoas add column tipo_conta text not null default 'pessoa' check (tipo_conta in ('pessoa', 'esta_poli', 'robo'));

-- Limpeza: a importação de conversa exportada tratava os avisos do sistema ("mensagens protegidas por criptografia...",
-- que vêm com o nome do grupo como autor) como se fossem uma pessoa. As mensagens ficam; só some a "pessoa" falsa.
update mensagens set autor_pessoa_id = null
 where autor_pessoa_id in (
   select p.id from pessoas p
   join grupos g on g.workspace_id = p.workspace_id and lower(g.nome) = lower(p.nome)
   where p.jid is null and p.telefone is null
 );
delete from pessoas p
 using grupos g
 where g.workspace_id = p.workspace_id and lower(g.nome) = lower(p.nome) and p.jid is null and p.telefone is null;

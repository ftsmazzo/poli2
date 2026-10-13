-- O WhatsApp identifica pessoas por LID (id interno) além do telefone. A Poli guarda a ligação entre os dois
-- para reconhecer quem a chama e quando ela mesma é marcada.
alter table instancias_wa add column lid_proprio text;

create table lids (
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  lid           text not null,
  telefone      text not null,
  atualizado_em timestamptz not null default now(),
  primary key (workspace_id, lid)
);

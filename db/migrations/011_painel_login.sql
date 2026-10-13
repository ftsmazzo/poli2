-- Login do painel pelo WhatsApp: a pessoa pede o link à Poli e entra, sem senha.
-- Usuário é identificado pelo telefone; e-mail e senha passam a ser opcionais.
alter table usuarios alter column email drop not null;
alter table usuarios alter column senha_hash drop not null;
alter table usuarios add column telefone text;
create unique index usuarios_telefone on usuarios (telefone) where telefone is not null;

-- Cada ferramenta de uma Fonte MCP guarda o esquema dos argumentos (o modelo precisa dele para chamá-la)
-- e se ela só lê. Ferramenta que pode escrever nasce desligada.
alter table fonte_tools add column esquema jsonb not null default '{"type":"object","properties":{}}';
alter table fonte_tools add column somente_leitura boolean not null default false;

-- Link de acesso de uso único e vida curta. Só o hash do token fica no banco.
create table login_links (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  telefone      text not null,
  token_hash    text not null unique,
  expira_em     timestamptz not null,
  usado_em      timestamptz,
  criado_em     timestamptz not null default now()
);

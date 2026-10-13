-- Poli 2.0: núcleo. Multi-tenant por workspace_id.
create extension if not exists vector;

create table workspaces (
  id          bigserial primary key,
  nome        text not null,
  criado_em   timestamptz not null default now()
);

create table instancias_wa (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  evolution_instance text not null,
  ativa         boolean not null default true,
  unique (workspace_id, evolution_instance)
);

-- Pessoas e papéis (Heads recebem alertas; VIPs comandam).
create table pessoas (
  id             bigserial primary key,
  workspace_id   bigint not null references workspaces(id) on delete cascade,
  jid            text,
  nome           text,
  telefone       text,
  papel          text not null default 'equipe' check (papel in ('head','vip','equipe','outro')),
  pode_comandar  boolean not null default false,
  pode_conversar boolean not null default false,
  unique (workspace_id, jid)
);

create table grupos (
  id             bigserial primary key,
  workspace_id   bigint not null references workspaces(id) on delete cascade,
  jid            text not null,
  nome           text,
  acompanhar     boolean not null default false,
  intervalo_min  integer not null default 60 check (intervalo_min >= 5),
  ultima_leitura_msg_id bigint,
  ultima_leitura_em     timestamptz,
  unique (workspace_id, jid)
);

-- Toda mensagem fica guardada com a hora real do WhatsApp (enviada_em).
create table mensagens (
  id             bigserial primary key,
  workspace_id   bigint not null references workspaces(id) on delete cascade,
  grupo_id       bigint references grupos(id) on delete cascade,
  wa_message_id  text not null,
  autor_pessoa_id bigint references pessoas(id) on delete set null,
  autor_jid      text,
  enviada_em     timestamptz not null,
  recebida_em    timestamptz not null default now(),
  tipo           text not null default 'texto',
  texto          text,
  midia_ref      text,
  citada_wa_id   text,
  bruto          jsonb,
  tsv            tsvector generated always as (to_tsvector('portuguese', coalesce(texto, ''))) stored,
  unique (workspace_id, wa_message_id)
);
create index mensagens_grupo_data on mensagens (grupo_id, enviada_em);
create index mensagens_tsv on mensagens using gin (tsv);

-- Janelas de ~10 mensagens com embedding: a parte "quase RAG".
create table janelas (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  grupo_id      bigint not null references grupos(id) on delete cascade,
  de_msg_id     bigint not null references mensagens(id) on delete cascade,
  ate_msg_id    bigint not null references mensagens(id) on delete cascade,
  inicio_em     timestamptz not null,
  fim_em        timestamptz not null,
  texto         text not null,
  embedding     vector(1536)
);
create index janelas_grupo_data on janelas (grupo_id, inicio_em);

-- Itens extraídos das mensagens: link, arquivo, contato, endereço.
create table itens (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  grupo_id      bigint references grupos(id) on delete cascade,
  mensagem_id   bigint not null references mensagens(id) on delete cascade,
  tipo          text not null check (tipo in ('link','arquivo','contato','endereco')),
  valor         text not null,
  dados         jsonb not null default '{}',
  autor_pessoa_id bigint references pessoas(id) on delete set null,
  enviada_em    timestamptz not null,
  dedupe_key    text not null,
  unique (workspace_id, dedupe_key)
);
create index itens_tipo_data on itens (workspace_id, tipo, enviada_em desc);

create table resumos (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  grupo_id      bigint not null references grupos(id) on delete cascade,
  de_msg_id     bigint not null,
  ate_msg_id    bigint not null,
  de_em         timestamptz not null,
  ate_em        timestamptz not null,
  texto         text not null,
  importancia   smallint check (importancia between 0 and 3),
  criado_em     timestamptz not null default now()
);

create table alertas (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  grupo_id      bigint references grupos(id) on delete set null,
  resumo_id     bigint references resumos(id) on delete set null,
  severidade    smallint not null check (severidade between 1 and 3),
  texto         text not null,
  dedupe_key    text not null,
  enviado_em    timestamptz,
  criado_em     timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);

-- Fontes configuráveis pelo painel (MCP, RAG, agenda, API).
create table fontes (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  tipo          text not null check (tipo in ('mcp','rag','agenda','api','arquivos','contatos')),
  nome          text not null,
  config        jsonb not null default '{}',
  segredo_enc   text,
  quando_usar   text not null default '',
  escopo        jsonb not null default '{"papeis":["head","vip"],"grupos":"todos"}',
  ativa         boolean not null default true,
  status        text not null default 'nunca_testada' check (status in ('nunca_testada','ok','erro')),
  ultimo_teste_em timestamptz,
  ultimo_erro   text,
  latencia_ms   integer,
  unique (workspace_id, nome)
);

create table fonte_tools (
  fonte_id  bigint not null references fontes(id) on delete cascade,
  nome      text not null,
  descricao text,
  ativa     boolean not null default true,
  primary key (fonte_id, nome)
);

-- Fila de jobs em Postgres (for update skip locked).
create table jobs (
  id            bigserial primary key,
  tipo          text not null,
  payload       jsonb not null default '{}',
  dedupe_key    text,
  executar_em   timestamptz not null default now(),
  tentativas    integer not null default 0,
  estado        text not null default 'pendente' check (estado in ('pendente','rodando','feito','falhou')),
  ultimo_erro   text,
  criado_em     timestamptz not null default now()
);
create unique index jobs_dedupe_pendente on jobs (dedupe_key) where estado = 'pendente' and dedupe_key is not null;
create index jobs_fila on jobs (estado, executar_em);

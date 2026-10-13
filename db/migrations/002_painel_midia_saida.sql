-- Poli 2.0: login do painel, mídia, mensagens enviadas, log de turnos e saúde.

-- Painel: login por pessoa, vários tenants por usuário, entrada só por convite.
create table usuarios (
  id          bigserial primary key,
  email       text not null,
  senha_hash  text not null,
  nome        text,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);
create unique index usuarios_email on usuarios (lower(email));

create table usuario_workspaces (
  usuario_id    bigint not null references usuarios(id) on delete cascade,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  papel         text not null check (papel in ('admin','head')),
  pessoa_id     bigint references pessoas(id) on delete set null,
  primary key (usuario_id, workspace_id)
);

create table sessoes (
  id            bigserial primary key,
  usuario_id    bigint not null references usuarios(id) on delete cascade,
  token_hash    text not null unique,
  expira_em     timestamptz not null,
  ultimo_uso_em timestamptz,
  criado_em     timestamptz not null default now()
);

create table convites (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  email         text not null,
  papel         text not null check (papel in ('admin','head')),
  token_hash    text not null unique,
  expira_em     timestamptz not null,
  usado_em      timestamptz,
  criado_em     timestamptz not null default now()
);

-- Mídia: o original fica em volume; aqui só metadados e o texto extraído.
-- O mesmo arquivo (sha256) pode aparecer em várias mensagens: uma linha por mensagem, um arquivo em disco.
create table midias (
  id             bigserial primary key,
  workspace_id   bigint not null references workspaces(id) on delete cascade,
  mensagem_id    bigint not null references mensagens(id) on delete cascade,
  mime           text,
  bytes          bigint,
  sha256         text,
  caminho        text,
  texto_extraido text,
  estado         text not null default 'pendente' check (estado in ('pendente','baixada','falhou','ignorada')),
  baixada_em     timestamptz
);
create index midias_sha on midias (workspace_id, sha256) where sha256 is not null;
create index midias_mensagem on midias (mensagem_id);

-- Tudo o que a Poli envia (resposta, alerta, aviso, MD). Base do dedupe e do reenvio.
create table mensagens_saida (
  id             bigserial primary key,
  workspace_id   bigint not null references workspaces(id) on delete cascade,
  destino_jid    text not null,
  destino_tipo   text not null check (destino_tipo in ('privado','grupo')),
  origem         text not null check (origem in ('resposta','alerta','aviso','md')),
  alerta_id      bigint references alertas(id) on delete set null,
  texto          text not null,
  estado         text not null default 'pendente' check (estado in ('pendente','enviada','falhou')),
  tentativas     integer not null default 0,
  wa_message_id  text,
  criado_em      timestamptz not null default now(),
  enviada_em     timestamptz
);
create index mensagens_saida_estado on mensagens_saida (estado, criado_em);

-- Log de cada pergunta respondida, para o Diagnóstico e a auditoria.
create table turnos (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  pessoa_id     bigint references pessoas(id) on delete set null,
  grupo_id      bigint references grupos(id) on delete set null,
  pergunta      text not null,
  tools         jsonb not null default '[]',
  fontes        jsonb not null default '[]',
  resposta      text,
  modelo        text,
  latencia_ms   integer,
  criado_em     timestamptz not null default now()
);
create index turnos_workspace_data on turnos (workspace_id, criado_em desc);

-- Quedas e retornos de instância e de Fonte: alimenta a faixa vermelha e o aviso ao admin.
create table eventos_saude (
  id            bigserial primary key,
  workspace_id  bigint not null references workspaces(id) on delete cascade,
  tipo          text not null check (tipo in ('instancia','fonte')),
  alvo          text not null,
  estado        text not null check (estado in ('caiu','voltou')),
  detalhe       text,
  criado_em     timestamptz not null default now()
);
create index eventos_saude_workspace_data on eventos_saude (workspace_id, criado_em desc);

-- Índices que faltavam na 001.
create index mensagens_workspace_data on mensagens (workspace_id, enviada_em);
create index janelas_embedding_hnsw on janelas using hnsw (embedding vector_cosine_ops);

-- Mensagens importadas de uma exportação do WhatsApp ficam marcadas e ligadas ao arquivo de origem,
-- para dar para ver de onde vieram e desfazer uma importação.
alter table mensagens add column origem text not null default 'whatsapp'
  check (origem in ('whatsapp', 'exportacao'));
alter table mensagens add column importacao_ref text;
create index mensagens_importacao on mensagens (importacao_ref) where importacao_ref is not null;

-- Fila de download de mídia: nome do arquivo, tentativas e último erro.
alter table midias add column nome_arquivo text;
alter table midias add column tentativas integer not null default 0;
alter table midias add column erro text;
create index midias_pendentes on midias (id) where estado = 'pendente';

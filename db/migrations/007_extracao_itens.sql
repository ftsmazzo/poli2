-- Controle da extração de itens (links, contatos, endereços, arquivos): cada mensagem é processada uma vez.
alter table mensagens add column itens_extraidos_em timestamptz;
create index mensagens_itens_pendentes on mensagens (id) where itens_extraidos_em is null;

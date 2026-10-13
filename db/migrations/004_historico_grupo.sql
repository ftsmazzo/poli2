-- Controle da importação do histórico: cada grupo é importado uma vez só.
alter table grupos add column historico_importado_em timestamptz;
alter table grupos add column historico_mensagens integer;

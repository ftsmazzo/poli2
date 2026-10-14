-- Com quem a Poli conversou no turno (JID do grupo ou do privado): permite lembrar o que foi dito há pouco
-- ("Onde procurou?" só faz sentido sabendo qual foi a pergunta anterior).
alter table turnos add column contato text;
create index turnos_contato_data on turnos (workspace_id, contato, criado_em desc);

-- Resposta do agente: a Poli precisa saber o próprio número e não responder duas vezes ao mesmo pedido.
alter table instancias_wa add column jid_proprio text;
alter table turnos add column wa_message_id text;
create unique index turnos_pedido on turnos (workspace_id, wa_message_id) where wa_message_id is not null;

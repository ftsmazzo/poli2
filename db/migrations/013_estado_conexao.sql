-- Estado da conexão do número com o WhatsApp (open, close, connecting...), para o painel e para saber quando cai.
alter table instancias_wa add column estado_conexao text;
alter table instancias_wa add column estado_em timestamptz;

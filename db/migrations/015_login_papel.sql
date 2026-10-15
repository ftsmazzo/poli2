-- O papel no painel (admin ou head) é decidido quando o link é criado, a partir de quem a Poli reconheceu:
-- só o mantenedor (lista do servidor) entra como admin. O padrão é o papel menor.
alter table login_links add column papel text not null default 'head' check (papel in ('admin', 'head'));

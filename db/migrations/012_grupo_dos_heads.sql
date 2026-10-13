-- Grupo onde a Poli avisa os Heads (além do privado de cada Head).
alter table grupos add column eh_heads boolean not null default false;

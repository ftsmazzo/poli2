-- Uma instância da Evolution pertence a um único tenant.
-- Rede de segurança caso duas sincronizações rodem ao mesmo tempo.
create unique index instancias_wa_instancia on instancias_wa (evolution_instance);

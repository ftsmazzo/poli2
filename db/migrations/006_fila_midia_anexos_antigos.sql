-- Anexos que chegaram antes da fila de download existir: entram na fila agora.
-- Lê o nome e o tipo do arquivo do JSON bruto guardado na mensagem. Vídeo só guarda metadados.
insert into midias (workspace_id, mensagem_id, mime, nome_arquivo, estado)
select m.workspace_id,
       m.id,
       coalesce(
         m.bruto #>> '{message,documentMessage,mimetype}',
         m.bruto #>> '{message,imageMessage,mimetype}',
         m.bruto #>> '{message,audioMessage,mimetype}'
       ),
       m.bruto #>> '{message,documentMessage,fileName}',
       'pendente'
from mensagens m
where m.tipo in ('documento', 'imagem', 'audio')
  and m.origem = 'whatsapp'
  and not exists (select 1 from midias x where x.mensagem_id = m.id);

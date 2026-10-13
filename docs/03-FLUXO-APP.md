# Fluxo do App — Poli 2.0

> Como o usuário se move pelo produto.
> Fonte: [x] Entrevista com usuário
> Depende de: [PRD](01-PRD.md)

**Data**: 2026-10-10

## 1. Perfis de usuário

| Perfil | Descrição | Permissões principais |
|---|---|---|
| Admin do tenant | Quem configura a Poli de uma campanha | Painel completo: Fontes, Grupos, Pessoas e papéis, Alertas, Diagnóstico |
| Head | Comando da campanha | Painel (leitura e ajuste de alertas e grupos), recebe os alertas, consulta e comanda no WhatsApp |
| VIP | Pessoa de confiança que comanda a Poli | Consulta e comanda no WhatsApp. Sem acesso ao painel |
| Equipe | Equipe de campo e operação | Consulta no WhatsApp, só do que o escopo do grupo permite |
| Outros | Qualquer pessoa fora das listas | Nenhum. No privado a Poli ignora quem não está autorizado |

O painel é de configuração, **sem chat**. Só admin e Heads entram nele.

## 2. Jornadas principais

### Jornada 1: Perguntar à Poli no WhatsApp

Perfil: Head, VIP ou equipe.

1. A pessoa escreve para a Poli em um grupo (mencionando `@Poli`) ou no privado.
2. A Poli confere o papel de quem perguntou. No privado só responde a quem está na lista de autorizados. Em grupo, só responde sob menção.
3. O orquestrador escolhe o que consultar: o acervo de mensagens dos grupos (links, arquivos, contatos, endereços, resumos) e/ou uma Fonte MCP.
4. Ponto de decisão: se a pergunta pede dados de outro grupo, o escopo decide. Se o grupo de origem não pode cruzar, a Poli responde que não pode ou não encontra.
5. A redatora responde curto, citando a mensagem de origem (grupo, autor e data) e a Fonte usada.

Telas envolvidas: nenhuma (WhatsApp).
Fluxo de erro/exceção:
- Se uma Fonte falha, a Poli diz que não conseguiu consultar aquela fonte e responde com o que tem do acervo.
- Se não encontra, responde "não encontrei" e não inventa.
- Número só aparece se vier de uma Fonte.

### Jornada 2: Acompanhar um grupo e alertar os Heads

Perfil: sistema (Heads recebem).

1. Admin ou Head liga "acompanhar" num grupo e define o intervalo de leitura.
2. No temporizador, o job lê as mensagens novas desde a última leitura.
3. Gera um resumo incremental e o classifica por importância.
4. Ponto de decisão: abaixo do limiar, só guarda o resumo. Acima, cria um alerta, desde que não seja duplicado e não esteja em horário silencioso.
5. O alerta é enviado ao **privado de cada Head e ao grupo dos Heads**.

Telas envolvidas: Grupos, Alertas.
Fluxo de erro/exceção: se o envio falha, o alerta fica pendente no painel e é tentado de novo. Se a instância do WhatsApp está fora do ar, aplica-se a Jornada 4.

### Jornada 3: Configurar Fontes e Grupos (painel)

Perfil: admin e Head.

1. Entra no painel (login).
2. Em Fontes, cadastra uma Fonte (URL do MCP, RAG ou agenda), escreve "quando usar" e define o escopo (papéis e grupos).
3. Clica em "Testar": o painel lista as tools descobertas e mostra o status (ok ou erro) e a latência.
4. Liga ou desliga cada tool. Tools de escrita vêm desligadas.
5. Em Grupos, escolhe quais acompanhar e o intervalo. Em Pessoas, define papéis e a lista de autorizados do privado.
6. Em Diagnóstico, vê o que está conectado e funcional: instância do WhatsApp, Fontes, fila de jobs e últimas execuções.

Telas envolvidas: Fontes, Grupos, Pessoas, Alertas, Diagnóstico.
Fluxo de erro/exceção: teste de Fonte com erro mostra a mensagem do erro e mantém a Fonte inativa até passar.

### Jornada 4: Falha de conexão (WhatsApp ou Fonte)

Perfil: admin.

1. O sistema detecta a instância do WhatsApp fora do ar por mais de 10 minutos, ou uma Fonte falhando.
2. Mostra uma **faixa vermelha no painel** e envia **mensagem no WhatsApp ao admin**.
3. Tenta reconectar sozinho (reiniciar a instância).
4. Quando volta, avisa que voltou (faixa some e nova mensagem).

Telas envolvidas: todas (faixa global), Diagnóstico.
Fluxo de erro/exceção: se o próprio WhatsApp é o que caiu, a mensagem ao admin só sai quando voltar. A faixa no painel é o aviso garantido.

### Jornada 5: Resumo e MD do dia

Perfil: Head, VIP.

1. Pede "resume o grupo X de ontem" ou "gera o MD de hoje".
2. A Poli resume em etapas, para grupos grandes.
3. Para o MD, exporta o resumo do dia em Markdown e envia o arquivo.

Telas envolvidas: nenhuma (WhatsApp).
Fluxo de erro/exceção: grupo sem mensagens no período responde "sem movimento".

## 3. Diagrama (opcional)

```
WhatsApp (Evolution) ──► Ingestão ──► Acervo (mensagens + itens + vetores)
                                          │
Pergunta (grupo/privado) ──► Orquestrador ┼──► Fontes MCP (urna, RAG, agenda)
                                          └──► Redatora ──► Resposta com origem

Temporizador por grupo ──► Resumo ──► Importância ──► Alerta ──► Heads (privado + grupo)
Falha de conexão ──► Faixa vermelha no painel + mensagem ao admin
```

---

## Gaps & Recomendações (preencher só no Modo B — análise de repo existente)

Não se aplica: projeto novo.

Pontos que o PRD pede e que o fluxo ainda deixa para o TRD/Backend:
- [ ] Horário silencioso dos alertas: faixa padrão a definir.
- [ ] Confirmações e aprovações (marcar alerta como resolvido, silenciar grupo): fora da v1, por decisão do usuário.

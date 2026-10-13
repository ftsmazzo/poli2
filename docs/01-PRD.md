# PRD — Poli 2.0

> Product Requirements Document — o quê e por quê, não como.
> Fonte: [x] Entrevista com usuário  [x] Leitura de código existente (Prumo e Poli atual)

**Data**: 2026-10-10
**Responsável**: Frederico Mazzo

## 1. Resumo em uma frase

Agente de WhatsApp que lê e acompanha os grupos de uma campanha, resume qualquer grupo, resgata links, arquivos, contatos e endereços citados nas mensagens, alerta os Heads sobre o que é importante e se conecta a bases (MCP, RAG, agenda) configuradas por um painel.

## 2. Problema e contexto

- Problema real que motiva o projeto: as conversas dos grupos concentram informação operacional (endereços, contatos, links, arquivos, decisões) que se perde no fluxo. Hoje ninguém consegue achar "o endereço que o fulano mandou no grupo X há um mês" nem saber, sem ler tudo, o que é urgente.
- Como é resolvido hoje:
  - A Poli atual (Inteligência Eleitoral) responde só sob menção, tem proatividade quase nula (alertas gravados, mas não enviados), memória só por busca em mensagens e um monólito Python com nomes da campanha dentro do prompt.
  - O Prumo (agente pessoal) observa conversas 1:1 e é proativo, mas atende um único dono.
  - Na prática, a equipe rola o histórico à mão.
- Por que agora: segundo turno da eleição. A equipe precisa ler e acompanhar os grupos já, e um agente que não leia os grupos não tem utilidade.

## 3. Público-alvo

- Persona principal: Heads da campanha, que precisam saber o que é importante sem ler todos os grupos, e a equipe, que precisa achar informação rápido.
- Outros perfis:
  - VIPs, que comandam a Poli.
  - Equipe de campo, que consulta.
  - Administrador do tenant, que configura o painel.
- Tenants: **2 tenants** desde o início, totalmente isolados entre si. Não há venda a terceiros, cadastro público nem cobrança na v1.

## 4. Objetivos e métricas de sucesso

| Objetivo | Métrica | Meta |
|---|---|---|
| Achar informação nos grupos | Tempo e acerto de busca de link, contato, endereço e arquivo, medidos num conjunto de 30 perguntas de teste feitas com dados reais do tenant | p95 abaixo de 10 s e acerto de pelo menos 90% |
| Não perder mensagens | Mensagens gravadas sobre mensagens recebidas, e atraso entre a hora real e a gravação | Pelo menos 99% gravadas, atraso mediano abaixo de 30 s |
| Resumir qualquer grupo | Tempo para resumir 24 h de um grupo ativo | Abaixo de 60 s, sem número inventado |
| Alertar sem ruído | Alertas por Head por dia, duplicados, e importantes perdidos numa amostra rotulada semanalmente | No máximo 5 por dia, zero duplicados, pelo menos 90% dos importantes capturados |
| Conectar fontes com facilidade | Tempo para cadastrar e testar uma Fonte nova (MCP, RAG, agenda) pelo painel | Menos de 5 min, sem deploy |
| Isolar os tenants | Vazamento de dados entre tenants | Zero, coberto por teste automatizado |

## 5. Escopo

### Dentro do escopo (MVP)
- Ingestão contínua das mensagens dos grupos (texto e áudio transcrito), com a hora real do WhatsApp, e importação do histórico.
- Extração de links, arquivos, contatos (vCard e texto) e endereços, ligados à mensagem de origem.
- Busca nas mensagens (texto e semântica) e resposta que cita a origem.
- Resumo de qualquer grupo em qualquer período.
- Acompanhamento de grupos com temporizador por grupo e alerta aos Heads, com limiar de importância e dedupe.
- Registro de Fontes (MCP, RAG, agenda, API) com teste e status no painel.
- Painel mínimo: Fontes, Grupos e temporizadores, Pessoas e papéis, Alertas, Diagnóstico.
- Papéis (Head, VIP, equipe) e escopo por grupo.
- Saída em Markdown do dia.
- 2 tenants isolados.

### Fora do escopo (por enquanto)
- Responder eleitores ou o público externo.
- Enviar mensagens a terceiros.
- Escrever em sistemas externos (nem com aprovação, na v1).
- App mobile.
- Venda a terceiros, cadastro público e cobrança.

## 6. Funcionalidades principais

| Funcionalidade | Prioridade (MVP/depois) | Descrição curta |
|---|---|---|
| Ingestão e histórico | MVP | Grava toda mensagem dos grupos, sem duplicar, com a hora real |
| Extração de itens | MVP | Links, arquivos, contatos e endereços ligados à origem |
| Busca e resposta com fonte | MVP | Busca híbrida; toda resposta cita a mensagem de origem |
| Resumo de grupo | MVP | Qualquer grupo, qualquer período, incremental e em etapas |
| Temporizador e alertas aos Heads | MVP | Leitura periódica, classificação de importância, dedupe |
| Registro de Fontes com status | MVP | MCP, RAG, agenda e API, testadas e visíveis no painel |
| Painel | MVP | Fontes, Grupos, Pessoas, Alertas, Diagnóstico |
| Papéis e escopo por grupo | MVP | Quem comanda, quem consulta, o que cruza entre grupos |
| MDs do dia | MVP | Exporta o resumo do dia em Markdown |
| Cofre de dados gravados | Depois | Números, contatos e links salvos de forma curada |

## 7. Restrições de negócio

- Prazo: segundo turno da eleição (25/10/2026, a confirmar). O corte do MVP precisa caber nessa janela.
- Orçamento: a definir (inclui custo mensal de IA via OpenRouter e embeddings).
- Legais/regulatórias (ex. LGPD): o sistema guarda conversas e dados pessoais de terceiros (contatos, endereços). Exige isolamento por tenant, retenção definida e acesso por papel. Os detalhes ficam para o TRD.

## 8. Riscos e premissas

- Premissa: a Evolution API continua entregando as mensagens dos grupos e o histórico. Se cair ou banir o número, a ingestão para.
- Premissa: a qualidade da extração de endereços e contatos por texto livre é suficiente. Se for baixa, a busca perde a utilidade principal.
- Risco: prazo curto até o segundo turno (alto impacto, alta probabilidade). Mitigação: cortar o MVP à ingestão, busca e resumo primeiro.
- Risco: alertas demais ou de menos fazem os Heads ignorarem o sistema (médio).
- Risco: MCP arbitrário abre prompt injection e vazamento. Mitigação: leitura por padrão, retorno das tools tratado como dado.
- Risco: vazamento entre os 2 tenants (alto impacto). Mitigação: teste automatizado de isolamento.

---

## Gaps & Recomendações (preencher só no Modo B — análise de repo existente)

Não se aplica: projeto novo. Os pontos fracos da Poli atual e do Prumo estão na seção 2.

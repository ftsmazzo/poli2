# Plano de Implementação — Poli 2.0

> Roteiro de execução, no cronograma mais curto possível.
> Depende de: [PRD](01-PRD.md), [TRD](02-TRD.md), [Fluxo](03-FLUXO-APP.md), [UI/UX](04-UIUX.md), [Esquema Backend](05-ESQUEMA-BACKEND.md).

**Data**: 2026-10-10
**Marco:** segundo turno em 25/10/2026 (a confirmar). São 15 dias, **sem folga**.

## 1. MVP

O que precisa existir para a Poli já gerar valor e ser testável:

- Ingestão contínua das mensagens dos grupos, no ar o quanto antes, para começar a acumular histórico.
- Busca e resposta com origem: links, contatos, endereços, arquivos e mensagens.
- Resumo de qualquer grupo em qualquer período.
- Conexão com Fontes MCP (urna e RAG), cadastradas pelo painel.
- Acompanhamento de grupos com temporizador e alerta aos Heads.
- Painel mínimo com Diagnóstico e a faixa de falha.

## 2. Fases (cronograma mais curto)

| Fase | Datas | Escopo | Prioridade | Dependências |
|---|---|---|---|---|
| 0. Base no ar | 10 a 11/10 | Deploy no EasyPanel (app e Postgres com pgvector), migração `002`, webhook da Evolution gravando as mensagens, `/health`, CI | Crítica | Projeto no EasyPanel, instância Evolution do tenant, repositório no GitHub |
| 1. Ingestão, busca e resposta | 12 a 14/10 | Importação do histórico, extratores (link, contato, endereço, arquivo), mídia no volume, embeddings, busca híbrida, turno do orquestrador e da redatora com os gates, resposta com origem, papéis e escopo, privado só para autorizados | Alta | Chave do OpenRouter, fase 0 |
| 2. Resumo e Fontes MCP | 15 a 17/10 | Resumo de grupo (incremental e em etapas), cliente MCP com tools descobertas, Fontes cadastradas direto no banco por enquanto, retorno de tool tratado como dado | Alta | URLs dos MCPs de urna e RAG, fase 1 |
| 3. Painel | 18 a 20/10 | Login por convite, seletor de tenant, telas Fontes (com "Testar"), Grupos, Pessoas, Diagnóstico e a faixa vermelha, tema claro e escuro | Alta | Fase 2 |
| 4. Temporizador e alertas | 21 a 23/10 | `ler_grupo`, importância, dedupe, alerta ao privado dos Heads e ao grupo dos Heads, `checar_saude` e aviso ao admin | Alta | Fase 3 |
| 5. Fechamento | 24/10 | MD do dia, teste de isolamento entre os 2 tenants, backup do banco e do volume, revisão de segurança | Alta | Fase 4 |

**Segundo tenant:** entra na fase 0 já com a configuração (`workspace_id` em tudo). A instância Evolution do segundo tenant é ligada assim que existir, sem esperar as outras fases.

### Se o prazo apertar (ordem de corte)

1. **MD do dia** sai primeiro, e fica para depois do segundo turno.
2. O painel perde as telas de Pessoas e Alertas: a lista de autorizados e os papéis passam a ser editados por SQL, e os alertas aparecem só no WhatsApp.
3. Resumo em etapas para grupos muito grandes vira resumo de janela fixa.

**Não se corta:** ingestão, busca com origem, resumo de grupo, alerta aos Heads, isolamento entre tenants e backup.

## 3. Marcos externos

- Data de lançamento/demo: segundo turno, 25/10/2026.
- Outras datas relevantes:
  - **12/10:** a ingestão precisa estar gravando (fase 0), porque cada dia sem gravar é histórico perdido.
  - **17/10:** Poli já responde e resume pelo WhatsApp, antes do painel, para a equipe começar a usar.
  - **23/10:** alertas ligados com 2 dias de margem para calibrar o limiar.

## 4. Critério de "pronto" por fase

Cada fase só fecha com **teste automatizado passando** e **conferência com dados reais de um tenant**.

- Fase 0: mensagem enviada a um grupo aparece no banco com a hora real em até 30 s, sem duplicar após reenvio do webhook. `/health` responde no domínio.
- Fase 1: 30 perguntas de teste (links, contatos, endereços e arquivos) respondidas com a origem correta em pelo menos 90%, p95 abaixo de 10 s. Pergunta de pessoa não autorizada no privado não recebe resposta. Pergunta que cruza grupos respeita o escopo.
- Fase 2: resumo de 24 h de um grupo ativo em menos de 60 s e sem número inventado. Fonte MCP com falha não derruba a resposta e é citada como indisponível.
- Fase 3: cadastrar e testar uma Fonte nova em menos de 5 min, sem deploy. A faixa vermelha aparece com uma Fonte derrubada de propósito.
- Fase 4: alerta chega ao privado dos Heads e ao grupo dos Heads, sem duplicar e com no máximo 5 por Head por dia na amostra. A queda da instância gera faixa e mensagem ao admin.
- Fase 5: o teste de isolamento prova que um tenant não lê dados do outro. O backup restaura num banco limpo.

---

## Riscos do cronograma

- **Sem folga:** qualquer atraso de dependência externa (acesso à Evolution, URL dos MCPs, chave do OpenRouter) consome direto a data final.
- A Evolution não é oficial: se a instância cair, a ingestão para e o histórico daquele intervalo só volta pela importação de histórico.
- Calibrar alertas leva tempo de uso real, e a janela é de 2 dias.

## Dependências que você precisa liberar já

- [ ] Nome do projeto no EasyPanel e criação (ou permissão para eu criar) do Postgres com pgvector.
- [ ] Instância Evolution de cada tenant, com URL e chave.
- [ ] URLs (e credenciais) dos MCPs de urna e de RAG.
- [ ] Chave do OpenRouter.
- [ ] Repositório privado no GitHub (`poli2`).
- [ ] Confirmação da data do segundo turno.

# TRD — Poli 2.0

> Technical Requirements Document — traduz o PRD em decisões técnicas.
> Fonte: [x] Entrevista com usuário  [x] Leitura de código existente (Prumo e Poli atual)
> Depende de: [PRD](01-PRD.md)

**Data**: 2026-10-10

## 1. Stack tecnológica

| Camada | Tecnologia | Motivo/restrição |
|---|---|---|
| Frontend | React 19, Vite, TypeScript | Painel. Mesma stack do Prumo, o que permite reaproveitar padrões. |
| Backend | Node 22+, Express 5, TypeScript, zod, `tsx` | Serviço único (monólito simples). Mantido por uma pessoa. |
| Banco de dados | PostgreSQL 16 com pgvector (`pgvector/pgvector:pg16`) | Mensagens, vetores, jobs e configuração no mesmo banco. Sem Redis. |
| Fila e agendamento | Jobs em Postgres (`for update skip locked`) | Padrão do Prumo: dedupe, backoff e idempotência no banco. |
| IA | OpenRouter: orquestrador barato, redatora Claude, Whisper e embeddings | Mesmo desenho das duas IAs atuais. Modelos por variável de ambiente, com fallback. |
| Infra/Deploy | EasyPanel (projeto "eleitoral"), Docker, GitHub com autodeploy | Decisão do usuário. |
| Testes | vitest com PGlite (+ pgvector) | Sem rede e sem Postgres externo nos testes. |

## 2. Integrações externas

| Integração | Finalidade | Observações |
|---|---|---|
| **MCP (principal)** | Conexão principal de dados e RAG: dados de urna, RAG de fake news, agenda e o que mais for cadastrado | Cliente MCP remoto (Streamable HTTP). Fontes cadastradas pelo painel. As tools são descobertas (`tools/list`) e cada uma pode ser ligada ou desligada. Leitura por padrão. |
| Evolution API | Receber mensagens e histórico de grupos, transcrever áudio e baixar mídia | Não oficial: risco de queda e de banimento. Uma instância por tenant, com monitoramento. |
| OpenRouter | Orquestrador, redatora, Whisper e embeddings | Uma chave por ambiente. Dimensão do vetor: 1536. |
| GitHub | Código e autodeploy | Repositório privado. |

## 3. Requisitos não-funcionais

- Performance: busca abaixo de 10 s (p95), resumo de 24 h abaixo de 60 s, atraso de ingestão mediano abaixo de 30 s (metas do PRD).
- Escalabilidade: 2 tenants, dezenas de grupos e centenas de milhares de mensagens. Um serviço e um Postgres bastam. O MVP não exige escala horizontal.
- Segurança:
  - Painel com login próprio (Argon2id), sessão em cookie httpOnly e papéis por tenant.
  - Segredos das Fontes criptografados no banco (AES-256-GCM, chave em variável de ambiente).
  - Webhook da Evolution com token verificado.
  - **Retorno de tools MCP é dado, nunca instrução** (defesa contra prompt injection). Tools de escrita ficam desligadas por padrão.
  - Segredos nunca entram no repositório.
- Isolamento entre tenants: `workspace_id` em toda tabela e em toda consulta, por uma camada de acesso única. Teste automatizado de vazamento entre tenants é obrigatório. Avaliar RLS do Postgres como segunda barreira.
- Compliance (LGPD):
  - Retenção: **guarda-se tudo, sem expiração na v1** (decisão do usuário).
  - Acesso por papel e tenant isolado.
  - Exportação e exclusão por solicitação ficam como procedimento manual até serem automatizados.
- Disponibilidade: sem SLA formal. Healthcheck `/health`, monitor de instância caída da Evolution com aviso aos Heads, e jobs que retomam sozinhos após falha.
- Internacionalização/idiomas: apenas pt-BR.

## 4. Ambiente e deploy

- Onde roda: nuvem própria via EasyPanel.
- Provedor: EasyPanel, projeto `poli2`, na VPS do usuário (o IP não é registrado aqui porque o repositório é público).
- Serviços: um app Node (Dockerfile, autodeploy do GitHub) e um Postgres próprio com pgvector. Não reaproveitar o banco de outro projeto.
- CI/CD: GitHub Actions com `typecheck` e `test`, e deploy automático pelo EasyPanel na `main`.
- Migrations SQL próprias, aplicadas no boot (`server/migrate.ts`).
- Observabilidade: logs do app e `/health`. Erros e uptime com ferramenta self-hosted se já houver no EasyPanel (GlitchTip e Uptime Kuma), caso contrário fica para depois.

## 5. Restrições herdadas

- Sistemas legados a integrar: nenhum obrigatório. A Poli atual e o Prumo continuam rodando e não são tocados. Os dados de urna vêm por MCP.
- Decisões técnicas já tomadas e não-negociáveis:
  - Projeto novo, em repositório separado (`poli2`).
  - Stack TypeScript, React e Postgres com pgvector.
  - MCP como conexão principal de dados e RAG.
  - Guardar tudo.
  - Dois tenants isolados.
  - Prazo: segundo turno, em 25/10/2026 (a confirmar).

## 6. Manutenção

- Quem mantém o código após o lançamento: Frederico Mazzo, sozinho.
- Nível de complexidade aceitável dado quem mantém: baixo. Um serviço, um banco, sem Redis, sem microsserviços e sem frameworks de agente. Poucas dependências e prompts versionados em arquivos. Os gates e a ingestão ficam cobertos por testes, para que uma pessoa consiga mexer sem medo.

---

## Gaps & Recomendações (preencher só no Modo B — análise de repo existente)

Não se aplica: projeto novo.

Pendências a confirmar:
- [ ] Nome exato do projeto no EasyPanel e se já existe um Postgres com pgvector disponível.
- [ ] Data do segundo turno (25/10/2026).
- [ ] Orçamento mensal de IA.

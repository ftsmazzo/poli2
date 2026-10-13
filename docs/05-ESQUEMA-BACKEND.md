# Esquema Backend — Poli 2.0

> Modelagem de dados e API.
> Fonte: [x] Entrevista com usuário  [x] Leitura de código existente (`db/migrations/001_core.sql`)
> Depende de: [TRD](02-TRD.md)

**Data**: 2026-10-10

## Decisões desta fase (tomadas com o usuário delegando a escolha)

| Pergunta | Decisão | Por quê |
|---|---|---|
| Login do painel | Por pessoa (e-mail e senha), com convite do admin | Dá trilha de quem fez o quê e permite revogar um Head sem trocar a senha de todos |
| Usuário em 2 tenants | Sim: um login, vários tenants, com seletor no painel | O dono precisa operar os dois tenants sem sair |
| Mídia | Guardar o **arquivo original** em volume, com metadados e texto extraído no banco | "Resgatar arquivos" exige o original. O volume é barato perto do valor |
| Mensagens da Poli | Guardar tudo o que a Poli envia e um log de cada turno | Auditoria, dedupe de alertas e diagnóstico |

## 1. Entidades principais

**Já existem em `001_core.sql`:**

| Entidade | Campos-chave | Relacionamentos |
|---|---|---|
| `workspaces` | id, nome | Tenant. Pai de tudo |
| `instancias_wa` | workspace_id, evolution_instance, ativa | 1 instância por tenant |
| `pessoas` | workspace_id, jid, nome, telefone, papel (head, vip, equipe, outro), pode_comandar, pode_conversar | Pessoa do WhatsApp (diferente de usuário do painel) |
| `grupos` | workspace_id, jid, nome, acompanhar, intervalo_min, ultima_leitura_msg_id, ultima_leitura_em | Tem mensagens, janelas, resumos |
| `mensagens` | workspace_id, grupo_id, wa_message_id (único por tenant), autor, enviada_em (hora real), recebida_em, tipo, texto, midia_ref, citada_wa_id, bruto, tsv | Base de tudo. Busca por texto em português |
| `janelas` | grupo_id, de_msg_id, ate_msg_id, inicio_em, fim_em, texto, embedding (vector 1536) | Janelas de ~10 mensagens para busca semântica |
| `itens` | tipo (link, arquivo, contato, endereco), valor, dados, mensagem_id, dedupe_key | Sempre aponta para a mensagem de origem |
| `resumos` | grupo_id, de/ate (mensagem e hora), texto, importancia (0 a 3) | Resumo incremental por grupo |
| `alertas` | grupo_id, resumo_id, severidade (1 a 3), texto, dedupe_key, enviado_em | Dedupe por tenant |
| `fontes` | tipo (mcp, rag, agenda, api, arquivos, contatos), nome, config, segredo_enc, quando_usar, escopo, ativa, status, ultimo_teste_em, ultimo_erro, latencia_ms | Registro de Fontes |
| `fonte_tools` | fonte_id, nome, descricao, ativa | Tools descobertas, ligáveis uma a uma |
| `jobs` | tipo, payload, dedupe_key, executar_em, tentativas, estado | Fila em Postgres |

**A criar (migração `002`):**

| Entidade | Campos-chave | Relacionamentos |
|---|---|---|
| `usuarios` | id, email (único), senha_hash (Argon2id), nome, ativo, criado_em | Login do painel |
| `usuario_workspaces` | usuario_id, workspace_id, papel (admin, head), pessoa_id (opcional) | Muitos para muitos. Liga o usuário à sua pessoa do WhatsApp |
| `sessoes` | id, usuario_id, token_hash, expira_em, ultimo_uso_em | Cookie httpOnly. Guarda só o hash |
| `convites` | id, workspace_id, email, papel, token_hash, expira_em, usado_em | Admin convida; sem cadastro público |
| `midias` | id, workspace_id, mensagem_id, mime, bytes, sha256, caminho, texto_extraido, estado (pendente, baixada, falhou, ignorada), baixada_em | Original no volume. Dedupe por sha256 dentro do tenant |
| `mensagens_saida` | id, workspace_id, destino_jid, destino_tipo (privado, grupo), origem (resposta, alerta, aviso, md), alerta_id, texto, estado (pendente, enviada, falhou), tentativas, wa_message_id, criado_em, enviada_em | Tudo o que a Poli manda. Base do dedupe e do reenvio |
| `turnos` | id, workspace_id, pessoa_id, grupo_id, pergunta, tools (jsonb), fontes (jsonb), resposta, modelo, latencia_ms, criado_em | Log de cada pergunta, para a tela de Diagnóstico e auditoria |
| `eventos_saude` | id, workspace_id, tipo (instancia, fonte), alvo, estado (caiu, voltou), detalhe, criado_em | Alimenta a faixa vermelha e o aviso ao admin |

Índices a acrescentar na `002`: vetor HNSW em `janelas.embedding`, `mensagens (workspace_id, enviada_em)`, `midias (workspace_id, sha256)` (não único: o mesmo arquivo pode estar em várias mensagens, com uma linha por mensagem e um só arquivo em disco) e `mensagens_saida (estado)`.

## 2. Autenticação e autorização

- Método: login **pelo WhatsApp, sem senha**. A pessoa autorizada pede "painel" à Poli e recebe no privado um link de uso único (15 minutos, tabela `login_links`, só o hash do token). O usuário é identificado pelo telefone (`usuarios.telefone`); e-mail e senha são opcionais e não usados. Sessão em cookie httpOnly com hash do token no banco (`sessoes`). Sem cadastro público: quem pode entrar é quem a Poli reconhece como autorizado (variável `COMANDANTES` e as pessoas marcadas como "pode comandar" no painel).
- Níveis de permissão/papéis:
  - **Painel:** admin do tenant (tudo) e Head (leitura e ajuste de grupos e alertas, sem editar Fontes nem segredos).
  - **WhatsApp:** head, vip, equipe e outro, definidos em `pessoas`. `pode_comandar` e `pode_conversar` controlam o privado.
- Isolamento: toda consulta passa por uma camada que exige `workspace_id` vindo da sessão (nunca do corpo do pedido). O teste de vazamento entre tenants roda no CI.

## 3. Endpoints/ações principais

| Endpoint/Ação | Método | Autenticado? | Regra de negócio relevante |
|---|---|---|---|
| `/webhooks/evolution/:instancia` | POST | Token do webhook | Grava a mensagem sem duplicar, com a hora real, e enfileira os jobs |
| `/health` | GET | Não | Só estado do processo e do banco, sem detalhes |
| `/api/auth/login` | POST | Não | Rate limit; cria sessão |
| `/api/auth/logout`, `/api/auth/me` | POST, GET | Sim | |
| `/api/convites` | POST | Admin | Gera link com expiração |
| `/api/workspaces` | GET | Sim | Lista os tenants do usuário (seletor) |
| `/api/fontes` | GET, POST | Admin (POST); Head lê | Segredo nunca volta na resposta |
| `/api/fontes/:id` | PATCH, DELETE | Admin | |
| `/api/fontes/:id/testar` | POST | Admin | Conecta, lista as tools, grava status e latência |
| `/api/fontes/:id/tools/:nome` | PATCH | Admin | Liga ou desliga a tool. Tools de escrita nascem desligadas |
| `/api/grupos` | GET | Sim | |
| `/api/grupos/:id` | PATCH | Admin, Head | Acompanhar e intervalo (mínimo 5 min) |
| `/api/pessoas` | GET, POST, PATCH | Admin | Papéis e lista de autorizados do privado |
| `/api/alertas` | GET | Sim | Histórico e estado de envio |
| `/api/diagnostico` | GET | Sim | Instância, Fontes, fila de jobs, últimos turnos e eventos de saúde |
| `/api/midias/:id` | GET | Sim, do mesmo tenant | Serve o arquivo original |
| `/api/historico/importar` | POST | Admin | Enfileira a importação do histórico de um grupo |

A busca, o resumo e o MD do dia **não** têm endpoint: acontecem pelo WhatsApp (turno do orquestrador).

## 4. Processamento assíncrono

Jobs na fila Postgres (dedupe, backoff e retomada após falha):

| Job | Gatilho | O que faz |
|---|---|---|
| `baixar_midia` | Mensagem com mídia | Baixa o original, calcula o sha256, extrai o texto (PDF, imagem e áudio transcrito) |
| `extrair_itens` | Mensagem nova | Gera links, contatos (vCard e texto), endereços e arquivos |
| `indexar_janela` | A cada ~10 mensagens | Gera o embedding da janela |
| `ler_grupo` | Temporizador por grupo | Resumo incremental, importância e criação do alerta |
| `enviar_mensagem` | Linha em `mensagens_saida` | Envia pela Evolution, com nova tentativa se falhar |
| `checar_saude` | Periódico (1 min) | Instância e Fontes. Gera `eventos_saude`, a faixa e o aviso ao admin |
| `importar_historico` | Pedido do admin | Traz as mensagens antigas da Evolution |
| `md_do_dia` | Pedido no WhatsApp | Gera o Markdown do dia |

Webhook: entrada da Evolution. Toda escrita nasce idempotente (`wa_message_id` único).

## 5. Armazenamento

- Tipo de dados:
  - Estruturado em Postgres: mensagens, itens, vetores e configuração.
  - Arquivos: originais em volume do EasyPanel, em `/data/midia/<workspace_id>/<sha256>`. No banco ficam só os metadados e o texto extraído.
  - Sensível: conversas e dados pessoais de terceiros (contatos, endereços), segredos das Fontes criptografados (AES-256-GCM).
- Mídia na v1: documentos, imagens e áudio entram com o original guardado, limite de 25 MB por arquivo. Vídeo guarda só os metadados e a referência.
- Volume esperado: 2 tenants, centenas de milhares de mensagens. Cada janela com vetor ocupa cerca de 6 KB, então 100 mil mensagens (~10 mil janelas) ficam em dezenas de MB. A mídia domina o espaço e cresce sem limite, já que guarda-se tudo.
- Retenção: sem expiração na v1 (decisão do usuário).

---

## Gaps & Recomendações (preencher só no Modo B — análise de repo existente)

Não se aplica: projeto novo.

Pendências:
- [ ] **Backup** do Postgres e do volume de mídia não está definido. Com "guardar tudo", perder o volume é perder o histórico. Definir a rotina antes do segundo turno.
- [ ] Confirmar que o PGlite aceita o índice HNSW, para o teste da `002`. Se não aceitar, o índice vira uma migração separada só para o Postgres real.
- [ ] Definir a política de crescimento da mídia (alerta de espaço no Diagnóstico).

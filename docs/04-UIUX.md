# UI/UX Design — Poli 2.0

> Direção visual e de experiência.
> Fonte: [x] Entrevista com usuário  [x] Leitura de código existente (tokens do Prumo)
> Depende de: [Fluxo do App](03-FLUXO-APP.md)

**Data**: 2026-10-10

## 1. Referências e tom

- Referências visuais/concorrentes: o próprio Prumo (`src/index.css`): mesma família visual, mesmos tokens e mesma estrutura de navegação lateral. A Poli 2.0 parece irmã do Prumo.
- Tom da marca: sóbrio e denso em informação. É um painel de operação: tabelas, status e pouca decoração.

## 2. Plataformas-alvo

- [x] Web responsivo
- [ ] Mobile nativo (iOS/Android): fora de escopo
- [x] Desktop: foco principal

O painel é pensado para computador. Os Heads talvez usem o celular, então o layout precisa funcionar em tela estreita, sem perder a leitura de status e alertas.
**PWA: talvez.** Na v1 só deixamos o painel *instalável* (manifest, ícones e tela cheia). Offline e push ficam fora, e a decisão de investir nisso é adiada.

## 3. Sistema visual

- Paleta de cores: reaproveita os tokens do Prumo. A semântica de status é fixa (verde: ok, vermelho: erro, cinza: nunca testada).

| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `--fog` | `#e8ebf0` | `#0e1117` | Fundo da página |
| `--snow` | `#ffffff` | `#151a22` | Superfícies e cartões |
| `--panel` | `#f2f4f7` | `#1b212b` | Painéis e cabeçalhos de tabela |
| `--graphite` | `#12171e` | `#e8ecf2` | Texto principal |
| `--ash` | `#66707d` | `#96a0af` | Texto secundário |
| `--rule` | `#d4dae3` | `#2a3342` | Linhas e bordas |
| `--plumb` | `#c2342a` | `#e2554b` | Erro, alerta e ação destrutiva |
| `--ok` | `#2f6a4f` | `#3f9a6e` | Fonte ok, conectado |
| `--zap` | `#128c7e` | `#2aa892` | Acento (WhatsApp) |

- **Modo claro e escuro:** os dois, com a mesma estrutura de tokens. Segue o tema do sistema e permite escolha manual em Configurações. A escolha manual é guardada por usuário. O atributo `data-theme` no `html` troca os tokens, como no Prumo.
- Tipografia: Figtree, com `Segoe UI` e sans-serif como reserva. Tamanho compacto para tabelas.
- Forma e movimento: raio de 8 px, sombras suaves e transições curtas de 280 ms. Sem animações decorativas.
- Componentes centrais:
  - Tabelas de dados: Grupos, Pessoas, Alertas, Fontes.
  - Pílulas de status (ok, erro, nunca testada) sempre com ícone e texto, nunca só cor.
  - Gaveta lateral (drawer) para detalhe e edição de Fonte, Grupo e Pessoa.
  - Formulários curtos, com validação inline.
  - Faixa global vermelha de falha de conexão, no topo de todas as telas.
  - Seletor de tenant no topo (os 2 tenants), no estilo do menu de organização do Prumo.
  - Sem componente de chat: o painel é só de configuração.

## 4. Acessibilidade

- Requisitos específicos: nenhum exigido por lei ou público. Adotar WCAG 2.2 nível AA como piso.
- Contraste mínimo AA nos dois temas, validado nos tokens acima.
- Estado nunca só por cor (ícone e texto junto).
- Navegação completa por teclado, foco visível, rótulos nos campos e a faixa de falha anunciada para leitores de tela (`role="alert"`).

## 5. Telas principais

| Tela | Jornada relacionada | Estado (rascunho/aprovado) |
|---|---|---|
| Login | Todas | Rascunho |
| Visão geral / Diagnóstico (WhatsApp, Fontes, fila de jobs, últimas execuções) | 3 e 4 | Rascunho |
| Fontes (lista, "Testar", tools descobertas e escopo) | 3 | Rascunho |
| Grupos (acompanhar, intervalo, última leitura) | 2 e 3 | Rascunho |
| Pessoas e papéis (lista de autorizados do privado) | 3 | Rascunho |
| Alertas (histórico, severidade, status de envio) | 2 | Rascunho |
| Configurações (tema, tenant, horário silencioso) | 3 | Rascunho |

---

## Gaps & Recomendações (preencher só no Modo B — análise de repo existente)

Não se aplica: projeto novo.

Pontos em aberto:
- [ ] PWA: decidir depois da v1 se vale investir em push e uso offline.
- [ ] Conferir o contraste real dos tokens do Prumo nos dois temas antes de congelar. Eu li os valores, mas não medi a razão de contraste.

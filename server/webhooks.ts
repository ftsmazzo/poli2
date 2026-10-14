import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import type { Db } from './migrate';
import { extrairMensagem, extrairPrivado, gravarMensagem, normalizarEvento, type MensagemNormalizada, type MensagemPrivada } from './ingest/evolution';

// Compara os hashes, não os textos: tempo constante e sem exigir o mesmo tamanho.
function tokenValido(recebido: string, esperado: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(recebido), h(esperado));
}

// Chamado depois que uma mensagem NOVA foi gravada (nunca para reenvio). Roda sem bloquear a resposta
// ao webhook: responder um pedido pode demorar, e a Evolution reenviaria se o webhook ficasse esperando.
export type AoGravar = (instancia: string, msg: MensagemNormalizada) => Promise<void>;

// Mensagem de texto recebida no privado: nunca é gravada, só atendida se quem escreveu tiver permissão.
export type AoReceberPrivado = (instancia: string, dm: MensagemPrivada) => Promise<void>;

export function webhookRouter(getDb: () => Db | undefined, token: string | undefined, aoGravar?: AoGravar, aoPrivado?: AoReceberPrivado): Router {
  const router = Router();

  router.post('/evolution/:instancia', express.json({ limit: '15mb' }), async (req, res) => {
    // Sem token configurado o webhook fica fechado, nunca aberto.
    if (!token) {
      res.status(503).json({ erro: 'webhook_nao_configurado' });
      return;
    }
    if (!tokenValido(req.header('x-webhook-token') ?? '', token)) {
      res.status(401).json({ erro: 'nao_autorizado' });
      return;
    }
    const db = getDb();
    if (!db) {
      res.status(503).json({ erro: 'banco_indisponivel' });
      return;
    }

    try {
      // Só mensagens novas de grupo. Os outros eventos recebem 200 para a Evolution não reenviar.
      if (normalizarEvento(req.body?.event) !== 'messages.upsert') {
        res.json({ ignorado: 'evento' });
        return;
      }
      // O payload pode trazer uma mensagem ou uma lista.
      const itens: unknown[] = Array.isArray(req.body.data) ? req.body.data : [req.body.data];
      const resumo = { gravadas: 0, duplicadas: 0, ignoradas: 0, instancia_desconhecida: 0 };
      for (const item of itens) {
        const dm = aoPrivado ? extrairPrivado(item) : null;
        if (dm && aoPrivado) {
          void aoPrivado(req.params.instancia, dm).catch((err) =>
            console.error('atendimento no privado falhou:', err instanceof Error ? err.message : err),
          );
          continue;
        }
        const msg = extrairMensagem(item);
        if (!msg) {
          resumo.ignoradas++;
          continue;
        }
        const r = await gravarMensagem(db, req.params.instancia, msg);
        if (r === 'gravada') {
          resumo.gravadas++;
          if (aoGravar) {
            void aoGravar(req.params.instancia, msg).catch((err) =>
              console.error('processamento após a gravação falhou:', err instanceof Error ? err.message : err),
            );
          }
        }
        else if (r === 'duplicada') resumo.duplicadas++;
        else resumo.instancia_desconhecida++;
      }
      // Só contagens: nunca o conteúdo da conversa. Deixa rastro de que as mensagens estão chegando.
      if (resumo.gravadas || resumo.instancia_desconhecida) {
        console.log(`webhook ${req.params.instancia}: ${JSON.stringify(resumo)}`);
      }
      res.json(resumo);
    } catch (err) {
      // Nunca loga o corpo: tem conversa e dados pessoais.
      console.error('webhook evolution falhou:', err instanceof Error ? err.message : err);
      res.status(500).json({ erro: 'falha_interna' });
    }
  });

  return router;
}

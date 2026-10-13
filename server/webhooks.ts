import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import type { Db } from './migrate';
import { extrairMensagem, gravarMensagem, normalizarEvento } from './ingest/evolution';

// Compara os hashes, não os textos: tempo constante e sem exigir o mesmo tamanho.
function tokenValido(recebido: string, esperado: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(recebido), h(esperado));
}

export function webhookRouter(getDb: () => Db | undefined, token: string | undefined): Router {
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
        const msg = extrairMensagem(item);
        if (!msg) {
          resumo.ignoradas++;
          continue;
        }
        const r = await gravarMensagem(db, req.params.instancia, msg);
        if (r === 'gravada') resumo.gravadas++;
        else if (r === 'duplicada') resumo.duplicadas++;
        else resumo.instancia_desconhecida++;
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

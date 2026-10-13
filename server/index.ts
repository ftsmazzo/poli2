import express from 'express';

const app = express();

// Só o estado do processo. Detalhes de banco e Fontes ficam no Diagnóstico autenticado.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`poli2 ouvindo na porta ${port}`);
});

import { describe, expect, it } from 'vitest';
import { enviarDocumento } from './client';

const cfg = { url: 'https://evo.exemplo.com/', apiKey: 'chave-de-teste' };

describe('enviarDocumento', () => {
  it('manda o arquivo em base64 para a instância e devolve o id da mensagem', async () => {
    let url = '';
    let init: RequestInit = {};
    const f = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: 'ABC123' } }) } as Response;
    }) as unknown as typeof fetch;

    const r = await enviarDocumento(cfg, 'minha instancia', '5511987654321@s.whatsapp.net', { nomeArquivo: 'poli-md-2026-10-15.md', conteudo: '# Resumo\nação', mime: 'text/markdown', legenda: 'Resumo do dia' }, f);

    expect(r).toEqual({ waMessageId: 'ABC123' });
    expect(url).toBe('https://evo.exemplo.com/message/sendMedia/minha%20instancia');
    expect((init.headers as Record<string, string>).apikey).toBe('chave-de-teste');
    const corpo = JSON.parse(String(init.body));
    expect(corpo).toMatchObject({ number: '5511987654321@s.whatsapp.net', mediatype: 'document', mimetype: 'text/markdown', fileName: 'poli-md-2026-10-15.md', caption: 'Resumo do dia' });
    // O conteúdo vai em base64 e volta igual, com acento.
    expect(Buffer.from(corpo.media, 'base64').toString('utf8')).toBe('# Resumo\nação');
  });

  it('o erro leva só o status, nunca o corpo da resposta', async () => {
    const f = (async () => ({ ok: false, status: 400, text: async () => 'conteúdo do arquivo ecoado' }) as Response) as unknown as typeof fetch;
    const tentativa = enviarDocumento(cfg, 'inst', 'x', { nomeArquivo: 'a.md', conteudo: 'segredo', mime: 'text/markdown' }, f);
    await expect(tentativa).rejects.toThrow(/respondeu 400/);
    await expect(tentativa).rejects.not.toThrow(/ecoado/);
  });
});

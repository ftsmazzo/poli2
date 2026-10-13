const FUSO = 'America/Sao_Paulo';

export function dataAbsoluta(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: FUSO }).format(d)} (Brasília)`;
}

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function dataRelativa(iso: string | null | undefined, agora = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const seg = Math.round((t - agora) / 1000);
  const abs = Math.abs(seg);
  if (abs < 45) return 'agora há pouco';
  if (abs < 3600) return rtf.format(Math.round(seg / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seg / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(seg / 86400), 'day');
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: FUSO }).format(new Date(t));
}

export const numero = (n: number) => new Intl.NumberFormat('pt-BR').format(n);

export function formatarTelefone(t: string | null): string {
  if (!t) return '';
  const d = t.replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 13 || d.length === 12)) {
    const ddd = d.slice(2, 4);
    const resto = d.slice(4);
    return `+55 (${ddd}) ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
  }
  return d ? `+${d}` : '';
}

export function textoDeFerramentas(f: unknown): string {
  if (Array.isArray(f)) {
    return f
      .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && 'nome' in x ? String((x as { nome: unknown }).nome) : ''))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof f === 'string') return f;
  return '';
}

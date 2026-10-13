import { dataAbsoluta, dataRelativa } from '../format';

export function Quando({ iso, vazio = '—' }: { iso: string | null | undefined; vazio?: string }) {
  if (!iso) return <span className="suave">{vazio}</span>;
  const abs = dataAbsoluta(iso);
  if (!abs) return <span className="suave">{vazio}</span>;
  return (
    <time dateTime={iso} title={abs}>
      {dataRelativa(iso)}
    </time>
  );
}

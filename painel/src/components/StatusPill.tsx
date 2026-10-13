import type { StatusFonte } from '../api';
import { IconeErro, IconeNunca, IconeOk } from './Icones';

export function StatusPill({ status }: { status: StatusFonte }) {
  if (status === 'ok')
    return (
      <span className="pilula pilula-ok">
        <IconeOk /> OK
      </span>
    );
  if (status === 'erro')
    return (
      <span className="pilula pilula-erro">
        <IconeErro /> Com erro
      </span>
    );
  return (
    <span className="pilula pilula-nunca">
      <IconeNunca /> Nunca testada
    </span>
  );
}

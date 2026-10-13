interface Props {
  checked: boolean;
  onChange: (valor: boolean) => void;
  rotulo: string;
  disabled?: boolean;
  textoLigado?: string;
  textoDesligado?: string;
  semTexto?: boolean;
}

// Interruptor: o estado aparece em texto ("Ligado"/"Desligado"), nunca só pela cor.
export function Switch({ checked, onChange, rotulo, disabled, textoLigado = 'Ligado', textoDesligado = 'Desligado', semTexto }: Props) {
  return (
    <label className={`switch${disabled ? ' switch-off' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={rotulo} onChange={(e) => onChange(e.target.checked)} />
      <span className="trilho" aria-hidden="true">
        <span className="bola" />
      </span>
      {!semTexto && (
        <span className="switch-txt" aria-hidden="true">
          {checked ? textoLigado : textoDesligado}
        </span>
      )}
    </label>
  );
}

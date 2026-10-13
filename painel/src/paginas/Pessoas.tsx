import { useState } from 'react';
import { api, mensagemDeErro, type PapelPessoa, type Pessoa, type PessoaPatch } from '../api';
import { Aviso, Carregando, ErroCarga, Vazio } from '../components/Estados';
import { Switch } from '../components/Switch';
import { formatarTelefone, numero } from '../format';
import { useCarregar } from '../hooks';
import { useSessao } from '../sessao';

const PAPEIS: { valor: PapelPessoa; rotulo: string }[] = [
  { valor: 'head', rotulo: 'Head' },
  { valor: 'vip', rotulo: 'VIP' },
  { valor: 'equipe', rotulo: 'Equipe' },
  { valor: 'outro', rotulo: 'Outro' },
];

function CampoTelefone({ pessoa, podeEditar, aoSalvar }: { pessoa: Pessoa; podeEditar: boolean; aoSalvar: (telefone: string) => void }) {
  const [valor, setValor] = useState<string | null>(null);
  if (!podeEditar) return <span>{formatarTelefone(pessoa.telefone) || <span className="suave">—</span>}</span>;
  const mostrado = valor ?? pessoa.telefone ?? '';
  function salvar() {
    if (valor === null) return;
    const novo = valor.replace(/\D/g, '');
    setValor(null);
    if (novo !== (pessoa.telefone ?? '')) aoSalvar(novo);
  }
  return (
    <input
      type="tel"
      inputMode="tel"
      className="campo-telefone"
      aria-label={`Telefone de ${pessoa.nome ?? 'pessoa sem nome'}`}
      placeholder="5511999999999"
      value={mostrado}
      onChange={(e) => setValor(e.target.value)}
      onBlur={salvar}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setValor(null);
      }}
    />
  );
}

export function Pessoas() {
  const { ehAdmin } = useSessao();
  const { dados, erro, carregando, recarregar, definir } = useCarregar(api.pessoas);
  const [aviso, setAviso] = useState<string | null>(null);

  async function mudar(p: Pessoa, patch: PessoaPatch) {
    const antes: Partial<Pessoa> = {};
    for (const k of Object.keys(patch) as (keyof PessoaPatch)[]) Object.assign(antes, { [k]: p[k] });
    setAviso(null);
    // O servidor guarda o telefone só com dígitos; mostramos igual na hora.
    const otimista: Partial<Pessoa> = { ...patch, telefone: undefined };
    delete otimista.telefone;
    if (patch.telefone !== undefined) otimista.telefone = patch.telefone.replace(/\D/g, '') || null;
    definir((l) => l && l.map((x) => (x.id === p.id ? { ...x, ...otimista } : x)));
    try {
      await api.editarPessoa(p.id, patch);
    } catch (e) {
      definir((l) => l && l.map((x) => (x.id === p.id ? { ...x, ...antes } : x)));
      setAviso(`Não salvei a mudança em "${p.nome ?? 'pessoa sem nome'}": ${mensagemDeErro(e)}`);
    }
  }

  return (
    <>
      <div className="titulo-pagina">
        <h1>Pessoas</h1>
        <button type="button" className="btn" onClick={recarregar}>
          Atualizar
        </button>
      </div>
      <p className="ajuda">
        <strong>Quem tem &quot;Pode comandar a Poli&quot; também recebe acesso a este painel</strong> quando pedir o link no WhatsApp. &quot;Pode conversar&quot; libera a Poli a responder essa pessoa no privado.
      </p>
      {!ehAdmin && <Aviso tipo="info">Você pode ver esta lista, mas só administradores podem alterá-la.</Aviso>}
      {aviso && <Aviso aoFechar={() => setAviso(null)}>{aviso}</Aviso>}
      {carregando && !dados && <Carregando />}
      {erro && <ErroCarga mensagem={erro} aoTentar={recarregar} />}
      {dados && dados.length === 0 && (
        <Vazio titulo="Nenhuma pessoa ainda">
          <p>As pessoas aparecem aqui conforme participam dos grupos que a Poli acompanha.</p>
        </Vazio>
      )}
      {dados && dados.length > 0 && (
        <div className="cartao sem-padding">
          <div className="rolagem">
            <table>
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">Telefone</th>
                  <th scope="col">Papel</th>
                  <th scope="col">Pode comandar a Poli</th>
                  <th scope="col">Pode conversar</th>
                  <th scope="col" className="num">
                    Mensagens
                  </th>
                </tr>
              </thead>
              <tbody>
                {dados.map((p) => {
                  const nome = p.nome ?? 'pessoa sem nome';
                  return (
                    <tr key={p.id}>
                      <th scope="row">{p.nome ?? <span className="suave">(sem nome)</span>}</th>
                      <td>
                        <CampoTelefone pessoa={p} podeEditar={ehAdmin} aoSalvar={(t) => void mudar(p, { telefone: t })} />
                      </td>
                      <td>
                        {ehAdmin ? (
                          <select aria-label={`Papel de ${nome}`} value={p.papel} onChange={(e) => void mudar(p, { papel: e.target.value as PapelPessoa })}>
                            {PAPEIS.map((o) => (
                              <option key={o.valor} value={o.valor}>
                                {o.rotulo}
                              </option>
                            ))}
                          </select>
                        ) : (
                          PAPEIS.find((o) => o.valor === p.papel)?.rotulo ?? p.papel
                        )}
                      </td>
                      <td>
                        <Switch rotulo={`${nome} pode comandar a Poli`} checked={p.podeComandar} disabled={!ehAdmin} textoLigado="Sim" textoDesligado="Não" onChange={(v) => void mudar(p, { podeComandar: v })} />
                      </td>
                      <td>
                        <Switch rotulo={`${nome} pode conversar com a Poli`} checked={p.podeConversar} disabled={!ehAdmin} textoLigado="Sim" textoDesligado="Não" onChange={(v) => void mudar(p, { podeConversar: v })} />
                      </td>
                      <td className="num">{numero(p.mensagens)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

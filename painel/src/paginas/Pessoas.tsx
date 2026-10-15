import { useState } from 'react';
import { api, mensagemDeErro, type PapelPessoa, type Pessoa, type PessoaPatch } from '../api';
import { Dialogo } from '../components/Dialogo';
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

type Visao = 'membros' | 'saiu' | 'semVinculo' | 'todos';

const grupos = (p: Pessoa) => p.grupos ?? [];
const estaEmAlgumGrupo = (p: Pessoa) => grupos(p).some((g) => g.ativo);
const jaSaiu = (p: Pessoa) => grupos(p).length > 0 && !estaEmAlgumGrupo(p);
const semVinculo = (p: Pessoa) => grupos(p).length === 0;
const nomeDe = (p: Pessoa) => p.nome ?? (formatarTelefone(p.telefone) || 'pessoa sem nome');

const FILTROS: Record<Visao, (p: Pessoa) => boolean> = {
  membros: estaEmAlgumGrupo,
  saiu: jaSaiu,
  semVinculo,
  todos: () => true,
};

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

// "Unir": a mesma pessoa que apareceu em dois cadastros (ex.: um pelo número, outro só pelo nome numa conversa exportada).
function DialogoUnir({ origem, candidatos, ocupado, aoUnir, aoFechar }: { origem: Pessoa; candidatos: Pessoa[]; ocupado: boolean; aoUnir: (paraId: number) => void; aoFechar: () => void }) {
  const [paraId, setParaId] = useState<number | ''>('');
  return (
    <Dialogo
      titulo={`Unir "${nomeDe(origem)}" a outra pessoa`}
      lado="centro"
      aoFechar={aoFechar}
      rodape={
        <>
          <button type="button" className="btn" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primario" disabled={ocupado || paraId === ''} onClick={() => paraId !== '' && aoUnir(paraId)}>
            Unir
          </button>
        </>
      }
    >
      <p>
        Use quando <strong>{nomeDe(origem)}</strong> e outra pessoa da lista são a mesma gente. As mensagens, os links e os grupos dele passam para a pessoa que você escolher, e este cadastro deixa de existir. Não dá para desfazer.
      </p>
      <div className="campo">
        <label htmlFor="unir-para">Unir a</label>
        <select id="unir-para" value={paraId} onChange={(e) => setParaId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">Escolha a pessoa…</option>
          {candidatos.map((c) => (
            <option key={c.id} value={c.id}>
              {nomeDe(c)}
              {c.telefone && c.nome ? ` · ${formatarTelefone(c.telefone)}` : ''}
            </option>
          ))}
        </select>
      </div>
    </Dialogo>
  );
}

export function Pessoas() {
  const { ehAdmin } = useSessao();
  const { dados, erro, carregando, recarregar, definir } = useCarregar(api.pessoas);
  const [aviso, setAviso] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [visao, setVisao] = useState<Visao | null>(null);
  const [unindo, setUnindo] = useState<Pessoa | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function mudar(p: Pessoa, patch: PessoaPatch) {
    const antes: Partial<Pessoa> = {};
    for (const k of Object.keys(patch) as (keyof PessoaPatch)[]) {
      if (k !== 'robo') Object.assign(antes, { [k]: p[k] });
    }
    if (patch.robo !== undefined) antes.tipoConta = p.tipoConta;
    setAviso(null);
    // O servidor guarda o telefone só com dígitos; mostramos igual na hora.
    const { robo, telefone, ...resto } = patch;
    const otimista: Partial<Pessoa> = { ...resto };
    if (telefone !== undefined) otimista.telefone = telefone.replace(/\D/g, '') || null;
    if (robo !== undefined) otimista.tipoConta = robo ? 'robo' : 'pessoa';
    definir((l) => l && l.map((x) => (x.id === p.id ? { ...x, ...otimista } : x)));
    try {
      await api.editarPessoa(p.id, patch);
    } catch (e) {
      definir((l) => l && l.map((x) => (x.id === p.id ? { ...x, ...antes } : x)));
      setAviso(`Não salvei a mudança em "${nomeDe(p)}": ${mensagemDeErro(e)}`);
    }
  }

  async function unir(origem: Pessoa, paraId: number) {
    setOcupado(true);
    setAviso(null);
    try {
      await api.unirPessoa(origem.id, paraId);
      const destino = dados?.find((x) => x.id === paraId);
      setInfo(`"${nomeDe(origem)}" foi unida a "${destino ? nomeDe(destino) : 'outra pessoa'}".`);
      setUnindo(null);
      recarregar();
    } catch (e) {
      setAviso(`Não consegui unir: ${mensagemDeErro(e)}`);
      setUnindo(null);
    } finally {
      setOcupado(false);
    }
  }

  // Antes da primeira sincronização com o WhatsApp ninguém tem grupo: mostra todos para a lista não aparecer vazia.
  const temVinculos = (dados ?? []).some((p) => grupos(p).length > 0);
  const visaoAtual: Visao = visao ?? (temVinculos ? 'membros' : 'todos');
  const lista = (dados ?? []).filter(FILTROS[visaoAtual]);
  const contagem = (v: Visao) => (dados ?? []).filter(FILTROS[v]).length;
  const ABAS: { v: Visao; rotulo: string }[] = [
    { v: 'membros', rotulo: 'Membros atuais' },
    { v: 'saiu', rotulo: 'Quem saiu' },
    { v: 'semVinculo', rotulo: 'Sem vínculo' },
    { v: 'todos', rotulo: 'Todos' },
  ];

  return (
    <>
      <div className="titulo-pagina">
        <div>
          <h1>Pessoas</h1>
          <p className="subtitulo">Quem está em cada grupo agora, pela lista oficial do WhatsApp. A mesma pessoa em vários grupos aparece uma vez só.</p>
        </div>
        <button type="button" className="btn" onClick={recarregar}>
          Atualizar
        </button>
      </div>
      <p className="ajuda">
        <strong>Quem tem &quot;Comanda&quot; (pode pedir coisas à Poli) também recebe acesso a este painel</strong> quando pedir o link no WhatsApp. &quot;Conversa&quot; libera a Poli a responder essa pessoa no privado.
        Quem aparece em &quot;Sem vínculo&quot; veio de uma conversa exportada e não foi reconhecido em nenhum grupo: se for alguém que já está na lista, use &quot;Unir&quot;.
      </p>
      {!ehAdmin && <Aviso tipo="info">Você pode ver esta lista, mas só administradores podem alterá-la.</Aviso>}
      {aviso && <Aviso aoFechar={() => setAviso(null)}>{aviso}</Aviso>}
      {info && (
        <Aviso tipo="info" aoFechar={() => setInfo(null)}>
          {info}
        </Aviso>
      )}
      {carregando && !dados && <Carregando />}
      {erro && <ErroCarga mensagem={erro} aoTentar={recarregar} />}
      {dados && dados.length === 0 && (
        <Vazio titulo="Nenhuma pessoa ainda">
          <p>As pessoas aparecem aqui conforme participam dos grupos que a Poli acompanha.</p>
        </Vazio>
      )}
      {dados && dados.length > 0 && (
        <>
          <div className="abas" role="group" aria-label="Filtrar pessoas">
            {ABAS.map((a) => (
              <button key={a.v} type="button" className="aba" aria-pressed={visaoAtual === a.v} onClick={() => setVisao(a.v)}>
                {a.rotulo} <span className="aba-n">{numero(contagem(a.v))}</span>
              </button>
            ))}
          </div>
          {lista.length === 0 ? (
            <Vazio titulo="Ninguém nesta visão">
              <p>Troque a aba acima para ver as outras pessoas.</p>
            </Vazio>
          ) : (
            <div className="cartao sem-padding">
              <div className="rolagem">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Pessoa</th>
                      <th scope="col">Grupos</th>
                      <th scope="col">Papel</th>
                      <th scope="col" title="Pode pedir coisas à Poli e recebe acesso ao painel">
                        Comanda
                      </th>
                      <th scope="col" title="A Poli pode responder essa pessoa no privado">
                        Conversa
                      </th>
                      <th scope="col" className="num">
                        Mensagens
                      </th>
                      {ehAdmin && <th scope="col">Ações</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lista.map((p) => {
                      const nome = nomeDe(p);
                      const propria = p.tipoConta === 'esta_poli';
                      const travada = !ehAdmin || propria;
                      return (
                        <tr key={p.id}>
                          <th scope="row">
                            <div className="pessoa-linha">
                              <span className="nome-pessoa">{p.nome ?? <span className="suave">(sem nome)</span>}</span>
                              {propria && <span className="etiqueta etiqueta-poli">Esta Poli</span>}
                              {p.tipoConta === 'robo' && <span className="etiqueta">Robô</span>}
                            </div>
                            <div className="pessoa-telefone">
                              <CampoTelefone pessoa={p} podeEditar={ehAdmin && !propria} aoSalvar={(t) => void mudar(p, { telefone: t })} />
                            </div>
                          </th>
                          <td>
                            {grupos(p).length === 0 ? (
                              <span className="suave">—</span>
                            ) : (
                              <ul className="chips-grupo">
                                {grupos(p).map((g) => (
                                  <li key={g.id} className={`chip-grupo${g.ativo ? '' : ' chip-grupo-saiu'}`} title={g.ativo ? (g.admin ? 'Administrador do grupo' : 'Está no grupo') : 'Já esteve e saiu do grupo'}>
                                    {g.nome}
                                    {g.ativo ? g.admin && <small> · admin</small> : <small> · saiu</small>}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td>
                            {travada ? (
                              propria ? <span className="suave">—</span> : PAPEIS.find((o) => o.valor === p.papel)?.rotulo ?? p.papel
                            ) : (
                              <select aria-label={`Papel de ${nome}`} value={p.papel} onChange={(e) => void mudar(p, { papel: e.target.value as PapelPessoa })}>
                                {PAPEIS.map((o) => (
                                  <option key={o.valor} value={o.valor}>
                                    {o.rotulo}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td>
                            <Switch semTexto rotulo={`${nome} pode comandar a Poli`} checked={p.podeComandar} disabled={travada} onChange={(v) => void mudar(p, { podeComandar: v })} />
                          </td>
                          <td>
                            <Switch semTexto rotulo={`${nome} pode conversar com a Poli`} checked={p.podeConversar} disabled={travada} onChange={(v) => void mudar(p, { podeConversar: v })} />
                          </td>
                          <td className="num">{numero(p.mensagens)}</td>
                          {ehAdmin && (
                            <td>
                              {propria ? (
                                <span className="suave">—</span>
                              ) : (
                                <div className="acoes">
                                  <button type="button" className="btn" onClick={() => setUnindo(p)} aria-label={`Unir ${nome} a outra pessoa`}>
                                    Unir…
                                  </button>
                                  <label className="robo-campo">
                                    <input type="checkbox" checked={p.tipoConta === 'robo'} onChange={(e) => void mudar(p, { robo: e.target.checked })} />
                                    Robô
                                  </label>
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {unindo && dados && (
        <DialogoUnir
          origem={unindo}
          candidatos={dados.filter((x) => x.id !== unindo.id && x.tipoConta !== 'esta_poli')}
          ocupado={ocupado}
          aoUnir={(paraId) => void unir(unindo, paraId)}
          aoFechar={() => setUnindo(null)}
        />
      )}
    </>
  );
}

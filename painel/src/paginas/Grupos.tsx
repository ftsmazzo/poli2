import { useState } from 'react';
import { api, mensagemDeErro, type Grupo } from '../api';
import { Aviso, Carregando, ErroCarga, Vazio } from '../components/Estados';
import { Quando } from '../components/Quando';
import { Switch } from '../components/Switch';
import { numero } from '../format';
import { useCarregar } from '../hooks';

export const INTERVALOS = [5, 15, 30, 60, 120, 360, 1440];

function rotuloIntervalo(min: number): string {
  if (min < 60) return `${min} minutos`;
  if (min === 60) return '1 hora';
  if (min < 1440) return `${min / 60} horas`;
  return '1 dia';
}

export function Grupos() {
  const { dados, erro, carregando, recarregar, definir } = useCarregar(api.grupos);
  const [aviso, setAviso] = useState<string | null>(null);

  // Salva ao mudar: atualiza a tela na hora e desfaz se o servidor recusar.
  async function mudar(g: Grupo, patch: { acompanhar?: boolean; intervaloMin?: number; grupoDosHeads?: boolean }) {
    const antes = { acompanhar: g.acompanhar, intervaloMin: g.intervaloMin, grupoDosHeads: g.grupoDosHeads };
    setAviso(null);
    definir((l) => l && l.map((x) => (x.id === g.id ? { ...x, ...patch } : x)));
    try {
      await api.editarGrupo(g.id, patch);
    } catch (e) {
      definir((l) => l && l.map((x) => (x.id === g.id ? { ...x, ...antes } : x)));
      setAviso(`Não salvei a mudança em "${g.nome}": ${mensagemDeErro(e)}`);
    }
  }

  return (
    <>
      <div className="titulo-pagina">
        <h1>Grupos</h1>
        <button type="button" className="btn" onClick={recarregar}>
          Atualizar
        </button>
      </div>
      <p className="ajuda">Ligue &quot;Acompanhar&quot; para a Poli ler o grupo de tempos em tempos, resumir e alertar os Heads quando algo for importante. Ao ligar, ela faz um resumo inicial das últimas 24 horas (sem gerar alerta, e você o vê em Diagnóstico) e depois lê só o que chegar. Os alertas vão para o privado de cada pessoa marcada como Head em Pessoas e para o grupo marcado como &quot;Grupo dos Heads&quot; (só o administrador escolhe). As mudanças são salvas na hora.</p>
      {aviso && <Aviso aoFechar={() => setAviso(null)}>{aviso}</Aviso>}
      {carregando && !dados && <Carregando />}
      {erro && <ErroCarga mensagem={erro} aoTentar={recarregar} />}
      {dados && dados.length === 0 && (
        <Vazio titulo="Nenhum grupo ainda">
          <p>Os grupos aparecem aqui assim que a Poli recebe mensagens deles pelo WhatsApp.</p>
        </Vazio>
      )}
      {dados && dados.length > 0 && (
        <div className="cartao sem-padding">
          <div className="rolagem">
            <table>
              <thead>
                <tr>
                  <th scope="col">Grupo</th>
                  <th scope="col" className="num">
                    Mensagens
                  </th>
                  <th scope="col">Última mensagem</th>
                  <th scope="col">Última leitura</th>
                  <th scope="col">Histórico</th>
                  <th scope="col">Acompanhar</th>
                  <th scope="col">Lê a cada</th>
                  <th scope="col">Grupo dos Heads</th>
                </tr>
              </thead>
              <tbody>
                {dados.map((g) => {
                  const opcoes = INTERVALOS.includes(g.intervaloMin) ? INTERVALOS : [...INTERVALOS, g.intervaloMin].sort((a, b) => a - b);
                  return (
                    <tr key={g.id}>
                      <th scope="row">{g.nome}</th>
                      <td className="num">{numero(g.mensagens)}</td>
                      <td>
                        <Quando iso={g.ultimaMensagemEm} vazio="sem mensagens" />
                      </td>
                      <td>
                        <Quando iso={g.ultimaLeituraEm} vazio="ainda não" />
                      </td>
                      <td>
                        <Quando iso={g.historicoImportadoEm} vazio="não" />
                      </td>
                      <td>
                        <Switch semTexto rotulo={`Acompanhar o grupo ${g.nome}`} checked={g.acompanhar} onChange={(v) => void mudar(g, { acompanhar: v })} />
                      </td>
                      <td>
                        <select aria-label={`Intervalo de leitura do grupo ${g.nome}`} value={g.intervaloMin} onChange={(e) => void mudar(g, { intervaloMin: Number(e.target.value) })}>
                          {opcoes.map((m) => (
                            <option key={m} value={m}>
                              {rotuloIntervalo(m)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <Switch semTexto rotulo={`Usar o grupo ${g.nome} como Grupo dos Heads, que recebe os alertas`} checked={g.grupoDosHeads} onChange={(v) => void mudar(g, { grupoDosHeads: v })} />
                      </td>
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

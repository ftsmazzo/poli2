import { api } from '../api';
import { Carregando, ErroCarga, Vazio } from '../components/Estados';
import { IconeAviso, IconeInfo, IconeOk, IconeRelogio } from '../components/Icones';
import { Quando } from '../components/Quando';
import { useCarregar } from '../hooks';

function Severidade({ n }: { n: number }) {
  if (n >= 3)
    return (
      <span className="pilula pilula-erro">
        <IconeAviso /> Alta ({n})
      </span>
    );
  if (n === 2)
    return (
      <span className="pilula pilula-media">
        <IconeAviso /> Média ({n})
      </span>
    );
  return (
    <span className="pilula pilula-nunca">
      <IconeInfo /> Baixa ({n})
    </span>
  );
}

export function Alertas() {
  const { dados, erro, carregando, recarregar } = useCarregar(api.alertas);
  return (
    <>
      <div className="titulo-pagina">
        <h1>Alertas</h1>
        <button type="button" className="btn" onClick={recarregar}>
          Atualizar
        </button>
      </div>
      <p className="ajuda">Os 100 alertas mais recentes. Alertas pendentes ainda não foram entregues no WhatsApp e serão tentados de novo.</p>
      {carregando && !dados && <Carregando />}
      {erro && <ErroCarga mensagem={erro} aoTentar={recarregar} />}
      {dados && dados.length === 0 && (
        <Vazio titulo="Nenhum alerta por enquanto">
          <p>
            Os alertas aparecem aqui quando o acompanhamento de grupos for ligado. Vá em <strong>Grupos</strong>, ligue &quot;Acompanhar&quot; nos grupos que importam e defina de quanto em quanto tempo a Poli deve ler.
          </p>
        </Vazio>
      )}
      {dados && dados.length > 0 && (
        <div className="cartao sem-padding">
          <div className="rolagem">
            <table>
              <thead>
                <tr>
                  <th scope="col">Severidade</th>
                  <th scope="col">Alerta</th>
                  <th scope="col">Grupo</th>
                  <th scope="col">Quando</th>
                  <th scope="col">Envio</th>
                </tr>
              </thead>
              <tbody>
                {dados.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Severidade n={a.severidade} />
                    </td>
                    <td className="celula-texto">{a.texto}</td>
                    <td>{a.grupo ?? <span className="suave">—</span>}</td>
                    <td>
                      <Quando iso={a.criadoEm} />
                    </td>
                    <td>
                      {a.enviadoEm ? (
                        <span className="pilula pilula-ok" title="Enviado">
                          <IconeOk /> Enviado <Quando iso={a.enviadoEm} />
                        </span>
                      ) : (
                        <span className="pilula pilula-media">
                          <IconeRelogio /> Pendente
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

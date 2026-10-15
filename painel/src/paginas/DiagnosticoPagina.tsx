import { useDiagnostico, problemasDoDiagnostico } from '../diagnosticoCtx';
import { Carregando, ErroCarga } from '../components/Estados';
import { IconeErro, IconeOk } from '../components/Icones';
import { Quando } from '../components/Quando';
import { StatusPill } from '../components/StatusPill';
import { dataRelativa, numero, textoDeFerramentas } from '../format';
import type { Diagnostico } from '../api';

function SimNao({ valor }: { valor: boolean }) {
  return valor ? (
    <span className="pilula pilula-ok">
      <IconeOk /> Sim
    </span>
  ) : (
    <span className="pilula pilula-erro">
      <IconeErro /> Não
    </span>
  );
}

const NIVEL = ['Nada de novo', 'Registrar', 'Importante', 'Urgente'];

type Tom = 'ok' | 'erro' | 'neutro';

function Ficha({ rotulo, valor, tom }: { rotulo: string; valor: string; tom: Tom }) {
  return (
    <li className={`ficha ficha-${tom}`}>
      <span className="ficha-ponto" aria-hidden="true" />
      <span className="ficha-rotulo">{rotulo}</span>
      <strong>{valor}</strong>
    </li>
  );
}

// A frase de estado é o que o Head quer saber primeiro: está no ar ou não, e o que fazer.
function EstadoGeral({ d }: { d: Diagnostico }) {
  const problemas = problemasDoDiagnostico(d);
  const ok = problemas.length === 0;
  const fontesAtivas = d.fontes.filter((f) => f.ativa);
  const fontesOk = fontesAtivas.filter((f) => f.status === 'ok').length;
  const grupos = d.alertas?.gruposAcompanhados ?? 0;
  const ultima = d.ultimasLeituras?.[0]?.criadoEm ?? null;
  const conectado = d.instancia?.estadoConexao === 'open';

  return (
    <section className={`estado-geral ${ok ? 'estado-geral-ok' : 'estado-geral-atencao'}`} aria-labelledby="estado-geral-titulo">
      <div className="estado-geral-texto">
        <h2 id="estado-geral-titulo">{ok ? 'Tudo no ar.' : problemas.length === 1 ? 'Um ponto pede atenção.' : `${problemas.length} pontos pedem atenção.`}</h2>
        {ok ? (
          <p>
            A Poli está conectada ao WhatsApp{grupos > 0 ? ` e acompanhando ${grupos} ${grupos === 1 ? 'grupo' : 'grupos'}` : ''}.
            {grupos === 0 && ' Nenhum grupo está sendo acompanhado: ligue em Grupos para ela resumir e alertar.'}
          </p>
        ) : (
          <ul className="estado-geral-problemas">
            {problemas.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <ul className="fichas" aria-label="Resumo do estado">
        <Ficha rotulo="WhatsApp" valor={!d.instancia ? 'Sem número' : conectado ? 'Conectado' : d.instancia.estadoConexao ? 'Desconectado' : 'Não verificado'} tom={conectado ? 'ok' : 'erro'} />
        <Ficha
          rotulo="Fontes"
          valor={fontesAtivas.length === 0 ? 'Nenhuma ativa' : `${fontesOk} de ${fontesAtivas.length} funcionando`}
          tom={fontesAtivas.length === 0 ? 'neutro' : fontesOk === fontesAtivas.length ? 'ok' : 'erro'}
        />
        <Ficha rotulo="Fila de alertas" valor={d.alertas ? `${numero(d.alertas.pendentesDeEnvio)} para enviar` : '—'} tom={d.alertas && (d.alertas.semDestino > 0 || d.alertas.falhasDeEnvio > 0) ? 'erro' : 'neutro'} />
        <Ficha rotulo="Última leitura" valor={ultima ? dataRelativa(ultima) : 'ainda não'} tom="neutro" />
      </ul>
    </section>
  );
}

export function DiagnosticoPagina() {
  const { diagnostico: d, erro, carregando, recarregar } = useDiagnostico();

  return (
    <>
      <div className="titulo-pagina">
        <div>
          <h1>Diagnóstico</h1>
          <p className="subtitulo">Se a Poli está no ar, o que ela leu por último e o que respondeu.</p>
        </div>
        <button type="button" className="btn" onClick={recarregar}>
          Atualizar
        </button>
      </div>
      {!d && carregando && <Carregando />}
      {!d && !carregando && erro && <ErroCarga mensagem={erro} aoTentar={recarregar} />}
      {d && (
        <>
          {erro && (
            <p className="aviso aviso-erro" role="alert">
              Não consegui atualizar agora ({erro}). Os dados abaixo podem estar desatualizados.
            </p>
          )}

          <EstadoGeral d={d} />

          <dl className="numeros" aria-label="Totais gravados">
            <div>
              <dt>Mensagens gravadas</dt>
              <dd>{numero(d.totais.mensagens)}</dd>
            </div>
            <div>
              <dt>Links, contatos e endereços</dt>
              <dd>{numero(d.totais.itens)}</dd>
            </div>
            <div>
              <dt>Grupos</dt>
              <dd>{numero(d.totais.grupos)}</dd>
            </div>
            <div>
              <dt>Pessoas</dt>
              <dd>{numero(d.totais.pessoas)}</dd>
            </div>
          </dl>

          {d.ultimasLeituras && (
            <section className="cartao" aria-labelledby="d-leituras">
              <h2 id="d-leituras">O que a Poli leu nos grupos</h2>
              {d.ultimasLeituras.length === 0 ? (
                <p className="suave">
                  Nenhuma leitura ainda. Ligue &quot;Acompanhar&quot; em Grupos: a Poli faz um resumo inicial das últimas 24 horas e depois lê o que chegar a cada intervalo.
                </p>
              ) : (
                <ol className="leituras">
                  {d.ultimasLeituras.map((l, i) => (
                    <li key={`${l.criadoEm}-${i}`} className={`leitura nivel-${Math.min(Math.max(l.importancia, 0), 3)}`}>
                      <div className="leitura-topo">
                        <span className="leitura-nivel">{NIVEL[l.importancia] ?? l.importancia}</span>
                        <span className="leitura-grupo">{l.grupo ?? 'sem nome'}</span>
                        <span className="leitura-quando suave">
                          <Quando iso={l.criadoEm} vazio="" />
                        </span>
                      </div>
                      <p>{l.resumo}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}

          <div className="grade">
            <section className="cartao" aria-labelledby="d-inst">
              <h2 id="d-inst">Número do WhatsApp</h2>
              {d.instancia ? (
                <dl className="lista-def">
                  <dt>Instância</dt>
                  <dd>{d.instancia.nome}</dd>
                  <dt>Nome do perfil</dt>
                  <dd>{d.instancia.nomePerfil ?? <span className="suave">não informado</span>}</dd>
                  <dt>Número</dt>
                  <dd>
                    <SimNao valor={d.instancia.numeroConhecido} />
                  </dd>
                  <dt>LID</dt>
                  <dd>
                    <SimNao valor={d.instancia.lidConhecido} />
                  </dd>
                  <dt>Conexão</dt>
                  <dd>
                    {d.instancia.estadoConexao === 'open' ? (
                      <span className="pilula pilula-ok">
                        <IconeOk /> Conectado
                      </span>
                    ) : d.instancia.estadoConexao ? (
                      <span className="pilula pilula-erro">
                        <IconeErro /> Desconectado ({d.instancia.estadoConexao})
                      </span>
                    ) : (
                      <span className="suave">ainda não verificada</span>
                    )}
                  </dd>
                </dl>
              ) : (
                <p>
                  <span className="pilula pilula-erro">
                    <IconeErro /> Sem instância
                  </span>{' '}
                  Nenhum número de WhatsApp está ligado a este workspace.
                </p>
              )}
            </section>

            <section className="cartao" aria-labelledby="d-mid">
              <h2 id="d-mid">Mídia e extração</h2>
              <dl className="lista-def">
                <dt>Mídias pendentes</dt>
                <dd>{numero(d.midias.pendentes)}</dd>
                <dt>Mídias com falha</dt>
                <dd>
                  {numero(d.midias.falhas)}
                  {d.midias.falhas > 0 && (
                    <>
                      {' '}
                      <span className="pilula pilula-erro">
                        <IconeErro /> Atenção
                      </span>
                    </>
                  )}
                </dd>
                <dt>Extração pendente</dt>
                <dd>{numero(d.extracaoPendente)} mensagens</dd>
              </dl>
            </section>

            {d.alertas && (
              <section className="cartao" aria-labelledby="d-alertas">
                <h2 id="d-alertas">Alertas aos Heads</h2>
                <dl className="lista-def">
                  <dt>Grupos acompanhados</dt>
                  <dd>{numero(d.alertas.gruposAcompanhados)}</dd>
                  <dt>Envios esperando</dt>
                  <dd>{numero(d.alertas.pendentesDeEnvio)}</dd>
                  <dt>Sem destino</dt>
                  <dd>{numero(d.alertas.semDestino)}</dd>
                  <dt>Envios que falharam</dt>
                  <dd>{numero(d.alertas.falhasDeEnvio)}</dd>
                </dl>
              </section>
            )}
          </div>

          <section className="cartao sem-padding" aria-labelledby="d-fontes">
            <h2 id="d-fontes" className="titulo-cartao">
              Fontes
            </h2>
            {d.fontes.length === 0 ? (
              <p className="suave corpo-cartao">Nenhuma Fonte cadastrada ainda.</p>
            ) : (
              <div className="rolagem">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Nome</th>
                      <th scope="col">Estado</th>
                      <th scope="col">Ativa</th>
                      <th scope="col">Último teste</th>
                      <th scope="col" className="num">
                        Resposta
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.fontes.map((f) => (
                      <tr key={f.id}>
                        <th scope="row">{f.nome}</th>
                        <td>
                          <StatusPill status={f.status} />
                          {f.status === 'erro' && f.ultimoErro && <div className="erro-texto">{f.ultimoErro}</div>}
                        </td>
                        <td>{f.ativa ? 'Sim' : 'Não'}</td>
                        <td>
                          <Quando iso={f.ultimoTesteEm} vazio="nunca" />
                        </td>
                        <td className="num">{f.latenciaMs !== null ? `${numero(f.latenciaMs)} ms` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="cartao sem-padding" aria-labelledby="d-turnos">
            <h2 id="d-turnos" className="titulo-cartao">
              Últimas perguntas à Poli
            </h2>
            {d.ultimosTurnos.length === 0 ? (
              <p className="suave corpo-cartao">A Poli ainda não respondeu a nenhuma pergunta.</p>
            ) : (
              <div className="rolagem">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Quando</th>
                      <th scope="col">Pergunta</th>
                      <th scope="col">Ferramentas</th>
                      <th scope="col" className="num">
                        Tempo
                      </th>
                      <th scope="col">Respondida</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.ultimosTurnos.map((t, i) => (
                      <tr key={`${t.quando}-${i}`}>
                        <td>
                          <Quando iso={t.quando} />
                        </td>
                        <td className="celula-texto">{t.pergunta ?? <span className="suave">—</span>}</td>
                        <td className="celula-ferr">{textoDeFerramentas(t.ferramentas) || <span className="suave">nenhuma</span>}</td>
                        <td className="num">{t.latenciaMs !== null ? `${(t.latenciaMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : '—'}</td>
                        <td>
                          <SimNao valor={t.respondido} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

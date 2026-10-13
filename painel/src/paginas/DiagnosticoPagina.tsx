import { useDiagnostico } from '../diagnosticoCtx';
import { Carregando, ErroCarga } from '../components/Estados';
import { IconeErro, IconeOk } from '../components/Icones';
import { Quando } from '../components/Quando';
import { StatusPill } from '../components/StatusPill';
import { numero, textoDeFerramentas } from '../format';

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

export function DiagnosticoPagina() {
  const { diagnostico: d, erro, carregando, recarregar } = useDiagnostico();

  return (
    <>
      <div className="titulo-pagina">
        <h1>Diagnóstico</h1>
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
          <div className="grade">
            <section className="cartao" aria-labelledby="d-inst">
              <h2 id="d-inst">Instância do WhatsApp</h2>
              {d.instancia ? (
                <dl className="lista-def">
                  <dt>Nome da instância</dt>
                  <dd>{d.instancia.nome}</dd>
                  <dt>Nome do perfil</dt>
                  <dd>{d.instancia.nomePerfil ?? <span className="suave">não informado</span>}</dd>
                  <dt>Número conhecido</dt>
                  <dd>
                    <SimNao valor={d.instancia.numeroConhecido} />
                  </dd>
                  <dt>LID conhecido</dt>
                  <dd>
                    <SimNao valor={d.instancia.lidConhecido} />
                  </dd>
                  <dt>Conexão com o WhatsApp</dt>
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

            <section className="cartao" aria-labelledby="d-tot">
              <h2 id="d-tot">Totais</h2>
              <dl className="lista-def">
                <dt>Mensagens</dt>
                <dd>{numero(d.totais.mensagens)}</dd>
                <dt>Itens extraídos</dt>
                <dd>{numero(d.totais.itens)}</dd>
                <dt>Grupos</dt>
                <dd>{numero(d.totais.grupos)}</dd>
                <dt>Pessoas</dt>
                <dd>{numero(d.totais.pessoas)}</dd>
              </dl>
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
                  <dt>Alertas sem destino</dt>
                  <dd>{numero(d.alertas.semDestino)}</dd>
                  <dt>Envios que falharam</dt>
                  <dd>{numero(d.alertas.falhasDeEnvio)}</dd>
                </dl>
              </section>
            )}
          </div>

          {d.ultimasLeituras && (
            <section className="cartao" aria-labelledby="d-leituras">
              <h2 id="d-leituras">Últimas leituras dos grupos</h2>
              {d.ultimasLeituras.length === 0 ? (
                <p className="suave">
                  Nenhuma leitura ainda. Ligue &quot;Acompanhar&quot; em Grupos: a Poli faz um resumo inicial das últimas 24 horas e depois lê o que chegar a cada intervalo.
                </p>
              ) : (
                <div className="rolagem">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Grupo</th>
                        <th scope="col">Quando</th>
                        <th scope="col">Importância</th>
                        <th scope="col">O que a Poli concluiu</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.ultimasLeituras.map((l, i) => (
                        <tr key={`${l.criadoEm}-${i}`}>
                          <th scope="row">{l.grupo ?? 'sem nome'}</th>
                          <td>
                            <Quando iso={l.criadoEm} vazio="" />
                          </td>
                          <td>{['0 · nada de novo', '1 · registrar', '2 · importante', '3 · urgente'][l.importancia] ?? l.importancia}</td>
                          <td>{l.resumo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section className="cartao" aria-labelledby="d-fontes">
            <h2 id="d-fontes">Fontes</h2>
            {d.fontes.length === 0 ? (
              <p className="suave">Nenhuma Fonte cadastrada ainda.</p>
            ) : (
              <div className="rolagem">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Nome</th>
                      <th scope="col">Status</th>
                      <th scope="col">Ativa</th>
                      <th scope="col">Último teste</th>
                      <th scope="col">Latência</th>
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
                        <td>{f.latenciaMs !== null ? `${numero(f.latenciaMs)} ms` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="cartao" aria-labelledby="d-turnos">
            <h2 id="d-turnos">Últimos turnos da Poli</h2>
            {d.ultimosTurnos.length === 0 ? (
              <p className="suave">A Poli ainda não respondeu a nenhuma pergunta.</p>
            ) : (
              <div className="rolagem">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Quando</th>
                      <th scope="col">Pergunta</th>
                      <th scope="col">Ferramentas</th>
                      <th scope="col">Latência</th>
                      <th scope="col">Respondido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.ultimosTurnos.map((t, i) => (
                      <tr key={`${t.quando}-${i}`}>
                        <td>
                          <Quando iso={t.quando} />
                        </td>
                        <td className="celula-texto">{t.pergunta ?? <span className="suave">—</span>}</td>
                        <td>{textoDeFerramentas(t.ferramentas) || <span className="suave">nenhuma</span>}</td>
                        <td>{t.latenciaMs !== null ? `${numero(t.latenciaMs)} ms` : '—'}</td>
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

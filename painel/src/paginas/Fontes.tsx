import { useState, type FormEvent } from 'react';
import { ApiError, api, mensagemDeErro, type Ferramenta, type Fonte, type ResultadoTeste } from '../api';
import { Confirmar, Dialogo } from '../components/Dialogo';
import { Aviso, Carregando, ErroCarga, Spinner, Vazio } from '../components/Estados';
import { IconeAviso } from '../components/Icones';
import { Quando } from '../components/Quando';
import { StatusPill } from '../components/StatusPill';
import { Switch } from '../components/Switch';
import { numero } from '../format';
import { useCarregar } from '../hooks';
import { useSessao } from '../sessao';

// ---------- Formulário (gaveta) ----------

// Um MCP pode ter várias ferramentas (urna, checagem de boato...), e este texto explica todas.
const LIMITE_QUANDO_USAR = 2500;

function FormularioFonte({ fonte, aoSalvar, aoFechar }: { fonte: Fonte | null; aoSalvar: (f: Fonte) => void; aoFechar: () => void }) {
  const editando = fonte !== null;
  const [nome, setNome] = useState(fonte?.nome ?? '');
  const [url, setUrl] = useState(fonte?.url ?? '');
  const [segredo, setSegredo] = useState('');
  const [removerSegredo, setRemoverSegredo] = useState(false);
  const [headerNome, setHeaderNome] = useState(fonte?.headerNome ?? '');
  const [quandoUsar, setQuandoUsar] = useState(fonte?.quandoUsar ?? '');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [erroCampo, setErroCampo] = useState<{ nome?: string; url?: string }>({});

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const campos: { nome?: string; url?: string } = {};
    if (!nome.trim()) campos.nome = 'Informe um nome.';
    if (!/^https?:\/\/\S+$/i.test(url.trim())) campos.url = 'Informe o endereço completo, começando com https://';
    setErroCampo(campos);
    if (campos.nome || campos.url) return;

    setSalvando(true);
    setErro(null);
    try {
      let salva: Fonte;
      if (editando) {
        const patch: Parameters<typeof api.editarFonte>[1] = { nome: nome.trim(), url: url.trim(), quandoUsar: quandoUsar.trim() };
        if (headerNome.trim()) patch.headerNome = headerNome.trim();
        if (segredo) patch.segredo = segredo;
        else if (removerSegredo) patch.segredo = '';
        salva = await api.editarFonte(fonte.id, patch);
      } else {
        salva = await api.criarFonte({
          nome: nome.trim(),
          url: url.trim(),
          quandoUsar: quandoUsar.trim(),
          ...(segredo ? { segredo } : {}),
          ...(headerNome.trim() ? { headerNome: headerNome.trim() } : {}),
        });
      }
      aoSalvar(salva);
    } catch (e2) {
      setErro(mensagemDeErro(e2));
      if (e2 instanceof ApiError && e2.codigo === 'nome_ja_existe') setErroCampo({ nome: 'Já existe uma Fonte com esse nome.' });
      if (e2 instanceof ApiError && e2.codigo === 'url_invalida') setErroCampo({ url: 'Endereço inválido.' });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialogo
      titulo={editando ? `Editar Fonte: ${fonte.nome}` : 'Nova Fonte'}
      aoFechar={aoFechar}
      rodape={
        <>
          <button type="button" className="btn" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="submit" form="form-fonte" className="btn btn-primario" disabled={salvando}>
            {salvando ? 'Salvando…' : editando ? 'Salvar' : 'Criar Fonte'}
          </button>
        </>
      }
    >
      <form id="form-fonte" onSubmit={(e) => void enviar(e)} noValidate autoComplete="off">
        {erro && (
          <p className="aviso aviso-erro" role="alert">
            {erro}
          </p>
        )}
        <div className="campo">
          <label htmlFor="f-nome">Nome</label>
          <input id="f-nome" value={nome} maxLength={80} onChange={(e) => setNome(e.target.value)} aria-invalid={!!erroCampo.nome} aria-describedby={erroCampo.nome ? 'f-nome-e' : undefined} required />
          {erroCampo.nome && (
            <p id="f-nome-e" className="erro-texto">
              {erroCampo.nome}
            </p>
          )}
        </div>
        <div className="campo">
          <label htmlFor="f-url">URL do MCP</label>
          <input id="f-url" type="url" value={url} maxLength={500} placeholder="https://servidor.exemplo.com/mcp" onChange={(e) => setUrl(e.target.value)} aria-invalid={!!erroCampo.url} aria-describedby={erroCampo.url ? 'f-url-e' : undefined} required />
          {erroCampo.url && (
            <p id="f-url-e" className="erro-texto">
              {erroCampo.url}
            </p>
          )}
        </div>
        <div className="campo">
          <label htmlFor="f-segredo">Token / segredo</label>
          <input id="f-segredo" type="password" value={segredo} autoComplete="new-password" maxLength={2000} placeholder={editando && fonte.temSegredo ? 'Deixe vazio para manter o segredo atual' : 'Opcional'} onChange={(e) => setSegredo(e.target.value)} aria-describedby="f-segredo-a" />
          <p id="f-segredo-a" className="ajuda-campo">
            Guardado cifrado no servidor e nunca mostrado de novo.
            {editando && fonte.temSegredo && !removerSegredo && ' Esta Fonte já tem um segredo guardado.'}
            {removerSegredo && ' O segredo será removido ao salvar.'}
          </p>
          {editando && fonte.temSegredo && (
            <button type="button" className="btn btn-sutil" onClick={() => { setRemoverSegredo((v) => !v); setSegredo(''); }}>
              {removerSegredo ? 'Desfazer remoção do segredo' : 'Remover segredo'}
            </button>
          )}
        </div>
        <div className="campo">
          <label htmlFor="f-header">Nome do cabeçalho (opcional)</label>
          <input id="f-header" value={headerNome} maxLength={60} placeholder="Authorization" onChange={(e) => setHeaderNome(e.target.value)} />
          <p className="ajuda-campo">Cabeçalho HTTP que leva o segredo. Se vazio, usa Authorization.</p>
        </div>
        <div className="campo">
          <label htmlFor="f-quando">Quando usar</label>
          <textarea id="f-quando" rows={8} maxLength={LIMITE_QUANDO_USAR} value={quandoUsar} placeholder="Ex.: perguntas sobre resultados e votos de eleições passadas" onChange={(e) => setQuandoUsar(e.target.value)} />
          <p className="ajuda-campo">Ajuda a Poli a escolher esta Fonte em vez de outra. {quandoUsar.length}/{LIMITE_QUANDO_USAR}</p>
        </div>
      </form>
    </Dialogo>
  );
}

// ---------- Cartão de uma Fonte ----------

interface CartaoProps {
  fonte: Fonte;
  ehAdmin: boolean;
  aoAtualizar: (f: Fonte) => void;
  aoApagar: (id: number) => void;
  aoEditar: (f: Fonte) => void;
}

function CartaoFonte({ fonte, ehAdmin, aoAtualizar, aoApagar, aoEditar }: CartaoProps) {
  const [testando, setTestando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoTeste | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmarFerramenta, setConfirmarFerramenta] = useState<Ferramenta | null>(null);
  const [confirmarApagar, setConfirmarApagar] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  async function testar() {
    setTestando(true);
    setErro(null);
    setResultado(null);
    try {
      const r = await api.testarFonte(fonte.id);
      setResultado(r);
      aoAtualizar(r.fonte);
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setTestando(false);
    }
  }

  async function ligarFerramenta(f: Ferramenta, ativa: boolean) {
    setOcupado(true);
    setErro(null);
    try {
      await api.ligarFerramenta(fonte.id, f.nome, ativa);
      aoAtualizar({ ...fonte, ferramentas: fonte.ferramentas.map((x) => (x.nome === f.nome ? { ...x, ativa } : x)) });
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
      setConfirmarFerramenta(null);
    }
  }

  function aoMudarFerramenta(f: Ferramenta, ativa: boolean) {
    // Ligar uma ferramenta que pode alterar dados exige confirmação explícita.
    if (ativa && !f.somenteLeitura) setConfirmarFerramenta(f);
    else void ligarFerramenta(f, ativa);
  }

  async function alternarAtiva(ativa: boolean) {
    setErro(null);
    try {
      aoAtualizar(await api.editarFonte(fonte.id, { ativa }));
    } catch (e) {
      setErro(mensagemDeErro(e));
    }
  }

  async function apagar() {
    setOcupado(true);
    try {
      await api.apagarFonte(fonte.id);
      aoApagar(fonte.id);
    } catch (e) {
      setErro(mensagemDeErro(e));
      setConfirmarApagar(false);
    } finally {
      setOcupado(false);
    }
  }

  const idTitulo = `fonte-${fonte.id}-t`;
  return (
    <article className="cartao fonte" aria-labelledby={idTitulo}>
      <header className="fonte-topo">
        <div>
          <h2 id={idTitulo}>{fonte.nome}</h2>
          <p className="url">{fonte.url ?? 'sem endereço'}</p>
        </div>
        <div className="fonte-estado">
          <StatusPill status={fonte.status} />
          {ehAdmin ? (
            <Switch rotulo={`Fonte ${fonte.nome} ativa`} checked={fonte.ativa} textoLigado="Ativa" textoDesligado="Inativa" onChange={(v) => void alternarAtiva(v)} />
          ) : (
            <span>{fonte.ativa ? 'Ativa' : 'Inativa'}</span>
          )}
        </div>
      </header>

      <dl className="lista-def compacta">
        <dt>Latência</dt>
        <dd>{fonte.latenciaMs !== null ? `${numero(fonte.latenciaMs)} ms` : '—'}</dd>
        <dt>Último teste</dt>
        <dd>
          <Quando iso={fonte.ultimoTesteEm} vazio="nunca testada" />
        </dd>
        <dt>Segredo</dt>
        <dd>{fonte.temSegredo ? 'Guardado (não exibido)' : 'Nenhum'}</dd>
        {fonte.quandoUsar && (
          <>
            <dt>Quando usar</dt>
            <dd>{fonte.quandoUsar}</dd>
          </>
        )}
        {fonte.ultimoErro && (
          <>
            <dt>Último erro</dt>
            <dd className="erro-texto">{fonte.ultimoErro}</dd>
          </>
        )}
      </dl>

      {ehAdmin && (
        <div className="acoes">
          <button type="button" className="btn btn-primario" onClick={() => void testar()} disabled={testando}>
            {testando ? (
              <>
                <Spinner /> Testando…
              </>
            ) : (
              'Testar'
            )}
          </button>
          <button type="button" className="btn" onClick={() => aoEditar(fonte)}>
            Editar
          </button>
          <button type="button" className="btn btn-perigo-sutil" onClick={() => setConfirmarApagar(true)}>
            Apagar
          </button>
        </div>
      )}

      <div aria-live="polite" className="resultado-teste">
        {testando && <span className="suave">Testando a conexão…</span>}
        {resultado &&
          (resultado.ok ? (
            <p className="aviso aviso-ok">
              Conexão ok em {numero(resultado.latenciaMs)} ms. {resultado.ferramentas === 1 ? '1 ferramenta encontrada.' : `${numero(resultado.ferramentas)} ferramentas encontradas.`}
            </p>
          ) : (
            <p className="aviso aviso-erro">Falhou em {numero(resultado.latenciaMs)} ms: {resultado.erro ?? 'erro desconhecido'}</p>
          ))}
      </div>
      {erro && (
        <p className="aviso aviso-erro" role="alert">
          {erro}
        </p>
      )}

      <section aria-label={`Ferramentas da Fonte ${fonte.nome}`} className="ferramentas">
        <h3>Ferramentas ({fonte.ferramentas.length})</h3>
        {fonte.ferramentas.length === 0 ? (
          <p className="suave">Nenhuma ferramenta descoberta ainda. Use &quot;Testar&quot; para conectar e listar o que a Fonte oferece.</p>
        ) : (
          <ul>
            {fonte.ferramentas.map((f) => (
              <li key={f.nome}>
                <div className="ferr-info">
                  <code>{f.nome}</code>
                  {f.descricao && <p className="suave">{f.descricao}</p>}
                  {!f.somenteLeitura && (
                    <p className="alerta-escrita">
                      <IconeAviso /> Pode alterar dados
                    </p>
                  )}
                </div>
                <Switch
                  rotulo={`Ferramenta ${f.nome}`}
                  checked={f.ativa}
                  disabled={!ehAdmin || ocupado}
                  onChange={(v) => aoMudarFerramenta(f, v)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmarFerramenta && (
        <Confirmar
          titulo="Ligar ferramenta que altera dados?"
          rotuloConfirmar="Ligar mesmo assim"
          perigo
          ocupado={ocupado}
          aoCancelar={() => setConfirmarFerramenta(null)}
          aoConfirmar={() => void ligarFerramenta(confirmarFerramenta, true)}
          mensagem={
            <p>
              A ferramenta <code>{confirmarFerramenta.nome}</code> da Fonte <strong>{fonte.nome}</strong> pode alterar dados. Se você ligá-la, a Poli poderá usá-la quando achar útil. Tem certeza?
            </p>
          }
        />
      )}
      {confirmarApagar && (
        <Confirmar
          titulo="Apagar Fonte?"
          rotuloConfirmar="Apagar Fonte"
          perigo
          ocupado={ocupado}
          aoCancelar={() => setConfirmarApagar(false)}
          aoConfirmar={() => void apagar()}
          mensagem={
            <p>
              A Fonte <strong>{fonte.nome}</strong> e a lista das suas ferramentas serão apagadas. Não dá para desfazer.
            </p>
          }
        />
      )}
    </article>
  );
}

// ---------- Página ----------

export function Fontes() {
  const { ehAdmin } = useSessao();
  const { dados, erro, carregando, recarregar, definir } = useCarregar(api.fontes);
  const [gaveta, setGaveta] = useState<{ fonte: Fonte | null } | null>(null);

  const substituir = (f: Fonte) => definir((l) => l && l.map((x) => (x.id === f.id ? f : x)));

  return (
    <>
      <div className="titulo-pagina">
        <h1>Fontes</h1>
        <div className="acoes">
          <button type="button" className="btn" onClick={recarregar}>
            Atualizar
          </button>
          {ehAdmin && (
            <button type="button" className="btn btn-primario" onClick={() => setGaveta({ fonte: null })}>
              Nova Fonte
            </button>
          )}
        </div>
      </div>
      <p className="ajuda">Uma Fonte é um servidor MCP que a Poli consulta para responder com dados de fora do WhatsApp. Ferramentas que podem alterar dados vêm desligadas.</p>
      {!ehAdmin && <Aviso tipo="info">Você pode ver as Fontes, mas só administradores podem criá-las ou alterá-las.</Aviso>}
      {carregando && !dados && <Carregando />}
      {erro && <ErroCarga mensagem={erro} aoTentar={recarregar} />}
      {dados && dados.length === 0 && (
        <Vazio titulo="Nenhuma Fonte cadastrada">
          <p>
            Uma Fonte conecta a Poli a um sistema externo. Exemplos: a <strong>urna</strong> (resultados de eleições), um <strong>RAG de fake news</strong> (checagem de boatos) ou a <strong>agenda</strong> da campanha.
          </p>
          <p>Você cadastra o endereço do servidor MCP (e o token, se houver), testa, e liga só as ferramentas que a Poli pode usar.</p>
          {ehAdmin && (
            <button type="button" className="btn btn-primario" onClick={() => setGaveta({ fonte: null })}>
              Cadastrar a primeira Fonte
            </button>
          )}
        </Vazio>
      )}
      {dados && dados.length > 0 && (
        <div className="pilha">
          {dados.map((f) => (
            <CartaoFonte
              key={f.id}
              fonte={f}
              ehAdmin={ehAdmin}
              aoAtualizar={substituir}
              aoApagar={(id) => definir((l) => l && l.filter((x) => x.id !== id))}
              aoEditar={(x) => setGaveta({ fonte: x })}
            />
          ))}
        </div>
      )}
      {gaveta && (
        <FormularioFonte
          fonte={gaveta.fonte}
          aoFechar={() => setGaveta(null)}
          aoSalvar={(f) => {
            definir((l) => {
              const lista = l ?? [];
              return lista.some((x) => x.id === f.id) ? lista.map((x) => (x.id === f.id ? f : x)) : [...lista, f];
            });
            setGaveta(null);
          }}
        />
      )}
    </>
  );
}

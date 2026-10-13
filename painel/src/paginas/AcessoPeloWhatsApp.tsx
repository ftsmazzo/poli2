export function AcessoPeloWhatsApp({ mensagem }: { mensagem?: string }) {
  return (
    <main className="tela-central">
      <section className="cartao cartao-central" aria-labelledby="t-acesso">
        <p className="marca">Poli 2.0</p>
        <h1 id="t-acesso">Acesso pelo WhatsApp</h1>
        {mensagem && (
          <p className="aviso aviso-erro" role="alert">
            {mensagem}
          </p>
        )}
        <p>Este painel não tem senha. O acesso vem por um link enviado pela Poli no seu WhatsApp.</p>
        <ol className="passos">
          <li>
            No grupo, escreva para a Poli: <strong>MapSolar painel</strong>
          </li>
          <li>Ela manda o link no seu privado.</li>
          <li>Toque no link para entrar. Ele vale 15 minutos e só pode ser usado uma vez.</li>
        </ol>
        <p className="suave">Só quem tem permissão para comandar a Poli recebe o link.</p>
      </section>
    </main>
  );
}

import { BrowserRouter, Route, Routes } from 'react-router';
import { Layout } from './Layout';
import { Alertas } from './paginas/Alertas';
import { DiagnosticoPagina } from './paginas/DiagnosticoPagina';
import { Entrar } from './paginas/Entrar';
import { Fontes } from './paginas/Fontes';
import { Grupos } from './paginas/Grupos';
import { Pessoas } from './paginas/Pessoas';
import { ProvedorSessao } from './sessao';

export function Rotas() {
  return (
    <Routes>
      <Route path="/entrar" element={<Entrar />} />
      <Route
        element={
          <ProvedorSessao>
            <Layout />
          </ProvedorSessao>
        }
      >
        <Route index element={<DiagnosticoPagina />} />
        <Route path="fontes" element={<Fontes />} />
        <Route path="grupos" element={<Grupos />} />
        <Route path="pessoas" element={<Pessoas />} />
        <Route path="alertas" element={<Alertas />} />
        <Route path="*" element={<DiagnosticoPagina />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Rotas />
    </BrowserRouter>
  );
}

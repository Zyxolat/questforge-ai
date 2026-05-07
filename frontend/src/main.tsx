import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CeloProvider, Alfajores } from '@celo/react-celo';
import App from './App';
import { WalletProvider } from './context/WalletContext';
import './styles/globals.css';

const networks = [Alfajores];
const app = document.getElementById('root') as HTMLElement;

ReactDOM.createRoot(app).render(
  <React.StrictMode>
    <CeloProvider dappName="QuestForge AI" networks={networks} defaultNetwork={Alfajores}>
      <WalletProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WalletProvider>
    </CeloProvider>
  </React.StrictMode>
);

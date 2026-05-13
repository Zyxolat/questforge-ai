import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { RealtimeProvider } from './context/RealtimeContext';
import { WalletProvider } from './context/WalletContext';
import './styles/globals.css';

const app = document.getElementById('root') as HTMLElement;

ReactDOM.createRoot(app).render(
  <React.StrictMode>
    <WalletProvider>
      <BrowserRouter>
        <RealtimeProvider>
          <App />
        </RealtimeProvider>
      </BrowserRouter>
    </WalletProvider>
  </React.StrictMode>
);

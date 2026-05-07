import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { Route, Routes, Link, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage';
import CommandCenter from './pages/CommandCenter';
import Leaderboards from './pages/Leaderboards';
import InventoryPage from './pages/InventoryPage';
import TavernPage from './pages/TavernPage';
import WalletModal from './components/WalletModal';
import { useWallet } from './context/WalletContext';

const links = [
  { to: '/', label: 'Home' },
  { to: '/command-center', label: 'Command Center' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/tavern', label: 'Tavern' }
];

function App() {
  const location = useLocation();
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const { address, status } = useWallet();

  return (
    <div className="min-h-screen bg-gradient-to-b from-deepnavy via-navy to-[#030610] text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-navy/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <div className="text-sm uppercase tracking-[0.35em] text-softyellow">QuestForge AI</div>
            <div className="text-2xl font-extrabold tracking-tight text-white">Forge Your Destiny Onchain</div>
          </div>
          <nav className="hidden items-center gap-4 md:flex">
            {links.map((item) => (
              <Link key={item.to} to={item.to} className="text-sm text-white/80 hover:text-glowyellow transition">
                {item.label}
              </Link>
            ))}
          </nav>
          <button
            onClick={() => setWalletModalOpen(true)}
            className="rounded-full border border-glowyellow/30 bg-glowyellow/10 px-4 py-2 text-sm font-semibold text-glowyellow transition hover:bg-glowyellow/15"
          >
            {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Connect Wallet'}
          </button>
        </div>
      </header>
      <WalletModal open={walletModalOpen} onClose={() => setWalletModalOpen(false)} />

      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<HomePage />} />
          <Route path="/command-center" element={<CommandCenter />} />
          <Route path="/leaderboard" element={<Leaderboards />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/tavern" element={<TavernPage />} />
        </Routes>
      </AnimatePresence>
    </div>
  );
}

export default App;

import { motion } from 'framer-motion';
import GlowButton from './GlowButton';
import { useWallet } from '../context/WalletContext';

interface WalletModalProps {
  open: boolean;
  onClose: () => void;
}

export default function WalletModal({ open, onClose }: WalletModalProps) {
  const { address, balance, network, status, connectWallet, disconnectWallet, switchCeloNetwork } = useWallet();
  if (!open) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="w-full max-w-md rounded-[2rem] border border-white/10 bg-navy/90 p-8 shadow-strong backdrop-blur-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Wallet Forge</p>
            <h2 className="mt-2 text-3xl font-bold text-white">Celo Connection</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">Close</button>
        </div>

        <div className="mt-6 space-y-4">
          <div className="rounded-3xl border border-white/10 bg-white/5 p-5 text-sm text-slate-200">
            <p className="text-xs uppercase tracking-[0.35em] text-glowyellow">Status</p>
            <p className="mt-2 text-lg font-semibold text-white">{status === 'connected' ? 'Connected' : status === 'unsupported' ? 'Unsupported Wallet' : 'Disconnected'}</p>
            <p className="mt-2 text-sm text-slate-400">Network: {network ?? 'Unknown'}</p>
            <p className="mt-2 text-sm text-slate-400">Balance: {balance} CELO</p>
            <p className="mt-2 text-sm text-slate-400">Address: {address ?? '---'}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <GlowButton label={address ? 'Disconnect' : 'Connect Wallet'} onClick={address ? disconnectWallet : connectWallet} />
            <GlowButton label="Switch to Celo" onClick={switchCeloNetwork} className="bg-white/10 text-white hover:bg-white/20" />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

import { motion } from 'framer-motion';
import { env } from '../lib/env';

type TxStatus = 'pending' | 'success' | 'error' | 'confirmed';

interface TransactionStatusCardProps {
  status: TxStatus;
  txHash?: string | null;
  label?: string;
  message?: string;
  onDismiss?: () => void;
}

export default function TransactionStatusCard({
  status,
  txHash,
  label,
  message,
  onDismiss
}: TransactionStatusCardProps) {
  const isPending = status === 'pending';
  const isSuccess = status === 'success' || status === 'confirmed';

  const explorerUrl = txHash ? `${env.CELO_EXPLORER_BASE_URL}/tx/${txHash}` : null;

  const bgColor = isSuccess ? 'from-emerald-500/20 to-green-600/20 border-emerald-500' : isPending ? 'from-amber-500/20 to-yellow-600/20 border-amber-500' : 'from-red-500/20 to-rose-600/20 border-red-500';

  const textColor = isSuccess ? 'text-emerald-300' : isPending ? 'text-amber-300' : 'text-red-300';

  const icon = isSuccess ? '✓' : isPending ? '⟳' : '✕';

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`rounded-2xl border-2 bg-gradient-to-r ${bgColor} p-4 shadow-lg`}
    >
      <div className="flex items-start gap-4">
        <motion.div
          animate={{ scale: isPending ? [1, 1.2, 1] : 1, rotate: isPending ? 360 : 0 }}
          transition={{ duration: isPending ? 1 : 0.3, repeat: isPending ? Infinity : 0 }}
          className={`text-2xl font-bold ${textColor}`}
        >
          {icon}
        </motion.div>

        <div className="flex-1">
          <p className={`font-bold uppercase tracking-[0.15em] ${textColor}`}>
            {label || (isSuccess ? 'Transaction Confirmed' : isPending ? 'Pending Confirmation' : 'Transaction Failed')}
          </p>
          {message && <p className="mt-1 text-sm text-slate-300">{message}</p>}
          {txHash && (
            <p className="mt-2 text-xs text-slate-400">
              TX Hash:{' '}
              <span className="font-mono">{txHash.slice(0, 16)}...{txHash.slice(-8)}</span>
            </p>
          )}
        </div>

        <motion.div className="flex gap-2">
          {explorerUrl && (
            <motion.a
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold uppercase text-white hover:bg-white/20 transition"
            >
              View
            </motion.a>
          )}
          {onDismiss && (
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={onDismiss}
              className="rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold uppercase text-white hover:bg-white/20 transition"
            >
              ✕
            </motion.button>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

import { motion } from 'framer-motion';
import { useState } from 'react';
import { claimDailyLoginBonus } from '../lib/api';
import { env } from '../lib/env';

interface DailyBonusData {
  amountCelo: string;
  txHash: string;
  dailyClaimStreak: number;
  totalClaimedCelo: number;
}

interface DailyLoginBonusProps {
  onBonusClaimed?: (data: DailyBonusData) => void;
}

export default function DailyLoginBonus({ onBonusClaimed }: DailyLoginBonusProps) {
  const [loading, setLoading] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bonusData, setBonusData] = useState<DailyBonusData | null>(null);

  const handleClaimBonus = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await claimDailyLoginBonus();
      if (response.data.success) {
        const data = response.data.reward as DailyBonusData;
        setBonusData(data);
        setClaimed(true);
        onBonusClaimed?.(data);

        // Show celebration animation
        setTimeout(() => {
          setClaimed(false);
        }, 5000);
      } else {
        setError(response.data.message || "You have already claimed today's reward. Come back tomorrow.");
      }
    } catch (err: unknown) {
      const responseError = err as { response?: { data?: { message?: string } } };
      const message = responseError.response?.data?.message || 'Failed to claim bonus. Try again tomorrow!';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (claimed && bonusData) {
    const explorerUrl = `${env.CELO_EXPLORER_BASE_URL}/tx/${bonusData.txHash}`;

    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <motion.div
          className="rounded-2xl border-2 border-glowyellow bg-gradient-to-b from-glowyellow/30 to-transparent p-8 text-center backdrop-blur-xl"
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 0.6, repeat: 2 }}
        >
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 0.8, repeat: Infinity }}
            className="mb-4 text-6xl"
          >
            🎁
          </motion.div>
          <h2 className="text-3xl font-black text-glowyellow">Daily Reward Claimed!</h2>
          <p className="mt-4 text-2xl font-bold text-white">+{bonusData.amountCelo} CELO</p>
          <p className="mt-2 text-lg text-slate-300">Streak: {bonusData.dailyClaimStreak} days</p>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block max-w-sm break-all text-xs text-green-300 underline decoration-green-300/40 underline-offset-4"
          >
            Tx: {bonusData.txHash}
          </a>
          <p className="mt-4 text-sm text-slate-400">Keep the streak alive!</p>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border-2 border-green-500/50 bg-gradient-to-r from-green-500/10 to-transparent p-6 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <p className="text-sm font-semibold uppercase tracking-[0.1em] text-green-400">Daily CELO Reward</p>
          <p className="mt-2 text-slate-300">Claim 0.0001 CELO once per UTC day and build your streak</p>
          {error && <p className="mt-2 text-sm text-amber-400">{error}</p>}
        </div>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={handleClaimBonus}
          disabled={loading}
          className="flex-shrink-0 rounded-full bg-gradient-to-r from-green-400 to-green-500 px-6 py-3 font-bold text-navy shadow-lg transition disabled:opacity-50 hover:shadow-xl"
        >
          {loading ? '...' : '📦 Claim Now'}
        </motion.button>
      </div>
    </motion.div>
  );
}

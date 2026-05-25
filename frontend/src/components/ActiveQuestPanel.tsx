import { motion } from 'framer-motion';
import { QuestState } from '../context/RealtimeContext';

interface ActiveQuestPanelProps {
  quest: QuestState | null;
  onStartQuest?: () => void;
  onSubmitProof?: () => void;
  loading?: boolean;
  disabled?: boolean;
}

export default function ActiveQuestPanel({
  quest,
  onStartQuest,
  onSubmitProof,
  loading = false,
  disabled = false
}: ActiveQuestPanelProps) {
  if (!quest) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="rounded-[2rem] border border-dashed border-white/20 bg-gradient-to-b from-white/5 to-transparent p-12 text-center"
      >
        <p className="text-lg text-slate-400">Generate your first quest to begin the adventure</p>
      </motion.div>
    );
  }

  const getDifficultyColor = (difficulty: number | string | undefined) => {
    const d = Number(difficulty);
    if (d === 5) return 'from-purple-500 to-pink-500';
    if (d === 4) return 'from-orange-500 to-red-500';
    if (d === 3) return 'from-blue-500 to-cyan-500';
    if (d === 2) return 'from-green-500 to-emerald-500';
    return 'from-yellow-500 to-amber-500';
  };

  const getRarityLabel = (difficulty: number | string | undefined) => {
    const d = Number(difficulty);
    if (d === 5) return 'Legendary';
    if (d === 4) return 'Epic';
    if (d === 3) return 'Rare';
    if (d === 2) return 'Uncommon';
    return 'Common';
  };

  const isAvailable = quest.status === 'AVAILABLE';
  const isActive = quest.status === 'ACTIVE';
  const isSubmitted = quest.status === 'SUBMITTED';
  const isVerified = quest.status === 'VERIFIED';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-[2.5rem] border-2 border-glowyellow/50 bg-gradient-to-br from-navy/80 via-deepnavy/60 to-navy/40 p-8 shadow-2xl backdrop-blur-xl"
    >
      {/* Animated background glow */}
      <motion.div
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 3, repeat: Infinity }}
        className={`absolute inset-0 bg-gradient-to-br ${getDifficultyColor(quest.difficulty)} opacity-10 blur-2xl`}
      />

      <div className="relative z-10 space-y-6">
        {/* Header with rarity */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={`mb-2 inline-block rounded-full bg-gradient-to-r ${getDifficultyColor(
                quest.difficulty
              )} px-4 py-1 text-xs font-bold uppercase tracking-[0.15em] text-white shadow-lg`}
            >
              {getRarityLabel(quest.difficulty)} • Tier {quest.difficulty}
            </motion.div>
            <h2 className="mt-3 text-4xl font-black text-white drop-shadow-lg">{quest.title || 'Quest'}</h2>
            <p className="mt-2 max-w-2xl text-lg text-slate-300">{quest.description}</p>
          </div>

          {/* Status badge */}
          <motion.div
            animate={{ scale: isSubmitted ? [1, 1.1, 1] : 1 }}
            transition={{ duration: 1, repeat: isSubmitted ? Infinity : 0 }}
            className={`rounded-2xl px-4 py-2 text-sm font-bold uppercase tracking-[0.2em] ${
              isVerified
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500'
                : isSubmitted
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500'
                  : isActive
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500'
                    : 'bg-glowyellow/20 text-glowyellow border border-glowyellow'
            }`}
          >
            {isVerified ? '✓ Verified' : isSubmitted ? '⟳ Verifying' : isActive ? '⚡ Active' : '◉ Available'}
          </motion.div>
        </div>

        {/* Lore section */}
        {quest.lore && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="rounded-2xl border border-white/10 bg-white/5 p-4 italic text-slate-300"
          >
            {quest.lore}
          </motion.div>
        )}

        {/* Objectives */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="space-y-3"
        >
          <h3 className="text-sm uppercase tracking-[0.25em] text-glowyellow">Objective</h3>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="font-semibold text-white">{quest.objective || 'Complete the quest objectives'}</p>
            {quest.requiredTxTypes && quest.requiredTxTypes.length > 0 && (
              <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                Transaction path: {quest.requiredTxTypes.join(' → ')}
              </p>
            )}
          </div>
        </motion.div>

        {/* Rewards preview */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="grid gap-3 sm:grid-cols-3"
        >
          <div className="rounded-2xl border border-glowyellow/30 bg-glowyellow/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Reward</p>
            <p className="mt-2 text-2xl font-bold text-glowyellow">{quest.rewardAmount || '?'} CELO</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">XP Earned</p>
            <p className="mt-2 text-2xl font-bold text-emerald-300">{quest.xpReward || '?'}</p>
          </div>
          <div className="rounded-2xl border border-purple-500/30 bg-purple-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-purple-300">NFT Rarity</p>
            <p className="mt-2 text-2xl font-bold text-purple-300">{getRarityLabel(quest.difficulty)}</p>
          </div>
        </motion.div>

        {/* Stake display if active */}
        {isActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-2xl border border-orange-500/30 bg-orange-500/10 p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-orange-300">Stake Locked</p>
                <p className="mt-1 text-xl font-bold text-orange-300">{quest.stakeAmount || '?'} CELO</p>
              </div>
              <p className="text-right text-sm text-slate-400">At risk during quest</p>
            </div>
          </motion.div>
        )}

        {/* Action buttons */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="flex gap-3 pt-4"
        >
          {isAvailable && onStartQuest && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={onStartQuest}
              disabled={loading || disabled}
              className="flex-1 rounded-2xl bg-gradient-to-r from-glowyellow to-softyellow px-6 py-4 font-bold uppercase tracking-[0.2em] text-navy shadow-lg hover:shadow-2xl transition-shadow disabled:opacity-50"
            >
              {loading ? 'Starting...' : 'Begin Quest'}
            </motion.button>
          )}

          {isActive && onSubmitProof && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={onSubmitProof}
              disabled={loading || disabled}
              className="flex-1 rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 px-6 py-4 font-bold uppercase tracking-[0.2em] text-white shadow-lg hover:shadow-2xl transition-shadow disabled:opacity-50"
            >
              {loading ? 'Submitting...' : 'Submit Proof'}
            </motion.button>
          )}

          {isSubmitted && (
            <motion.div
              animate={{ opacity: [0.6, 1, 0.6] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="flex-1 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-600 px-6 py-4 font-bold uppercase tracking-[0.2em] text-white text-center shadow-lg"
            >
              ⟳ Verifying...
            </motion.div>
          )}

          {isVerified && (
            <motion.div
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="flex-1 rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 px-6 py-4 font-bold uppercase tracking-[0.2em] text-white text-center shadow-lg"
            >
              ✓ Completed!
            </motion.div>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

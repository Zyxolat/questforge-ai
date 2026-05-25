import { motion, AnimatePresence } from 'framer-motion';
import { QuestState } from '../context/RealtimeContext';

interface QuestRevealModalProps {
  isOpen: boolean;
  quest: QuestState | null;
  onClose: () => void;
  onAccept?: () => void;
  loading?: boolean;
}

export default function QuestRevealModal({
  isOpen,
  quest,
  onClose,
  onAccept,
  loading = false
}: QuestRevealModalProps) {
  if (!quest) return null;

  const getDifficultyColor = (difficulty: number | string | undefined) => {
    const d = Number(difficulty);
    if (d === 5) return 'purple';
    if (d === 4) return 'orange';
    if (d === 3) return 'blue';
    if (d === 2) return 'green';
    return 'yellow';
  };

  const color = getDifficultyColor(quest.difficulty);
  const colorClasses: Record<string, string> = {
    purple: 'from-purple-600 to-pink-600',
    orange: 'from-orange-600 to-red-600',
    blue: 'from-blue-600 to-cyan-600',
    green: 'from-green-600 to-emerald-600',
    yellow: 'from-yellow-600 to-amber-600'
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.8, opacity: 0, rotateX: -10 }}
            animate={{ scale: 1, opacity: 1, rotateX: 0 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 100, damping: 15 }}
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-2xl w-full"
          >
            {/* Dramatic background glow */}
            <motion.div
              animate={{ opacity: [0.2, 0.5, 0.2] }}
              transition={{ duration: 2, repeat: Infinity }}
              className={`absolute -inset-8 rounded-[3rem] bg-gradient-to-r ${colorClasses[color]} blur-3xl -z-10`}
            />

            {/* Main card */}
            <motion.div className="rounded-[2.5rem] border-2 border-glowyellow bg-gradient-to-br from-navy via-deepnavy to-navy p-8 shadow-2xl">
              {/* Animated particles */}
              <div className="absolute inset-0 rounded-[2.5rem] overflow-hidden">
                {[...Array(6)].map((_, i) => (
                  <motion.div
                    key={i}
                    animate={{
                      y: [0, -300],
                      x: Math.sin(i) * 200,
                      opacity: [0, 1, 0]
                    }}
                    transition={{
                      duration: 2 + i * 0.3,
                      repeat: Infinity,
                      delay: i * 0.2
                    }}
                    className={`absolute w-2 h-2 rounded-full ${['bg-glowyellow', 'bg-softyellow', 'bg-yellow-400'][i % 3]} blur-sm`}
                    style={{
                      left: `${(i / 6) * 100}%`,
                      bottom: 0
                    }}
                  />
                ))}
              </div>

              <div className="relative z-10 space-y-6">
                {/* Header */}
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="text-center"
                >
                  <motion.p
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ duration: 0.5 }}
                    className="text-sm uppercase tracking-[0.3em] text-glowyellow font-bold"
                  >
                    ✨ New Quest Discovered ✨
                  </motion.p>
                  <motion.h2
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.3, type: 'spring' }}
                    className={`mt-4 text-5xl font-black bg-gradient-to-r ${colorClasses[color]} bg-clip-text text-transparent`}
                  >
                    {quest.title}
                  </motion.h2>
                </motion.div>

                {/* Difficulty badge */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="flex justify-center"
                >
                  <div className={`rounded-full bg-gradient-to-r ${colorClasses[color]} px-6 py-2 text-sm font-bold uppercase tracking-[0.15em] text-white shadow-lg`}>
                    Tier {quest.difficulty} Quest
                  </div>
                </motion.div>

                {/* Description */}
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 }}
                  className="text-center text-lg text-slate-200"
                >
                  {quest.description}
                </motion.p>

                {/* Lore */}
                {quest.lore && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.6 }}
                    className="rounded-2xl border border-white/10 bg-white/5 p-4 italic text-slate-300"
                  >
                    "{quest.lore}"
                  </motion.div>
                )}

                {/* Rewards grid */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.7 }}
                  className="grid gap-4 sm:grid-cols-3"
                >
                  <div className="rounded-xl border border-glowyellow/30 bg-glowyellow/10 p-3 text-center">
                    <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Reward</p>
                    <p className="mt-2 text-2xl font-bold text-glowyellow">{quest.rewardAmount} CELO</p>
                  </div>
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-center">
                    <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">XP Gain</p>
                    <p className="mt-2 text-2xl font-bold text-emerald-300">{quest.xpReward}</p>
                  </div>
                  <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 text-center">
                    <p className="text-xs uppercase tracking-[0.2em] text-purple-300">NFT Rarity</p>
                    <p className="mt-2 text-2xl font-bold text-purple-300">
                      {Number(quest.difficulty) === 5 ? 'Legendary' : Number(quest.difficulty) === 4 ? 'Epic' : Number(quest.difficulty) === 3 ? 'Rare' : Number(quest.difficulty) === 2 ? 'Uncommon' : 'Common'}
                    </p>
                  </div>
                </motion.div>

                {/* Stake requirement */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.8 }}
                  className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-4"
                >
                  <p className="text-center text-sm text-orange-200">
                    <span className="text-2xl font-bold text-orange-300">{quest.stakeAmount} CELO</span> stake required
                  </p>
                  <p className="mt-2 text-xs text-center text-orange-200">Returned if you succeed</p>
                </motion.div>

                {/* Action buttons */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.9 }}
                  className="flex gap-3 pt-4"
                >
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={onClose}
                    className="flex-1 rounded-xl border border-white/30 bg-white/10 px-6 py-3 font-bold uppercase tracking-[0.2em] text-white hover:bg-white/20 transition"
                  >
                    Later
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={onAccept}
                    disabled={loading}
                    className={`flex-1 rounded-xl bg-gradient-to-r ${colorClasses[color]} px-6 py-3 font-bold uppercase tracking-[0.2em] text-white shadow-lg hover:shadow-2xl transition disabled:opacity-50`}
                  >
                    {loading ? 'Accepting...' : 'Accept Quest'}
                  </motion.button>
                </motion.div>
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

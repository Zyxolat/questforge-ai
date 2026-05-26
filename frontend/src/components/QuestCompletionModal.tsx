import { motion, AnimatePresence } from 'framer-motion';
import { QuestState } from '../context/RealtimeContext';

interface QuestCompletionModalProps {
  isOpen: boolean;
  quest: QuestState | null;
  onClose: () => void;
  onGenerateNew?: () => void;
  onViewInventory?: () => void;
}

export default function QuestCompletionModal({
  isOpen,
  quest,
  onClose,
  onGenerateNew,
  onViewInventory
}: QuestCompletionModalProps) {
  if (!quest) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-md"
        >
          <motion.div
            initial={{ scale: 0.5, opacity: 0, rotateY: -90 }}
            animate={{ scale: 1, opacity: 1, rotateY: 0 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 100, damping: 15 }}
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-2xl w-full"
          >
            {/* Background glow - emerald for success */}
            <motion.div
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 2.5, repeat: Infinity }}
              className="absolute -inset-8 rounded-[3rem] bg-gradient-to-r from-emerald-500 to-green-600 blur-3xl -z-10"
            />

            {/* Main card */}
            <div className="rounded-[2.5rem] border-3 border-emerald-400 bg-gradient-to-br from-navy via-deepnavy to-navy p-4 sm:p-6 md:p-8 shadow-2xl overflow-hidden">
              {/* Fireworks effect */}
              <div className="absolute inset-0 rounded-[2.5rem] overflow-hidden">
                {[...Array(20)].map((_, i) => (
                  <motion.div
                    key={i}
                    animate={{
                      y: [-50, -300],
                      x: (Math.random() - 0.5) * 400,
                      opacity: [1, 0],
                      scale: [1, 0]
                    }}
                    transition={{
                      duration: 1.5 + Math.random(),
                      repeat: Infinity,
                      delay: i * 0.1
                    }}
                    className={`absolute w-3 h-3 rounded-full ${['bg-glowyellow', 'bg-emerald-400', 'bg-purple-400'][i % 3]} blur-sm`}
                    style={{
                      left: `${(i / 20) * 100}%`,
                      bottom: 0
                    }}
                  />
                ))}
              </div>

              <div className="relative z-10 space-y-8">
                {/* Celebration emoji and title */}
                <motion.div
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2, type: 'spring' }}
                  className="text-center"
                >
                  <motion.div
                    animate={{ scale: [1, 1.2, 1], rotate: [0, 10, -10, 0] }}
                    transition={{ duration: 0.8, repeat: Infinity, repeatDelay: 2 }}
                    className="text-7xl mb-4"
                  >
                    ✨
                  </motion.div>
                  <p className="text-sm uppercase tracking-[0.3em] text-emerald-300 font-bold">Quest Complete!</p>
                  <h2 className="mt-4 text-5xl font-black text-emerald-300">Victory!</h2>
                </motion.div>

                {/* Quest title */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="text-center"
                >
                  <p className="text-2xl font-bold text-white">{quest.title}</p>
                  <p className="mt-2 text-slate-300">"Completed successfully onchain"</p>
                </motion.div>

                {/* Rewards showcase */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="space-y-4"
                >
                  <p className="text-center text-sm uppercase tracking-[0.2em] text-softyellow font-bold">Rewards Earned</p>
                  <div className="grid gap-4 sm:grid-cols-3">
                    {/* XP */}
                    <motion.div
                      whileHover={{ scale: 1.05 }}
                      className="rounded-2xl border-2 border-emerald-500 bg-gradient-to-br from-emerald-500/20 to-green-600/10 p-6 text-center"
                    >
                      <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ duration: 0.6 }}>
                        <p className="text-3xl font-black text-emerald-300">+{quest.xpReward || '???'}</p>
                      </motion.div>
                      <p className="mt-2 text-xs uppercase tracking-[0.2em] text-emerald-200">Experience Points</p>
                    </motion.div>

                    {/* CELO */}
                    <motion.div
                      whileHover={{ scale: 1.05 }}
                      className="rounded-2xl border-2 border-glowyellow bg-gradient-to-br from-glowyellow/20 to-softyellow/10 p-6 text-center"
                    >
                      <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ duration: 0.6, delay: 0.1 }}>
                        <p className="text-3xl font-black text-glowyellow">+{quest.rewardAmount || '???'}</p>
                      </motion.div>
                      <p className="mt-2 text-xs uppercase tracking-[0.2em] text-softyellow">CELO Tokens</p>
                    </motion.div>

                    {/* NFT */}
                    <motion.div
                      whileHover={{ scale: 1.05 }}
                      className="rounded-2xl border-2 border-purple-500 bg-gradient-to-br from-purple-500/20 to-pink-600/10 p-6 text-center"
                    >
                      <motion.div
                        animate={{ scale: [1, 1.2, 1], rotate: [0, 360] }}
                        transition={{ duration: 0.8, delay: 0.2, repeat: Infinity, repeatDelay: 3 }}
                      >
                        <p className="text-4xl">🎖️</p>
                      </motion.div>
                      <p className="mt-2 text-xs uppercase tracking-[0.2em] text-purple-200">
                        {Number(quest.difficulty) === 5 ? 'Legendary' : Number(quest.difficulty) === 4 ? 'Epic' : Number(quest.difficulty) === 3 ? 'Rare' : Number(quest.difficulty) === 2 ? 'Uncommon' : 'Common'} NFT
                      </p>
                    </motion.div>
                  </div>
                </motion.div>

                {/* Celebration message */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 }}
                  className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center"
                >
                  <p className="text-lg font-semibold text-emerald-200">🏆 An NFT has been minted to your wallet</p>
                  <p className="mt-2 text-sm text-emerald-300">Your legendary achievement is now recorded onchain forever</p>
                </motion.div>

                {/* Action buttons */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="flex flex-col gap-3 pt-4 sm:flex-row"
                >
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={onViewInventory ?? onClose}
                    className="flex-1 rounded-xl border border-white/30 bg-white/10 px-6 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-white hover:bg-white/20 transition min-h-[44px] sm:min-h-[48px]"
                  >
                    View Inventory
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={onGenerateNew}
                    className="flex-1 rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 px-6 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-white shadow-lg hover:shadow-2xl transition min-h-[44px] sm:min-h-[48px]"
                  >
                    ⚔️ Next Quest
                  </motion.button>
                </motion.div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

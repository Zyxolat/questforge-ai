import { motion, AnimatePresence } from 'framer-motion';
import { useEffect } from 'react';
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
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;

    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, [isOpen]);

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
  const questGeneration = quest.generation && typeof quest.generation === 'object' ? quest.generation as Record<string, unknown> : null;
  const questNpc = quest.npc && typeof quest.npc === 'object' ? quest.npc as Record<string, unknown> : null;
  const requiredTxTypes = Array.isArray(quest.requiredTxTypes)
    ? quest.requiredTxTypes.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  const colorClasses: Record<string, string> = {
    purple: 'from-yellow-500 to-amber-400',
    orange: 'from-yellow-500 to-amber-500',
    blue: 'from-yellow-500 to-yellow-300',
    green: 'from-yellow-500 to-lime-300',
    yellow: 'from-yellow-500 to-amber-500'
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/80 p-4 backdrop-blur-sm"
        >
          <div className="flex min-h-full items-start justify-center py-4 sm:items-center">
            <motion.div
              initial={{ scale: 0.8, opacity: 0, rotateX: -10 }}
              animate={{ scale: 1, opacity: 1, rotateX: 0 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 100, damping: 15 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-2xl"
            >
              {/* Dramatic background glow */}
              <motion.div
                animate={{ opacity: [0.2, 0.5, 0.2] }}
                transition={{ duration: 2, repeat: Infinity }}
                className={`absolute -inset-8 rounded-[3rem] bg-gradient-to-r ${colorClasses[color]} blur-3xl -z-10`}
              />

              {/* Main card */}
              <motion.div className="relative flex max-h-[90vh] flex-col overflow-hidden rounded-[2.5rem] border-2 border-glowyellow bg-gradient-to-br from-navy via-deepnavy to-navy shadow-2xl">
                {/* Animated particles */}
                <div className="absolute inset-0 overflow-hidden rounded-[2.5rem]">
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
                      className={`absolute h-2 w-2 rounded-full ${['bg-glowyellow', 'bg-softyellow', 'bg-yellow-400'][i % 3]} blur-sm`}
                      style={{
                        left: `${(i / 6) * 100}%`,
                        bottom: 0
                      }}
                    />
                  ))}
                </div>

                <div className="relative z-10 flex min-h-0 flex-1 flex-col">
                  <div className="border-b border-white/10 bg-navy/75 px-4 pb-4 pt-4 text-center backdrop-blur-sm sm:px-6 sm:pb-5 sm:pt-6 md:px-8">
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 }}
                    >
                      <motion.p
                        animate={{ scale: [1, 1.1, 1] }}
                        transition={{ duration: 0.5 }}
                        className="text-sm font-bold uppercase tracking-[0.3em] text-glowyellow"
                      >
                        ✨ New Quest Discovered ✨
                      </motion.p>
                      <motion.h2
                        initial={{ scale: 0.8 }}
                        animate={{ scale: 1 }}
                        transition={{ delay: 0.3, type: 'spring' }}
                        className={`mt-4 bg-gradient-to-r ${colorClasses[color]} bg-clip-text text-3xl font-black text-transparent sm:text-4xl md:text-5xl`}
                      >
                        {quest.title}
                      </motion.h2>
                    </motion.div>

                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.4 }}
                      className="mt-4 flex justify-center"
                    >
                      <div className={`rounded-full bg-gradient-to-r ${colorClasses[color]} px-4 py-2 text-xs font-bold uppercase tracking-[0.15em] text-white shadow-lg sm:px-6 sm:text-sm`}>
                        Tier {quest.difficulty} Quest
                      </div>
                    </motion.div>

                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.5 }}
                      className="mt-4 text-sm text-slate-200 sm:text-base md:text-lg"
                    >
                      {quest.description}
                    </motion.p>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 pr-3 scroll-smooth sm:px-6 md:px-8">
                    <div className="space-y-6 pr-1">
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.55 }}
                        className="rounded-2xl border border-glowyellow/20 bg-glowyellow/10 p-4"
                      >
                        <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Primary Objective</p>
                        <p className="mt-2 text-base font-semibold text-white">{quest.objective || 'Complete the mission and return with proof.'}</p>
                      </motion.div>

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

                      {quest.missionStructure ? (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.62 }}
                          className="rounded-2xl border border-white/10 bg-white/5 p-4"
                        >
                          <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Cinematic Structure</p>
                          <p className="mt-2 text-sm text-slate-200">{String(quest.missionStructure ?? "")}</p>
                        </motion.div>
                      ) : null}

                      {Array.isArray(quest.missionChapters) && quest.missionChapters.length > 0 ? (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.64 }}
                          className="grid gap-3"
                        >
                          {quest.missionChapters.slice(0, 3).map((chapter, index) => (
                            <div key={chapter.id ?? `chapter-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Chapter {index + 1}</p>
                              <p className="mt-2 text-base font-semibold text-white">{chapter.title || `Chapter ${index + 1}`}</p>
                              <p className="mt-1 text-sm text-slate-300">{chapter.summary || 'The mission advances deeper into the realm.'}</p>
                            </div>
                          ))}
                        </motion.div>
                      ) : null}

                      {(questNpc || questGeneration || requiredTxTypes.length > 0) && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.65 }}
                          className="grid gap-4 sm:grid-cols-2"
                        >
                          {questNpc ? (
                            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Narrated By</p>
                              <p className="mt-2 text-lg font-semibold text-white">{String(questNpc.name ?? 'Forge Guide')}</p>
                              {typeof questNpc.role === 'string' ? <p className="mt-1 text-sm text-slate-300">{questNpc.role}</p> : null}
                            </div>
                          ) : null}
                          {questGeneration ? (
                            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">AI Provenance</p>
                              <p className="mt-2 text-lg font-semibold text-white">{String(questGeneration.provider ?? questGeneration.source ?? 'Adaptive engine')}</p>
                              {typeof questGeneration.model === 'string' ? <p className="mt-1 text-sm text-slate-300">{questGeneration.model}</p> : null}
                              {typeof questGeneration.latencyMs === 'number' || typeof questGeneration.totalTokens === 'number' ? (
                                <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
                                  {String(questGeneration.latencyMs ?? "n/a")} ms • {String(questGeneration.totalTokens ?? "n/a")} tokens
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                          {requiredTxTypes.length > 0 ? (
                            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:col-span-2">
                              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Expected Onchain Moves</p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {requiredTxTypes.map((step) => (
                                  <span
                                    key={step}
                                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-200"
                                  >
                                    {step.replace(/_/g, ' ')}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </motion.div>
                      )}

                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.72 }}
                        className="rounded-2xl border border-white/10 bg-white/5 p-4"
                      >
                        <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Acceptance Fee</p>
                        <p className="mt-2 text-sm text-slate-200">
                          Generating this quest is free. Accepting it will send 0.001 CELO to begin the mission.
                        </p>
                      </motion.div>

                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.75 }}
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
                          <p className="text-xs uppercase tracking-[0.2em] text-softyellow">NFT Rarity</p>
                          <p className="mt-2 text-2xl font-bold text-white">
                            {Number(quest.difficulty) === 5 ? 'Legendary' : Number(quest.difficulty) === 4 ? 'Epic' : Number(quest.difficulty) === 3 ? 'Rare' : Number(quest.difficulty) === 2 ? 'Uncommon' : 'Common'}
                          </p>
                        </div>
                      </motion.div>

                    </div>
                  </div>

                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.95 }}
                    className="border-t border-white/10 bg-navy/75 px-4 pb-4 pt-4 backdrop-blur-sm sm:px-6 md:px-8"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <motion.button
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={onClose}
                        className="min-h-[44px] flex-1 rounded-xl border border-white/30 bg-white/10 px-6 py-3 font-bold uppercase tracking-[0.2em] text-white transition hover:bg-white/20 sm:min-h-[48px]"
                      >
                        Later
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={onAccept}
                        disabled={loading}
                        className={`min-h-[44px] flex-1 rounded-xl bg-gradient-to-r ${colorClasses[color]} px-6 py-3 font-bold uppercase tracking-[0.2em] text-white shadow-lg transition hover:shadow-2xl disabled:opacity-50 sm:min-h-[48px]`}
                      >
                        {loading ? 'Accepting...' : 'Accept Quest'}
                      </motion.button>
                    </div>
                  </motion.div>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

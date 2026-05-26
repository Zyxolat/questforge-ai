import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { QuestState } from '../context/RealtimeContext';

interface ActiveQuestPanelProps {
  quest: QuestState | null;
  onStartQuest?: () => void;
  onSubmitProof?: () => void;
  onReviewFailure?: () => void;
  loading?: boolean;
  disabled?: boolean;
}

export default function ActiveQuestPanel({
  quest,
  onStartQuest,
  onSubmitProof,
  onReviewFailure,
  loading = false,
  disabled = false
}: ActiveQuestPanelProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

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
  const isFailed = quest.status === 'FAILED' || quest.status === 'CANCELLED';

  const questGeneration = quest.generation && typeof quest.generation === 'object' ? quest.generation as Record<string, unknown> : null;
  const questNpc = quest.npc && typeof quest.npc === 'object' ? quest.npc as Record<string, unknown> : null;
  const questExpiresAt = typeof quest.expiresAt === 'string' ? new Date(quest.expiresAt) : null;
  const questStartedAt = typeof quest.startedAt === 'string' ? new Date(quest.startedAt) : null;
  const verificationReason =
    typeof quest.verificationReason === 'string' && quest.verificationReason.trim().length > 0
      ? quest.verificationReason
      : null;
  const durationSeconds = Number(quest.durationSeconds ?? quest.estimatedDurationSeconds ?? 0);
  const derivedDeadline =
    questExpiresAt && !Number.isNaN(questExpiresAt.getTime())
      ? questExpiresAt
      : questStartedAt && !Number.isNaN(questStartedAt.getTime()) && durationSeconds > 0
        ? new Date(questStartedAt.getTime() + durationSeconds * 1000)
        : null;
  const remainingMs = derivedDeadline ? Math.max(derivedDeadline.getTime() - now, 0) : null;

  const countdownLabel =
    remainingMs === null
      ? null
      : remainingMs === 0
        ? 'Quest timer elapsed'
        : `${Math.floor(remainingMs / 3_600_000)
            .toString()
            .padStart(2, '0')}:${Math.floor((remainingMs % 3_600_000) / 60_000)
            .toString()
            .padStart(2, '0')}:${Math.floor((remainingMs % 60_000) / 1000)
            .toString()
            .padStart(2, '0')}`;

  const nextAction = isAvailable
    ? 'Review the objective, confirm the stake, and begin the quest onchain.'
    : isActive
      ? 'Complete the objective below, then submit a proof transaction or Celoscan link.'
      : isSubmitted
        ? 'Your proof is queued for deterministic verification. Stay on this screen for live updates.'
        : isVerified
          ? 'Rewards have landed. Open the celebration summary and continue your adventure.'
          : isFailed
            ? 'This run did not settle successfully. Review the treasury outcome and start another quest.'
            : 'Quest state synced. Review the latest objective details below.';

  const transactionPath = Array.isArray(quest.requiredTxTypes)
    ? quest.requiredTxTypes.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-[2.5rem] border-2 border-glowyellow/50 bg-gradient-to-br from-navy/80 via-deepnavy/60 to-navy/40 p-8 shadow-2xl backdrop-blur-xl xl:max-h-[78vh] xl:overflow-y-auto xl:pr-5"
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
            animate={{ scale: isSubmitted ? [1, 1.1, 1] : isFailed ? [1, 1.02, 1] : 1 }}
            transition={{ duration: 1, repeat: isSubmitted || isFailed ? Infinity : 0 }}
            className={`rounded-2xl px-4 py-2 text-sm font-bold uppercase tracking-[0.2em] ${
              isVerified
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500'
                : isFailed
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500'
                : isSubmitted
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500'
                  : isActive
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500'
                    : 'bg-glowyellow/20 text-glowyellow border border-glowyellow'
            }`}
          >
            {isVerified ? '✓ Verified' : isFailed ? '✕ Failed' : isSubmitted ? '⟳ Verifying' : isActive ? '⚡ Active' : '◉ Available'}
          </motion.div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.2fr,0.8fr]">
          <div className="rounded-2xl border border-glowyellow/20 bg-glowyellow/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Next Move</p>
            <p className="mt-2 text-sm text-white">{nextAction}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {countdownLabel ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Quest Timer</p>
                <p className="mt-2 text-xl font-bold text-white">{countdownLabel}</p>
              </div>
            ) : null}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Chain Quest ID</p>
              <p className="mt-2 break-all text-sm font-mono text-white">{quest.chainQuestId || 'Pending sync'}</p>
            </div>
          </div>
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
            {transactionPath.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {transactionPath.map((step) => (
                  <span
                    key={step}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-300"
                  >
                    {step.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </motion.div>

        {(questNpc || questGeneration) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.35 }}
            className="grid gap-3 lg:grid-cols-2"
          >
            {questNpc ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Quest Narrator</p>
                <p className="mt-2 text-lg font-semibold text-white">{String(questNpc.name ?? 'Forge Guide')}</p>
                {typeof questNpc.role === 'string' ? <p className="mt-1 text-sm text-slate-300">{questNpc.role}</p> : null}
              </div>
            ) : null}
            {questGeneration ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">AI Provenance</p>
                <p className="mt-2 text-lg font-semibold text-white">{String(questGeneration.provider ?? questGeneration.source ?? 'Adaptive engine')}</p>
                {typeof questGeneration.model === 'string' ? <p className="mt-1 text-sm text-slate-300">{questGeneration.model}</p> : null}
              </div>
            ) : null}
          </motion.div>
        )}

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
            className="grid gap-3 rounded-2xl border border-orange-500/30 bg-orange-500/10 p-4 md:grid-cols-2"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-orange-300">Stake Locked</p>
                <p className="mt-1 text-xl font-bold text-orange-300">{quest.stakeAmount || '?'} CELO</p>
              </div>
              <p className="text-right text-sm text-slate-400">At risk during quest</p>
            </div>
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Proof Target</p>
              <p className="mt-2 text-sm text-white">Submit a transaction hash or Celoscan URL that proves this objective was completed.</p>
            </div>
          </motion.div>
        )}

        {(quest.proofTxHash || quest.verificationTx || quest.treasuryPayout?.status) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 md:grid-cols-3"
          >
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Proof Tx</p>
              <p className="mt-2 break-all text-xs font-mono text-white">{String(quest.proofTxHash ?? quest.proofTx ?? 'Pending')}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Verification Tx</p>
              <p className="mt-2 break-all text-xs font-mono text-white">{String(quest.verificationTx ?? 'Pending')}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Treasury</p>
              <p className="mt-2 text-sm font-semibold text-white">{quest.treasuryPayout?.status ?? 'Pending'}</p>
            </div>
          </motion.div>
        )}

        {isFailed ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4"
          >
            <p className="text-xs uppercase tracking-[0.2em] text-rose-200">Failure Details</p>
            <p className="mt-2 text-sm text-white">
              {verificationReason ||
                'Deterministic verification rejected this proof or the quest settlement failed.'}
            </p>
          </motion.div>
        ) : null}

        {/* Action buttons */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="flex flex-col gap-3 pt-4 sm:flex-row"
        >
          {isAvailable && onStartQuest && (
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={onStartQuest}
              disabled={loading || disabled}
              className="flex-1 rounded-2xl bg-gradient-to-r from-glowyellow to-softyellow px-6 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-navy shadow-lg hover:shadow-2xl transition-shadow disabled:opacity-50 min-h-[44px] sm:min-h-[48px]"
            >
              {loading ? 'Starting...' : 'Begin Quest'}
            </motion.button>
          )}

          {isActive && onSubmitProof && (
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={onSubmitProof}
              disabled={loading || disabled}
              className="flex-1 rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 px-6 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-white shadow-lg hover:shadow-2xl transition-shadow disabled:opacity-50 min-h-[44px] sm:min-h-[48px]"
            >
              {loading ? 'Submitting...' : 'Prepare Proof Submission'}
            </motion.button>
          )}

          {isSubmitted && (
            <motion.div
              animate={{ opacity: [0.6, 1, 0.6] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="flex-1 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-600 px-6 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-white text-center shadow-lg min-h-[44px] sm:min-h-[48px] flex items-center justify-center"
            >
              ⟳ Verifying...
            </motion.div>
          )}

          {isVerified && (
            <motion.div
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="flex-1 rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 px-6 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-white text-center shadow-lg min-h-[44px] sm:min-h-[48px] flex items-center justify-center"
            >
              ✓ Completed!
            </motion.div>
          )}

          {isFailed && (
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              animate={{ opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              onClick={onReviewFailure}
              className="flex-1 rounded-2xl bg-gradient-to-r from-rose-500 to-red-600 px-6 py-4 text-center font-bold uppercase tracking-[0.2em] text-white shadow-lg"
            >
              Review Failure State
            </motion.button>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

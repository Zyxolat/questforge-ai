import { motion } from 'framer-motion';

type QuestFlowStep = 'PENDING' | 'GENERATED' | 'ACCEPTED' | 'ACTIVE' | 'SUBMITTED' | 'VERIFIED' | 'COMPLETED';

interface QuestFlowTrackerProps {
  currentStep: QuestFlowStep;
}

export default function QuestFlowTracker({ currentStep }: QuestFlowTrackerProps) {
  const steps: { step: QuestFlowStep; label: string; description: string }[] = [
    { step: 'PENDING', label: 'Connected', description: 'Wallet ready' },
    { step: 'GENERATED', label: 'Quest Generated', description: 'AI created your quest' },
    { step: 'ACCEPTED', label: 'Quest Started', description: 'Staked onchain' },
    { step: 'ACTIVE', label: 'In Progress', description: 'Complete objectives' },
    { step: 'SUBMITTED', label: 'Proof Submitted', description: 'Awaiting verification' },
    { step: 'VERIFIED', label: 'Verified', description: 'Reward earned' },
    { step: 'COMPLETED', label: 'Completed', description: 'Quest finished' }
  ];

  const currentIndex = steps.findIndex((s) => s.step === currentStep);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-[0.25em] text-glowyellow">Quest Journey</h3>
        <p className="text-xs text-slate-400">
          Step {Math.max(1, currentIndex + 1)} of {steps.length}
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {steps.map((step, index) => {
          const isActive = index <= currentIndex;
          const isCurrent = step.step === currentStep;

          return (
            <motion.div
              key={step.step}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className="flex flex-col items-center gap-2 min-w-max"
            >
              <motion.div
                animate={{
                  boxShadow: isCurrent ? '0 0 20px rgba(255, 214, 10, 0.8)' : 'none',
                  scale: isCurrent ? 1.1 : 1
                }}
                className={`relative h-10 w-10 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  isCurrent
                    ? 'bg-glowyellow text-navy'
                    : isActive
                      ? 'bg-emerald-500/30 border border-emerald-500 text-emerald-300'
                      : 'bg-slate-700/30 border border-slate-600 text-slate-400'
                }`}
              >
                {isActive && !isCurrent ? '✓' : index + 1}
              </motion.div>
              <p className={`text-xs text-center whitespace-nowrap ${isCurrent ? 'text-glowyellow font-semibold' : isActive ? 'text-emerald-300' : 'text-slate-400'}`}>
                {step.label}
              </p>
            </motion.div>
          );
        })}
      </div>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        initial={{ opacity: 0, y: 5 }}
        className="rounded-2xl border border-white/10 bg-gradient-to-r from-glowyellow/10 to-yellow-500/10 p-3 text-sm text-slate-200"
      >
        <p className="text-glowyellow font-semibold">{steps[currentIndex]?.label}</p>
        <p className="mt-1 text-xs text-slate-400">{steps[currentIndex]?.description}</p>
      </motion.div>
    </div>
  );
}

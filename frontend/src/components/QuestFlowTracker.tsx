import { motion } from 'framer-motion';

type QuestFlowStep =
  | 'PENDING'
  | 'GENERATED'
  | 'ACCEPTED'
  | 'ACTIVE'
  | 'SUBMITTED'
  | 'VERIFIED'
  | 'REWARDED'
  | 'COMPLETED';

interface QuestFlowTrackerProps {
  currentStep: QuestFlowStep;
  statusLabel?: string;
}

export default function QuestFlowTracker({ currentStep, statusLabel }: QuestFlowTrackerProps) {
  const steps: { step: QuestFlowStep; label: string; description: string }[] = [
    { step: 'PENDING', label: 'Connected', description: 'Wallet ready' },
    { step: 'GENERATED', label: 'Quest Generated', description: 'AI forged the mission' },
    { step: 'ACCEPTED', label: 'Quest Accepted', description: 'Adventure locked in' },
    { step: 'ACTIVE', label: 'In Progress', description: 'Complete objectives' },
    { step: 'SUBMITTED', label: 'Proof Submitted', description: 'Awaiting verification' },
    { step: 'VERIFIED', label: 'Verified', description: 'Backend confirmed success' },
    { step: 'REWARDED', label: 'Rewarded', description: 'Celebration sequence live' },
    { step: 'COMPLETED', label: 'Completed', description: 'Ready for the next quest' }
  ];

  const currentIndex = steps.findIndex((s) => s.step === currentStep);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-[0.25em] text-glowyellow">Quest Journey</h3>
        <div className="text-right">
          <p className="text-xs text-slate-400">
            Step {Math.max(1, currentIndex + 1)} of {steps.length}
          </p>
          {statusLabel ? <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-softyellow">{statusLabel}</p> : null}
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2">
        {steps.map((step, index) => {
          const isActive = index <= currentIndex;
          const isCurrent = step.step === currentStep;
          const isFuture = index > currentIndex;

          return (
            <motion.div
              key={step.step}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className="flex min-w-max items-center gap-2"
            >
              <div className="flex flex-col items-center gap-2">
                <motion.div
                  animate={{
                    boxShadow: isCurrent ? '0 0 20px rgba(255, 214, 10, 0.8)' : 'none',
                    scale: isCurrent ? 1.08 : 1
                  }}
                  className={`relative flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold transition-all ${
                    isCurrent
                      ? 'bg-glowyellow text-navy'
                      : isActive
                        ? 'border border-emerald-500 bg-emerald-500/30 text-emerald-300'
                        : 'border border-slate-600 bg-slate-700/30 text-slate-400'
                  }`}
                >
                  {isActive && !isCurrent ? '✓' : index + 1}
                </motion.div>
                <p
                  className={`whitespace-nowrap text-center text-xs ${
                    isCurrent
                      ? 'font-semibold text-glowyellow'
                      : isActive
                        ? 'text-emerald-300'
                        : 'text-slate-400'
                  }`}
                >
                  {step.label}
                </p>
              </div>
              {index < steps.length - 1 ? (
                <div
                  className={`mt-[-1.2rem] hidden h-[2px] w-10 rounded-full sm:block ${
                    isFuture ? 'bg-slate-700/60' : 'bg-gradient-to-r from-emerald-500 to-glowyellow'
                  }`}
                />
              ) : null}
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

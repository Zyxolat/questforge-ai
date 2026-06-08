import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';

type OnboardingStep = 'welcome' | 'minipay' | 'howitworks' | 'rewards' | 'complete';

interface OnboardingFlowProps {
  open: boolean;
  onComplete: () => void;
}

const steps: Record<OnboardingStep, { title: string; description: string; icon: string; tips: string[] }> = {
  welcome: {
    title: '⚔️ Welcome to Online ForgeQuest Game',
    description: 'You\'re about to enter a realm where rule-based quests become real blockchain activity. Every decision matters, and every victory is rewarded on-chain.',
    icon: '🏰',
    tips: [
      'Quests come from deterministic templates',
      'Complete challenges to earn real CELO tokens',
      'Collect NFTs and climb the leaderboard'
    ]
  },
  minipay: {
    title: '📱 MiniPay Magic',
    description: 'Online ForgeQuest Game is optimized for MiniPay on Celo. Your wallet is already connected and secure. Every transaction is instant and low-cost.',
    icon: '🔐',
    tips: [
      'MiniPay handles all wallet security',
      'Transactions happen on Celo mainnet',
      'Your rewards arrive instantly to your wallet'
    ]
  },
  howitworks: {
    title: '🎮 How Quests Work',
    description: 'Generate a rule-based quest → Complete the challenge → Submit proof → Earn rewards. It\'s that simple, and it all settles on-chain.',
    icon: '✨',
    tips: [
      'Prove: Submit transaction hash or URL as proof',
      'Earn: Verified proofs = instant CELO + NFT rewards'
    ]
  },
  rewards: {
    title: '🏆 Build Your Legend',
    description: 'Daily streaks keep your progress alive. Claim the daily reward to receive a backend-verified CELO payout directly to your wallet.',
    icon: '🔥',
    tips: [
      'Daily claims pay 0.0001 CELO once per UTC day',
      'Confirmed payouts include an on-chain transaction hash',
      'Leaderboard rankings update in real-time'
    ]
  },
  complete: {
    title: '🚀 Ready to Begin?',
    description: 'You\'re all set to forge your destiny. Generate your first quest, complete it, and prove yourself worthy of the game.',
    icon: '💎',
    tips: [
      'Your first quest is ready to generate',
      'Start with any difficulty level',
      'Tips and help available in-game'
    ]
  }
};

const stepOrder: OnboardingStep[] = ['welcome', 'minipay', 'howitworks', 'rewards', 'complete'];

export default function OnboardingFlow({ open, onComplete }: OnboardingFlowProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const currentStep: OnboardingStep = stepOrder[currentStepIndex];
  const stepData = steps[currentStep];
  const isLast = currentStepIndex === stepOrder.length - 1;

  useEffect(() => {
    if (open) {
      setCurrentStepIndex(0);
    }
  }, [open]);

  const handleNext = () => {
    if (isLast) {
      localStorage.setItem('online-forgequest:onboarding-complete', 'true');
      onComplete();
    } else {
      setCurrentStepIndex(prev => prev + 1);
    }
  };

  const handleSkip = () => {
    localStorage.setItem('online-forgequest:onboarding-complete', 'true');
    onComplete();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleSkip}
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
          >
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border-2 border-glowyellow bg-gradient-to-b from-deepnavy via-navy to-[#030610] p-8 shadow-2xl md:p-12">
              {/* Progress Bar */}
              <div className="mb-8 flex gap-2">
                {stepOrder.map((_, idx) => (
                  <motion.div
                    key={idx}
                    className={`h-1 flex-1 rounded-full transition-all ${
                      idx < currentStepIndex
                        ? 'bg-green-500'
                        : idx === currentStepIndex
                        ? 'bg-glowyellow'
                        : 'bg-white/20'
                    }`}
                  />
                ))}
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={currentStep}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  {/* Icon */}
                  <motion.div
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="text-6xl text-center"
                  >
                    {stepData.icon}
                  </motion.div>

                  {/* Title */}
                  <h2 className="text-center text-4xl font-black text-white">{stepData.title}</h2>

                  {/* Description */}
                  <p className="text-center text-lg text-slate-300">{stepData.description}</p>

                  {/* Tips */}
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-6">
                    <p className="text-sm font-semibold uppercase tracking-[0.1em] text-glowyellow">Key Points:</p>
                    <ul className="space-y-2">
                      {stepData.tips.map((tip, idx) => (
                        <motion.li
                          key={idx}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.1 }}
                          className="flex items-start gap-3 text-slate-200"
                        >
                          <span className="mt-1 text-glowyellow">✓</span>
                          <span>{tip}</span>
                        </motion.li>
                      ))}
                    </ul>
                  </div>

                  {/* Navigation */}
                  <div className="flex gap-4 pt-6">
                    {currentStepIndex > 0 && (
                      <button
                        onClick={() => setCurrentStepIndex(prev => prev - 1)}
                        className="flex-1 rounded-full border border-white/30 px-6 py-3 font-semibold text-white transition hover:bg-white/10"
                      >
                        Back
                      </button>
                    )}
                    <button
                      onClick={handleNext}
                      className="flex-1 rounded-full bg-glowyellow px-6 py-3 font-semibold text-navy transition hover:bg-glowyellow/90"
                    >
                      {isLast ? '🚀 Enter the Forge' : 'Next →'}
                    </button>
                  </div>

                  {/* Skip Link */}
                  <button
                    onClick={handleSkip}
                    className="w-full text-center text-sm text-slate-400 transition hover:text-slate-200"
                  >
                    Skip for now
                  </button>
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import GlowButton from '../components/GlowButton';

const SAMPLE_QUESTS = [
  {
    id: 'daily-check-in',
    title: 'Daily Check-In',
    category: 'Daily',
    difficulty: 'Common',
    reward: '120 XP + 0.010 CELO',
    description: 'Keep your streak active with a quick wallet action and claim a small reward.',
    icon: '🔥',
    timeEstimate: '2-3 min'
  },
  {
    id: 'community-join-celo',
    title: 'Join Celo Community',
    category: 'Community',
    difficulty: 'Uncommon',
    reward: '180 XP + 0.018 CELO',
    description: 'Show support for the ecosystem and prove the action with a clean transaction.',
    icon: '🌱',
    timeEstimate: '5 min'
  },
  {
    id: 'explorer-dapp-tour',
    title: 'dApp Tour',
    category: 'Explorer',
    difficulty: 'Rare',
    reward: '200 XP + 0.020 CELO',
    description: 'Explore a live Celo dApp, then submit the proof transaction that marks the visit.',
    icon: '🧭',
    timeEstimate: '8 min'
  }
];

const FLOW_STEPS = [
  {
    step: '1',
    title: 'Connect Wallet',
    description: 'Open the app, connect MiniPay, and confirm you are on Celo.',
    icon: '🔐'
  },
  {
    step: '2',
    title: 'Browse Quests',
    description: 'Choose from a live pool of rule-based quests grouped by category and difficulty.',
    icon: '📜'
  },
  {
    step: '3',
    title: 'Complete Proof',
    description: 'Finish the objective, submit the proof transaction, and let the backend verify it.',
    icon: '⛏️'
  },
  {
    step: '4',
    title: 'Claim Rewards',
    description: 'Earn XP, CELO, and eligible NFTs after verification lands on-chain.',
    icon: '🏆'
  }
];

const PLATFORM_PILLARS = [
  {
    label: 'Rule Based',
    title: 'Fast, predictable quest selection',
    body: 'Templates are predefined, auditable, and instant. No external model calls, no generation lag.'
  },
  {
    label: 'Onchain Rewards',
    title: 'XP, CELO, and achievement NFTs',
    body: 'Every verified quest can settle rewards cleanly through the existing Celo flow.'
  },
  {
    label: 'Mobile Ready',
    title: 'Built for MiniPay from day one',
    body: 'The experience stays lightweight and responsive so players can move quickly on mobile.'
  }
];

function QuestPreviewCard({ quest, index }: { quest: typeof SAMPLE_QUESTS[0]; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.08 }}
      whileHover={{ y: -4, scale: 1.01 }}
      className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-strong backdrop-blur-xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-softyellow">{quest.category}</p>
          <h3 className="mt-3 text-xl font-bold text-white">{quest.title}</h3>
        </div>
        <div className="text-3xl">{quest.icon}</div>
      </div>
      <p className="mt-4 text-sm text-slate-300">{quest.description}</p>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="rounded-full border border-glowyellow/20 bg-glowyellow/10 px-3 py-1 text-glowyellow">
          {quest.difficulty}
        </span>
        <span className="text-white/90">{quest.reward}</span>
      </div>
      <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-400">{quest.timeEstimate}</p>
    </motion.div>
  );
}

export default function HomePage() {
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mx-auto flex min-h-[calc(100vh-96px)] max-w-7xl flex-col gap-12 px-6 py-12"
    >
      <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="inline-flex items-center rounded-full border border-glowyellow/20 bg-glowyellow/10 px-4 py-2 text-xs uppercase tracking-[0.35em] text-glowyellow shadow-glow"
          >
            Online ForgeQuest Game on Celo
          </motion.span>
          <h1 className="max-w-3xl text-5xl font-black uppercase leading-tight tracking-[-0.05em] text-white md:text-6xl">
            Browse quests. Complete proofs. Claim rewards.
          </h1>
          <p className="max-w-2xl text-lg text-slate-300">
            Online ForgeQuest Game is a rule-based quest and reward platform built for Celo and MiniPay. Pick a quest,
            complete the objective, submit proof, and earn XP, CELO, and achievement NFTs without any external
            generation service.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link to="/command-center">
              <GlowButton label="Start Playing" />
            </Link>
            <Link
              to="/tavern"
              className="rounded-full border border-white/30 bg-white/10 px-6 py-3 font-semibold text-white transition hover:bg-white/20"
            >
              Explore NPCs
            </Link>
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl"
        >
          <div className="space-y-4">
            <div className="rounded-3xl border border-glowyellow/20 bg-gradient-to-br from-white/5 to-transparent p-6">
              <p className="text-sm uppercase tracking-[0.3em] text-softyellow">Instant selection</p>
              <h2 className="mt-4 text-2xl font-semibold text-white">Rule-based quest engine</h2>
              <p className="mt-3 text-sm text-slate-300">
                Templates are generated locally from predefined quest pools. Every quest is auditable and ready
                immediately.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {['Daily', 'Community', 'Learning', 'Explorer'].map((item) => (
                <div key={item} className="rounded-2xl border border-white/10 bg-navy/70 p-4 text-sm text-slate-200">
                  {item} quests
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </section>

      <section className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold text-white">Sample quest pool</h2>
          <p className="mt-2 text-slate-400">A preview of the rule-based categories available to every player.</p>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {SAMPLE_QUESTS.map((quest, idx) => (
            <QuestPreviewCard key={quest.id} quest={quest} index={idx} />
          ))}
        </div>
      </section>

      <section className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold text-white">How it works</h2>
          <p className="mt-2 text-slate-400">A simple loop designed around fast gameplay and clear proof submission.</p>
        </div>
        <div className="grid gap-4">
          {FLOW_STEPS.map((item, idx) => (
            <motion.div
              key={item.step}
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.05 }}
              className="flex gap-6 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl"
            >
              <div className="text-3xl">{item.icon}</div>
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-black text-glowyellow">{item.step}</span>
                  <h3 className="text-xl font-bold text-white">{item.title}</h3>
                </div>
                <p className="mt-2 text-slate-400">{item.description}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        {PLATFORM_PILLARS.map((pillar) => (
          <div key={pillar.label} className="rounded-3xl border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <span className="text-sm uppercase tracking-[0.35em] text-glowyellow">{pillar.label}</span>
            <h2 className="mt-4 text-2xl font-bold text-white">{pillar.title}</h2>
            <p className="mt-3 text-slate-300">{pillar.body}</p>
          </div>
        ))}
      </section>

      <motion.section
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        className="rounded-3xl border-2 border-glowyellow bg-gradient-to-br from-glowyellow/20 via-transparent to-glowyellow/10 p-12 text-center"
      >
        <h2 className="text-4xl font-black text-white">Ready to begin?</h2>
        <p className="mt-4 text-lg text-slate-300">
          Connect your wallet, pick a quest, and let the rule-based engine keep the flow moving.
        </p>
        <Link to="/command-center" className="mt-8 inline-block">
          <GlowButton label="Enter Online ForgeQuest Game" />
        </Link>
      </motion.section>
    </motion.main>
  );
}

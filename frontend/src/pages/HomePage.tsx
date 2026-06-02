import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import GlowButton from '../components/GlowButton';

// Sample quests to display before wallet connection
const SAMPLE_QUESTS = [
  {
    id: 'sample-1',
    title: 'The Dragon\'s Treasure',
    difficulty: 5,
    reward: '0.5 CELO + Legendary NFT',
    description: 'Venture into the dragon\'s lair. Stake 0.5 CELO and complete this epic quest.',
    icon: '🐉',
    timeEstimate: '30-45 min'
  },
  {
    id: 'sample-2',
    title: 'Forest Guardian Challenge',
    difficulty: 3,
    reward: '0.25 CELO + Rare NFT',
    description: 'Protect the ancient forest. A moderate challenge with fair rewards.',
    icon: '🌲',
    timeEstimate: '15-20 min'
  },
  {
    id: 'sample-3',
    title: 'Beginner\'s First Steps',
    difficulty: 1,
    reward: '0.1 CELO + Common NFT',
    description: 'Start your journey. A perfect introduction to QuestForge AI.',
    icon: '⚔️',
    timeEstimate: '5-10 min'
  }
];

// Daily CELO reward milestones
const DAILY_REWARD_MILESTONES = [
  { day: 1, amount: '0.0001 CELO', bonus: 'First claim' },
  { day: 2, amount: '0.0001 CELO', bonus: 'Streak active' },
  { day: 3, amount: '0.0001 CELO', bonus: 'Momentum built' },
  { day: 7, amount: '0.0001 CELO', bonus: 'Weekly streak' },
];

function SampleQuestCard({ quest }: { quest: typeof SAMPLE_QUESTS[0] }) {
  const rarityColors: Record<number, string> = {
    1: 'border-blue-400/50 bg-blue-500/10',
    2: 'border-purple-400/50 bg-purple-500/10',
    3: 'border-pink-400/50 bg-pink-500/10',
    4: 'border-orange-400/50 bg-orange-500/10',
    5: 'border-yellow-400/50 bg-yellow-500/10',
  };

  const rarityLabels: Record<number, string> = {
    1: 'Common',
    2: 'Uncommon',
    3: 'Rare',
    4: 'Epic',
    5: 'Legendary',
  };

  return (
    <motion.div
      whileHover={{ y: -4, scale: 1.02 }}
      className={`rounded-2xl border-2 p-6 backdrop-blur-xl transition-all ${rarityColors[quest.difficulty]}`}
    >
      <div className="flex items-start justify-between">
        <div className="text-3xl">{quest.icon}</div>
        <span className="rounded-full bg-glowyellow/20 px-3 py-1 text-xs font-semibold text-glowyellow">
          {rarityLabels[quest.difficulty]}
        </span>
      </div>
      <h3 className="mt-4 text-xl font-bold text-white">{quest.title}</h3>
      <p className="mt-2 text-sm text-slate-300">{quest.description}</p>
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">Reward:</span>
          <span className="font-semibold text-glowyellow">{quest.reward}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">Est. Time:</span>
          <span className="text-white">{quest.timeEstimate}</span>
        </div>
      </div>
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
      {/* Hero Section */}
      <section className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <motion.span 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="inline-flex items-center rounded-full border border-glowyellow/20 bg-glowyellow/10 px-4 py-2 text-xs uppercase tracking-[0.35em] text-glowyellow shadow-glow"
          >
            🚀 Powered by MiniPay & Celo
          </motion.span>
          <h1 className="max-w-3xl text-5xl font-black uppercase leading-tight tracking-[-0.05em] text-white md:text-6xl">
            Forge Your Destiny Onchain
          </h1>
          <p className="max-w-2xl text-lg text-slate-300">
            Real quests. Real rewards. Real blockchain. Generate AI-powered adventures, stake tokens on Celo, collect NFTs, and climb the leaderboard—all from your phone with MiniPay.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link to="/command-center"><GlowButton label="Play Now" /></Link>
            <motion.button
              whileHover={{ scale: 1.05 }}
              onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}
              className="rounded-full border border-white/30 bg-white/10 px-6 py-3 font-semibold text-white transition hover:bg-white/20"
            >
              See How It Works
            </motion.button>
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          className="glass-card rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl"
        >
          <div className="space-y-4">
            <div className="rounded-3xl border border-glowyellow/20 bg-gradient-to-br from-white/5 to-transparent p-6 shadow-glow">
              <p className="text-sm uppercase tracking-[0.3em] text-softyellow">📱 Mobile First</p>
              <h2 className="mt-4 text-2xl font-semibold text-white">Built for MiniPay</h2>
              <p className="mt-3 text-sm text-slate-300">Optimized for fast transactions and seamless wallet integration on mobile devices.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {['AI Quests', 'NFT Rewards', 'Live Leaderboards', 'Daily Streaks'].map((item) => (
                <div key={item} className="rounded-2xl border border-white/10 bg-navy/70 p-4 text-sm text-slate-200 shadow-glow">
                  {item}
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </section>

      {/* Daily Rewards Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold text-white">Daily Rewards & Retention</h2>
          <p className="mt-2 text-slate-400">Claim a real CELO payout once per UTC day and build your streak</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DAILY_REWARD_MILESTONES.map((bonus, idx) => (
            <motion.div
              key={bonus.day}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.1 }}
              className="rounded-2xl border border-green-400/30 bg-green-500/10 p-6 backdrop-blur-xl"
            >
              <div className="flex items-center justify-between">
                <span className="text-3xl font-black text-glowyellow">Day {bonus.day}</span>
                {bonus.day === 7 && <span className="text-2xl">👑</span>}
              </div>
              <p className="mt-3 text-sm text-slate-300">{bonus.bonus}</p>
              <p className="mt-2 text-lg font-bold text-green-400">+{bonus.amount}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Sample Quests Preview Section */}
      <section className="space-y-6" id="sample-quests">
        <div>
          <h2 className="text-3xl font-bold text-white">Adventure Awaits</h2>
          <p className="mt-2 text-slate-400">Sample quests from our AI-powered generation system</p>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {SAMPLE_QUESTS.map((quest, idx) => (
            <motion.div
              key={quest.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.1 }}
            >
              <SampleQuestCard quest={quest} />
            </motion.div>
          ))}
        </div>
        <motion.div
          whileHover={{ scale: 1.02 }}
          className="mt-8 rounded-2xl border-2 border-glowyellow/30 bg-gradient-to-r from-glowyellow/10 to-transparent p-8 text-center"
        >
          <p className="text-sm uppercase tracking-[0.2em] text-glowyellow">Start Your Adventure</p>
          <h3 className="mt-4 text-2xl font-bold text-white">Each quest generates uniquely with AI</h3>
          <p className="mt-3 text-slate-300">Connect your MiniPay wallet to generate your first personalized quest and start earning rewards.</p>
          <Link to="/command-center" className="mt-6 inline-block">
            <GlowButton label="Connect & Generate Quest" />
          </Link>
        </motion.div>
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" className="space-y-8">
        <div>
          <h2 className="text-3xl font-bold text-white">How It Works</h2>
          <p className="mt-2 text-slate-400">From player to legendary: the complete journey</p>
        </div>

        <div className="space-y-4">
          {[
            {
              step: '1',
              title: 'Connect MiniPay Wallet',
              description: 'Tap the connect button and sign in with your Celo MiniPay wallet. Works perfectly on mobile.',
              icon: '🔐'
            },
            {
              step: '2',
              title: 'Generate an AI Quest',
              description: 'Let our AI create a unique quest just for you. Every quest is different—fantasy stories, real challenges, tailored to your skill level.',
              icon: '✨'
            },
            {
              step: '3',
              title: 'Stake & Complete',
              description: 'Stake CELO tokens on the quest. Complete the challenge by providing proof (transaction hash, URL, or proof of work).',
              icon: '⚔️'
            },
            {
              step: '4',
              title: 'Earn Rewards',
              description: 'Proof verified? Earn CELO tokens, XP, and collect unique NFTs. Your rewards settle on-chain instantly.',
              icon: '🏆'
            },
            {
              step: '5',
              title: 'Build Your Streak',
              description: 'Return daily to build streaks and claim a backend-verified CELO payout once per UTC day.',
              icon: '🔥'
            },
            {
              step: '6',
              title: 'Climb the Leaderboard',
              description: 'Compete with players worldwide. Top performers earn recognition, rare NFTs, and exclusive achievements.',
              icon: '📈'
            },
          ].map((item, idx) => (
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

      {/* Competitive Differentiation */}
      <section className="grid gap-6 md:grid-cols-3">
        <div className="glass-card rounded-3xl border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
          <span className="text-sm uppercase tracking-[0.35em] text-glowyellow">🤖 AI Native</span>
          <h2 className="mt-4 text-2xl font-bold text-white">AI-Generated Stories</h2>
          <p className="mt-3 text-slate-300">Every quest is uniquely crafted by GPT-4o. No two quests are ever the same.</p>
        </div>
        <div className="glass-card rounded-3xl border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
          <span className="text-sm uppercase tracking-[0.35em] text-glowyellow">⛓️ On-Chain Value</span>
          <h2 className="mt-4 text-2xl font-bold text-white">Real Token Rewards</h2>
          <p className="mt-3 text-slate-300">Stake CELO tokens, earn CELO + NFTs. Every action is transparent on-chain.</p>
        </div>
        <div className="glass-card rounded-3xl border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
          <span className="text-sm uppercase tracking-[0.35em] text-glowyellow">📱 Mobile Perfect</span>
          <h2 className="mt-4 text-2xl font-bold text-white">MiniPay Optimized</h2>
          <p className="mt-3 text-slate-300">Built for fast mobile transactions with zero friction from wallet to reward.</p>
        </div>
      </section>

      {/* Final CTA */}
      <motion.section
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        className="rounded-3xl border-2 border-glowyellow bg-gradient-to-br from-glowyellow/20 via-transparent to-glowyellow/10 p-12 text-center"
      >
        <h2 className="text-4xl font-black text-white">Ready to Forge Your Destiny?</h2>
        <p className="mt-4 text-lg text-slate-300">Join players worldwide discovering the future of on-chain gaming.</p>
        <Link to="/command-center" className="mt-8 inline-block">
          <GlowButton label="Enter the Forge" />
        </Link>
      </motion.section>
    </motion.main>
  );
}

import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import GlowButton from '../components/GlowButton';

export default function HomePage() {
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mx-auto flex min-h-[calc(100vh-96px)] max-w-7xl flex-col gap-12 px-6 py-12"
    >
      <section className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <span className="inline-flex items-center rounded-full border border-glowyellow/20 bg-glowyellow/10 px-4 py-2 text-xs uppercase tracking-[0.35em] text-glowyellow shadow-glow">
            AI-powered fantasy onchain realm
          </span>
          <h1 className="max-w-3xl text-5xl font-black uppercase leading-tight tracking-[-0.05em] text-white md:text-6xl">
            Forge Your Destiny Onchain
          </h1>
          <p className="max-w-2xl text-lg text-slate-300">
            Step into QuestForge AI, where every mission becomes real blockchain activity. Accept AI-generated quests, stake tokens, unlock NFTs, and level up across the Celo network.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link to="/command-center"><GlowButton label="Enter the Command Center" /></Link>
            <Link to="/tavern"><GlowButton label="Meet the Forge Master" className="bg-white/10 text-white hover:bg-white/20" /></Link>
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          className="glass-card rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl"
        >
          <div className="space-y-6">
            <div className="rounded-3xl border border-glowyellow/20 bg-gradient-to-br from-white/5 to-transparent p-6 shadow-glow">
              <p className="text-sm uppercase tracking-[0.3em] text-softyellow">Active Realm Pulse</p>
              <h2 className="mt-4 text-2xl font-semibold text-white">Cosmic Forge Gateway</h2>
              <p className="mt-3 text-slate-300">AI quests are generating new staking and reward actions every few minutes. Your next NFT awaits.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {['Daily Challenges', 'NFT Gallery', 'Leaderboards', 'AI Lore'].map((item) => (
                <div key={item} className="rounded-3xl border border-white/10 bg-navy/70 p-4 text-sm text-slate-200 shadow-glow">
                  {item}
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="glass-card rounded-3xl border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
          <span className="text-sm uppercase tracking-[0.35em] text-glowyellow">Cinematic Interface</span>
          <h2 className="mt-4 text-3xl font-bold text-white">Magical blockchain visuals</h2>
          <p className="mt-3 text-slate-300">Immersive animations, floating runes, and dramatic quest panels turn every action into premium gameplay with real onchain impact.</p>
        </div>
        <div className="glass-card rounded-3xl border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
          <span className="text-sm uppercase tracking-[0.35em] text-glowyellow">Premium UX</span>
          <h2 className="mt-4 text-3xl font-bold text-white">Designed for MiniPay and mobile</h2>
          <p className="mt-3 text-slate-300">Fast, responsive, and optimized for wallet interactions so players can explore the Forge from any screen.</p>
        </div>
      </section>
    </motion.main>
  );
}

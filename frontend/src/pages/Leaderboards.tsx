import { motion } from 'framer-motion';
import { useRealtimeState } from '../context/RealtimeContext';
import { useWallet } from '../context/WalletContext';

export default function Leaderboards() {
  const { connectWallet, status } = useWallet();
  const { connectionStatus, hydrationStatus, leaderboard } = useRealtimeState();

  if (status !== 'connected') {
    return (
      <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto flex min-h-[calc(100vh-96px)] items-center justify-center px-6 py-12">
        <div className="glass-card w-full max-w-3xl rounded-3xl border border-white/10 bg-white/5 p-10 text-center shadow-strong backdrop-blur-xl">
          <h2 className="text-3xl font-bold text-white">Connect to view the Leaderboards</h2>
          <p className="mt-4 text-slate-300">ForgeChampion rankings update when your wallet is connected.</p>
          <button onClick={connectWallet} className="mt-8 rounded-full bg-glowyellow px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-navy shadow-glow transition hover:brightness-110">Connect Wallet</button>
        </div>
      </motion.main>
    );
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-6xl px-6 py-12">
      <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
        <div className="mb-8">
          <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Leaderboards</p>
          <h1 className="mt-3 text-4xl font-black text-white">Top Forge Champions</h1>
          <p className="mt-3 text-slate-300">Explore the most active wallets, highest XP earners, and the guardians of the realm.</p>
          <p className="mt-4 text-sm text-softyellow">
            Feed hydration: {hydrationStatus} • socket: {connectionStatus}
          </p>
        </div>
        <div className="grid gap-4">
          {leaderboard.map((player, index) => (
            <div key={player.id} className="group flex items-center justify-between gap-4 rounded-3xl border border-white/10 bg-navy/80 p-5 transition hover:border-glowyellow/30">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-softyellow">#{index + 1}</p>
                <p className="mt-2 text-lg font-semibold text-white">{player.wallet}</p>
                <p className="text-sm text-slate-400">XP {player.xp} • Level {player.level} • Quests {player.questCount}</p>
              </div>
              <div className="rounded-2xl bg-glowyellow/10 px-4 py-2 text-sm font-semibold text-softyellow">
                {index === 0 ? 'Leading' : 'Live'}
              </div>
            </div>
          ))}
          {leaderboard.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/10 bg-navy/50 p-6 text-slate-300">
              Waiting for realtime hydration to populate the current standings.
            </div>
          ) : null}
        </div>
      </div>
    </motion.main>
  );
}

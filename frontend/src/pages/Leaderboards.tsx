import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { getPlayerStats } from '../lib/api';

export default function Leaderboards() {
  const [leaders, setLeaders] = useState<any[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const response = await getPlayerStats('0x0000000000000000000000000000000000000000');
        setLeaders(response.data.leaderboard);
      } catch (error) {
        console.error(error);
      }
    }
    load();
  }, []);

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-6xl px-6 py-12">
      <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
        <div className="mb-8">
          <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Leaderboards</p>
          <h1 className="mt-3 text-4xl font-black text-white">Top Forge Champions</h1>
          <p className="mt-3 text-slate-300">Explore the most active wallets, highest XP earners, and the guardians of the realm.</p>
        </div>
        <div className="grid gap-4">
          {leaders.map((player, index) => (
            <div key={player.id} className="group flex items-center justify-between gap-4 rounded-3xl border border-white/10 bg-navy/80 p-5 transition hover:border-glowyellow/30">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-softyellow">#{index + 1}</p>
                <p className="mt-2 text-lg font-semibold text-white">{player.wallet}</p>
                <p className="text-sm text-slate-400">XP {player.xp} • Level {player.level} • Quests {player.questCount}</p>
              </div>
              <div className="px-4 py-2 rounded-2xl bg-glowyellow/10 text-sm font-semibold text-softyellow">Active</div>
            </div>
          ))}
        </div>
      </div>
    </motion.main>
  );
}

import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useContractKit } from '@celo/react-celo';
import GlowButton from '../components/GlowButton';
import QuestCard from '../components/QuestCard';
import LoadingScreen from '../components/LoadingScreen';
import { generateQuest, getPlayerStats, fetchDailyMissions } from '../lib/api';

export default function CommandCenter() {
  const { connect, address, network, destroy } = useContractKit();
  const [activeQuest, setActiveQuest] = useState(null as any);
  const [playerStats, setPlayerStats] = useState(null as any);
  const [dailyMissions, setDailyMissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function load() {
      if (!address) return;
      const stats = await getPlayerStats(address);
      setPlayerStats(stats.data.user);
      const daily = await fetchDailyMissions();
      setDailyMissions(daily.data.missions);
    }
    load();
  }, [address]);

  async function handleConnect() {
    await connect();
  }

  async function handleForgeQuest() {
    if (!address) return;
    setLoading(true);
    try {
      const response = await generateQuest(address);
      setActiveQuest(response.data.quest);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  if (!address) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-96px)] items-center justify-center px-6 py-12">
        <div className="glass-card w-full max-w-3xl rounded-3xl border border-white/10 bg-white/5 p-10 text-center shadow-strong backdrop-blur-xl">
          <h2 className="text-3xl font-bold text-white">Connect your wallet to begin the quest</h2>
          <p className="mt-4 text-slate-300">The Forge Master needs your Celo wallet to generate missions, stake, and mint rewards.</p>
          <GlowButton label="Connect Wallet" onClick={handleConnect} className="mt-8" />
        </div>
      </div>
    );
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-7xl px-6 py-12">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_0.6fr]">
        <div className="space-y-8">
          <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">QuestForge Command Center</p>
                <h1 className="mt-3 text-4xl font-black text-white">Forge Master AI Dashboard</h1>
              </div>
              <div className="space-y-2 rounded-3xl border border-glowyellow/20 bg-navy/80 p-4 text-sm text-slate-200 shadow-glow">
                <p>Wallet</p>
                <p className="font-semibold text-white">{address}</p>
                <p>Network: {network?.name ?? 'Celo'}</p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">XP Level</p>
                <p className="mt-2 text-3xl font-semibold">{playerStats?.level ?? '---'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">Quest Count</p>
                <p className="mt-2 text-3xl font-semibold">{playerStats?.questCount ?? '---'}</p>
              </div>
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Forge Mission</p>
                <h2 className="mt-3 text-3xl font-bold text-white">Summon a New Quest</h2>
              </div>
              <GlowButton label="Generate Quest" onClick={handleForgeQuest} />
            </div>
            {loading ? <LoadingScreen /> : activeQuest ? (
              <div className="mt-8 space-y-4">
                <QuestCard title={activeQuest.title} description={activeQuest.description} difficulty="Arcane" reward={`${activeQuest.rewardAmount} CELO`} status="Active" />
                <div className="rounded-3xl border border-white/10 bg-navy/80 p-4 text-sm text-slate-200">
                  <p className="font-semibold text-white">AI Lore</p>
                  <p className="mt-3">The Forge Master has encoded your mission in a glowing rune. Execute all required actions onchain to prove your valor.</p>
                </div>
              </div>
            ) : (
              <p className="mt-6 text-slate-300">No active quests. Press the button to summon a mission that generates a real transaction flow.</p>
            )}
          </div>
        </div>

        <aside className="space-y-6">
          <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Daily Events</p>
            <div className="mt-6 space-y-4">
              {dailyMissions.map((mission) => (
                <div key={mission.id} className="rounded-3xl border border-white/10 bg-navy/70 p-4 text-slate-200">
                  <p className="font-semibold text-white">{mission.title}</p>
                  <p className="mt-2 text-sm">{mission.description}</p>
                  <p className="mt-3 text-xs uppercase text-softyellow">Reward: {mission.reward}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Stake Flow</p>
            <ul className="mt-6 space-y-3 text-sm text-slate-200">
              <li>1. Start quest with stake transaction</li>
              <li>2. Interact with mission contract</li>
              <li>3. Submit proof and verify onchain</li>
              <li>4. Claim rewards and mint NFT</li>
            </ul>
          </div>
        </aside>
      </div>
    </motion.main>
  );
}

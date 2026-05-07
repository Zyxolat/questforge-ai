import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import GlowButton from '../components/GlowButton';
import QuestCard from '../components/QuestCard';
import LoadingScreen from '../components/LoadingScreen';
import { api, generateQuest, getPlayerStats, fetchDailyMissions } from '../lib/api';
import { contractAddresses, contractABIs, getContract } from '../lib/contracts';

export default function CommandCenter() {
  const { address, signer, network, status, connectWallet } = useWallet();
  const [activeQuest, setActiveQuest] = useState<any>(null);
  const [playerStats, setPlayerStats] = useState<any>(null);
  const [dailyMissions, setDailyMissions] = useState<any[]>([]);
  const [proofUri, setProofUri] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const forgeQuestManager = useMemo(() => {
    if (!signer) return null;
    return getContract(contractAddresses.forgeQuestManagerAddress, contractABIs.forgeQuestManagerAbi, signer);
  }, [signer]);

  useEffect(() => {
    async function load() {
      if (!address) return;
      setLoading(true);
      try {
        const stats = await getPlayerStats(address);
        setPlayerStats(stats.data.user);
        const daily = await fetchDailyMissions();
        setDailyMissions(daily.data.missions);
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [address]);

  async function handleGenerateQuest() {
    if (!address) {
      setMessage('Connect your wallet first.');
      return;
    }
    setLoading(true);
    setMessage('Summoning the Forge Master...');
    try {
      const response = await generateQuest(address);
      setActiveQuest(response.data.quest);
      setMessage('Quest generated. Ready to begin your journey.');
    } catch (error) {
      console.error(error);
      setMessage('Failed to generate quest.');
    } finally {
      setLoading(false);
    }
  }

  async function handleStartQuest() {
    if (!address || !forgeQuestManager || !activeQuest) return;
    setLoading(true);
    setMessage('Submitting your stake to the Forge...');

    try {
      const stakeValue = ethers.parseEther(activeQuest.stakeAmount.toString());
      const tx = await forgeQuestManager.startQuest(BigInt(activeQuest.chainQuestId), { value: stakeValue });
      const receipt = await tx.wait();
      await api.post('/quests/start', { wallet: address, questId: activeQuest.id });
      await api.post('/quests/record', { wallet: address, questId: activeQuest.id, txHash: receipt.transactionHash, type: 'START_QUEST', chainId: Number(receipt.chainId), details: { chainQuestId: activeQuest.chainQuestId } });
      setMessage('Quest started. The Forge acknowledges your stake.');
    } catch (error) {
      console.error(error);
      setMessage('Start quest transaction failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitProof() {
    if (!address || !forgeQuestManager || !activeQuest || !proofUri) {
      setMessage('Provide proof and connect wallet to submit.');
      return;
    }
    setLoading(true);
    setMessage('Submitting proof to the Forge Master...');
    try {
      const tx = await forgeQuestManager.submitQuest(BigInt(activeQuest.chainQuestId), proofUri);
      const receipt = await tx.wait();
      await api.post('/quests/submit', { wallet: address, questId: activeQuest.id, proofUri, txHash: receipt.transactionHash });
      setMessage('Proof submitted. The AI validation sequence is running.');
      setActiveQuest(null);
      setProofUri('');
    } catch (error) {
      console.error(error);
      setMessage('Proof submission failed.');
    } finally {
      setLoading(false);
    }
  }

  if (status !== 'connected') {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-96px)] items-center justify-center px-6 py-12">
        <div className="glass-card w-full max-w-3xl rounded-3xl border border-white/10 bg-white/5 p-10 text-center shadow-strong backdrop-blur-xl">
          <h2 className="text-3xl font-bold text-white">Connect your wallet to enter the Forge</h2>
          <p className="mt-4 text-slate-300">The QuestForge AI system requires a wallet with Celo support to generate real onchain quests.</p>
          <GlowButton label="Connect Wallet" onClick={connectWallet} className="mt-8" />
        </div>
      </div>
    );
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-7xl px-6 py-12">
      <div className="grid gap-8 lg:grid-cols-[0.95fr_0.65fr]">
        <div className="space-y-8">
          <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Command Center</p>
                <h1 className="mt-3 text-4xl font-black text-white">Forge Your Chain Legend</h1>
                <p className="mt-2 text-slate-300">Active wallet: {address}</p>
              </div>
              <div className="rounded-3xl border border-glowyellow/20 bg-navy/80 p-4 text-sm text-slate-200 shadow-glow">
                <p className="uppercase tracking-[0.25em] text-softyellow">Network</p>
                <p className="mt-2 text-lg font-semibold text-white">{network ?? 'Celo'}</p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">XP</p>
                <p className="mt-2 text-3xl font-semibold">{playerStats?.xp ?? '---'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">Level</p>
                <p className="mt-2 text-3xl font-semibold">{playerStats?.level ?? '---'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">Quests</p>
                <p className="mt-2 text-3xl font-semibold">{playerStats?.questCount ?? '---'}</p>
              </div>
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Active Mission</p>
                <h2 className="mt-3 text-3xl font-bold text-white">Forge a New Onchain Quest</h2>
              </div>
              <GlowButton label="Generate Quest" onClick={handleGenerateQuest} />
            </div>
            {loading ? (
              <LoadingScreen />
            ) : activeQuest ? (
              <div className="mt-8 space-y-4">
                <QuestCard title={activeQuest.title} description={activeQuest.description} difficulty={`Tier ${activeQuest.difficulty}`} reward={`${activeQuest.rewardAmount} CELO`} status={activeQuest.status || 'AVAILABLE'} />
                <div className="grid gap-4 sm:grid-cols-3">
                  <GlowButton label="Start Quest" onClick={handleStartQuest} />
                  <GlowButton label="Submit Proof" onClick={handleSubmitProof} className="bg-white/10 text-white hover:bg-white/20" />
                </div>
                <textarea value={proofUri} onChange={(e) => setProofUri(e.target.value)} placeholder="Enter quest proof URL or final task hash" className="w-full rounded-3xl border border-white/10 bg-navy/80 p-4 text-slate-100 outline-none" rows={3} />
              </div>
            ) : (
              <p className="mt-6 text-slate-300">No active quest loaded. Generate AI-driven in-game missions to create real Celo transactions and earn rewards.</p>
            )}
            {message ? <p className="mt-4 text-sm text-softyellow">{message}</p> : null}
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
            <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Onchain Activity</p>
            <p className="mt-4 text-slate-300">Every quest in QuestForge AI is built to generate meaningful blockchain activity: staking, mission interaction, proof submission, AI validation, and rewards.</p>
          </div>
        </aside>
      </div>
    </motion.main>
  );
}

import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import QuestCard from '../components/QuestCard';
import GlowButton from '../components/GlowButton';
import LoadingScreen from '../components/LoadingScreen';
import { QuestState, useRealtimeState } from '../context/RealtimeContext';
import { useWallet } from '../context/WalletContext';
import { extractAuthFailure, fetchDailyMissions, generateQuest, submitProofForVerification } from '../lib/api';
import { contractAddresses, contractABIs, getContract } from '../lib/contracts';
import { env } from '../lib/env';

type DailyMission = {
  id: string;
  title: string;
  description: string;
  reward: string;
};

type GeneratedQuestTemplate = QuestState & {
  title: string;
  metadataUri: string;
  stakeAmount: string | number;
  rewardAmount: string | number;
  xpReward: string | number;
  durationSeconds: string | number;
};

function questMatcher(quest: QuestState | null) {
  return {
    id: quest?.id ?? undefined,
    chainQuestId: quest?.chainQuestId ?? undefined,
    orchestrationId: quest?.orchestrationId ?? undefined
  };
}

export default function CommandCenter() {
  const {
    address,
    signer,
    network,
    chainId,
    isCorrectNetwork,
    isMiniPay,
    status,
    authStatus,
    authMessage,
    isAuthReady,
    connectWallet,
    authenticateWallet,
    switchCeloNetwork
  } = useWallet();
  const {
    activeQuest,
    connectionStatus,
    player,
    syncNow,
    upsertQuest,
    patchQuest
  } = useRealtimeState();
  const [dailyMissions, setDailyMissions] = useState<DailyMission[]>([]);
  const [proofUri, setProofUri] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const forgeQuestManager = useMemo(() => {
    if (!signer) return null;
    return getContract(contractAddresses.forgeQuestManagerAddress, contractABIs.forgeQuestManagerAbi, signer);
  }, [signer]);

  useEffect(() => {
    async function loadDailyMissionsOnce() {
      try {
        const daily = await fetchDailyMissions();
        setDailyMissions(daily.data.missions as DailyMission[]);
      } catch (error) {
        console.error(error);
      }
    }

    void loadDailyMissionsOnce();
  }, []);

  function payoutStatusForQuest(quest: QuestState | null) {
    if (quest?.treasuryPayout?.status) {
      return quest.treasuryPayout.status;
    }

    if (quest?.status === 'VERIFIED') return 'PAID';
    if (quest?.status === 'FAILED' || quest?.status === 'CANCELLED') return 'REFUNDED';
    if (quest?.status === 'ACTIVE' || quest?.status === 'SUBMITTED') return 'LOCKED';
    return 'RESERVED';
  }

  async function requireReadyAuth(actionLabel: string) {
    if (!isAuthReady || authStatus === 'restoring') {
      setMessage('Restoring your secure session. Please wait a moment.');
      return false;
    }

    if (!isCorrectNetwork) {
      setMessage(`Switch to ${env.CELO_CHAIN_NAME} before ${actionLabel.toLowerCase()}. Detected ${network ?? 'an unsupported network'}.`);
      return false;
    }

    if (authStatus !== 'authenticated') {
      setMessage(authMessage || `Requesting wallet signature before ${actionLabel.toLowerCase()}...`);
      const authenticated = await authenticateWallet();
      if (!authenticated) {
        setMessage(authMessage || `Sign your wallet challenge before ${actionLabel.toLowerCase()}.`);
        return false;
      }
    }

    return true;
  }

  function parseQuestCreatedId(receipt: ethers.TransactionReceipt | null) {
    if (!forgeQuestManager) return null;

    const parsedLog = receipt?.logs
      ?.map((log) => {
        try {
          return forgeQuestManager.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((item) => item?.name === 'QuestCreated');

    if (!parsedLog?.args?.questId) {
      return null;
    }

    return parsedLog.args.questId.toString();
  }

  async function handleGenerateQuest() {
    if (!address || !forgeQuestManager) {
      setMessage('Connect your wallet first.');
      return;
    }
    if (!(await requireReadyAuth('generating quests'))) {
      return;
    }

    setLoading(true);
    setMessage('Summoning the Forge Master...');
    try {
      console.debug('[CommandCenter] Starting generate quest flow', {
        wallet: address,
        chainId,
        network
      });

      const response = await generateQuest('Celo');
      const template = response.data.quest as GeneratedQuestTemplate;

      console.debug('[CommandCenter] Quest template received', {
        questId: template.id,
        orchestrationId: template.orchestrationId,
        rewardAmount: template.rewardAmount,
        stakeAmount: template.stakeAmount,
        xpReward: template.xpReward
      });

      const tx = await forgeQuestManager.createQuest(
        template.title,
        template.metadataUri,
        ethers.parseEther(template.stakeAmount.toString()),
        ethers.parseEther(template.rewardAmount.toString()),
        BigInt(template.xpReward),
        BigInt(template.durationSeconds)
      );
      const receipt = await tx.wait();
      const chainQuestId = parseQuestCreatedId(receipt);
      if (!chainQuestId) {
        throw new Error('Quest creation receipt did not include a quest id');
      }

      upsertQuest({
        ...template,
        chainQuestId,
        creator: address,
        status: 'AVAILABLE',
        treasuryPayout: {
          status: 'RESERVED'
        }
      });
      setMessage('Quest forged onchain. Realtime state is tracking it now.');
      await syncNow();
    } catch (error) {
      console.error('[CommandCenter] Generate quest flow failed', error);
      const failure = extractAuthFailure(error);
      console.debug('[CommandCenter] Generate quest failure extracted', {
        code: failure.code,
        status: failure.status,
        message: failure.message,
        details: failure.details
      });

      const detailText = failure.details?.length ? ` ${failure.details.join(' ')}` : '';
      setMessage(`${failure.message}${detailText}`.trim());
    } finally {
      setLoading(false);
    }
  }

  async function handleStartQuest() {
    if (!address || !forgeQuestManager || !activeQuest) return;
    if (!(await requireReadyAuth('starting quests'))) {
      return;
    }

    setLoading(true);
    setMessage('Submitting your stake to the Forge...');

    try {
      const stakeValue = ethers.parseEther(String(activeQuest.stakeAmount));
      const tx = await forgeQuestManager.startQuest(BigInt(String(activeQuest.chainQuestId)), { value: stakeValue });
      await tx.wait();

      patchQuest(questMatcher(activeQuest), {
        status: 'ACTIVE',
        treasuryPayout: {
          ...(activeQuest.treasuryPayout || {}),
          status: 'LOCKED'
        }
      });
      setMessage('Quest started onchain. Waiting for realtime reconciliation.');
      await syncNow();
    } catch (error) {
      console.error(error);
      const failure = extractAuthFailure(error);
      setMessage(failure.code === 'AUTH_UNKNOWN' ? 'Start quest transaction failed.' : failure.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitProof() {
    if (!address || !forgeQuestManager || !activeQuest || !proofUri) {
      setMessage('Provide proof and connect wallet to submit.');
      return;
    }
    if (activeQuest.status !== 'ACTIVE') {
      setMessage('Start the quest onchain before submitting proof.');
      return;
    }
    if (!(await requireReadyAuth('submitting proof'))) {
      return;
    }

    setLoading(true);
    setMessage('Submitting proof to the Forge Master...');

    try {
      const submitTx = await forgeQuestManager.submitQuest(BigInt(String(activeQuest.chainQuestId)), proofUri);
      await submitTx.wait();

      patchQuest(questMatcher(activeQuest), { status: 'SUBMITTED' });
      if (!activeQuest.id) {
        throw new Error('Quest is missing a persistent id');
      }

      await submitProofForVerification(activeQuest.id, proofUri, submitTx.hash);
      setMessage('Proof submitted onchain and queued for deterministic verification. Realtime settlement updates will stream here.');
      await syncNow();
      setProofUri('');
    } catch (error) {
      console.error(error);
      const failure = extractAuthFailure(error);
      setMessage(failure.code === 'AUTH_UNKNOWN' ? 'Proof submission failed.' : failure.message);
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
                <p className="mt-2 text-sm text-softyellow">
                  Auth session:{' '}
                  {authStatus === 'authenticated'
                    ? 'signed in'
                    : authStatus === 'authenticating'
                      ? 'awaiting signature'
                      : authStatus === 'restoring'
                        ? 'restoring session'
                        : authStatus === 'expired'
                          ? 'session expired'
                          : authStatus === 'error'
                            ? 'attention required'
                            : 'signature required'}
                </p>
              </div>
              <div className="rounded-3xl border border-glowyellow/20 bg-navy/80 p-4 text-sm text-slate-200 shadow-glow">
                <p className="uppercase tracking-[0.25em] text-softyellow">Network</p>
                <p className="mt-2 text-lg font-semibold text-white">{network ?? 'No network detected'}</p>
                <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                  Expected: {env.CELO_CHAIN_NAME} ({env.CELO_CHAIN_ID})
                </p>
                <p className={`mt-2 text-sm ${isCorrectNetwork ? 'text-emerald-200' : 'text-amber-200'}`}>
                  {isCorrectNetwork
                    ? 'Connected to the supported Celo Mainnet network.'
                    : `Unsupported network detected${chainId ? ` (chain ${chainId})` : ''}.`}
                </p>
                {isMiniPay ? <p className="mt-2 text-xs uppercase tracking-[0.18em] text-softyellow">MiniPay detected</p> : null}
                {!isCorrectNetwork ? (
                  <button onClick={switchCeloNetwork} className="mt-3 text-xs font-semibold uppercase tracking-[0.2em] text-glowyellow transition hover:text-softyellow">
                    Switch To Celo Mainnet
                  </button>
                ) : null}
              </div>
            </div>
            {authStatus !== 'authenticated' ? (
              <div className="mt-6 rounded-3xl border border-glowyellow/20 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">Secure Sign-In Required</p>
                <p className="mt-2 text-slate-300">
                  {authStatus === 'restoring'
                    ? 'Restoring your secure session before protected quest actions unlock.'
                    : authMessage || 'Quest mutations are locked until you sign a one-time wallet nonce.'}
                </p>
                <GlowButton
                  label={
                    authStatus === 'authenticating'
                      ? 'Awaiting Signature'
                      : authStatus === 'restoring'
                        ? 'Restoring Session'
                        : authStatus === 'expired'
                          ? 'Sign In Again'
                          : 'Sign In With Wallet'
                  }
                  onClick={authenticateWallet}
                  className="mt-4"
                  disabled={authStatus === 'authenticating' || authStatus === 'restoring'}
                />
              </div>
            ) : null}
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">XP</p>
                <p className="mt-2 text-3xl font-semibold">{player?.xp ?? '---'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">Level</p>
                <p className="mt-2 text-3xl font-semibold">{player?.level ?? '---'}</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-navy/70 p-5 text-white">
                <p className="text-sm uppercase tracking-[0.25em] text-softyellow">Quests</p>
                <p className="mt-2 text-3xl font-semibold">{player?.questCount ?? '---'}</p>
              </div>
            </div>
            <div className="mt-4 rounded-3xl border border-white/10 bg-navy/60 p-4 text-sm text-slate-200">
              <p className="uppercase tracking-[0.22em] text-softyellow">Realtime Link</p>
              <p className="mt-2">
                Hydration is replay-backed and websocket-first. Connection status: <span className="font-semibold text-white">{connectionStatus}</span>
              </p>
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Active Mission</p>
                <h2 className="mt-3 text-3xl font-bold text-white">Forge a New Onchain Quest</h2>
              </div>
              <GlowButton label={authStatus === 'restoring' ? 'Restoring Session' : 'Generate Quest'} onClick={handleGenerateQuest} disabled={loading || authStatus === 'restoring'} />
            </div>
            {loading ? (
              <LoadingScreen />
            ) : activeQuest ? (
              <div className="mt-8 space-y-4">
                <QuestCard
                  title={activeQuest.title ?? 'Unnamed Quest'}
                  description={activeQuest.description ?? 'Description pending realtime hydration.'}
                  difficulty={`Tier ${activeQuest.difficulty ?? '?'}`}
                  reward={`${activeQuest.rewardAmount ?? '?'} CELO`}
                  status={activeQuest.status || 'AVAILABLE'}
                  payoutStatus={payoutStatusForQuest(activeQuest)}
                  treasuryPayout={activeQuest.treasuryPayout}
                  verificationTx={typeof activeQuest.verificationTx === 'string' ? activeQuest.verificationTx : null}
                  proofTxHash={
                    typeof activeQuest.proofTx === 'string'
                      ? activeQuest.proofTx
                      : typeof activeQuest.proofTxHash === 'string'
                        ? activeQuest.proofTxHash
                        : null
                  }
                  explorerBaseUrl={env.CELO_EXPLORER_BASE_URL}
                />
                <div className="rounded-3xl border border-white/10 bg-navy/70 p-4 text-sm text-slate-200">
                  <p className="uppercase tracking-[0.22em] text-softyellow">Treasury Settlement</p>
                  <p className="mt-2">
                    {activeQuest.status === 'SUBMITTED'
                      ? 'Reward reserved and stake locked. Waiting for verifier settlement through Treasury.'
                      : payoutStatusForQuest(activeQuest) === 'PAID'
                        ? 'Treasury payout completed and recorded onchain.'
                        : payoutStatusForQuest(activeQuest) === 'REFUNDED'
                          ? 'Treasury released the reservation and refunded the locked stake.'
                          : 'Treasury has reserved the reward for this quest.'}
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  {activeQuest.status === 'AVAILABLE' ? <GlowButton label="Start Quest" onClick={handleStartQuest} disabled={loading || authStatus === 'restoring'} /> : null}
                  {activeQuest.status === 'ACTIVE' ? <GlowButton label="Submit Proof" onClick={handleSubmitProof} className="bg-white/10 text-white hover:bg-white/20" disabled={loading || authStatus === 'restoring'} /> : null}
                </div>
                <textarea value={proofUri} onChange={(event) => setProofUri(event.target.value)} placeholder="Enter quest proof URL or final task hash" className="w-full rounded-3xl border border-white/10 bg-navy/80 p-4 text-slate-100 outline-none" rows={3} />
              </div>
            ) : (
              <p className="mt-6 text-slate-300">
                {isAuthReady ? 'No active quest loaded. Generate AI-driven in-game missions to create real Celo transactions and earn rewards.' : 'Loading wallet and secure session state...'}
              </p>
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

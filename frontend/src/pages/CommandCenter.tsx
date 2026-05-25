import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import QuestFlowTracker from '../components/QuestFlowTracker';
import ActiveQuestPanel from '../components/ActiveQuestPanel';
import ProofSubmissionPanel from '../components/ProofSubmissionPanel';
import TransactionStatusCard from '../components/TransactionStatusCard';
import QuestRevealModal from '../components/QuestRevealModal';
import QuestCompletionModal from '../components/QuestCompletionModal';
import RewardAnimation from '../components/RewardAnimation';
import LoadingScreen from '../components/LoadingScreen';
import { QuestState, useRealtimeState } from '../context/RealtimeContext';
import { useWallet } from '../context/WalletContext';
import { extractAuthFailure, fetchDailyMissions, generateQuest, registerOnchainQuest, registerQuestStart, submitProofForVerification } from '../lib/api';
import { contractAddresses, contractABIs, getContract } from '../lib/contracts';
import { env } from '../lib/env';
import { parseReceiptEvent } from '../lib/questTransactions';
import { describeTransactionFailure, formatCeloAmount } from '../lib/transactionDiagnostics';
import { estimateContractWriteGas, sendContractWrite, waitForTransactionReceipt } from '../lib/walletProvider';

type DailyMission = { id: string; title: string; description: string; reward: string };
type GeneratedQuestTemplate = QuestState & { title: string; metadataUri: string; stakeAmount: string | number; rewardAmount: string | number; xpReward: string | number; durationSeconds: string | number };
type TxStatusType = 'pending' | 'success' | 'error' | 'confirmed';

function questMatcher(quest: QuestState | null) {
  return { id: quest?.id ?? undefined, chainQuestId: quest?.chainQuestId ?? undefined, orchestrationId: quest?.orchestrationId ?? undefined };
}

function formatActionFailure(error: unknown, fallbackLabel: string) {
  const txFailure = describeTransactionFailure(error);
  if (txFailure.kind !== 'unknown') {
    const details = (Array.isArray(txFailure.details) ? txFailure.details : []).slice(0, 2).join(' ');
    return details ? `${txFailure.message} ${details}`.trim() : txFailure.message;
  }
  const authFailure = extractAuthFailure(error);
  const detailText = (authFailure.details && Array.isArray(authFailure.details) && authFailure.details.length) ? ` ${authFailure.details.join(' ')}` : '';
  if (authFailure.code !== 'AUTH_UNKNOWN' || authFailure.message) {
    return `${(authFailure.message || '')}${detailText}`.trim();
  }
  return fallbackLabel;
}

export default function CommandCenter() {
  const { address, balance, signer, provider, network, isCorrectNetwork, isMiniPay, walletProvider, status, authStatus, authMessage, isAuthReady, connectWallet, authenticateWallet, switchCeloNetwork } = useWallet();
  const { activeQuest, player, syncNow, refreshQuestFeed, upsertQuest, patchQuest, getQuest } = useRealtimeState();
  const [dailyMissions, setDailyMissions] = useState<DailyMission[]>([]);
  const [proofUri, setProofUri] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [revealQuestModal, setRevealQuestModal] = useState(false);
  const [completionModal, setCompletionModal] = useState(false);
  const [showRewardAnimation, setShowRewardAnimation] = useState(false);
  const [rewardData, setRewardData] = useState({ xp: 0, token: '0', nft: 'Rare' });
  const [txStatus, setTxStatus] = useState<{ type: TxStatusType; hash?: string; label?: string; message?: string } | null>(null);
  const [lastGeneratedQuest, setLastGeneratedQuest] = useState<QuestState | null>(null);

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

  // Watch for quest completion
  useEffect(() => {
    if (activeQuest?.status === 'VERIFIED' && !showRewardAnimation) {
      setRewardData({
        xp: Number(activeQuest.xpReward) || 0,
        token: String(activeQuest.rewardAmount || '0'),
        nft: activeQuest.difficulty === 5 ? 'Legendary' : activeQuest.difficulty === 4 ? 'Epic' : activeQuest.difficulty === 3 ? 'Rare' : activeQuest.difficulty === 2 ? 'Uncommon' : 'Common'
      });
      setShowRewardAnimation(true);
      // Show completion modal after animation completes
      setTimeout(() => {
        setCompletionModal(true);
      }, 3000);
    }
  }, [activeQuest?.status]);

  const getFlowStep = (): 'PENDING' | 'GENERATED' | 'ACCEPTED' | 'ACTIVE' | 'SUBMITTED' | 'VERIFIED' | 'COMPLETED' => {
    if (!activeQuest) return 'PENDING';
    if (activeQuest.status === 'VERIFIED') return 'COMPLETED';
    if (activeQuest.status === 'SUBMITTED') return 'SUBMITTED';
    if (activeQuest.status === 'ACTIVE') return 'ACTIVE';
    if (activeQuest.status === 'AVAILABLE' && activeQuest.chainQuestId) return 'ACCEPTED';
    if (activeQuest.status === 'AVAILABLE') return 'GENERATED';
    return 'PENDING';
  };

  async function submitForgeWrite(functionName: 'createQuest' | 'startQuest' | 'submitQuest', args: unknown[], options?: { value?: bigint; gasLimit?: bigint }) {
    if (!forgeQuestManager) throw new Error('Contract interface is not ready');
    if (!provider) throw new Error('Wallet provider is not ready');
    if (!address) throw new Error('Wallet address is not available');

    try {
      if (!isMiniPay) {
        if (!signer) throw new Error('Wallet signer is unavailable');
        const transactionMethod = (forgeQuestManager as ethers.Contract)[functionName] as (...methodArgs: unknown[]) => Promise<ethers.ContractTransactionResponse>;
        if (typeof transactionMethod !== 'function') throw new Error(`Transaction method ${functionName} not found`);
        const tx = await transactionMethod(...args, { ...(typeof options?.value === 'bigint' ? { value: options.value } : {}), ...(typeof options?.gasLimit === 'bigint' ? { gasLimit: options.gasLimit } : {}) });
        setTxStatus({ type: 'pending', hash: tx.hash, label: `${functionName} pending`, message: 'Waiting for confirmation...' });
        const receipt = await tx.wait();
        setTxStatus({ type: 'confirmed', hash: tx.hash, label: `${functionName} confirmed`, message: 'Transaction confirmed!' });
        return { hash: tx.hash, receipt };
      } else {
        if (!walletProvider) throw new Error('MiniPay provider is unavailable');
        const signerAddress = await signer?.getAddress();
        const gasLimit = options?.gasLimit ?? (await estimateContractWriteGas({ provider: walletProvider, contractAddress: contractAddresses.forgeQuestManagerAddress, contractInterface: forgeQuestManager.interface, functionName, args, from: signerAddress || address, ...(typeof options?.value === 'bigint' ? { value: options.value } : {}) }));
        const { txHash } = await sendContractWrite({ provider: walletProvider, contractAddress: contractAddresses.forgeQuestManagerAddress, contractInterface: forgeQuestManager.interface, functionName, args, from: address, gasLimit, ...(typeof options?.value === 'bigint' ? { value: options.value } : {}) });
        setTxStatus({ type: 'pending', hash: txHash, label: `${functionName} submitted`, message: 'Awaiting blockchain confirmation...' });
        const receipt = await waitForTransactionReceipt(provider, txHash);
        setTxStatus({ type: 'confirmed', hash: txHash, label: `${functionName} confirmed`, message: 'Transaction confirmed!' });
        return { hash: txHash, receipt };
      }
    } catch (error) {
      setTxStatus({ type: 'error', hash: undefined, label: 'Transaction failed', message: formatActionFailure(error, 'Transaction failed') });
      throw error;
    }
  }

  async function resolveQuestForChainAction(quest: QuestState, fallbackMessage: string) {
    let latestQuest = getQuest(questMatcher(quest)) ?? quest;
    if (latestQuest.chainQuestId) return latestQuest;
    setMessage('Quest is syncing with backend. Refreshing quest feed and realtime state...');
    for (let attempt = 1; attempt <= 3 && !latestQuest.chainQuestId; attempt += 1) {
      await refreshQuestFeed();
      latestQuest = getQuest(questMatcher(quest)) ?? latestQuest;
      if (latestQuest.chainQuestId) break;
      await syncNow();
      latestQuest = getQuest(questMatcher(quest)) ?? latestQuest;
      if (latestQuest.chainQuestId) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      latestQuest = getQuest(questMatcher(quest)) ?? latestQuest;
    }
    if (!latestQuest.chainQuestId) throw new Error(fallbackMessage);
    return latestQuest;
  }

  async function registerOnchainQuestWithRetry(questId: string, chainQuestId: string, creationTxHash: string, maxRetries = 3): Promise<QuestState | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const registrationResponse = await registerOnchainQuest(questId, chainQuestId, creationTxHash);
        const registeredQuest = (registrationResponse.data as { quest?: QuestState }).quest;
        if (registeredQuest) return registeredQuest;
        return null;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  async function handleGenerateQuest() {
    if (!address || !forgeQuestManager) {
      setMessage('Connect your wallet first.');
      return;
    }
    if (!(await requireReadyAuth('generating quests'))) return;

    setLoading(true);
    setMessage('Summoning the Forge Master... The AI is crafting your quest...');
    setTxStatus(null);
    try {
      const response = await generateQuest('Celo');
      const template = response.data.quest as GeneratedQuestTemplate;

      const createQuestArgs = [
        template.title,
        template.metadataUri,
        ethers.parseEther(template.stakeAmount.toString()),
        ethers.parseEther(template.rewardAmount.toString()),
        BigInt(template.xpReward),
        BigInt(template.durationSeconds)
      ] as const;

      const { hash: creationTxHash, receipt } = await submitForgeWrite('createQuest', [...createQuestArgs]);
      const parsedLog = parseReceiptEvent(receipt, { contractAddress: contractAddresses.forgeQuestManagerAddress, contractInterface: forgeQuestManager.interface }, 'QuestCreated');
      const chainQuestId = parsedLog?.args?.questId?.toString();
      if (!chainQuestId) throw new Error('Quest creation receipt did not include a quest id');

      let persistedQuest: QuestState = { ...template, chainQuestId, creator: address, status: 'AVAILABLE', treasuryPayout: { status: 'RESERVED' } };

      setMessage('Quest forged onchain. Syncing with backend...');
      try {
        const registeredQuest = await registerOnchainQuestWithRetry(String(template.id), chainQuestId, creationTxHash);
        if (registeredQuest) persistedQuest = { ...persistedQuest, ...registeredQuest };
        setMessage('✨ Quest generated! Click "Begin Quest" to accept and start the adventure.');
      } catch (registrationError) {
        console.error('[CommandCenter] Backend onchain quest registration failed after retries', registrationError);
        setMessage(`Quest forged onchain! You can still begin it, but backend sync is delayed.`);
      }

      setLastGeneratedQuest(persistedQuest);
      setRevealQuestModal(true);
      upsertQuest(persistedQuest);
      await syncNow();
    } catch (error) {
      console.error('[CommandCenter] Generate quest flow failed', error);
      setMessage(formatActionFailure(error, 'Quest creation failed.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleStartQuest() {
    if (!address || !forgeQuestManager || !activeQuest || !signer) return;
    if (!(await requireReadyAuth('starting quests'))) return;

    setLoading(true);
    setMessage('Accepting the quest and locking stake onchain...');
    setTxStatus(null);

    try {
      const resolvedQuest = await resolveQuestForChainAction(activeQuest, 'Quest is still missing its onchain id after sync. Please wait a moment and try again.');
      setMessage('Quest sync complete. Starting quest on Celo...');

      if (!provider) throw new Error('Wallet provider is unavailable');

      const signerAddress = await signer.getAddress();
      const chainQuestId = BigInt(String(resolvedQuest.chainQuestId));
      const onchainQuest = await forgeQuestManager.quests(chainQuestId);
      if (Number(onchainQuest.status) !== 0) throw new Error(`Quest is no longer available`);

      const stakeValue = BigInt(onchainQuest.stakeAmount.toString());
      const availableBalance = await provider.getBalance(signerAddress);
      if (availableBalance < stakeValue) throw new Error(`Insufficient funds for the quest stake. Need ${formatCeloAmount(stakeValue)} CELO`);

      const gasEstimate =
        isMiniPay && walletProvider
          ? await estimateContractWriteGas({ provider: walletProvider, contractAddress: contractAddresses.forgeQuestManagerAddress, contractInterface: forgeQuestManager.interface, functionName: 'startQuest', args: [chainQuestId], from: signerAddress, value: stakeValue })
          : await forgeQuestManager.startQuest.estimateGas(chainQuestId, { value: stakeValue });

      const gasLimit = gasEstimate + gasEstimate / 5n;
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const estimatedGasCost = gasEstimate * gasPrice;

      if (availableBalance < stakeValue + estimatedGasCost) throw new Error(`Insufficient funds for stake plus gas`);

      const { hash: startTxHash } = await submitForgeWrite('startQuest', [chainQuestId], { value: stakeValue, gasLimit });

      let persistedQuest: QuestState = { ...resolvedQuest, status: 'ACTIVE', treasuryPayout: { ...(resolvedQuest.treasuryPayout || {}), status: 'LOCKED' } };

      if (resolvedQuest.id) {
        try {
          const startRegistrationResponse = await registerQuestStart(String(resolvedQuest.id), chainQuestId.toString(), startTxHash);
          const registeredQuest = (startRegistrationResponse.data as { quest?: QuestState }).quest;
          if (registeredQuest) persistedQuest = { ...persistedQuest, ...registeredQuest };
        } catch (registrationError) {
          console.error('[CommandCenter] Backend quest start registration failed', registrationError);
        }
      }

      upsertQuest(persistedQuest);
      setMessage('⚡ Quest started! Your stake is now locked. Complete the mission objectives and submit your proof.');
      await syncNow();
    } catch (error) {
      console.error('[CommandCenter] startQuest failed', error);
      setMessage(formatActionFailure(error, 'Start quest transaction failed.'));
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
    if (!(await requireReadyAuth('submitting proof'))) return;

    setLoading(true);
    setMessage('Submitting proof to the Forge Master for verification...');
    setTxStatus(null);

    try {
      const resolvedQuest = await resolveQuestForChainAction(activeQuest, 'Quest is still missing its onchain id after sync. Please wait a moment and try again.');
      setMessage('Quest sync complete. Submitting proof...');

      const chainQuestId = BigInt(String(resolvedQuest.chainQuestId));
      const { hash: submissionTxHash } = await submitForgeWrite('submitQuest', [chainQuestId, proofUri]);

      patchQuest(questMatcher(resolvedQuest), { status: 'SUBMITTED' });
      if (!resolvedQuest.id) throw new Error('Quest is missing a persistent id');

      await submitProofForVerification(resolvedQuest.id, proofUri, submissionTxHash);
      setMessage('✓ Proof submitted! The AI Dungeon Master is verifying your quest completion. Rewards will stream in realtime.');
      await syncNow();
      setProofUri('');
    } catch (error) {
      console.error('[CommandCenter] submitQuest failed', error);
      setMessage(formatActionFailure(error, 'Proof submission failed.'));
    } finally {
      setLoading(false);
    }
  }

  async function requireReadyAuth(actionLabel: string) {
    if (!isAuthReady || authStatus === 'restoring') {
      setMessage('Restoring your secure session. Please wait a moment.');
      return false;
    }
    if (!isCorrectNetwork) {
      setMessage(`Switch to ${env.CELO_CHAIN_NAME} before ${actionLabel.toLowerCase()}.`);
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

  if (status !== 'connected') {
    return (
      <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto flex min-h-[calc(100vh-96px)] items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl rounded-3xl border-2 border-glowyellow bg-gradient-to-br from-navy via-deepnavy to-navy p-12 text-center shadow-2xl">
          <motion.div animate={{ scale: [1, 1.05, 1] }} transition={{ duration: 2, repeat: Infinity }} className="text-6xl mb-6">
            ⚔️
          </motion.div>
          <h2 className="text-4xl font-black text-glowyellow">Enter the Forge</h2>
          <p className="mt-4 text-lg text-slate-300">Connect your wallet to begin your AI-powered quest across the Celo blockchain.</p>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={connectWallet}
            className="mt-8 rounded-2xl bg-gradient-to-r from-glowyellow to-softyellow px-8 py-4 font-bold uppercase tracking-[0.2em] text-navy shadow-lg hover:shadow-2xl transition"
          >
            Connect Wallet
          </motion.button>
        </div>
      </motion.main>
    );
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-7xl px-4 py-8 md:px-6 md:py-12">
      <QuestRevealModal isOpen={revealQuestModal} quest={lastGeneratedQuest} onClose={() => setRevealQuestModal(false)} onAccept={() => { setRevealQuestModal(false); handleStartQuest(); }} loading={loading} />
      <QuestCompletionModal isOpen={completionModal} quest={activeQuest} onClose={() => setCompletionModal(false)} onGenerateNew={() => { setCompletionModal(false); handleGenerateQuest(); }} />
      <RewardAnimation show={showRewardAnimation} xpAmount={rewardData.xp} tokenAmount={rewardData.token} nftRarity={rewardData.nft} onComplete={() => setShowRewardAnimation(false)} />

      <div className="space-y-8">
        {/* Wallet Status Section */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-[2.5rem] border-2 border-glowyellow/40 bg-gradient-to-br from-navy/60 to-deepnavy/40 p-6 md:p-8 shadow-xl backdrop-blur-xl">
          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Connected Wallet</p>
              <p className="mt-2 font-mono text-sm text-white">{address?.slice(0, 10)}...{address?.slice(-8)}</p>
              <p className="mt-1 text-xs text-slate-400">Balance: {balance} CELO</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Network</p>
              <p className="mt-2 text-sm text-white font-semibold">{network}</p>
              <p className={`mt-1 text-xs ${isCorrectNetwork ? 'text-emerald-300' : 'text-amber-300'}`}>
                {isCorrectNetwork ? '✓ Supported' : '⚠ Unsupported'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Player Stats</p>
              <div className="mt-2 flex gap-4 text-sm">
                <div>
                  <p className="text-glowyellow font-bold">{player?.xp || '0'}</p>
                  <p className="text-xs text-slate-400">XP</p>
                </div>
                <div>
                  <p className="text-emerald-300 font-bold">Level {player?.level || '1'}</p>
                  <p className="text-xs text-slate-400">Rank</p>
                </div>
                <div>
                  <p className="text-purple-300 font-bold">{player?.questCount || '0'}</p>
                  <p className="text-xs text-slate-400">Quests</p>
                </div>
              </div>
            </div>
          </div>

          {!isCorrectNetwork && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              onClick={switchCeloNetwork}
              className="mt-4 w-full rounded-xl bg-amber-500/20 border border-amber-500 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-500/30 transition"
            >
              ⚡ Switch to Celo Mainnet
            </motion.button>
          )}

          {authStatus !== 'authenticated' && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              onClick={authenticateWallet}
              disabled={authStatus === 'authenticating' || authStatus === 'restoring'}
              className="mt-4 w-full rounded-xl bg-glowyellow/20 border border-glowyellow py-2 text-sm font-semibold text-glowyellow hover:bg-glowyellow/30 transition disabled:opacity-50"
            >
              {authStatus === 'authenticating' ? '⟳ Signing...' : authStatus === 'restoring' ? '⟳ Restoring...' : authStatus === 'expired' ? '🔐 Sign In Again' : '🔐 Secure Sign-In'}
            </motion.button>
          )}
        </motion.div>

        {/* Transaction Status */}
        {txStatus && <TransactionStatusCard status={txStatus.type as TxStatusType} txHash={txStatus.hash} label={txStatus.label} message={txStatus.message} onDismiss={() => setTxStatus(null)} />}

        {/* Main Content Grid */}
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Left Column - Quest Flow */}
          <div className="lg:col-span-2 space-y-8">
            {/* Quest Flow Tracker */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-xl">
              <QuestFlowTracker currentStep={getFlowStep()} />
            </motion.div>

            {/* Active Quest Panel */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="rounded-[2rem]">
              {loading && !activeQuest ? (
                <LoadingScreen />
              ) : activeQuest ? (
                <ActiveQuestPanel
                  quest={activeQuest}
                  onStartQuest={activeQuest.status === 'AVAILABLE' ? handleStartQuest : undefined}
                  onSubmitProof={activeQuest.status === 'ACTIVE' ? () => {} : undefined}
                  loading={loading}
                  disabled={authStatus !== 'authenticated'}
                />
              ) : (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-[2rem] border-2 border-dashed border-glowyellow/30 bg-gradient-to-br from-glowyellow/10 to-transparent p-12 text-center">
                  <div className="text-5xl mb-4">✨</div>
                  <p className="text-xl font-bold text-white">Generate Your First Quest</p>
                  <p className="mt-2 text-slate-300">Click the button below to summon an AI-crafted mission</p>
                </motion.div>
              )}
            </motion.div>

            {/* Proof Submission Panel */}
            {activeQuest?.status === 'ACTIVE' && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                <ProofSubmissionPanel
                  proofUri={proofUri}
                  onProofChange={setProofUri}
                  onSubmit={handleSubmitProof}
                  loading={loading}
                  disabled={authStatus !== 'authenticated'}
                />
              </motion.div>
            )}

            {/* Generate Quest Button */}
            {!activeQuest || activeQuest.status === 'VERIFIED' ? (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-center">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleGenerateQuest}
                  disabled={loading || authStatus !== 'authenticated'}
                  className="rounded-2xl bg-gradient-to-r from-glowyellow to-softyellow px-8 py-4 font-bold uppercase tracking-[0.2em] text-navy shadow-lg hover:shadow-2xl transition disabled:opacity-50"
                >
                  {loading ? '⟳ Generating...' : '⚔️ Generate New Quest'}
                </motion.button>
              </motion.div>
            ) : null}
          </div>

          {/* Right Column - Sidebar */}
          <aside className="space-y-6">
            {/* Daily Missions */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-xl">
              <h3 className="text-sm uppercase tracking-[0.25em] text-glowyellow font-bold">Daily Challenges</h3>
              <div className="mt-4 space-y-3">
                {dailyMissions.length > 0 ? (
                  dailyMissions.map((mission) => (
                    <motion.div key={mission.id} whileHover={{ scale: 1.02 }} className="rounded-xl border border-white/10 bg-navy/40 p-3 hover:border-glowyellow/50 transition">
                      <p className="text-sm font-semibold text-white">{mission.title}</p>
                      <p className="mt-1 text-xs text-slate-400">{mission.description}</p>
                      <p className="mt-2 text-xs font-bold text-glowyellow">{mission.reward}</p>
                    </motion.div>
                  ))
                ) : (
                  <p className="text-sm text-slate-400">Checking daily events...</p>
                )}
              </div>
            </motion.div>

            {/* Tips & Info */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-xl">
              <h3 className="text-sm uppercase tracking-[0.25em] text-softyellow font-bold">How It Works</h3>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="flex gap-3">
                  <span className="text-lg">1️⃣</span>
                  <p>AI generates a unique quest</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-lg">2️⃣</span>
                  <p>Accept the quest & stake CELO</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-lg">3️⃣</span>
                  <p>Complete the mission objectives</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-lg">4️⃣</span>
                  <p>Submit proof & earn rewards</p>
                </div>
              </div>
            </motion.div>

            {/* Status Messages */}
            {message && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-xl border border-glowyellow/30 bg-glowyellow/10 p-4">
                <p className="text-sm text-glowyellow">{message}</p>
              </motion.div>
            )}
          </aside>
        </div>
      </div>
    </motion.main>
  );
}

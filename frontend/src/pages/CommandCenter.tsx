import { motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import {
  extractAuthFailure,
  fetchDailyMissions,
  generateQuest,
  registerOnchainQuest,
  registerQuestStart,
  submitProofForVerification
} from '../lib/api';
import { contractAddresses, contractABIs, getContract } from '../lib/contracts';
import { env } from '../lib/env';
import { parseReceiptEvent } from '../lib/questTransactions';
import { describeTransactionFailure, formatCeloAmount } from '../lib/transactionDiagnostics';
import {
  estimateContractWriteGas,
  sendContractWrite,
  waitForTransactionReceipt
} from '../lib/walletProvider';

type DailyMission = { id: string; title: string; description: string; reward: string };
type GeneratedQuestTemplate = QuestState & {
  title: string;
  metadataUri: string;
  stakeAmount: string | number;
  rewardAmount: string | number;
  xpReward: string | number;
  durationSeconds: string | number;
};
type GenerationProfile = {
  source?: string;
  provider?: string;
  model?: string | null;
  promptHash?: string | null;
  fallbackReason?: string | null;
};
type TxStatusType = 'pending' | 'success' | 'error' | 'confirmed';
type QuestFlowStage =
  | 'PENDING'
  | 'GENERATED'
  | 'ACCEPTED'
  | 'ACTIVE'
  | 'SUBMITTED'
  | 'VERIFIED'
  | 'REWARDED'
  | 'COMPLETED';

function questMatcher(quest: QuestState | null) {
  return {
    id: quest?.id ?? undefined,
    chainQuestId: quest?.chainQuestId ?? undefined,
    orchestrationId: quest?.orchestrationId ?? undefined
  };
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveGenerationProfile(quest: QuestState | null): GenerationProfile | null {
  const direct = asRecord(quest?.generation);
  if (direct) {
    return direct as GenerationProfile;
  }

  const metadata = asRecord(quest?.metadata);
  const generation = metadata ? asRecord(metadata.generation) : null;
  return generation as GenerationProfile | null;
}

function resolveQuestRarityLabel(difficulty: number | string | undefined) {
  const tier = Number(difficulty);
  if (tier === 5) return 'Legendary';
  if (tier === 4) return 'Epic';
  if (tier === 3) return 'Rare';
  if (tier === 2) return 'Uncommon';
  return 'Common';
}

function normalizeProofReference(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const txHashMatch = trimmed.match(/0x[a-fA-F0-9]{64}/);
  if (txHashMatch) {
    return txHashMatch[0];
  }

  try {
    const url = new URL(trimmed);
    const pathHash = url.pathname.match(/0x[a-fA-F0-9]{64}/);
    return pathHash ? pathHash[0] : null;
  } catch {
    return null;
  }
}

function formatActionFailure(error: unknown, fallbackLabel: string) {
  const txFailure = describeTransactionFailure(error);
  if (txFailure.kind !== 'unknown') {
    const details = (Array.isArray(txFailure.details) ? txFailure.details : [])
      .slice(0, 2)
      .join(' ');
    return details ? `${txFailure.message} ${details}`.trim() : txFailure.message;
  }

  const authFailure = extractAuthFailure(error);
  const detailText =
    authFailure.details && Array.isArray(authFailure.details) && authFailure.details.length
      ? ` ${authFailure.details.join(' ')}`
      : '';

  if (authFailure.code !== 'AUTH_UNKNOWN' || authFailure.message) {
    return `${authFailure.message || ''}${detailText}`.trim();
  }

  return fallbackLabel;
}

function formatTxLabel(functionName: 'createQuest' | 'startQuest' | 'submitQuest') {
  if (functionName === 'createQuest') return 'Forge quest';
  if (functionName === 'startQuest') return 'Start quest';
  return 'Submit proof';
}

const QUEST_DISPLAY_STATUS_RANK: Record<string, number> = {
  ACTIVE: 6,
  SUBMITTED: 5,
  VERIFIED: 4,
  AVAILABLE: 3,
  FAILED: 2,
  CANCELLED: 1
};

function questIdentity(quest: QuestState) {
  return quest.id ?? quest.chainQuestId ?? quest.orchestrationId ?? quest.title ?? null;
}

function questTimestamp(quest: QuestState | null, field: 'createdAt' | 'updatedAt') {
  const value = quest?.[field];
  if (typeof value !== 'string') {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickDisplayQuest(candidates: QuestState[]) {
  return [...candidates].sort((left, right) => {
    const rightRank = QUEST_DISPLAY_STATUS_RANK[String(right.status ?? '')] ?? 0;
    const leftRank = QUEST_DISPLAY_STATUS_RANK[String(left.status ?? '')] ?? 0;

    if (rightRank !== leftRank) {
      return rightRank - leftRank;
    }

    return (
      questTimestamp(right, 'updatedAt') - questTimestamp(left, 'updatedAt') ||
      questTimestamp(right, 'createdAt') - questTimestamp(left, 'createdAt')
    );
  })[0] ?? null;
}

export default function CommandCenter() {
  const navigate = useNavigate();
  const {
    address,
    balance,
    signer,
    provider,
    network,
    isCorrectNetwork,
    isMiniPay,
    walletProvider,
    walletKind,
    status,
    authStatus,
    authMessage,
    isAuthReady,
    connectWallet,
    authenticateWallet,
    disconnectWallet,
    switchCeloNetwork
  } = useWallet();
  const {
    activeQuest,
    connectionStatus,
    hydrationStatus,
    isRealtimeReady,
    player,
    quests,
    syncNow,
    refreshQuestFeed,
    upsertQuest,
    patchQuest,
    getQuest
  } = useRealtimeState();
  const [dailyMissions, setDailyMissions] = useState<DailyMission[]>([]);
  const [proofUri, setProofUri] = useState('');
  const [proofError, setProofError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [revealQuestModal, setRevealQuestModal] = useState(false);
  const [completionModal, setCompletionModal] = useState(false);
  const [showRewardAnimation, setShowRewardAnimation] = useState(false);
  const [rewardData, setRewardData] = useState({ xp: 0, token: '0', nft: 'Rare' });
  const [txStatus, setTxStatus] = useState<{
    type: TxStatusType;
    hash?: string;
    label?: string;
    message?: string;
  } | null>(null);
  const [lastGeneratedQuest, setLastGeneratedQuest] = useState<QuestState | null>(null);
  const [resumedQuestId, setResumedQuestId] = useState<string | null>(null);
  const [celebrationQuestId, setCelebrationQuestId] = useState<string | null>(null);
  const [completedQuestIds, setCompletedQuestIds] = useState<string[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  const proofPanelRef = useRef<HTMLDivElement | null>(null);

  const forgeQuestManager = useMemo(() => {
    if (!signer) return null;
    return getContract(
      contractAddresses.forgeQuestManagerAddress,
      contractABIs.forgeQuestManagerAbi,
      signer
    );
  }, [signer]);

  function isQuestFromCurrentSession(quest: QuestState | null): boolean {
    if (!quest) return false;

    if (lastGeneratedQuest?.id && quest.id === lastGeneratedQuest.id) {
      return true;
    }

    const questCreatedMs = questTimestamp(quest, 'createdAt');
    return questCreatedMs >= sessionStartedAt && questCreatedMs > 0;
  }

  const normalizedProof = useMemo(() => normalizeProofReference(proofUri), [proofUri]);
  const generatedQuest = lastGeneratedQuest
    ? getQuest(questMatcher(lastGeneratedQuest)) ?? lastGeneratedQuest
    : null;
  const sessionQuest = useMemo(() => {
    const candidates: QuestState[] = [];
    const seen = new Set<string>();

    [generatedQuest, ...quests].forEach((quest) => {
      if (!quest || !isQuestFromCurrentSession(quest)) {
        return;
      }

      const identity = questIdentity(quest);
      if (!identity || seen.has(identity)) {
        return;
      }

      seen.add(identity);
      candidates.push(quest);
    });

    return pickDisplayQuest(candidates);
  }, [generatedQuest, quests, sessionStartedAt, lastGeneratedQuest?.id]);
  const resumedQuest = resumedQuestId
    ? getQuest({ id: resumedQuestId }) ?? (activeQuest?.id === resumedQuestId ? activeQuest : null)
    : null;
  const interactiveQuest = sessionQuest ?? resumedQuest;
  const restoredQuest =
    interactiveQuest || !activeQuest || isQuestFromCurrentSession(activeQuest) ? null : activeQuest;
  const currentQuestForDisplay = interactiveQuest ?? generatedQuest ?? restoredQuest;
  const generationProfile = resolveGenerationProfile(currentQuestForDisplay);

  const proofHelperText = useMemo(() => {
    if (!interactiveQuest) {
      return null;
    }

    const txTypes = Array.isArray(interactiveQuest.requiredTxTypes)
      ? interactiveQuest.requiredTxTypes.filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        )
      : [];

    if (txTypes.length > 0) {
      return `Expected proof comes from: ${txTypes.join(' -> ')}.`;
    }

    return 'Paste the transaction that best proves the objective was completed.';
  }, [interactiveQuest]);

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

  // Reset session when wallet connects/disconnects
  useEffect(() => {
    if (status === 'connected' && authStatus === 'authenticated') {
      // Session started: reset timestamp to current moment
      setSessionStartedAt(Date.now());
      setMessage('Welcome back to the Forge. Your session is fresh and ready for new adventures.');
    } else if (status === 'disconnected') {
      // Wallet disconnected: clear quest state
      setLastGeneratedQuest(null);
      setResumedQuestId(null);
      setCompletedQuestIds([]);
      setCelebrationQuestId(null);
      setMessage('');
      setProofUri('');
    }
  }, [status, authStatus]);

  useEffect(() => {
    if (resumedQuestId && !resumedQuest) {
      setResumedQuestId(null);
    }
  }, [resumedQuest, resumedQuestId]);

  useEffect(() => {
    const questId = interactiveQuest?.id;
    if (
      interactiveQuest?.status !== 'VERIFIED' ||
      !questId ||
      completedQuestIds.includes(questId) ||
      celebrationQuestId === questId
    ) {
      return;
    }

    setRewardData({
      xp: Number(interactiveQuest.xpReward) || 0,
      token: String(interactiveQuest.rewardAmount || '0'),
      nft: resolveQuestRarityLabel(interactiveQuest.difficulty)
    });
    setCelebrationQuestId(questId);
    setShowRewardAnimation(true);

    const timer = window.setTimeout(() => {
      setCompletionModal(true);
    }, 2200);

    return () => window.clearTimeout(timer);
  }, [
    interactiveQuest?.difficulty,
    interactiveQuest?.id,
    interactiveQuest?.rewardAmount,
    interactiveQuest?.status,
    interactiveQuest?.xpReward,
    celebrationQuestId,
    completedQuestIds
  ]);

  function markQuestCompleted(questId?: string) {
    if (!questId) {
      return;
    }

    setCompletedQuestIds((current) =>
      current.includes(questId) ? current : [...current, questId]
    );
  }

  function handleCompletionClose() {
    markQuestCompleted(interactiveQuest?.id);
    setCompletionModal(false);
  }

  function handleViewInventory() {
    markQuestCompleted(interactiveQuest?.id);
    setCompletionModal(false);
    navigate('/inventory');
  }

  function handleProofChange(value: string) {
    setProofUri(value);
    if (proofError) {
      setProofError(null);
    }
  }

  function focusProofSubmission() {
    setMessage(
      'Complete the objective, then paste the proof transaction below to trigger AI verification.'
    );
    proofPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resumeRestoredQuest() {
    if (!restoredQuest?.id) {
      return;
    }

    setResumedQuestId(restoredQuest.id);

    if (restoredQuest.status === 'ACTIVE') {
      setMessage('Previous active quest resumed. Paste your proof reference below when you are ready.');
      window.setTimeout(() => {
        proofPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
      return;
    }

    if (restoredQuest.status === 'AVAILABLE') {
      setMessage('Previous quest resumed. You can begin it onchain whenever you are ready.');
      return;
    }

    setMessage('Previous quest resumed. Review its latest state below.');
  }

  function getFlowStep(): QuestFlowStage {
    if (!interactiveQuest) {
      return 'PENDING';
    }

    if (
      interactiveQuest.status === 'VERIFIED' &&
      interactiveQuest.id &&
      completedQuestIds.includes(interactiveQuest.id)
    ) {
      return 'COMPLETED';
    }
    if (interactiveQuest.status === 'VERIFIED' && (completionModal || showRewardAnimation)) {
      return 'REWARDED';
    }
    if (interactiveQuest.status === 'VERIFIED') return 'VERIFIED';
    if (interactiveQuest.status === 'SUBMITTED') return 'SUBMITTED';
    if (interactiveQuest.status === 'ACTIVE') return 'ACTIVE';
    if (interactiveQuest.status === 'AVAILABLE' && interactiveQuest.chainQuestId) return 'ACCEPTED';
    if (interactiveQuest.status === 'AVAILABLE') return 'GENERATED';
    return 'PENDING';
  }

  function flowStatusLabel() {
    if (status !== 'connected') return 'Wallet disconnected';
    if (!isCorrectNetwork) return 'Wrong network';
    if (authStatus !== 'authenticated') return 'Awaiting secure sign-in';
    if (!isRealtimeReady) return `Realtime ${hydrationStatus}`;
    if (interactiveQuest?.status === 'SUBMITTED') return 'Verification pending';
    if (interactiveQuest?.status === 'VERIFIED') return 'Reward settlement complete';
    if (interactiveQuest?.status === 'ACTIVE') return 'Quest live';
    if (interactiveQuest?.status === 'AVAILABLE') return 'Ready to begin';
    if (restoredQuest) return 'No new quest started yet';
    return 'Forge ready';
  }

  async function submitForgeWrite(
    functionName: 'createQuest' | 'startQuest' | 'submitQuest',
    args: unknown[],
    options?: { value?: bigint; gasLimit?: bigint }
  ) {
    if (!forgeQuestManager) throw new Error('Contract interface is not ready');
    if (!provider) throw new Error('Wallet provider is not ready');
    if (!address) throw new Error('Wallet address is not available');

    const txLabel = formatTxLabel(functionName);

    try {
      if (!isMiniPay) {
        if (!signer) throw new Error('Wallet signer is unavailable');

        const transactionMethod = (forgeQuestManager as ethers.Contract)[functionName] as (
          ...methodArgs: unknown[]
        ) => Promise<ethers.ContractTransactionResponse>;

        if (typeof transactionMethod !== 'function') {
          throw new Error(`Transaction method ${functionName} not found`);
        }

        const tx = await transactionMethod(...args, {
          ...(typeof options?.value === 'bigint' ? { value: options.value } : {}),
          ...(typeof options?.gasLimit === 'bigint' ? { gasLimit: options.gasLimit } : {})
        });

        setTxStatus({
          type: 'pending',
          hash: tx.hash,
          label: `${txLabel} pending`,
          message: 'Approve the wallet prompt and wait for Celo confirmation.'
        });

        const receipt = await tx.wait();
        setTxStatus({
          type: 'confirmed',
          hash: tx.hash,
          label: `${txLabel} confirmed`,
          message: 'The chain step settled successfully.'
        });
        return { hash: tx.hash, receipt };
      }

      if (!walletProvider) throw new Error('MiniPay provider is unavailable');

      const signerAddress = await signer?.getAddress();
      const gasLimit =
        options?.gasLimit ??
        (await estimateContractWriteGas({
          provider: walletProvider,
          contractAddress: contractAddresses.forgeQuestManagerAddress,
          contractInterface: forgeQuestManager.interface,
          functionName,
          args,
          from: signerAddress || address,
          ...(typeof options?.value === 'bigint' ? { value: options.value } : {})
        }));
      const { txHash } = await sendContractWrite({
        provider: walletProvider,
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface,
        functionName,
        args,
        from: address,
        gasLimit,
        ...(typeof options?.value === 'bigint' ? { value: options.value } : {})
      });

      setTxStatus({
        type: 'pending',
        hash: txHash,
        label: `${txLabel} submitted`,
        message: 'MiniPay submitted the transaction. Waiting for confirmation on Celo.'
      });

      const receipt = await waitForTransactionReceipt(provider, txHash);
      setTxStatus({
        type: 'confirmed',
        hash: txHash,
        label: `${txLabel} confirmed`,
        message: 'Celo confirmed the transaction.'
      });

      return { hash: txHash, receipt };
    } catch (error) {
      setTxStatus({
        type: 'error',
        label: `${txLabel} failed`,
        message: formatActionFailure(error, 'Transaction failed')
      });
      throw error;
    }
  }

  async function resolveQuestForChainAction(
    quest: QuestState,
    fallbackMessage: string
  ) {
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

  async function registerOnchainQuestWithRetry(
    questId: string,
    chainQuestId: string,
    creationTxHash: string,
    maxRetries = 3
  ): Promise<QuestState | null> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const registrationResponse = await registerOnchainQuest(
          questId,
          chainQuestId,
          creationTxHash
        );
        const registeredQuest = (registrationResponse.data as { quest?: QuestState }).quest;
        return registeredQuest ?? null;
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
    setMessage('Summoning the Forge Master. AI is crafting your quest and preparing the onchain record...');
    setTxStatus(null);
    setProofError(null);
    setProofUri('');
    setResumedQuestId(null);

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

      const { hash: creationTxHash, receipt } = await submitForgeWrite(
        'createQuest',
        [...createQuestArgs]
      );
      const parsedLog = parseReceiptEvent(
        receipt,
        {
          contractAddress: contractAddresses.forgeQuestManagerAddress,
          contractInterface: forgeQuestManager.interface
        },
        'QuestCreated'
      );
      const chainQuestId = parsedLog?.args?.questId?.toString();
      if (!chainQuestId) {
        throw new Error('Quest creation receipt did not include a quest id');
      }

      let persistedQuest: QuestState = {
        ...template,
        chainQuestId,
        creator: address,
        status: 'AVAILABLE',
        treasuryPayout: { status: 'RESERVED' }
      };

      setMessage('Quest forged onchain. Syncing cinematic state with the backend...');

      try {
        const registeredQuest = await registerOnchainQuestWithRetry(
          String(template.id),
          chainQuestId,
          creationTxHash
        );
        if (registeredQuest) {
          persistedQuest = { ...persistedQuest, ...registeredQuest };
        }
        setMessage('Quest forged successfully. Review the reveal and accept it to begin.');
      } catch (registrationError) {
        console.error(
          '[CommandCenter] Backend onchain quest registration failed after retries',
          registrationError
        );
        setMessage(
          'Quest forged onchain, but backend sync is delayed. You can still review and begin it.'
        );
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

  async function handleStartQuest(questOverride?: QuestState | null) {
    const candidateQuest = questOverride ?? interactiveQuest;
    if (!address || !forgeQuestManager || !candidateQuest || !signer) return;
    if (!(await requireReadyAuth('starting quests'))) return;

    setLoading(true);
    setMessage('Accepting the quest and locking your stake onchain...');
    setTxStatus(null);

    try {
      const resolvedQuest = await resolveQuestForChainAction(
        candidateQuest,
        'Quest is still missing its onchain id after sync. Please wait a moment and try again.'
      );
      setMessage('Quest sync complete. Starting quest on Celo...');

      if (!provider) throw new Error('Wallet provider is unavailable');

      const signerAddress = await signer.getAddress();
      const chainQuestId = BigInt(String(resolvedQuest.chainQuestId));
      const onchainQuest = await forgeQuestManager.quests(chainQuestId);
      if (Number(onchainQuest.status) !== 0) {
        throw new Error('Quest is no longer available.');
      }

      const stakeValue = BigInt(onchainQuest.stakeAmount.toString());
      const availableBalance = await provider.getBalance(signerAddress);
      if (availableBalance < stakeValue) {
        throw new Error(
          `Insufficient funds for the quest stake. Need ${formatCeloAmount(stakeValue)} CELO.`
        );
      }

      const gasEstimate =
        isMiniPay && walletProvider
          ? await estimateContractWriteGas({
              provider: walletProvider,
              contractAddress: contractAddresses.forgeQuestManagerAddress,
              contractInterface: forgeQuestManager.interface,
              functionName: 'startQuest',
              args: [chainQuestId],
              from: signerAddress,
              value: stakeValue
            })
          : await forgeQuestManager.startQuest.estimateGas(chainQuestId, {
              value: stakeValue
            });

      const gasLimit = gasEstimate + gasEstimate / 5n;
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const estimatedGasCost = gasEstimate * gasPrice;

      if (availableBalance < stakeValue + estimatedGasCost) {
        throw new Error('Insufficient funds for the quest stake plus gas.');
      }

      const { hash: startTxHash } = await submitForgeWrite(
        'startQuest',
        [chainQuestId],
        { value: stakeValue, gasLimit }
      );

      let persistedQuest: QuestState = {
        ...resolvedQuest,
        status: 'ACTIVE',
        treasuryPayout: {
          ...(resolvedQuest.treasuryPayout || {}),
          status: 'LOCKED'
        }
      };

      if (resolvedQuest.id) {
        try {
          const startRegistrationResponse = await registerQuestStart(
            String(resolvedQuest.id),
            chainQuestId.toString(),
            startTxHash
          );
          const registeredQuest = (startRegistrationResponse.data as { quest?: QuestState }).quest;
          if (registeredQuest) {
            persistedQuest = { ...persistedQuest, ...registeredQuest };
          }
        } catch (registrationError) {
          console.error(
            '[CommandCenter] Backend quest start registration failed',
            registrationError
          );
        }
      }

      upsertQuest(persistedQuest);
      setRevealQuestModal(false);
      setMessage(
        'Quest started. Your stake is locked and the objective is live. Complete the task, then submit proof below.'
      );
      await syncNow();
      window.setTimeout(() => {
        proofPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 250);
    } catch (error) {
      console.error('[CommandCenter] startQuest failed', error);
      setMessage(formatActionFailure(error, 'Start quest transaction failed.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitProof() {
    if (!address || !forgeQuestManager || !interactiveQuest) {
      setMessage('Provide proof and connect wallet to submit.');
      return;
    }

    if (interactiveQuest.status !== 'ACTIVE') {
      setMessage('Start the quest onchain before submitting proof.');
      return;
    }

    if (!normalizedProof) {
      setProofError('Paste a valid transaction hash or a Celoscan link that contains one.');
      setMessage('Proof reference is invalid. Paste a full transaction hash or a Celoscan link.');
      return;
    }

    if (!(await requireReadyAuth('submitting proof'))) return;

    setLoading(true);
    setProofError(null);
    setMessage('Submitting proof to the Forge Master for deterministic verification...');
    setTxStatus(null);

    try {
      const resolvedQuest = await resolveQuestForChainAction(
        interactiveQuest,
        'Quest is still missing its onchain id after sync. Please wait a moment and try again.'
      );
      setMessage('Quest sync complete. Submitting proof onchain...');

      const chainQuestId = BigInt(String(resolvedQuest.chainQuestId));
      const { hash: submissionTxHash } = await submitForgeWrite('submitQuest', [
        chainQuestId,
        normalizedProof
      ]);

      patchQuest(questMatcher(resolvedQuest), {
        status: 'SUBMITTED',
        proofTxHash: normalizedProof,
        proofTx: submissionTxHash
      });

      if (!resolvedQuest.id) {
        throw new Error('Quest is missing a persistent id');
      }

      await submitProofForVerification(resolvedQuest.id, normalizedProof, submissionTxHash);
      setMessage(
        'Proof submitted. The AI Dungeon Master is now verifying the result and streaming the outcome back to this screen.'
      );
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
      <motion.main
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mx-auto flex min-h-[calc(100vh-96px)] items-center justify-center px-6 py-12"
      >
        <div className="w-full max-w-2xl rounded-3xl border-2 border-glowyellow bg-gradient-to-br from-navy via-deepnavy to-navy p-12 text-center shadow-2xl">
          <motion.div
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="mb-6 text-6xl"
          >
            ⚔️
          </motion.div>
          <h2 className="text-4xl font-black text-glowyellow">Enter the Forge</h2>
          <p className="mt-4 text-lg text-slate-300">
            Connect your wallet to begin an AI-powered quest that settles on Celo and rewards
            real onchain progression.
          </p>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={connectWallet}
            className="mt-8 rounded-2xl bg-gradient-to-r from-glowyellow to-softyellow px-8 py-4 font-bold uppercase tracking-[0.2em] text-navy shadow-lg transition hover:shadow-2xl"
          >
            Connect Wallet
          </motion.button>
        </div>
      </motion.main>
    );
  }

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mx-auto max-w-7xl px-4 py-8 md:px-6 md:py-12"
    >
      <QuestRevealModal
        isOpen={revealQuestModal}
        quest={lastGeneratedQuest}
        onClose={() => setRevealQuestModal(false)}
        onAccept={() => void handleStartQuest(lastGeneratedQuest)}
        loading={loading}
      />
      <QuestCompletionModal
        isOpen={completionModal}
        quest={interactiveQuest}
        onClose={handleCompletionClose}
        onViewInventory={handleViewInventory}
        onGenerateNew={() => {
          markQuestCompleted(interactiveQuest?.id);
          setCompletionModal(false);
          void handleGenerateQuest();
        }}
      />
      <RewardAnimation
        show={showRewardAnimation}
        xpAmount={rewardData.xp}
        tokenAmount={rewardData.token}
        nftRarity={rewardData.nft}
        onComplete={() => setShowRewardAnimation(false)}
      />

      <div className="space-y-8">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="rounded-[2.5rem] border-2 border-glowyellow/40 bg-gradient-to-br from-navy/60 to-deepnavy/40 p-6 shadow-xl backdrop-blur-xl md:p-8"
        >
          <div className="grid gap-6 md:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Connected Wallet</p>
              <p className="mt-2 font-mono text-sm text-white">
                {address?.slice(0, 10)}...{address?.slice(-8)}
              </p>
              <p className="mt-1 text-xs text-slate-400">Balance: {balance} CELO</p>
              <p className="mt-1 text-xs text-slate-400">
                Provider: {isMiniPay ? 'MiniPay' : walletKind ?? 'Injected wallet'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Network</p>
              <p className="mt-2 text-sm font-semibold text-white">{network}</p>
              <p className={`mt-1 text-xs ${isCorrectNetwork ? 'text-emerald-300' : 'text-amber-300'}`}>
                {isCorrectNetwork ? '✓ Celo Mainnet ready' : '⚠ Switch to Celo Mainnet'}
              </p>
              <p className="mt-1 text-xs text-slate-400">Auth: {flowStatusLabel()}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Player Stats</p>
              <div className="mt-2 flex gap-4 text-sm">
                <div>
                  <p className="font-bold text-glowyellow">{player?.xp || '0'}</p>
                  <p className="text-xs text-slate-400">XP</p>
                </div>
                <div>
                  <p className="font-bold text-emerald-300">Level {player?.level || '1'}</p>
                  <p className="text-xs text-slate-400">Rank</p>
                </div>
                <div>
                  <p className="font-bold text-purple-300">{player?.questCount || '0'}</p>
                  <p className="text-xs text-slate-400">Quests</p>
                </div>
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-softyellow">Live Sync</p>
              <p className="mt-2 text-sm font-semibold text-white">
                Feed {hydrationStatus} • Socket {connectionStatus}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {isRealtimeReady
                  ? 'Quest state will restore after refresh.'
                  : 'Realtime hydration is still catching up.'}
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {!isCorrectNetwork ? (
              <motion.button
                whileHover={{ scale: 1.02 }}
                onClick={() => void switchCeloNetwork()}
                className="w-full rounded-xl border border-amber-500 bg-amber-500/20 py-3 text-sm font-semibold text-amber-300 transition hover:bg-amber-500/30 sm:w-auto sm:px-5"
              >
                ⚡ Switch to Celo Mainnet
              </motion.button>
            ) : null}

            {authStatus !== 'authenticated' ? (
              <motion.button
                whileHover={{ scale: 1.02 }}
                onClick={() => void authenticateWallet()}
                disabled={authStatus === 'authenticating' || authStatus === 'restoring'}
                className="w-full rounded-xl border border-glowyellow bg-glowyellow/20 py-3 text-sm font-semibold text-glowyellow transition disabled:opacity-50 hover:bg-glowyellow/30 sm:w-auto sm:px-5"
              >
                {authStatus === 'authenticating'
                  ? '⟳ Signing...'
                  : authStatus === 'restoring'
                    ? '⟳ Restoring session...'
                    : authStatus === 'expired'
                      ? '🔐 Sign In Again'
                      : '🔐 Secure Sign-In'}
              </motion.button>
            ) : (
              <motion.button
                whileHover={{ scale: 1.02 }}
                onClick={() => void disconnectWallet()}
                className="w-full rounded-xl border border-white/20 bg-white/10 py-3 text-sm font-semibold text-white transition hover:bg-white/20 sm:w-auto sm:px-5"
              >
                Disconnect Wallet
              </motion.button>
            )}

            <motion.button
              whileHover={{ scale: 1.02 }}
              onClick={() => void syncNow()}
              className="w-full rounded-xl border border-white/20 bg-white/10 py-3 text-sm font-semibold text-white transition hover:bg-white/20 sm:w-auto sm:px-5"
            >
              Refresh Live State
            </motion.button>
          </div>

          {authMessage ? (
            <div className="mt-4 rounded-2xl border border-glowyellow/20 bg-glowyellow/10 p-4 text-sm text-glowyellow">
              {authMessage}
            </div>
          ) : null}
        </motion.div>

        {txStatus ? (
          <TransactionStatusCard
            status={txStatus.type}
            txHash={txStatus.hash}
            label={txStatus.label}
            message={txStatus.message}
            onDismiss={() => setTxStatus(null)}
          />
        ) : null}

        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-xl"
            >
              <QuestFlowTracker currentStep={getFlowStep()} statusLabel={flowStatusLabel()} />
            </motion.div>

            {!interactiveQuest && restoredQuest ? (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-[2rem] border border-amber-400/30 bg-amber-500/10 p-6 shadow-xl"
              >
                <p className="text-xs uppercase tracking-[0.2em] text-amber-200">Restored Quest</p>
                <p className="mt-3 text-xl font-bold text-white">
                  {restoredQuest.title || 'Previous quest found'}
                </p>
                <p className="mt-2 text-sm text-slate-200">
                  We found an older quest on this wallet, but connecting your wallet did not generate,
                  accept, or pay for a new quest in this session.
                </p>
                <p className="mt-2 text-sm text-slate-300">
                  Resume it only if you want to continue that earlier run.
                </p>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={resumeRestoredQuest}
                    disabled={!restoredQuest.id}
                    className="rounded-xl border border-amber-300 bg-amber-300/20 px-5 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-300/30 disabled:opacity-50"
                  >
                    {restoredQuest.status === 'ACTIVE'
                      ? 'Resume and Submit Proof'
                      : restoredQuest.status === 'AVAILABLE'
                        ? 'Resume and Start Quest'
                        : 'Resume Previous Quest'}
                  </motion.button>
                  <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
                    Status: {restoredQuest.status || 'Unknown'}
                  </div>
                </div>
              </motion.div>
            ) : null}

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-[2rem]"
            >
              {loading && !interactiveQuest ? (
                <LoadingScreen />
              ) : interactiveQuest ? (
                <ActiveQuestPanel
                  quest={interactiveQuest}
                  onStartQuest={
                    interactiveQuest.status === 'AVAILABLE'
                      ? () => void handleStartQuest(interactiveQuest)
                      : undefined
                  }
                  onSubmitProof={interactiveQuest.status === 'ACTIVE' ? focusProofSubmission : undefined}
                  loading={loading}
                  disabled={false}
                />
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="rounded-[2rem] border-2 border-dashed border-glowyellow/30 bg-gradient-to-br from-glowyellow/10 to-transparent p-12 text-center"
                >
                  <div className="mb-4 text-5xl">✨</div>
                  <p className="text-xl font-bold text-white">Generate Your First Quest</p>
                  <p className="mt-2 text-slate-300">
                    One click summons an AI-crafted mission, writes it onchain, and stages it for
                    live play.
                  </p>
                </motion.div>
              )}
            </motion.div>

            {interactiveQuest?.status === 'ACTIVE' ? (
              <motion.div
                ref={proofPanelRef}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <ProofSubmissionPanel
                  proofUri={proofUri}
                  onProofChange={handleProofChange}
                  onSubmit={() => void handleSubmitProof()}
                  loading={loading}
                  disabled={false}
                  disabledReason={
                    !isCorrectNetwork
                      ? `Switch to ${env.CELO_CHAIN_NAME} before submitting proof.`
                      : authStatus !== 'authenticated'
                        ? 'Submitting will prompt secure sign-in before sending the transaction.'
                        : null
                  }
                  error={proofError ?? undefined}
                  normalizedProof={normalizedProof}
                  helperText={proofHelperText}
                />
              </motion.div>
            ) : null}

            {!interactiveQuest ||
            interactiveQuest.status === 'VERIFIED' ||
            interactiveQuest.status === 'FAILED' ||
            interactiveQuest.status === 'CANCELLED' ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex justify-center"
              >
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => void handleGenerateQuest()}
                  disabled={loading}
                  className="rounded-2xl bg-gradient-to-r from-glowyellow to-softyellow px-6 sm:px-8 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-navy shadow-lg transition disabled:opacity-50 hover:shadow-2xl min-h-[44px] sm:min-h-[48px]"
                >
                  {loading ? '⟳ Generating...' : '⚔️ Generate New Quest'}
                </motion.button>
              </motion.div>
            ) : null}
          </div>

          <aside className="space-y-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-xl"
            >
              <h3 className="font-bold text-glowyellow text-sm uppercase tracking-[0.25em]">
                Daily Challenges
              </h3>
              <div className="mt-4 space-y-3">
                {dailyMissions.length > 0 ? (
                  dailyMissions.map((mission) => (
                    <motion.div
                      key={mission.id}
                      whileHover={{ scale: 1.02 }}
                      className="rounded-xl border border-white/10 bg-navy/40 p-3 transition hover:border-glowyellow/50"
                    >
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

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-xl"
            >
              <h3 className="font-bold text-softyellow text-sm uppercase tracking-[0.25em]">
                Live Quest Intel
              </h3>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="rounded-2xl border border-white/10 bg-navy/40 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Realtime</p>
                  <p className="mt-2 text-white">
                    {isRealtimeReady
                      ? 'Bootstrap loaded and live sync is active.'
                      : 'Realtime bootstrap is still loading. Some quest transitions may appear with a short delay.'}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-navy/40 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">AI Layer</p>
                  <p className="mt-2 text-white">
                    {generationProfile?.provider || generationProfile?.source || 'Adaptive quest engine'}
                  </p>
                  {generationProfile?.model ? (
                    <p className="mt-1 text-xs text-slate-400">{generationProfile.model}</p>
                  ) : null}
                  {generationProfile?.fallbackReason ? (
                    <p className="mt-2 text-xs text-amber-300">
                      Fallback: {generationProfile.fallbackReason}
                    </p>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-white/10 bg-navy/40 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Judge Narrative</p>
                  <p className="mt-2 text-white">
                    The flow shows AI quest generation, secure wallet auth, onchain execution,
                    proof-driven verification, and NFT reward delivery in one loop.
                  </p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-xl"
            >
              <h3 className="font-bold text-softyellow text-sm uppercase tracking-[0.25em]">
                How It Works
              </h3>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="flex gap-3">
                  <span className="text-lg">1️⃣</span>
                  <p>AI generates a unique quest and the UI reveals it dramatically.</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-lg">2️⃣</span>
                  <p>You accept the quest and stake CELO through a real blockchain transaction.</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-lg">3️⃣</span>
                  <p>You complete the objective and submit proof using a transaction hash or explorer link.</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-lg">4️⃣</span>
                  <p>The backend verifies the quest and streams rewards, XP, and NFT updates live.</p>
                </div>
              </div>
            </motion.div>

            {message ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`rounded-xl p-4 border ${
                  message.toLowerCase().includes('failed') || message.toLowerCase().includes('error') || message.toLowerCase().includes('invalid') || message.toLowerCase().includes('insufficient')
                    ? 'border-red-500/50 bg-red-500/10'
                    : 'border-glowyellow/30 bg-glowyellow/10'
                }`}
              >
                <p className={`text-sm ${
                  message.toLowerCase().includes('failed') || message.toLowerCase().includes('error') || message.toLowerCase().includes('invalid') || message.toLowerCase().includes('insufficient')
                    ? 'text-red-300'
                    : 'text-glowyellow'
                }`}>
                  {message}
                </p>
              </motion.div>
            ) : null}
          </aside>
        </div>
      </div>
    </motion.main>
  );
}

import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import QuestCard from '../components/QuestCard';
import GlowButton from '../components/GlowButton';
import LoadingScreen from '../components/LoadingScreen';
import { QuestState, useRealtimeState } from '../context/RealtimeContext';
import { useWallet } from '../context/WalletContext';
import { extractAuthFailure, fetchDailyMissions, generateQuest, registerOnchainQuest, registerQuestStart, submitProofForVerification } from '../lib/api';
import { contractAddresses, contractABIs, getContract } from '../lib/contracts';
import { env } from '../lib/env';
import { parseReceiptEvent, summarizeReceiptLogs } from '../lib/questTransactions';
import { describeTransactionFailure, formatCeloAmount } from '../lib/transactionDiagnostics';
import { estimateContractWriteGas, sendContractWrite, waitForTransactionReceipt } from '../lib/walletProvider';

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

type GenerationProfile = {
  source?: string;
  provider?: string;
  model?: string | null;
  promptHash?: string | null;
  fallbackReason?: string | null;
};

function questMatcher(quest: QuestState | null) {
  return {
    id: quest?.id ?? undefined,
    chainQuestId: quest?.chainQuestId ?? undefined,
    orchestrationId: quest?.orchestrationId ?? undefined
  };
}

function asObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function resolveGenerationProfile(quest: QuestState | null): GenerationProfile | null {
  const direct = asObject(quest?.generation);
  if (direct) {
    return direct as GenerationProfile;
  }

  const metadata = asObject(quest?.metadata);
  const generation = metadata ? asObject(metadata.generation) : null;
  return generation as GenerationProfile | null;
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
  const {
    address,
    balance,
    signer,
    provider,
    network,
    chainId,
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
    switchCeloNetwork
  } = useWallet();
  const {
    activeQuest,
    connectionStatus,
    player,
    syncNow,
    refreshQuestFeed,
    upsertQuest,
    patchQuest,
    getQuest
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

  function logReceiptDiagnostics(label: string, receipt: ethers.TransactionReceipt | null) {
    if (!forgeQuestManager || !receipt) {
      return;
    }

    console.info(`[CommandCenter] ${label} receipt`, {
      hash: receipt.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      logs: summarizeReceiptLogs(receipt, {
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface
      })
    });
  }

  function parseQuestCreatedId(receipt: ethers.TransactionReceipt | null) {
    if (!forgeQuestManager || !receipt) return null;

    const parsedLog = parseReceiptEvent(
      receipt,
      {
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface
      },
      'QuestCreated'
    );

    console.info('[CommandCenter] Parsed QuestCreated log from receipt', {
      found: Boolean(parsedLog),
      questId: parsedLog?.args?.questId?.toString?.() ?? null
    });

    if (!parsedLog?.args?.questId) {
      return null;
    }

    return parsedLog.args.questId.toString();
  }

  async function submitForgeWrite(
    functionName: 'createQuest' | 'startQuest' | 'submitQuest',
    args: unknown[],
    options?: {
      value?: bigint;
      gasLimit?: bigint;
    }
  ) {
    // Defensive checks for all required dependencies
    if (!forgeQuestManager) {
      console.error('[CommandCenter] submitForgeWrite: forgeQuestManager is null', {
        functionName,
        hasSigner: !!signer,
        hasProvider: !!provider,
        hasAddress: !!address,
        isMiniPay,
        hasWalletProvider: !!walletProvider
      });
      throw new Error('Contract interface is not ready. Ensure wallet is connected.');
    }

    if (!provider) {
      console.error('[CommandCenter] submitForgeWrite: provider is null', {
        functionName,
        hasSigner: !!signer,
        hasForgeContract: !!forgeQuestManager,
        hasAddress: !!address,
        isMiniPay,
        hasWalletProvider: !!walletProvider
      });
      throw new Error('Wallet provider is not ready. Reconnect your wallet and try again.');
    }

    if (!address) {
      console.error('[CommandCenter] submitForgeWrite: address is null', {
        functionName,
        hasSigner: !!signer,
        hasProvider: !!provider,
        hasForgeContract: !!forgeQuestManager,
        isMiniPay,
        hasWalletProvider: !!walletProvider
      });
      throw new Error('Wallet address is not available. Reconnect your wallet and try again.');
    }

    console.info('[CommandCenter] submitForgeWrite starting', {
      functionName,
      argsCount: args.length,
      hasValue: typeof options?.value === 'bigint',
      hasGasLimit: typeof options?.gasLimit === 'bigint',
      isMiniPay,
      walletAddress: `${address.slice(0, 6) ?? 'INVALID'}...${address.slice(-4) ?? 'INVALID'}`,
      chainId,
      network
    });

    try {
      if (!isMiniPay) {
        // MetaMask / Standard ethers.js flow
        console.debug('[CommandCenter] Using standard ethers.js contract write (MetaMask/Standard)', {
          functionName,
          hasSigner: !!signer
        });

        if (!signer) {
          console.error('[CommandCenter] Signer is null for standard flow', {
            functionName,
            status,
            isAuthReady,
            isMiniPay
          });
          throw new Error('Wallet signer is unavailable. Reconnect your wallet and try again.');
        }

        const transactionMethod = (forgeQuestManager as ethers.Contract)[functionName] as (...methodArgs: unknown[]) => Promise<ethers.ContractTransactionResponse>;
        
        if (typeof transactionMethod !== 'function') {
          console.error('[CommandCenter] Transaction method not found on contract', {
            functionName,
            methodType: typeof transactionMethod,
            contractMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(forgeQuestManager))
          });
          throw new Error(`Transaction method ${functionName} not found on contract.`);
        }

        console.debug('[CommandCenter] Calling contract method', {
          functionName,
          argsCount: args.length,
          hasValue: typeof options?.value === 'bigint'
        });

        const tx = await transactionMethod(...args, {
          ...(typeof options?.value === 'bigint' ? { value: options.value } : {}),
          ...(typeof options?.gasLimit === 'bigint' ? { gasLimit: options.gasLimit } : {})
        });

        console.info('[CommandCenter] Transaction sent, waiting for confirmation', {
          functionName,
          txHash: tx.hash
        });

        const receipt = await tx.wait();
        logReceiptDiagnostics(functionName, receipt);
        return {
          hash: tx.hash,
          receipt
        };
      }

      // MiniPay flow
      console.debug('[CommandCenter] Using MiniPay transaction write', {
        functionName,
        hasWalletProvider: !!walletProvider
      });

      if (!walletProvider) {
        console.error('[CommandCenter] MiniPay wallet provider is null', {
          functionName,
          status,
          isMiniPay,
          walletKind
        });
        throw new Error('MiniPay provider is unavailable. Reconnect your wallet and try again.');
      }

      console.debug('[CommandCenter] Estimating gas for MiniPay', {
        functionName,
        from: address,
        contractAddress: contractAddresses.forgeQuestManagerAddress
      });

      const gasLimit =
        options?.gasLimit ??
        (await estimateContractWriteGas({
          provider: walletProvider,
          contractAddress: contractAddresses.forgeQuestManagerAddress,
          contractInterface: forgeQuestManager.interface,
          functionName,
          args,
          from: address,
          ...(typeof options?.value === 'bigint' ? { value: options.value } : {})
        }));

      console.info('[CommandCenter] Gas estimate successful for MiniPay', {
        functionName,
        gasLimit: gasLimit.toString()
      });

      console.debug('[CommandCenter] Sending transaction via MiniPay provider.request', {
        functionName,
        from: address,
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        gasLimit: gasLimit.toString()
      });

      const { txHash, request } = await sendContractWrite({
        provider: walletProvider,
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface,
        functionName,
        args,
        from: address,
        gasLimit,
        ...(typeof options?.value === 'bigint' ? { value: options.value } : {})
      });

      console.info('[CommandCenter] MiniPay transaction submitted successfully', {
        functionName,
        txHash,
        hasRequest: !!request
      });

      const receipt = await waitForTransactionReceipt(provider, txHash);
      logReceiptDiagnostics(functionName, receipt);

      return {
        hash: txHash,
        receipt
      };
    } catch (error) {
      console.error('[CommandCenter] submitForgeWrite failed', {
        functionName,
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        isMiniPay,
        hasWalletProvider: !!walletProvider,
        hasSigner: !!signer,
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  async function resolveQuestForChainAction(quest: QuestState, fallbackMessage: string) {
    let latestQuest = getQuest(questMatcher(quest)) ?? quest;

    console.info('[CommandCenter] Resolving quest for onchain action', {
      questId: latestQuest.id ?? null,
      orchestrationId: latestQuest.orchestrationId ?? null,
      chainQuestId: latestQuest.chainQuestId ?? null,
      status: latestQuest.status ?? null
    });

    if (latestQuest.chainQuestId) {
      return latestQuest;
    }

    setMessage('Quest is syncing with backend. Refreshing quest feed and realtime state...');
    await refreshQuestFeed();
    latestQuest = getQuest(questMatcher(quest)) ?? latestQuest;

    if (!latestQuest.chainQuestId) {
      await syncNow();
      await new Promise((resolve) => setTimeout(resolve, 750));
      latestQuest = getQuest(questMatcher(quest)) ?? latestQuest;
    }

    console.info('[CommandCenter] Quest sync resolution result', {
      questId: latestQuest.id ?? null,
      chainQuestId: latestQuest.chainQuestId ?? null,
      status: latestQuest.status ?? null
    });

    if (!latestQuest.chainQuestId) {
      throw new Error(fallbackMessage);
    }

    return latestQuest;
  }

  async function registerOnchainQuestWithRetry(
    questId: string,
    chainQuestId: string,
    creationTxHash: string,
    maxRetries = 3
  ): Promise<QuestState | null> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.info(`[CommandCenter] Backend onchain quest registration attempt ${attempt}/${maxRetries}`, {
          questId,
          chainQuestId,
          creationTxHash
        });
        const registrationResponse = await registerOnchainQuest(questId, chainQuestId, creationTxHash);
        const registeredQuest = (registrationResponse.data as { quest?: QuestState }).quest;
        if (registeredQuest) {
          console.info('[CommandCenter] Backend onchain quest registration succeeded', {
            questId,
            chainQuestId,
            responseQuestId: registeredQuest.id ?? null,
            responseChainQuestId: registeredQuest.chainQuestId ?? null
          });
          return registeredQuest;
        }
        return null;
      } catch (error) {
        lastError = error;
        console.warn(`[CommandCenter] Registration attempt ${attempt} failed`, error);

        if (attempt < maxRetries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.info(`[CommandCenter] Retrying in ${delayMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    console.error('[CommandCenter] Backend onchain quest registration failed after max retries', lastError);
    throw lastError;
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

      const createQuestArgs = [
        template.title,
        template.metadataUri,
        ethers.parseEther(template.stakeAmount.toString()),
        ethers.parseEther(template.rewardAmount.toString()),
        BigInt(template.xpReward),
        BigInt(template.durationSeconds)
      ] as const;
      const { hash: creationTxHash, receipt } = await submitForgeWrite('createQuest', [...createQuestArgs]);
      const chainQuestId = parseQuestCreatedId(receipt);
      if (!chainQuestId) {
        throw new Error('Quest creation receipt did not include a quest id');
      }

      console.info('[CommandCenter] createQuest confirmed', {
        hash: creationTxHash,
        chainQuestId
      });

      let persistedQuest: QuestState = {
        ...template,
        chainQuestId,
        creator: address,
        status: 'AVAILABLE',
        treasuryPayout: {
          status: 'RESERVED'
        }
      };

      setMessage('Quest forged onchain. Syncing with backend...');

      try {
        const registeredQuest = await registerOnchainQuestWithRetry(String(template.id), chainQuestId, creationTxHash);
        if (registeredQuest) {
          persistedQuest = {
            ...persistedQuest,
            ...registeredQuest
          };
          setMessage('Quest forged onchain and synced with backend. Ready to start!');
        }
      } catch (registrationError) {
        console.error('[CommandCenter] Backend onchain quest registration failed after retries', registrationError);
        setMessage(
          `Quest forged onchain, but backend sync is delayed. You can still start it, but it may retry syncing in the background. ${formatActionFailure(
            registrationError,
            'Wait a moment before starting.'
          )}`
        );
      }

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
    if (!(await requireReadyAuth('starting quests'))) {
      return;
    }

    setLoading(true);
    setMessage('Checking quest status and syncing...');

    try {
      const resolvedQuest = await resolveQuestForChainAction(
        activeQuest,
        'Quest is still missing its onchain id after sync. Please wait a moment and try again, or regenerate the quest.'
      );
      setMessage('Quest sync complete. Proceeding to start...');

      if (!provider) {
        throw new Error('Wallet provider is unavailable. Reconnect your wallet and try again.');
      }

      const signerAddress = await signer.getAddress();
      const chainQuestId = BigInt(String(resolvedQuest.chainQuestId));
      const onchainQuest = await forgeQuestManager.quests(chainQuestId);
      if (Number(onchainQuest.status) !== 0) {
        throw new Error(`Quest is no longer available to start. Onchain status=${Number(onchainQuest.status)}.`);
      }

      const stakeValue = BigInt(onchainQuest.stakeAmount.toString());
      const availableBalance = await provider.getBalance(signerAddress);
      const feeData = await provider.getFeeData();
      const fallbackGasPrice = await provider
        .send('eth_gasPrice', [])
        .then((value) => ethers.getBigInt(value))
        .catch(() => 0n);
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? fallbackGasPrice;

      console.info('[CommandCenter] startQuest preflight:start', {
        wallet: signerAddress,
        contract: contractAddresses.forgeQuestManagerAddress,
        chainId,
        network,
        chainQuestId: chainQuestId.toString(),
        stakeValueWei: stakeValue.toString(),
        stakeValueCelo: formatCeloAmount(stakeValue),
        availableBalanceWei: availableBalance.toString(),
        availableBalanceCelo: formatCeloAmount(availableBalance),
        gasPriceWei: gasPrice.toString()
      });

      if (availableBalance < stakeValue) {
        throw new Error(
          `Insufficient funds for the quest stake. Need ${formatCeloAmount(stakeValue)} CELO and wallet has ${formatCeloAmount(availableBalance)} CELO.`
        );
      }

      let gasEstimate: bigint;
      try {
        gasEstimate = isMiniPay && walletProvider
          ? await estimateContractWriteGas({
              provider: walletProvider,
              contractAddress: contractAddresses.forgeQuestManagerAddress,
              contractInterface: forgeQuestManager.interface,
              functionName: 'startQuest',
              args: [chainQuestId],
              from: signerAddress,
              value: stakeValue
            })
          : await forgeQuestManager.startQuest.estimateGas(chainQuestId, { value: stakeValue });
      } catch (preflightError) {
        const preflightFailure = describeTransactionFailure(preflightError);
        console.error('[CommandCenter] startQuest gas estimation failed', {
          wallet: signerAddress,
          chainQuestId: chainQuestId.toString(),
          stakeValueWei: stakeValue.toString(),
          failureKind: preflightFailure.kind,
          details: preflightFailure.details
        });
        throw preflightError;
      }

      const gasLimit = gasEstimate + gasEstimate / 5n;
      const estimatedGasCost = gasEstimate * gasPrice;

      console.info('[CommandCenter] startQuest preflight:success', {
        wallet: signerAddress,
        chainQuestId: chainQuestId.toString(),
        gasEstimate: gasEstimate.toString(),
        gasLimit: gasLimit.toString(),
        gasPriceWei: gasPrice.toString(),
        estimatedGasCostWei: estimatedGasCost.toString(),
        estimatedGasCostCelo: formatCeloAmount(estimatedGasCost)
      });

      if (availableBalance < stakeValue + estimatedGasCost) {
        throw new Error(
          `Insufficient funds for stake plus gas. Need about ${formatCeloAmount(stakeValue + estimatedGasCost)} CELO and wallet has ${formatCeloAmount(availableBalance)} CELO.`
        );
      }

      const { hash: startTxHash } = await submitForgeWrite('startQuest', [chainQuestId], {
        value: stakeValue,
        gasLimit
      });
      console.info('[CommandCenter] startQuest submitted', {
        hash: startTxHash,
        chainQuestId: chainQuestId.toString(),
        wallet: signerAddress,
        valueWei: stakeValue.toString()
      });

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
          const startRegistrationResponse = await registerQuestStart(String(resolvedQuest.id), chainQuestId.toString(), startTxHash);
          const registeredQuest = (startRegistrationResponse.data as { quest?: QuestState }).quest;
          if (registeredQuest) {
            persistedQuest = {
              ...persistedQuest,
              ...registeredQuest
            };
          }
        } catch (registrationError) {
          console.error('[CommandCenter] Backend quest start registration failed', registrationError);
          setMessage(
            `Quest started onchain, but backend start reconciliation is still catching up. ${formatActionFailure(
              registrationError,
              'Backend sync is delayed.'
            )}`
          );
        }
      }

      upsertQuest(persistedQuest);
      setMessage((current) =>
        typeof current === 'string' && current.startsWith('Quest started onchain')
          ? current
          : 'Quest started onchain. Wallet stake is locked and realtime reconciliation is running.'
      );
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
    if (!(await requireReadyAuth('submitting proof'))) {
      return;
    }

    setLoading(true);
    setMessage('Submitting proof to the Forge Master...');

    try {
      const resolvedQuest = await resolveQuestForChainAction(
        activeQuest,
        'Quest is still missing its onchain id after sync. Please wait a moment and try again.'
      );
      setMessage('Quest sync complete. Proceeding with proof submission...');

      const chainQuestId = BigInt(String(resolvedQuest.chainQuestId));
      const { hash: submissionTxHash } = await submitForgeWrite('submitQuest', [chainQuestId, proofUri]);
      console.info('[CommandCenter] submitQuest submitted', {
        hash: submissionTxHash,
        chainQuestId: chainQuestId.toString()
      });

      patchQuest(questMatcher(resolvedQuest), { status: 'SUBMITTED' });
      if (!resolvedQuest.id) {
        throw new Error('Quest is missing a persistent id');
      }

      await submitProofForVerification(resolvedQuest.id, proofUri, submissionTxHash);
      setMessage('Proof submitted onchain and queued for deterministic verification. Realtime settlement updates will stream here.');
      await syncNow();
      setProofUri('');
    } catch (error) {
      console.error('[CommandCenter] submitQuest failed', error);
      setMessage(formatActionFailure(error, 'Proof submission failed.'));
    } finally {
      setLoading(false);
    }
  }

  const generationProfile = resolveGenerationProfile(activeQuest);
  const generationLabel =
    generationProfile?.source === 'openai'
      ? `AI-generated${generationProfile.model ? ` via ${generationProfile.model}` : ''}`
      : 'Deterministic fallback';

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
                <p className="mt-1 text-sm text-slate-400">Available balance: {balance} CELO</p>
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
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-3xl border border-white/10 bg-navy/70 p-4 text-sm text-slate-200">
                    <p className="uppercase tracking-[0.22em] text-softyellow">Quest Source</p>
                    <p className="mt-2 font-semibold text-white">{generationLabel}</p>
                    {generationProfile?.provider || generationProfile?.promptHash ? (
                      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                        {generationProfile?.provider ? `Provider ${generationProfile.provider}` : 'Provider unknown'}
                        {generationProfile?.promptHash ? ` • Prompt ${generationProfile.promptHash.slice(0, 12)}` : ''}
                      </p>
                    ) : null}
                    <p className="mt-2">
                      {generationProfile?.source === 'openai'
                        ? 'OpenAI shaped the live quest narrative, title, and lore within deterministic economic bounds.'
                        : `OpenAI was unavailable or rejected, so QuestForge used its deterministic narrative fallback.${generationProfile?.fallbackReason ? ` ${generationProfile.fallbackReason}` : ''}`}
                    </p>
                  </div>
                  <div className="rounded-3xl border border-white/10 bg-navy/70 p-4 text-sm text-slate-200">
                    <p className="uppercase tracking-[0.22em] text-softyellow">Onchain Objective</p>
                    <p className="mt-2 font-semibold text-white">{String(activeQuest.objective ?? activeQuest.questType ?? 'Quest objective pending')}</p>
                    <p className="mt-2">
                      Stake {activeQuest.stakeAmount ?? '?'} CELO, pursue the gameplay step, then submit the proof hash for verifier settlement and Treasury payout.
                    </p>
                  </div>
                </div>
                <div className="rounded-3xl border border-white/10 bg-navy/70 p-4 text-sm text-slate-200">
                  <p className="uppercase tracking-[0.22em] text-softyellow">Lore Thread</p>
                  <p className="mt-2">{String(activeQuest.lore ?? 'Lore is synchronizing from the quest orchestrator.')}</p>
                  {Array.isArray(activeQuest.requiredTxTypes) && activeQuest.requiredTxTypes.length > 0 ? (
                    <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-400">
                      Tx path: {activeQuest.requiredTxTypes.join(' -> ')}
                    </p>
                  ) : null}
                </div>
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

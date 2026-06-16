import crypto from 'crypto';
import { ethers } from 'ethers';
import { env } from '../config/env';
import { prisma } from './chain';
import { contracts } from './contracts';
import { applyStreakDecay, clearQuestCooldown, hashProofUri, incrementDailyActivity, recoverStreakDecay, setQuestCooldown } from './antiAbuse';
import { isApprovalEvent, type ObjectiveType } from './questTemplates';
import { logger } from './logger';

// SAFETY: Maximum time to wait for a transaction receipt.
// Prevents the verification worker from blocking indefinitely
// if an RPC node goes silent or a transaction is stuck.
const TX_WAIT_TIMEOUT_MS = 120_000; // 2 minutes

type VerificationMetadata = {
  type: ObjectiveType;
  questType: string;
  minValueCelo: number;
  allowContractTarget: boolean;
  requireContractCall: boolean;
  requireTokenApproval: boolean;
};

type QuestVerificationRow = {
  id: string;
  chainQuestId: bigint | null;
  difficulty: number;
  metadata: unknown;
  status: string;
  proofTx: string | null;
  proofTxHash: string | null;
  startedAt: Date | null;
  expiresAt: Date;
  rewardAmount: number;
  playerId: string | null;
  playerWallet: string | null;
};

type ProofSubmissionRow = {
  id: string;
  userId: string;
  questId: string;
  proofUri: string;
  proofHash: string;
  submittedAt: Date;
  verificationResult: string | null;
  verificationReason: string | null;
};

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

let workerTimer: NodeJS.Timeout | null = null;
let workerActive = false;

/**
 * Wait for a transaction receipt with a timeout.
 * Prevents indefinite blocking when RPC nodes are unresponsive.
 */
async function waitForTransaction(
  tx: ethers.TransactionResponse,
  timeoutMs: number = TX_WAIT_TIMEOUT_MS
): Promise<ethers.TransactionReceipt | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    tx.wait(),
    new Promise<ethers.TransactionReceipt | null>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Transaction wait timed out after ${timeoutMs}ms: ${tx.hash}`));
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}



function elapsedMs(startedAtMs: number) {
  return Date.now() - startedAtMs;
}

function ensureVerifierContract() {
  if (!contracts.forgeQuestManagerWrite) {
    throw new Error('Verifier signer is not configured');
  }

  return contracts.forgeQuestManagerWrite as ethers.Contract;
}

export function canonicalizeProofReference(value: string) {
  const trimmed = value.trim();
  
  // Validate proof is not empty
  if (!trimmed || trimmed.length === 0) {
    throw new Error('Proof reference cannot be empty. Please describe how you completed the objective.');
  }

  // Accept the text proof as-is (could be plain text, hash, or URL)
  return trimmed;
}

function assertTransactionHash(value: string, label: string) {
  if (!TX_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid transaction hash`);
  }

  return value.toLowerCase();
}

function questRarityFromDifficulty(difficulty: number) {
  if (difficulty >= 5) return 'Legendary';
  if (difficulty === 4) return 'Epic';
  if (difficulty === 3) return 'Rare';
  if (difficulty === 2) return 'Uncommon';
  return 'Common';
}

async function resolveReceiptTimestamp(receipt: ethers.TransactionReceipt | null | undefined) {
  if (!receipt) {
    return new Date();
  }

  const block = await contracts.provider.getBlock(receipt.blockNumber);
  return block ? new Date(Number(block.timestamp) * 1000) : new Date();
}

function findReceiptEvents(contract: ethers.Contract, receipt: ethers.TransactionReceipt | null | undefined, eventName: string) {
  if (!receipt) {
    return [] as ethers.LogDescription[];
  }

  return receipt.logs.flatMap((log) => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === eventName ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function syncUserProfileSnapshot(userId: string | null, wallet: string | null) {
  if (!userId || !wallet) {
    return;
  }

  try {
    const profile = await contracts.reputation.profileFor(wallet);
    await prisma.user.update({
      where: { id: userId },
      data: {
        xp: Number(profile.xp),
        level: Number(profile.level),
        questCount: Number(profile.questCount),
        streak: Number(profile.streak),
        onchainActions: Number(profile.onchainActions)
      }
    });
  } catch (error) {
    logger.warn('Unable to sync user reputation snapshot after verification settlement', {
      userId,
      wallet,
      error: error instanceof Error ? error.message : 'Unknown reputation sync failure'
    });
  }
}

async function publishVerificationRealtimeEvent(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  input: {
    replayKey: string;
    eventName: string;
    quest: QuestVerificationRow;
    payload: Record<string, unknown>;
  }
) {
  // Real-time event publishing removed (database-first model)
  // Previously published verification events via realtimeEventPublisher (now deleted)
}

function readVerificationMetadata(metadata: unknown): VerificationMetadata {
  if (!metadata || typeof metadata !== 'object' || !('verification' in metadata)) {
    throw new Error('Quest metadata is missing deterministic verification rules');
  }

  const verification = (metadata as { verification?: VerificationMetadata }).verification;
  if (
    !verification ||
    typeof verification.type !== 'string' ||
    typeof verification.questType !== 'string' ||
    typeof verification.minValueCelo !== 'number' ||
    typeof verification.allowContractTarget !== 'boolean' ||
    typeof verification.requireContractCall !== 'boolean' ||
    typeof verification.requireTokenApproval !== 'boolean'
  ) {
    throw new Error('Quest verification metadata is malformed');
  }

  return verification;
}

async function loadQuestForVerification(questId: string) {
  const [quest] = await prisma.$queryRaw<QuestVerificationRow[]>`
    SELECT
      q.id,
      q."chainQuestId",
      q.difficulty,
      q.metadata,
      q.status,
      q."proofTx",
      q."proofTxHash",
      q."startedAt",
      q."expiresAt",
      q."rewardAmount",
      q."playerId",
      u.wallet AS "playerWallet"
    FROM "Quest" q
    LEFT JOIN "User" u ON u.id = q."playerId"
    WHERE q.id = ${questId}
    LIMIT 1
  `;

  return quest ?? null;
}

async function findProofSubmissionById(id: string) {
  const [proof] = await prisma.$queryRaw<ProofSubmissionRow[]>`
    SELECT
      id,
      "userId",
      "questId",
      "proofUri",
      "proofHash",
      "submittedAt",
      "verificationResult",
      "verificationReason"
    FROM "ProofSubmission"
    WHERE id = ${id}
    LIMIT 1
  `;

  return proof ?? null;
}

async function findProofSubmissionByHash(proofHash: string) {
  const [proof] = await prisma.$queryRaw<ProofSubmissionRow[]>`
    SELECT
      id,
      "userId",
      "questId",
      "proofUri",
      "proofHash",
      "submittedAt",
      "verificationResult",
      "verificationReason"
    FROM "ProofSubmission"
    WHERE "proofHash" = ${proofHash}
    LIMIT 1
  `;

  return proof ?? null;
}

async function updateProofSubmission(input: {
  id: string;
  proofUri?: string;
  verificationResult?: string;
  verificationReason?: string;
  verifiedAt?: Date | null;
}) {
  await prisma.$executeRaw`
    UPDATE "ProofSubmission"
    SET
      "proofUri" = COALESCE(${input.proofUri ?? null}, "proofUri"),
      "verificationResult" = COALESCE(${input.verificationResult ?? null}, "verificationResult"),
      "verificationReason" = COALESCE(${input.verificationReason ?? null}, "verificationReason"),
      "verifiedAt" = CASE
        WHEN ${typeof input.verifiedAt === 'undefined'} THEN "verifiedAt"
        ELSE ${input.verifiedAt}
      END
    WHERE id = ${input.id}
  `;
}

async function insertProofSubmission(input: {
  userId: string;
  questId: string;
  proofUri: string;
  proofHash: string;
  verificationResult: string;
  verificationReason: string;
}) {
  const id = crypto.randomUUID();
  const now = new Date();

  await prisma.$executeRaw`
    INSERT INTO "ProofSubmission" (
      id,
      "userId",
      "questId",
      "proofUri",
      "proofHash",
      "submittedAt",
      "verificationResult",
      "verificationReason",
      "createdAt"
    )
    VALUES (
      ${id},
      ${input.userId},
      ${input.questId},
      ${input.proofUri},
      ${input.proofHash},
      ${now},
      ${input.verificationResult},
      ${input.verificationReason},
      ${now}
    )
  `;

  return id;
}

async function updateQuestSubmissionState(input: {
  questId: string;
  status: 'COMPLETED' | 'CLAIMABLE' | 'ACCEPTED';
  proofTx?: string;
  proofTxHash?: string;
  verificationTx?: string;
  completedAt?: Date | null;
  failedAt?: Date | null;
}) {
  await prisma.$executeRaw`
    UPDATE "Quest"
    SET
      status = ${input.status}::"QuestStatus",
      "proofTx" = COALESCE(${input.proofTx ?? null}, "proofTx"),
      "proofTxHash" = COALESCE(${input.proofTxHash ?? null}, "proofTxHash"),
      "verificationTx" = COALESCE(${input.verificationTx ?? null}, "verificationTx"),
      "completedAt" = CASE
        WHEN ${typeof input.completedAt === 'undefined'} THEN "completedAt"
        ELSE ${input.completedAt}
      END,
      "failedAt" = CASE
        WHEN ${typeof input.failedAt === 'undefined'} THEN "failedAt"
        ELSE ${input.failedAt}
      END
    WHERE id = ${input.questId}
  `;
}

async function syncSuccessfulSettlementArtifacts(input: {
  quest: QuestVerificationRow;
  onchainQuest: Awaited<ReturnType<typeof resolveOnchainQuest>>;
  receipt: ethers.TransactionReceipt | null;
  verificationTxHash: string;
  verificationReason: string;
}) {
  const settledAt = await resolveReceiptTimestamp(input.receipt);
  const rewardReleased = findReceiptEvents(contracts.treasury, input.receipt, 'RewardReleased').at(-1);
  const rewardPaid = findReceiptEvents(contracts.treasury, input.receipt, 'RewardPaid').at(-1);
  const rewardMinted = findReceiptEvents(contracts.rewardNFT, input.receipt, 'RewardMinted').at(-1);

  const rewardAmount = Number(ethers.formatEther(input.onchainQuest.rewardAmount));
  const acceptanceFee = Number(ethers.formatEther(input.onchainQuest.stakeAmount));
  const stakeAmount = acceptanceFee;
  const totalAmount = rewardAmount + stakeAmount;

  logger.info('Proof verification reward settlement started', {
    questId: input.quest.id,
    chainQuestId: input.quest.chainQuestId?.toString() ?? null,
    verificationTxHash: input.verificationTxHash,
    verificationReason: input.verificationReason,
    rewardReleased: Boolean(rewardReleased),
    rewardPaid: Boolean(rewardPaid),
    rewardMinted: Boolean(rewardMinted),
    rewardAmount,
    acceptanceFee,
    stakeAmount,
    totalAmount
  });

  await prisma.treasuryPayout.upsert({
    where: { questId: input.quest.id },
    create: {
      questId: input.quest.id,
      userId: input.quest.playerId ?? undefined,
      chainQuestId: input.quest.chainQuestId ?? input.onchainQuest.questId,
      playerWallet: input.quest.playerWallet ?? undefined,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: rewardPaid ? 'PAID' : rewardReleased ? 'RELEASED' : 'LOCKED',
      releaseTx: rewardReleased ? input.verificationTxHash : undefined,
      payoutTx: rewardPaid ? input.verificationTxHash : undefined,
      rewardReleasedAt: rewardReleased ? settledAt : undefined,
      rewardPaidAt: rewardPaid ? settledAt : undefined
    },
    update: {
      userId: input.quest.playerId,
      chainQuestId: input.quest.chainQuestId ?? input.onchainQuest.questId,
      playerWallet: input.quest.playerWallet,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: rewardPaid ? 'PAID' : rewardReleased ? 'RELEASED' : 'LOCKED',
      releaseTx: rewardReleased ? input.verificationTxHash : undefined,
      payoutTx: rewardPaid ? input.verificationTxHash : undefined,
      rewardReleasedAt: rewardReleased ? settledAt : undefined,
      rewardPaidAt: rewardPaid ? settledAt : undefined
    }
  });

  if (input.quest.playerId && rewardPaid) {
    const existingReward = await prisma.reward.findFirst({
      where: {
        userId: input.quest.playerId,
        tokenTx: input.verificationTxHash
      },
      select: { id: true }
    });

    if (!existingReward) {
      await prisma.reward.create({
        data: {
          userId: input.quest.playerId,
          type: 'CELO',
          amount: rewardAmount,
          tokenTx: input.verificationTxHash,
          createdAt: settledAt
        }
      });

      logger.info('Proof verification reward issuance recorded', {
        questId: input.quest.id,
        userId: input.quest.playerId,
        verificationTxHash: input.verificationTxHash,
        rewardAmount
      });
    }
  }

  if (input.quest.playerId && rewardMinted) {
    const tokenId = rewardMinted.args?.tokenId?.toString?.();
    if (tokenId) {
      const existingNft = await prisma.nFT.findFirst({
        where: { tokenId },
        select: { id: true }
      });

      if (!existingNft) {
        await prisma.nFT.create({
          data: {
            userId: input.quest.playerId,
            tokenId,
            metadataUri: input.quest.proofTx ?? input.onchainQuest.proofUri,
            rarity: questRarityFromDifficulty(input.quest.difficulty),
            xpEarned: Number(input.onchainQuest.xpReward),
            questHistory: input.quest.id,
            mintedAt: settledAt
          }
        });

        logger.info('Proof verification NFT mint recorded', {
          questId: input.quest.id,
          userId: input.quest.playerId,
          tokenId,
          verificationTxHash: input.verificationTxHash
        });
      }

      await publishVerificationRealtimeEvent({
        replayKey: `verification-success-nft:${input.quest.id}:${tokenId}`,
        eventName: 'nft:minted',
        quest: input.quest,
        payload: {
          verificationTx: input.verificationTxHash,
          data: {
            tokenId
          }
        }
      });
    }
  }

  await syncUserProfileSnapshot(input.quest.playerId, input.quest.playerWallet);

  if (rewardReleased) {
    await publishVerificationRealtimeEvent({
      replayKey: `verification-success-released:${input.quest.id}:${input.verificationTxHash}`,
      eventName: 'reward:released',
      quest: input.quest,
      payload: {
        verificationTx: input.verificationTxHash,
        treasuryPayout: {
          status: 'RELEASED',
          releaseTx: input.verificationTxHash,
          rewardAmount,
          stakeAmount,
          totalAmount
        }
      }
    });
  }

  if (rewardPaid) {
    await publishVerificationRealtimeEvent({
      replayKey: `verification-success-paid:${input.quest.id}:${input.verificationTxHash}`,
      eventName: 'reward:paid',
      quest: input.quest,
      payload: {
        verificationTx: input.verificationTxHash,
        treasuryPayout: {
          status: 'PAID',
          releaseTx: rewardReleased ? input.verificationTxHash : null,
          payoutTx: input.verificationTxHash,
          rewardAmount,
          stakeAmount,
          totalAmount
        }
      }
    });
  }

  logger.info('Proof verification reward settlement completed', {
    questId: input.quest.id,
    chainQuestId: input.quest.chainQuestId?.toString() ?? null,
    verificationTxHash: input.verificationTxHash,
    verificationReason: input.verificationReason
  });
}

async function syncFailedSettlementArtifacts(input: {
  quest: QuestVerificationRow;
  onchainQuest: Awaited<ReturnType<typeof resolveOnchainQuest>>;
  receipt: ethers.TransactionReceipt | null;
  verificationTxHash?: string;
  verificationReason: string;
}) {
  const refundEvent = findReceiptEvents(contracts.treasury, input.receipt, 'RewardRefunded').at(-1);
  const settledAt = await resolveReceiptTimestamp(input.receipt);
  const rewardAmount = refundEvent
    ? Number(ethers.formatEther(refundEvent.args?.rewardAmount ?? 0n))
    : Number(ethers.formatEther(input.onchainQuest.rewardAmount));
  const acceptanceFee = Number(ethers.formatEther(input.onchainQuest.stakeAmount));
  const stakeAmount = acceptanceFee;
  const totalAmount = rewardAmount + stakeAmount;

  if (input.verificationTxHash) {
    await prisma.treasuryPayout.upsert({
      where: { questId: input.quest.id },
      create: {
        questId: input.quest.id,
        userId: input.quest.playerId ?? undefined,
        chainQuestId: input.quest.chainQuestId ?? input.onchainQuest.questId,
        playerWallet: input.quest.playerWallet ?? undefined,
        rewardAmount,
        stakeAmount,
        totalAmount,
        status: 'REFUNDED',
        refundTx: input.verificationTxHash,
        rewardRefundedAt: settledAt
      },
      update: {
        userId: input.quest.playerId,
        chainQuestId: input.quest.chainQuestId ?? input.onchainQuest.questId,
        playerWallet: input.quest.playerWallet,
        rewardAmount,
        stakeAmount,
        totalAmount,
        status: 'REFUNDED',
        refundTx: input.verificationTxHash,
        rewardRefundedAt: settledAt
      }
    });
  }

  if (input.verificationTxHash) {
    await publishVerificationRealtimeEvent({
      replayKey: `verification-failure-refunded:${input.quest.id}:${input.verificationTxHash}`,
      eventName: 'reward:refunded',
      quest: input.quest,
      payload: {
        verificationTx: input.verificationTxHash,
        treasuryPayout: {
          status: 'REFUNDED',
          refundTx: input.verificationTxHash,
          rewardAmount,
          stakeAmount,
          totalAmount
        },
        verificationReason: input.verificationReason
      }
    });
  }
}

async function claimPendingProofs(limit: number) {
  const proofs = await prisma.$queryRaw<ProofSubmissionRow[]>`
    SELECT
      id,
      "userId",
      "questId",
      "proofUri",
      "proofHash",
      "submittedAt",
      "verificationResult",
      "verificationReason"
    FROM "ProofSubmission"
    WHERE "verificationResult" = 'pending'
    ORDER BY "submittedAt" ASC
    LIMIT ${limit}
  `;

  const claimed: ProofSubmissionRow[] = [];
  const claimedQuestIds: string[] = [];

  for (const proof of proofs) {
    const updated = await prisma.$executeRaw`
      UPDATE "ProofSubmission"
      SET
        "verificationResult" = 'processing',
        "verificationReason" = 'Deterministic verification in progress'
      WHERE id = ${proof.id}
        AND "verificationResult" = 'pending'
    `;

    if (updated === 1) {
      claimed.push({ ...proof, verificationResult: 'processing', verificationReason: 'Deterministic verification in progress' });
      claimedQuestIds.push(proof.questId);
    }
  }

  logger.info('Proof verification batch claimed', {
    requestedLimit: limit,
    pendingCount: proofs.length,
    claimedCount: claimed.length,
    claimedQuestIds
  });

  return claimed;
}

async function verifySubmissionTransaction(input: {
  submissionTxHash: string;
  chainQuestId: bigint;
  wallet: string;
  proofHash: string;
}) {
  const receipt = await contracts.provider.getTransactionReceipt(input.submissionTxHash);
  if (!receipt || receipt.status !== 1) {
    throw new Error('Proof submission transaction was not successful onchain');
  }

  const parsedLogs = receipt.logs
    .map((log) => {
      try {
        return contracts.forgeQuestManager.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const submittedEvent = parsedLogs.find((log) => log?.name === 'QuestSubmitted');
  if (!submittedEvent) {
    throw new Error('Proof submission transaction did not emit QuestSubmitted');
  }

  if (BigInt(submittedEvent.args.questId.toString()) !== input.chainQuestId) {
    throw new Error('Proof submission transaction references the wrong quest');
  }

  if (String(submittedEvent.args.player).toLowerCase() !== input.wallet.toLowerCase()) {
    throw new Error('Proof submission transaction was not sent by the quest player');
  }

  if (String(submittedEvent.args.proofHash).toLowerCase() !== input.proofHash.toLowerCase()) {
    throw new Error('Proof submission transaction proof hash does not match the declared proof');
  }
}

async function verifyGameplayTransaction(input: {
  proofTxHash: string;
  wallet: string;
  verification: VerificationMetadata;
  startedAt: Date | null;
  expiresAt: Date;
}) {
  const [tx, receipt] = await Promise.all([
    contracts.provider.getTransaction(input.proofTxHash),
    contracts.provider.getTransactionReceipt(input.proofTxHash)
  ]);

  if (!tx || !receipt || receipt.status !== 1) {
    throw new Error('Proof transaction is missing or failed onchain');
  }

  if ((tx.from || '').toLowerCase() !== input.wallet.toLowerCase()) {
    throw new Error('Proof transaction is not owned by the authenticated wallet');
  }

  const block = await contracts.provider.getBlock(receipt.blockNumber);
  const blockTimestamp = new Date((block?.timestamp ?? 0) * 1000);

  if (input.startedAt && blockTimestamp.getTime() < input.startedAt.getTime()) {
    throw new Error('Proof transaction predates the quest start');
  }

  if (blockTimestamp.getTime() > input.expiresAt.getTime()) {
    throw new Error('Proof transaction occurred after the quest expiry');
  }

  if (input.verification.requireContractCall && (!tx.to || tx.data === '0x')) {
    throw new Error('Quest requires a contract call with calldata');
  }

  if (!input.verification.allowContractTarget && (!tx.to || tx.to.toLowerCase() === input.wallet.toLowerCase())) {
    throw new Error('Quest requires a transfer to another wallet');
  }

  const minValueWei = ethers.parseEther(input.verification.minValueCelo.toFixed(18));
  if (tx.value < minValueWei) {
    throw new Error('Proof transaction value is below the quest minimum');
  }

  if (input.verification.requireTokenApproval) {
    const hasApprovalLog = receipt.logs.some((log) => isApprovalEvent(log.topics));
    if (!hasApprovalLog) {
      throw new Error('Proof transaction did not emit an ERC20 Approval event');
    }
  }
}

async function resolveOnchainQuest(chainQuestId: bigint) {
  return contracts.forgeQuestManager.quests(chainQuestId);
}

type OnchainQuest = Awaited<ReturnType<typeof resolveOnchainQuest>>;

function computeVerificationHash(wallet: string, proofTxHash: string, playerNonce: bigint) {
  return ethers.solidityPackedKeccak256(['address', 'string', 'uint256'], [wallet, proofTxHash, playerNonce]);
}

async function markProofResult(input: {
  proofSubmissionId: string;
  questId: string;
  result: 'VERIFIED' | 'REJECTED';
  reason: string;
  verificationTx?: string;
}) {
  const now = new Date();

  await updateProofSubmission({
    id: input.proofSubmissionId,
    verificationResult: input.result,
    verificationReason: input.reason,
    verifiedAt: now
  });

  await updateQuestSubmissionState({
    questId: input.questId,
    status: input.result === 'VERIFIED' ? 'CLAIMABLE' : 'ACCEPTED',
    verificationTx: input.verificationTx,
    completedAt: input.result === 'VERIFIED' ? now : null,
    failedAt: input.result === 'REJECTED' ? now : null
  });
}

async function settleVerificationSuccess(input: {
  quest: QuestVerificationRow;
  proofSubmissionId: string;
  verificationReason: string;
  onchainQuest: OnchainQuest;
  expectedVerificationHash: string;
}) {
  const { quest, proofSubmissionId, verificationReason, onchainQuest, expectedVerificationHash } = input;
  if (!quest.playerId || !quest.chainQuestId) {
    throw new Error('Quest player context is incomplete');
  }

  const verifierContract = ensureVerifierContract();
  const tx = await verifierContract.verifyQuest(quest.chainQuestId, true, expectedVerificationHash);
  const receipt = await waitForTransaction(tx);
  const verificationTxHash = (receipt?.hash || tx.hash) as string;
  const xpReward = Number(onchainQuest.xpReward);

  logger.info('Proof verification success tx settled', {
    questId: quest.id,
    chainQuestId: quest.chainQuestId.toString(),
    proofSubmissionId,
    verificationTxHash,
    xpReward,
    verificationReason
  });

  await markProofResult({
    proofSubmissionId,
    questId: quest.id,
    result: 'VERIFIED',
    reason: verificationReason,
    verificationTx: verificationTxHash
  });

  await publishVerificationRealtimeEvent({
    replayKey: `verification-success-claimed:${quest.id}:${verificationTxHash}`,
    eventName: 'reward:claimed',
    quest,
    payload: {
      verificationTx: verificationTxHash,
      verificationReason,
      data: {
        success: true,
        reason: verificationReason
      }
    }
  });

  await incrementDailyActivity(quest.playerId, {
    questsCompleted: 1,
    xpEarned: xpReward,
    rewardsEarned: quest.rewardAmount
  });
  await recoverStreakDecay(quest.playerId);
  await clearQuestCooldown(quest.playerId);
  await syncSuccessfulSettlementArtifacts({
    quest,
    onchainQuest,
    receipt,
    verificationTxHash,
    verificationReason
  });

  logger.info('Quest completion finalized', {
    questId: quest.id,
    chainQuestId: quest.chainQuestId.toString(),
    playerId: quest.playerId,
    verificationTxHash,
    xpReward,
    rewardAmount: quest.rewardAmount
  });
}

async function settleVerificationFailure(quest: QuestVerificationRow, proofSubmissionId: string, verificationReason: string) {
  if (!quest.playerId || !quest.playerWallet || !quest.chainQuestId || !quest.proofTx) {
    await markProofResult({
      proofSubmissionId,
      questId: quest.id,
      result: 'REJECTED',
      reason: verificationReason
    });
    return;
  }

  const onchainQuest = await resolveOnchainQuest(quest.chainQuestId);
  const expectedVerificationHash = computeVerificationHash(
    quest.playerWallet,
    quest.proofTx,
    BigInt(onchainQuest.playerNonce.toString())
  );

  let verificationTxHash: string | undefined;
  let receipt: ethers.TransactionReceipt | null = null;
  if (contracts.forgeQuestManagerWrite && Number(onchainQuest.status) === 2) {
    const tx = await ensureVerifierContract().verifyQuest(quest.chainQuestId, false, expectedVerificationHash);
    receipt = await waitForTransaction(tx);
    verificationTxHash = (receipt?.hash || tx.hash) as string;
  }

  logger.warn('Proof verification failure settlement started', {
    questId: quest.id,
    chainQuestId: quest.chainQuestId.toString(),
    proofSubmissionId,
    verificationTxHash: verificationTxHash ?? null,
    verificationReason
  });

  await markProofResult({
    proofSubmissionId,
    questId: quest.id,
    result: 'REJECTED',
    reason: verificationReason,
    verificationTx: verificationTxHash
  });

  await publishVerificationRealtimeEvent({
    replayKey: `verification-failure-claimed:${quest.id}:${verificationTxHash ?? 'REJECTED'}`,
    eventName: 'reward:claimed',
    quest,
    payload: {
      verificationTx: verificationTxHash ?? null,
      verificationReason,
      data: {
        success: false,
        reason: verificationReason
      }
    }
  });

  await applyStreakDecay(quest.playerId);
  await setQuestCooldown(quest.playerId, 15, 'quest_failure');
  await syncFailedSettlementArtifacts({
    quest,
    onchainQuest,
    receipt,
    verificationTxHash,
    verificationReason
  });

  logger.warn('Quest completion rejected', {
    questId: quest.id,
    chainQuestId: quest.chainQuestId.toString(),
    playerId: quest.playerId,
    verificationTxHash: verificationTxHash ?? null,
    verificationReason
  });
}

async function verifyQueuedProof(proofSubmissionId: string) {
  const verificationStartedAtMs = Date.now();
  const proof = await findProofSubmissionById(proofSubmissionId);
  if (!proof) {
    return;
  }

  const quest = await loadQuestForVerification(proof.questId);
  if (!quest || !quest.playerId || !quest.playerWallet || !quest.chainQuestId) {
    logger.warn('Proof verification skipped because quest context is incomplete', {
      proofSubmissionId,
      questId: proof.questId,
      hasQuest: Boolean(quest),
      hasPlayerId: Boolean(quest?.playerId),
      hasPlayerWallet: Boolean(quest?.playerWallet),
      hasChainQuestId: Boolean(quest?.chainQuestId)
    });

    await updateProofSubmission({
      id: proof.id,
      verificationResult: 'REJECTED',
      verificationReason: 'Quest context is incomplete for deterministic verification',
      verifiedAt: new Date()
    });
    return;
  }

  logger.info('Proof verification started', {
    questId: quest.id,
    chainQuestId: quest.chainQuestId.toString(),
    wallet: quest.playerWallet,
    proofSubmissionId: proof.id,
    proofId: proof.id,
    proofReceivedAt: proof.submittedAt.toISOString()
  });

  try {
    const verification = readVerificationMetadata(quest.metadata);
    const proofTxHash = canonicalizeProofReference(proof.proofUri);
    const submissionTxHash = assertTransactionHash(quest.proofTxHash || '', 'submissionTxHash');
    const expectedProofHash = hashProofUri(proofTxHash);

    if (proofTxHash === submissionTxHash) {
      throw new Error('Paste the gameplay transaction hash as proof, not the proof-submission transaction hash');
    }

    logger.info('Proof verification tx fetch started', {
      questId: quest.id,
      chainQuestId: quest.chainQuestId.toString(),
      wallet: quest.playerWallet,
      proofSubmissionId: proof.id,
      proofId: proof.id,
      proofTxHash,
      submissionTxHash
    });

    const [onchainQuest] = await Promise.all([
      resolveOnchainQuest(quest.chainQuestId),
      verifySubmissionTransaction({
        submissionTxHash,
        chainQuestId: quest.chainQuestId,
        wallet: quest.playerWallet,
        proofHash: expectedProofHash
      }),
      verifyGameplayTransaction({
        proofTxHash,
        wallet: quest.playerWallet,
        verification,
        startedAt: quest.startedAt,
        expiresAt: quest.expiresAt
      })
    ]);

    if (String(onchainQuest.player).toLowerCase() !== quest.playerWallet.toLowerCase()) {
      throw new Error('Onchain quest ownership does not match the authenticated player');
    }

    if (String(onchainQuest.proofHash).toLowerCase() !== expectedProofHash.toLowerCase()) {
      throw new Error('Onchain quest proof hash does not match the stored proof');
    }

    if (Number(onchainQuest.status) !== 2) {
      throw new Error(`Onchain quest is not awaiting verification (status=${onchainQuest.status.toString()})`);
    }

    const expectedVerificationHash = computeVerificationHash(
      quest.playerWallet,
      proofTxHash,
      BigInt(onchainQuest.playerNonce.toString())
    );

    if (String(onchainQuest.proofVerificationHash).toLowerCase() !== expectedVerificationHash.toLowerCase()) {
      throw new Error('Onchain proof verification hash does not match the deterministic backend computation');
    }

    logger.info('Proof verification tx validated', {
      questId: quest.id,
      chainQuestId: quest.chainQuestId.toString(),
      wallet: quest.playerWallet,
      proofSubmissionId: proof.id,
      proofId: proof.id,
      proofTxHash,
      submissionTxHash,
      validationDurationMs: elapsedMs(verificationStartedAtMs)
    });

    await settleVerificationSuccess({
      quest,
      proofSubmissionId: proof.id,
      verificationReason: 'Deterministic onchain verification passed and treasury settlement executed',
      onchainQuest,
      expectedVerificationHash
    });
    logger.info('Proof verification completed', {
      questId: quest.id,
      chainQuestId: quest.chainQuestId.toString(),
      wallet: quest.playerWallet,
      proofSubmissionId: proof.id,
      proofId: proof.id,
      verificationResult: 'VERIFIED',
      durationMs: elapsedMs(verificationStartedAtMs)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Deterministic verification failed';
    await settleVerificationFailure(quest, proof.id, reason);
    logger.warn('Proof verification completed', {
      questId: quest.id,
      chainQuestId: quest.chainQuestId.toString(),
      wallet: quest.playerWallet,
      proofSubmissionId: proof.id,
      proofId: proof.id,
      verificationResult: 'REJECTED',
      reason,
      durationMs: elapsedMs(verificationStartedAtMs)
    });
  }

  logger.info('Proof verification worker finished quest', {
    proofSubmissionId,
    questId: quest.id,
    durationMs: elapsedMs(verificationStartedAtMs)
  });
}

export async function queueProofVerification(params: {
  userId: string;
  questId: string;
  proofUri: string;
  submissionTxHash: string;
}) {
  if (!contracts.forgeQuestManagerWrite) {
    throw new Error('Proof verification is unavailable because VERIFIER_PRIVATE_KEY is not configured');
  }

  const canonicalProofTxHash = canonicalizeProofReference(params.proofUri);
  const normalizedSubmissionTxHash = assertTransactionHash(params.submissionTxHash, 'submissionTxHash');
  const proofHash = hashProofUri(canonicalProofTxHash);
  const receivedAt = new Date();

  const quest = await loadQuestForVerification(params.questId);
  if (!quest || quest.playerId !== params.userId) {
    throw new Error('Quest not found for authenticated player');
  }

  logger.info('Proof verification received', {
    questId: params.questId,
    chainQuestId: quest.chainQuestId?.toString() ?? null,
    userId: params.userId,
    wallet: quest.playerWallet,
    proofTxHash: canonicalProofTxHash,
    submissionTxHash: normalizedSubmissionTxHash,
    receivedAt: receivedAt.toISOString()
  });

  const existingProof = await findProofSubmissionByHash(proofHash);
  let proofSubmissionId: string;

  if (existingProof && existingProof.questId !== params.questId) {
    throw new Error('Proof transaction hash has already been used for another quest');
  }

  if (existingProof) {
    if (existingProof.verificationResult && !['pending', 'processing'].includes(existingProof.verificationResult)) {
      throw new Error(`Proof has already been ${existingProof.verificationResult.toLowerCase()}`);
    }

    proofSubmissionId = existingProof.id;
    logger.info('Proof verification request deduplicated', {
      questId: params.questId,
      proofSubmissionId,
      proofId: proofSubmissionId,
      proofTxHash: canonicalProofTxHash,
      submissionTxHash: normalizedSubmissionTxHash,
      currentVerificationResult: existingProof.verificationResult
    });
  } else {
    logger.info('Proof verification persistence starting', {
      questId: params.questId,
      chainQuestId: quest.chainQuestId?.toString() ?? null,
      userId: params.userId,
      proofHash,
      proofUriPreview: canonicalProofTxHash.slice(0, 16),
      submissionTxHash: normalizedSubmissionTxHash
    });

    proofSubmissionId = await insertProofSubmission({
      userId: params.userId,
      questId: params.questId,
      proofUri: canonicalProofTxHash,
      proofHash,
      verificationResult: 'pending',
      verificationReason: 'Queued for deterministic verification'
    });

    logger.info('Proof verification persistence completed', {
      questId: params.questId,
      chainQuestId: quest.chainQuestId?.toString() ?? null,
      userId: params.userId,
      proofSubmissionId,
      proofHash
    });
  }

  await updateQuestSubmissionState({
    questId: params.questId,
    status: 'COMPLETED',
    proofTx: canonicalProofTxHash,
    proofTxHash: normalizedSubmissionTxHash
  });

  logger.info('Proof verification queued', {
    questId: params.questId,
    chainQuestId: quest.chainQuestId?.toString() ?? null,
    userId: params.userId,
    proofSubmissionId,
    proofTxHash: canonicalProofTxHash,
    submissionTxHash: normalizedSubmissionTxHash
  });

  await publishVerificationRealtimeEvent({
    replayKey: `verification-submitted:${params.questId}:${proofSubmissionId}:${normalizedSubmissionTxHash}`,
    eventName: 'proof:submitted',
    quest: {
      ...quest,
      proofTx: canonicalProofTxHash,
      proofTxHash: normalizedSubmissionTxHash
    },
    payload: {
      status: 'SUBMITTED',
      proofTx: canonicalProofTxHash,
      proofTxHash: normalizedSubmissionTxHash,
      verificationResult: 'pending',
      verificationReason: 'Queued for deterministic verification'
    }
  });

  void processPendingProofSubmissions();

  return {
    proofHash,
    proofSubmissionId
  };
}

export async function processPendingProofSubmissions(limit = env.VERIFICATION_BATCH_SIZE) {
  if (!contracts.forgeQuestManagerWrite) {
    logger.warn('Skipping proof verification batch because verifier signer is unavailable');
    return;
  }

  if (workerActive) {
    return;
  }

  workerActive = true;
  try {
    logger.info('Proof verification worker batch started', {
      limit
    });

    while (true) {
      const pending = await claimPendingProofs(limit);
      if (pending.length === 0) {
        break;
      }

      for (const proof of pending) {
        logger.info('Proof verification worker picked up quest', {
          questId: proof.questId,
          proofSubmissionId: proof.id,
          verificationResult: proof.verificationResult
        });
        await verifyQueuedProof(proof.id);
      }
    }
  } finally {
    workerActive = false;
    logger.info('Proof verification worker batch finished', {
      limit
    });
  }
}

export function startProofVerificationWorker() {
  if (workerTimer) {
    return;
  }

  if (!env.VERIFIER_PRIVATE_KEY) {
    const message = 'Proof verification worker disabled: VERIFIER_PRIVATE_KEY is not configured';
    if (env.NODE_ENV === 'production') {
      throw new Error(message);
    }
    logger.warn(message);
    return;
  }

  void processPendingProofSubmissions();
  workerTimer = setInterval(() => {
    void processPendingProofSubmissions();
  }, env.VERIFICATION_WORKER_INTERVAL_MS);
}

export async function stopProofVerificationWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }

  while (workerActive) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

import crypto from 'crypto';
import { ethers } from 'ethers';
import { env } from '../config/env';
import { prisma } from './chain';
import { contracts } from './contracts';
import { applyStreakDecay, clearQuestCooldown, hashProofUri, incrementDailyActivity, recoverStreakDecay, setQuestCooldown } from './antiAbuse';
import { isApprovalEvent, type ObjectiveType } from './questTemplates';
import { logger } from './logger';

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

function ensureVerifierContract() {
  if (!contracts.forgeQuestManagerWrite) {
    throw new Error('Verifier signer is not configured');
  }

  return contracts.forgeQuestManagerWrite as ethers.Contract;
}

export function canonicalizeProofReference(value: string) {
  const trimmed = value.trim();
  if (TX_HASH_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  try {
    const url = new URL(trimmed);
    const pathnameMatch = url.pathname.match(/0x[a-fA-F0-9]{64}/);
    if (pathnameMatch) {
      return pathnameMatch[0].toLowerCase();
    }

    for (const [key, paramValue] of url.searchParams.entries()) {
      if ((key === 'tx' || key === 'hash' || key === 'transactionHash') && TX_HASH_PATTERN.test(paramValue)) {
        return paramValue.toLowerCase();
      }
    }
  } catch {
    // Fall through to validation error.
  }

  throw new Error('Proof must be a Celo transaction hash or explorer URL containing one');
}

function assertTransactionHash(value: string, label: string) {
  if (!TX_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid transaction hash`);
  }

  return value.toLowerCase();
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
  status: 'SUBMITTED' | 'VERIFIED' | 'FAILED';
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
    }
  }

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
  const tx = await contracts.provider.getTransaction(input.proofTxHash);
  const receipt = await contracts.provider.getTransactionReceipt(input.proofTxHash);

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

function computeVerificationHash(wallet: string, proofTxHash: string, playerNonce: bigint) {
  return ethers.solidityPackedKeccak256(['address', 'string', 'uint256'], [wallet, proofTxHash, playerNonce]);
}

async function markProofResult(input: {
  proofSubmissionId: string;
  questId: string;
  result: 'approved' | 'rejected';
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
    status: input.result === 'approved' ? 'VERIFIED' : 'FAILED',
    verificationTx: input.verificationTx,
    completedAt: input.result === 'approved' ? now : null,
    failedAt: input.result === 'rejected' ? now : null
  });
}

async function settleVerificationSuccess(quest: QuestVerificationRow, proofSubmissionId: string, verificationReason: string) {
  if (!quest.playerId || !quest.playerWallet || !quest.chainQuestId || !quest.proofTx) {
    throw new Error('Quest player context is incomplete');
  }

  const onchainQuest = await resolveOnchainQuest(quest.chainQuestId);
  const expectedVerificationHash = computeVerificationHash(
    quest.playerWallet,
    quest.proofTx,
    BigInt(onchainQuest.playerNonce.toString())
  );

  if (String(onchainQuest.proofVerificationHash).toLowerCase() !== expectedVerificationHash.toLowerCase()) {
    throw new Error('Onchain proof verification hash does not match the deterministic backend computation');
  }

  const verifierContract = ensureVerifierContract();
  const tx = await verifierContract.verifyQuest(quest.chainQuestId, true, expectedVerificationHash);
  const receipt = await tx.wait();
  const verificationTxHash = (receipt?.hash || tx.hash) as string;
  const xpReward = Number(onchainQuest.xpReward);

  await markProofResult({
    proofSubmissionId,
    questId: quest.id,
    result: 'approved',
    reason: verificationReason,
    verificationTx: verificationTxHash
  });

  await incrementDailyActivity(quest.playerId, {
    questsCompleted: 1,
    xpEarned: xpReward,
    rewardsEarned: quest.rewardAmount
  });
  await recoverStreakDecay(quest.playerId);
  await clearQuestCooldown(quest.playerId);
}

async function settleVerificationFailure(quest: QuestVerificationRow, proofSubmissionId: string, verificationReason: string) {
  if (!quest.playerId || !quest.playerWallet || !quest.chainQuestId || !quest.proofTx) {
    await markProofResult({
      proofSubmissionId,
      questId: quest.id,
      result: 'rejected',
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
  if (contracts.forgeQuestManagerWrite && Number(onchainQuest.status) === 2) {
    const tx = await ensureVerifierContract().verifyQuest(quest.chainQuestId, false, expectedVerificationHash);
    const receipt = await tx.wait();
    verificationTxHash = (receipt?.hash || tx.hash) as string;
  }

  await markProofResult({
    proofSubmissionId,
    questId: quest.id,
    result: 'rejected',
    reason: verificationReason,
    verificationTx: verificationTxHash
  });

  await applyStreakDecay(quest.playerId);
  await setQuestCooldown(quest.playerId, 15, 'quest_failure');
}

async function verifyQueuedProof(proofSubmissionId: string) {
  const proof = await findProofSubmissionById(proofSubmissionId);
  if (!proof) {
    return;
  }

  const quest = await loadQuestForVerification(proof.questId);
  if (!quest || !quest.playerId || !quest.playerWallet || !quest.chainQuestId) {
    await updateProofSubmission({
      id: proof.id,
      verificationResult: 'rejected',
      verificationReason: 'Quest context is incomplete for deterministic verification',
      verifiedAt: new Date()
    });
    return;
  }

  try {
    const verification = readVerificationMetadata(quest.metadata);
    const proofTxHash = canonicalizeProofReference(proof.proofUri);
    const submissionTxHash = assertTransactionHash(quest.proofTxHash || '', 'submissionTxHash');
    const expectedProofHash = hashProofUri(proofTxHash);
    const onchainQuest = await resolveOnchainQuest(quest.chainQuestId);

    if (String(onchainQuest.player).toLowerCase() !== quest.playerWallet.toLowerCase()) {
      throw new Error('Onchain quest ownership does not match the authenticated player');
    }

    if (String(onchainQuest.proofHash).toLowerCase() !== expectedProofHash.toLowerCase()) {
      throw new Error('Onchain quest proof hash does not match the stored proof');
    }

    if (Number(onchainQuest.status) !== 2) {
      throw new Error(`Onchain quest is not awaiting verification (status=${onchainQuest.status.toString()})`);
    }

    await verifySubmissionTransaction({
      submissionTxHash,
      chainQuestId: quest.chainQuestId,
      wallet: quest.playerWallet,
      proofHash: expectedProofHash
    });

    await verifyGameplayTransaction({
      proofTxHash,
      wallet: quest.playerWallet,
      verification,
      startedAt: quest.startedAt,
      expiresAt: quest.expiresAt
    });

    await settleVerificationSuccess(quest, proof.id, 'Deterministic onchain verification passed');
    logger.info('Proof verification approved', {
      questId: quest.id,
      chainQuestId: quest.chainQuestId.toString(),
      wallet: quest.playerWallet,
      proofSubmissionId: proof.id
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Deterministic verification failed';
    await settleVerificationFailure(quest, proof.id, reason);
    logger.warn('Proof verification rejected', {
      questId: quest.id,
      chainQuestId: quest.chainQuestId.toString(),
      wallet: quest.playerWallet,
      proofSubmissionId: proof.id,
      reason
    });
  }
}

export async function queueProofVerification(params: {
  userId: string;
  questId: string;
  proofUri: string;
  submissionTxHash: string;
}) {
  const canonicalProofTxHash = canonicalizeProofReference(params.proofUri);
  const normalizedSubmissionTxHash = assertTransactionHash(params.submissionTxHash, 'submissionTxHash');
  const proofHash = hashProofUri(canonicalProofTxHash);

  const quest = await loadQuestForVerification(params.questId);
  if (!quest || quest.playerId !== params.userId) {
    throw new Error('Quest not found for authenticated player');
  }

  const existingProof = await findProofSubmissionByHash(proofHash);
  let proofSubmissionId: string;

  if (existingProof && existingProof.questId !== params.questId) {
    throw new Error('Proof transaction hash has already been used for another quest');
  }

  if (existingProof) {
    proofSubmissionId = existingProof.id;
    await updateProofSubmission({
      id: existingProof.id,
      proofUri: canonicalProofTxHash,
      verificationResult: 'pending',
      verificationReason: 'Queued for deterministic verification',
      verifiedAt: null
    });
  } else {
    proofSubmissionId = await insertProofSubmission({
      userId: params.userId,
      questId: params.questId,
      proofUri: canonicalProofTxHash,
      proofHash,
      verificationResult: 'pending',
      verificationReason: 'Queued for deterministic verification'
    });
  }

  await updateQuestSubmissionState({
    questId: params.questId,
    status: 'SUBMITTED',
    proofTx: canonicalProofTxHash,
    proofTxHash: normalizedSubmissionTxHash
  });

  void processPendingProofSubmissions(1);

  return {
    proofHash,
    proofSubmissionId
  };
}

export async function processPendingProofSubmissions(limit = env.VERIFICATION_BATCH_SIZE) {
  if (workerActive) {
    return;
  }

  workerActive = true;
  try {
    const pending = await claimPendingProofs(limit);
    for (const proof of pending) {
      await verifyQueuedProof(proof.id);
    }
  } finally {
    workerActive = false;
  }
}

export function startProofVerificationWorker() {
  if (workerTimer) {
    return;
  }

  if (!env.VERIFIER_PRIVATE_KEY) {
    logger.warn('Proof verification worker disabled: VERIFIER_PRIVATE_KEY is not configured');
    return;
  }

  void processPendingProofSubmissions();
  workerTimer = setInterval(() => {
    void processPendingProofSubmissions();
  }, env.VERIFICATION_WORKER_INTERVAL_MS);
}

import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { env } from '../config/env';
import { contracts } from './contracts';
import { normalizeWallet, prisma } from './chain';
import { logger } from './logger';

const INDEXER_CURSOR_KEY = 'questforge_event_indexer_last_block';
const STATUS_BY_INDEX = ['AVAILABLE', 'ACTIVE', 'SUBMITTED', 'VERIFIED', 'CANCELLED', 'FAILED'] as const;
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
const METADATA_PREFIX = 'data:application/json;base64,';

type TreasuryPayoutStatus = 'RESERVED' | 'LOCKED' | 'RELEASED' | 'PAID' | 'REFUNDED';
type IndexedEventName =
  | 'QuestStarted'
  | 'QuestVerified'
  | 'RewardMinted'
  | 'RewardReserved'
  | 'StakeLocked'
  | 'RewardReleased'
  | 'RewardPaid'
  | 'RewardRefunded';

type ParsedIndexedLog = {
  blockNumber: number;
  eventIndex: number;
  transactionHash: string;
  name: IndexedEventName;
  args: ethers.Result;
};

type QuestMetadata = {
  orchestrationId?: string;
  title?: string;
  description?: string;
  difficulty?: number;
  questType?: string;
  objective?: string;
  lore?: string;
  validationRules?: string[];
  chain?: string;
  version?: string;
  worldStateVersion?: number;
  transactionCount?: number;
  requiredTxTypes?: string[];
};

type QuestSnapshot = {
  chainQuestId: bigint;
  creator: string;
  title: string;
  metadataUri: string;
  proofUri: string;
  stakeAmount: number;
  rewardAmount: number;
  xpReward: number;
  expiresAt: number;
  status: 'AVAILABLE' | 'ACTIVE' | 'SUBMITTED' | 'VERIFIED' | 'CANCELLED' | 'FAILED';
  player: string;
  metadata: QuestMetadata;
};

type OnchainProfileSnapshot = {
  xp: number;
  level: number;
  questCount: number;
  streak: number;
  onchainActions: number;
};

type TransactionClient = Prisma.TransactionClient;
type LegacyIndexedLog = ethers.Log & { logIndex?: number | null };

let indexerTimer: NodeJS.Timeout | null = null;
let isSyncing = false;
let nextBlock: number | null = null;

function isConfiguredAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

function parseEventIndex(log: ethers.Log) {
  const indexedLog = log as LegacyIndexedLog;
  if (typeof log.index === 'number') return log.index;
  if (typeof indexedLog.logIndex === 'number') return indexedLog.logIndex;
  return 0;
}

function getResultValue(args: ethers.Result, key: string): unknown {
  return args.getValue(key);
}

function getBigIntResult(args: ethers.Result, key: string): bigint {
  const value = getResultValue(args, key);
  return typeof value === 'bigint' ? value : BigInt(String(value ?? 0));
}

function getStringResult(args: ethers.Result, key: string): string {
  const value = getResultValue(args, key);
  return typeof value === 'string' ? value : String(value ?? '');
}

function getBooleanResult(args: ethers.Result, key: string): boolean {
  const value = getResultValue(args, key);
  return typeof value === 'boolean' ? value : Boolean(value);
}

function eventKeyFor(log: ParsedIndexedLog) {
  return `${log.transactionHash}:${log.eventIndex}`;
}

function questRarityFromDifficulty(difficulty: number) {
  if (difficulty >= 5) return 'Legendary';
  if (difficulty === 4) return 'Epic';
  if (difficulty === 3) return 'Rare';
  if (difficulty === 2) return 'Uncommon';
  return 'Common';
}

function decodeQuestMetadata(metadataUri: string): QuestMetadata {
  if (!metadataUri.startsWith(METADATA_PREFIX)) {
    return {};
  }

  try {
    const encoded = metadataUri.slice(METADATA_PREFIX.length);
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as QuestMetadata;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureIndexerTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS processed_chain_events (
      event_key TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number BIGINT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getStoredCursor() {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    SELECT value
    FROM indexer_state
    WHERE key = ${INDEXER_CURSOR_KEY}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const numeric = Number(rows[0].value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

async function setStoredCursor(blockNumber: number) {
  await prisma.$executeRaw`
    INSERT INTO indexer_state (key, value, updated_at)
    VALUES (${INDEXER_CURSOR_KEY}, ${blockNumber.toString()}, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

async function getBlockTimestamp(blockNumber: number, cache: Map<number, Date>) {
  const cached = cache.get(blockNumber);
  if (cached) return cached;

  const block = await contracts.provider.getBlock(blockNumber);
  const timestamp = new Date(((block?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000));
  cache.set(blockNumber, timestamp);
  return timestamp;
}

async function fetchOnchainQuest(chainQuestId: bigint) {
  const quest = await contracts.forgeQuestManager.quests(chainQuestId);
  return {
    questId: BigInt(quest.questId.toString()),
    creator: normalizeWallet(quest.creator),
    title: quest.title,
    metadataUri: quest.metadataUri,
    proofUri: quest.proofUri,
    stakeAmount: Number(ethers.formatEther(quest.stakeAmount)),
    rewardAmount: Number(ethers.formatEther(quest.rewardAmount)),
    xpReward: Number(quest.xpReward),
    expiresAt: Number(quest.expiresAt),
    status: STATUS_BY_INDEX[Number(quest.status)] ?? 'AVAILABLE',
    player: normalizeWallet(quest.player)
  };
}

async function fetchProfileSnapshot(wallet: string): Promise<OnchainProfileSnapshot> {
  const profile = await contracts.reputation.profileFor(wallet);
  return {
    xp: Number(profile.xp),
    level: Number(profile.level),
    questCount: Number(profile.questCount),
    streak: Number(profile.streak),
    onchainActions: Number(profile.onchainActions)
  };
}

async function readQuestSnapshot(chainQuestId: bigint): Promise<QuestSnapshot> {
  const quest = await fetchOnchainQuest(chainQuestId);
  return {
    chainQuestId,
    creator: quest.creator,
    title: quest.title,
    metadataUri: quest.metadataUri,
    proofUri: quest.proofUri,
    stakeAmount: quest.stakeAmount,
    rewardAmount: quest.rewardAmount,
    xpReward: quest.xpReward,
    expiresAt: quest.expiresAt,
    status: quest.status,
    player: quest.player,
    metadata: decodeQuestMetadata(quest.metadataUri)
  };
}

async function upsertUserInTx(tx: TransactionClient, wallet: string, profile?: OnchainProfileSnapshot) {
  return tx.user.upsert({
    where: { wallet },
    update: profile
      ? {
          xp: profile.xp,
          level: profile.level,
          questCount: profile.questCount,
          streak: profile.streak,
          onchainActions: profile.onchainActions
        }
      : {},
    create: {
      wallet,
      ...(profile
        ? {
            xp: profile.xp,
            level: profile.level,
            questCount: profile.questCount,
            streak: profile.streak,
            onchainActions: profile.onchainActions
          }
        : {})
    }
  });
}

async function applyQuestSnapshot(
  tx: TransactionClient,
  input: {
    snapshot: QuestSnapshot;
    createdAt: Date;
    startedAt?: Date | null;
    forcedStatus?: 'AVAILABLE' | 'ACTIVE' | 'VERIFIED' | 'CANCELLED' | 'FAILED';
    playerId?: string;
  }
) {
  const metadata = input.snapshot.metadata;
  const [existing] = metadata.orchestrationId
    ? await tx.$queryRaw<
        Array<{
          id: string;
          startedAt: Date | null;
          transactionCount: number;
          requiredTxTypes: Prisma.JsonValue | null;
        }>
      >(
        Prisma.sql`
          SELECT
            id,
            "startedAt",
            "transactionCount",
            "requiredTxTypes"
          FROM "Quest"
          WHERE "chainQuestId" = ${input.snapshot.chainQuestId}
             OR metadata->>'orchestrationId' = ${metadata.orchestrationId}
          ORDER BY "createdAt" DESC
          LIMIT 1
        `
      )
    : await tx.$queryRaw<
        Array<{
          id: string;
          startedAt: Date | null;
          transactionCount: number;
          requiredTxTypes: Prisma.JsonValue | null;
        }>
      >(
        Prisma.sql`
          SELECT
            id,
            "startedAt",
            "transactionCount",
            "requiredTxTypes"
          FROM "Quest"
          WHERE "chainQuestId" = ${input.snapshot.chainQuestId}
          ORDER BY "createdAt" DESC
          LIMIT 1
        `
      );
  const data = {
    title: metadata.title || input.snapshot.title,
    description: metadata.description || 'Quest indexed from onchain state.',
    metadata: {
      ...metadata,
      metadataUri: input.snapshot.metadataUri,
      proofUri: input.snapshot.proofUri || null,
      indexedFrom: 'chain-events'
    },
    difficulty:
      typeof metadata.difficulty === 'number' && Number.isFinite(metadata.difficulty) ? metadata.difficulty : 3,
    questType: metadata.questType || 'AI Quest',
    objective: metadata.objective || 'Submit proof onchain.',
    lore: metadata.lore || 'Recovered from onchain quest metadata.',
    worldStateVersion:
      typeof metadata.worldStateVersion === 'number' && Number.isFinite(metadata.worldStateVersion)
        ? metadata.worldStateVersion
        : 1,
    stakeAmount: input.snapshot.stakeAmount,
    rewardAmount: input.snapshot.rewardAmount,
    xpReward: input.snapshot.xpReward,
    transactionCount:
      typeof metadata.transactionCount === 'number' && Number.isFinite(metadata.transactionCount)
        ? metadata.transactionCount
        : existing?.transactionCount ?? 0,
    requiredTxTypes:
      Array.isArray(metadata.requiredTxTypes) && metadata.requiredTxTypes.every((value) => typeof value === 'string')
        ? metadata.requiredTxTypes
        : existing?.requiredTxTypes ?? Prisma.JsonNull,
    chainQuestId: input.snapshot.chainQuestId,
    status: input.forcedStatus || input.snapshot.status,
    creator: input.snapshot.creator,
    startedAt: typeof input.startedAt === 'undefined' ? existing?.startedAt ?? null : input.startedAt,
    expiresAt: new Date(input.snapshot.expiresAt * 1000)
  };

  if (existing) {
    return tx.quest.update({
      where: { id: existing.id },
      data: {
        ...data,
        player: input.playerId ? { connect: { id: input.playerId } } : undefined
      }
    });
  }

  return tx.quest.create({
    data: {
      ...data,
      createdAt: input.createdAt,
      player: input.playerId ? { connect: { id: input.playerId } } : undefined
    }
  });
}

async function upsertTreasuryPayout(
  tx: TransactionClient,
  input: {
    questId: string;
    userId?: string;
    chainQuestId: bigint;
    playerWallet?: string;
    rewardAmount: number;
    stakeAmount: number;
    totalAmount: number;
    status: TreasuryPayoutStatus;
    reservationTx?: string;
    releaseTx?: string;
    payoutTx?: string;
    refundTx?: string;
    rewardReservedAt?: Date;
    rewardReleasedAt?: Date;
    rewardPaidAt?: Date;
    rewardRefundedAt?: Date;
  }
) {
  const normalizedWallet = input.playerWallet ? normalizeWallet(input.playerWallet) : undefined;
  await tx.$executeRaw(
    Prisma.sql`
      INSERT INTO "TreasuryPayout" (
        id,
        "questId",
        "userId",
        "chainQuestId",
        "playerWallet",
        "rewardAmount",
        "stakeAmount",
        "totalAmount",
        status,
        "reservationTx",
        "releaseTx",
        "payoutTx",
        "refundTx",
        "rewardReservedAt",
        "rewardReleasedAt",
        "rewardPaidAt",
        "rewardRefundedAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${crypto.randomUUID()},
        ${input.questId},
        ${input.userId ?? null},
        ${input.chainQuestId},
        ${normalizedWallet ?? null},
        ${input.rewardAmount},
        ${input.stakeAmount},
        ${input.totalAmount},
        ${input.status}::"TreasuryPayoutStatus",
        ${input.reservationTx ?? null},
        ${input.releaseTx ?? null},
        ${input.payoutTx ?? null},
        ${input.refundTx ?? null},
        ${input.rewardReservedAt ?? null},
        ${input.rewardReleasedAt ?? null},
        ${input.rewardPaidAt ?? null},
        ${input.rewardRefundedAt ?? null},
        NOW(),
        NOW()
      )
      ON CONFLICT ("chainQuestId")
      DO UPDATE SET
        "questId" = EXCLUDED."questId",
        "userId" = COALESCE(EXCLUDED."userId", "TreasuryPayout"."userId"),
        "playerWallet" = COALESCE(EXCLUDED."playerWallet", "TreasuryPayout"."playerWallet"),
        "rewardAmount" = EXCLUDED."rewardAmount",
        "stakeAmount" = EXCLUDED."stakeAmount",
        "totalAmount" = EXCLUDED."totalAmount",
        status = EXCLUDED.status,
        "reservationTx" = COALESCE(EXCLUDED."reservationTx", "TreasuryPayout"."reservationTx"),
        "releaseTx" = COALESCE(EXCLUDED."releaseTx", "TreasuryPayout"."releaseTx"),
        "payoutTx" = COALESCE(EXCLUDED."payoutTx", "TreasuryPayout"."payoutTx"),
        "refundTx" = COALESCE(EXCLUDED."refundTx", "TreasuryPayout"."refundTx"),
        "rewardReservedAt" = COALESCE(EXCLUDED."rewardReservedAt", "TreasuryPayout"."rewardReservedAt"),
        "rewardReleasedAt" = COALESCE(EXCLUDED."rewardReleasedAt", "TreasuryPayout"."rewardReleasedAt"),
        "rewardPaidAt" = COALESCE(EXCLUDED."rewardPaidAt", "TreasuryPayout"."rewardPaidAt"),
        "rewardRefundedAt" = COALESCE(EXCLUDED."rewardRefundedAt", "TreasuryPayout"."rewardRefundedAt"),
        "updatedAt" = NOW()
    `
  );
}

async function createRewardIfMissing(tx: TransactionClient, input: { userId: string; amount: number; txHash: string }) {
  const existing = await tx.reward.findFirst({
    where: {
      userId: input.userId,
      tokenTx: input.txHash
    }
  });

  if (existing) {
    return existing;
  }

  return tx.reward.create({
    data: {
      userId: input.userId,
      type: 'CELO',
      amount: input.amount,
      tokenTx: input.txHash
    }
  });
}

async function claimEvent(tx: TransactionClient, log: ParsedIndexedLog) {
  const rows = await tx.$queryRaw<Array<{ event_key: string }>>`
    INSERT INTO processed_chain_events (event_key, event_name, tx_hash, log_index, block_number)
    VALUES (${eventKeyFor(log)}, ${log.name}, ${log.transactionHash}, ${log.eventIndex}, ${log.blockNumber})
    ON CONFLICT (event_key) DO NOTHING
    RETURNING event_key
  `;
  return rows.length > 0;
}

async function handleRewardReserved(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const creatorWallet = normalizeWallet(getStringResult(log.args, 'creator'));
  const rewardAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'amount')));
  const snapshot = await readQuestSnapshot(chainQuestId);

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    await upsertUserInTx(tx, creatorWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      startedAt: null,
      forcedStatus: 'AVAILABLE'
    });

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      chainQuestId,
      rewardAmount,
      stakeAmount: 0,
      totalAmount: rewardAmount,
      status: 'RESERVED',
      reservationTx: log.transactionHash,
      rewardReservedAt: blockTimestamp
    });

    await tx.transaction.create({
      data: {
        wallet: creatorWallet,
        type: 'TREASURY_REWARD_RESERVED',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          rewardAmount
        }
      }
    });
  });
}

async function handleStakeLocked(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const playerWallet = normalizeWallet(getStringResult(log.args, 'player'));
  const stakeAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'amount')));
  const snapshot = await readQuestSnapshot(chainQuestId);
  const profile = await fetchProfileSnapshot(playerWallet);

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      startedAt: blockTimestamp,
      forcedStatus: 'ACTIVE',
      playerId: user.id
    });

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user.id,
      chainQuestId,
      playerWallet,
      rewardAmount: snapshot.rewardAmount,
      stakeAmount,
      totalAmount: snapshot.rewardAmount + stakeAmount,
      status: 'LOCKED'
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'TREASURY_STAKE_LOCKED',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          stakeAmount
        }
      }
    });
  });
}

async function handleRewardReleased(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const playerWallet = normalizeWallet(getStringResult(log.args, 'player'));
  const rewardAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'rewardAmount')));
  const stakeAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'stakeAmount')));
  const totalAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'totalPayout')));
  const snapshot = await readQuestSnapshot(chainQuestId);

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      forcedStatus: 'VERIFIED',
      playerId: user.id
    });

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user.id,
      chainQuestId,
      playerWallet,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: 'RELEASED',
      releaseTx: log.transactionHash,
      rewardReleasedAt: blockTimestamp
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'TREASURY_REWARD_RELEASED',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          rewardAmount,
          stakeAmount,
          totalAmount
        }
      }
    });
  });
}

async function handleRewardPaid(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const playerWallet = normalizeWallet(getStringResult(log.args, 'player'));
  const rewardAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'rewardAmount')));
  const stakeAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'stakeAmount')));
  const totalAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'totalPayout')));
  const snapshot = await readQuestSnapshot(chainQuestId);

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      forcedStatus: 'VERIFIED',
      playerId: user.id
    });

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user.id,
      chainQuestId,
      playerWallet,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: 'PAID',
      payoutTx: log.transactionHash,
      rewardPaidAt: blockTimestamp
    });

    await createRewardIfMissing(tx, {
      userId: user.id,
      amount: rewardAmount,
      txHash: log.transactionHash
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'TREASURY_REWARD_PAID',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          rewardAmount,
          stakeAmount,
          totalAmount
        }
      }
    });
  });
}

async function handleRewardRefunded(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const recipientRaw = getStringResult(log.args, 'recipient').toLowerCase();
  const recipientWallet = recipientRaw && recipientRaw !== ZERO_ADDRESS ? normalizeWallet(recipientRaw) : null;
  const rewardAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'rewardAmount')));
  const stakeAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'stakeAmount')));
  const totalAmount = rewardAmount + stakeAmount;
  const snapshot = await readQuestSnapshot(chainQuestId);
  const forcedStatus =
    snapshot.status === 'CANCELLED' ? 'CANCELLED' : snapshot.status === 'FAILED' ? 'FAILED' : 'CANCELLED';

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = recipientWallet ? await upsertUserInTx(tx, recipientWallet) : null;
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      forcedStatus,
      playerId: user?.id
    });

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user?.id,
      chainQuestId,
      playerWallet: recipientWallet || undefined,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: 'REFUNDED',
      refundTx: log.transactionHash,
      rewardRefundedAt: blockTimestamp
    });

    await tx.transaction.create({
      data: {
        userId: user?.id,
        wallet: recipientWallet || snapshot.creator,
        type: 'TREASURY_REWARD_REFUNDED',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          rewardAmount,
          stakeAmount
        }
      }
    });
  });
}

async function handleQuestStarted(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const playerWallet = normalizeWallet(getStringResult(log.args, 'player'));
  const snapshot = await readQuestSnapshot(chainQuestId);
  const profile = await fetchProfileSnapshot(playerWallet);

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      startedAt: blockTimestamp,
      forcedStatus: 'ACTIVE',
      playerId: user.id
    });

    await tx.questHistory.create({
      data: {
        userId: user.id,
        questId: quest.id,
        action: 'STARTED'
      }
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'QUEST_STARTED',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: { chainQuestId: chainQuestId.toString() }
      }
    });
  });
}

async function handleQuestCompleted(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const playerWallet = normalizeWallet(getStringResult(log.args, 'player'));
  const success = getBooleanResult(log.args, 'success');
  const rewardAmount = Number(ethers.formatEther(getBigIntResult(log.args, 'rewardAmount')));
  const xpReward = Number(getBigIntResult(log.args, 'xpReward'));
  const snapshot = await readQuestSnapshot(chainQuestId);
  const profile = await fetchProfileSnapshot(playerWallet);
  const proofUri = snapshot.proofUri || null;

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      forcedStatus: success ? 'VERIFIED' : 'FAILED',
      playerId: user.id
    });

    await tx.quest.update({
      where: { id: quest.id },
      data: {
        verificationTx: log.transactionHash
      }
    });

    await tx.questHistory.create({
      data: {
        userId: user.id,
        questId: quest.id,
        action: success ? 'COMPLETED' : 'FAILED',
        proofUri,
        xpEarned: success ? xpReward : 0
      }
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'QUEST_VERIFIED',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          success,
          rewardAmount,
          xpReward
        }
      }
    });
  });
}

async function handleRewardMinted(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = getBigIntResult(log.args, 'questId');
  const tokenId = getStringResult(log.args, 'tokenId');
  const playerWallet = normalizeWallet(getStringResult(log.args, 'player'));
  const snapshot = await readQuestSnapshot(chainQuestId);
  const metadataUri = snapshot.proofUri || snapshot.metadataUri;

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: blockTimestamp,
      playerId: user.id
    });
    const existingNft = await tx.nFT.findFirst({ where: { tokenId } });
    if (!existingNft) {
      await tx.nFT.create({
        data: {
          userId: user.id,
          tokenId,
          metadataUri,
          rarity: questRarityFromDifficulty(quest.difficulty),
          xpEarned: 0,
          questHistory: quest.id
        }
      });
    }

    await tx.quest.update({
      where: { id: quest.id },
      data: {
        nftMintTx: log.transactionHash
      }
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'REWARD_MINTED',
        chainId: env.CELO_CHAIN_ID,
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          tokenId
        }
      }
    });
  });
}

async function fetchLogs(fromBlock: number, toBlock: number) {
  const [forgeLogs, rewardLogs, treasuryLogs] = await Promise.all([
    contracts.provider.getLogs({
      address: await contracts.forgeQuestManager.getAddress(),
      fromBlock,
      toBlock
    }),
    contracts.provider.getLogs({
      address: await contracts.rewardNFT.getAddress(),
      fromBlock,
      toBlock
    }),
    contracts.provider.getLogs({
      address: await contracts.treasury.getAddress(),
      fromBlock,
      toBlock
    })
  ]);

  const parsed: ParsedIndexedLog[] = [];

  for (const log of forgeLogs) {
    try {
      const description = contracts.forgeQuestManager.interface.parseLog(log);
      if (description && (description.name === 'QuestStarted' || description.name === 'QuestVerified')) {
        parsed.push({
          blockNumber: Number(log.blockNumber),
          eventIndex: parseEventIndex(log),
          transactionHash: log.transactionHash,
          name: description.name as IndexedEventName,
          args: description.args
        });
      }
    } catch {
      continue;
    }
  }

  for (const log of rewardLogs) {
    try {
      const description = contracts.rewardNFT.interface.parseLog(log);
      if (description && description.name === 'RewardMinted') {
        parsed.push({
          blockNumber: Number(log.blockNumber),
          eventIndex: parseEventIndex(log),
          transactionHash: log.transactionHash,
          name: 'RewardMinted',
          args: description.args
        });
      }
    } catch {
      continue;
    }
  }

  for (const log of treasuryLogs) {
    try {
      const description = contracts.treasury.interface.parseLog(log);
      if (
        description &&
        (description.name === 'RewardReserved' ||
          description.name === 'StakeLocked' ||
          description.name === 'RewardReleased' ||
          description.name === 'RewardPaid' ||
          description.name === 'RewardRefunded')
      ) {
        parsed.push({
          blockNumber: Number(log.blockNumber),
          eventIndex: parseEventIndex(log),
          transactionHash: log.transactionHash,
          name: description.name as IndexedEventName,
          args: description.args
        });
      }
    } catch {
      continue;
    }
  }

  return parsed.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) return left.blockNumber - right.blockNumber;
    return left.eventIndex - right.eventIndex;
  });
}

async function syncRange(fromBlock: number, toBlock: number) {
  if (toBlock < fromBlock) return;

  const blockTimestamps = new Map<number, Date>();
  const logs = await fetchLogs(fromBlock, toBlock);

  for (const log of logs) {
    const blockTimestamp = await getBlockTimestamp(log.blockNumber, blockTimestamps);

    if (log.name === 'RewardReserved') {
      await handleRewardReserved(log, blockTimestamp);
      continue;
    }

    if (log.name === 'StakeLocked') {
      await handleStakeLocked(log, blockTimestamp);
      continue;
    }

    if (log.name === 'RewardReleased') {
      await handleRewardReleased(log, blockTimestamp);
      continue;
    }

    if (log.name === 'RewardPaid') {
      await handleRewardPaid(log, blockTimestamp);
      continue;
    }

    if (log.name === 'RewardRefunded') {
      await handleRewardRefunded(log, blockTimestamp);
      continue;
    }

    if (log.name === 'QuestStarted') {
      await handleQuestStarted(log, blockTimestamp);
      continue;
    }

    if (log.name === 'QuestVerified') {
      await handleQuestCompleted(log, blockTimestamp);
      continue;
    }

    await handleRewardMinted(log, blockTimestamp);
  }
}

async function performSync() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    await ensureIndexerTables();

    if (nextBlock === null) {
      const storedCursor = await getStoredCursor();
      nextBlock = storedCursor ?? env.INDEXER_FROM_BLOCK;
    }

    const startBlock = nextBlock;
    const latestBlock = await contracts.provider.getBlockNumber();
    if (latestBlock < startBlock) return;

    await syncRange(startBlock, latestBlock);
    await setStoredCursor(latestBlock + 1);
    nextBlock = latestBlock + 1;
  } catch (error) {
    logger.error('QuestForge indexer sync failed', error);
  } finally {
    isSyncing = false;
  }
}

export function startQuestIndexer() {
  if (
    !isConfiguredAddress(process.env.FORGE_QUEST_MANAGER_ADDRESS || '') ||
    !isConfiguredAddress(process.env.REWARD_NFT_ADDRESS || '') ||
    !isConfiguredAddress(process.env.REPUTATION_ADDRESS || '') ||
    !isConfiguredAddress(process.env.TREASURY_ADDRESS || '')
  ) {
    logger.warn('QuestForge indexer disabled: contract addresses are not configured');
    return;
  }

  if (indexerTimer) return;

  const pollIntervalMs = env.INDEXER_POLL_INTERVAL_MS;
  void performSync();
  indexerTimer = setInterval(() => {
    void performSync();
  }, pollIntervalMs);
}

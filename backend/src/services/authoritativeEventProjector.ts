import { Prisma, type ChainEvent, type QuestStatus, type TreasuryPayoutStatus } from '@prisma/client';
import { env } from '../config/env';
import { aiMemoryGraph } from './aiMemoryGraph';
import { normalizeWallet, prisma } from './chain';
import { contracts } from './contracts';
import { gameStateProjector } from './gameStateProjector';
import { logger } from './logger';
import { worldStateCoordinator } from './worldStateCoordinator';

const STATUS_BY_INDEX = ['AVAILABLE', 'ACTIVE', 'SUBMITTED', 'VERIFIED', 'CANCELLED', 'FAILED'] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const METADATA_PREFIX = 'data:application/json;base64,';

type ProjectorMode = 'live' | 'replay' | 'recovery';

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
  status: QuestStatus;
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

type ProjectorDiagnostics = {
  projectorKey: string;
  projectionVersion: number;
  totalProjected: number;
  totalReplayed: number;
  totalRecovered: number;
  totalFailures: number;
  lastEventKey: string | null;
  lastEventType: string | null;
  lastProjectedAt: string | null;
  lastDurationMs: number | null;
};

type TransactionClient = Prisma.TransactionClient;
type ProjectionDeadLetterRow = {
  id: string;
  chainEventId: string | null;
};

function isJsonObject(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getEventPayload(event: ChainEvent): Prisma.JsonObject {
  const payload = event.decodedData ?? event.data;
  return isJsonObject(payload) ? payload : {};
}

function getStringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }

  return null;
}

function getBigIntValue(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  return null;
}

function getBooleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return false;
}

function getNumericDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function normalizeOptionalWallet(wallet: string | null | undefined) {
  if (!wallet) {
    return null;
  }

  const normalized = normalizeWallet(wallet);
  return normalized === ZERO_ADDRESS ? null : normalized;
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

async function fetchOnchainQuest(chainQuestId: bigint) {
  const quest = await contracts.forgeQuestManager.quests(chainQuestId);
  return {
    questId: BigInt(quest.questId.toString()),
    creator: normalizeWallet(quest.creator),
    title: quest.title,
    metadataUri: quest.metadataUri,
    proofUri: quest.proofUri,
    stakeAmount: Number(quest.stakeAmount) / 1e18,
    rewardAmount: Number(quest.rewardAmount) / 1e18,
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
    completedAt?: Date | null;
    failedAt?: Date | null;
    forcedStatus?: QuestStatus;
    playerId?: string | null;
    proofTxHash?: string | null;
    verificationTx?: string | null;
    nftMintTx?: string | null;
  }
) {
  const metadata = input.snapshot.metadata;
  const [matches] = metadata.orchestrationId
    ? await tx.$queryRaw<
        Array<{
          id: string;
          playerId: string | null;
          startedAt: Date | null;
          completedAt: Date | null;
          failedAt: Date | null;
          transactionCount: number;
          requiredTxTypes: Prisma.JsonValue | null;
        }>
      >(
        Prisma.sql`
          SELECT
            id,
            "playerId",
            "startedAt",
            "completedAt",
            "failedAt",
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
          playerId: string | null;
          startedAt: Date | null;
          completedAt: Date | null;
          failedAt: Date | null;
          transactionCount: number;
          requiredTxTypes: Prisma.JsonValue | null;
        }>
      >(
        Prisma.sql`
          SELECT
            id,
            "playerId",
            "startedAt",
            "completedAt",
            "failedAt",
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
    description: metadata.description || 'Quest materialized from authoritative chain event stream.',
    metadata: {
      ...metadata,
      metadataUri: input.snapshot.metadataUri,
      proofUri: input.snapshot.proofUri || null,
      materializedFrom: 'authoritative-chain-projector'
    },
    difficulty:
      typeof metadata.difficulty === 'number' && Number.isFinite(metadata.difficulty) ? metadata.difficulty : 3,
    questType: metadata.questType || 'AI Quest',
    objective: metadata.objective || 'Submit proof onchain.',
    lore: metadata.lore || 'Recovered from onchain quest metadata.',
    stakeAmount: input.snapshot.stakeAmount,
    rewardAmount: input.snapshot.rewardAmount,
    xpReward: input.snapshot.xpReward,
    transactionCount:
      typeof metadata.transactionCount === 'number' && Number.isFinite(metadata.transactionCount)
        ? metadata.transactionCount
        : matches?.transactionCount ?? 0,
    requiredTxTypes:
      Array.isArray(metadata.requiredTxTypes) && metadata.requiredTxTypes.every((value) => typeof value === 'string')
        ? metadata.requiredTxTypes
        : matches?.requiredTxTypes ?? Prisma.JsonNull,
    chainQuestId: input.snapshot.chainQuestId,
    status: input.forcedStatus || input.snapshot.status,
    creator: input.snapshot.creator,
    playerId: input.playerId ?? matches?.playerId ?? null,
    startedAt: typeof input.startedAt === 'undefined' ? matches?.startedAt ?? null : input.startedAt,
    completedAt: typeof input.completedAt === 'undefined' ? matches?.completedAt ?? null : input.completedAt,
    failedAt: typeof input.failedAt === 'undefined' ? matches?.failedAt ?? null : input.failedAt,
    proofTxHash: input.proofTxHash ?? undefined,
    verificationTx: input.verificationTx ?? undefined,
    nftMintTx: input.nftMintTx ?? undefined,
    expiresAt: new Date(input.snapshot.expiresAt * 1000)
  } satisfies Prisma.QuestUncheckedCreateInput;

  if (matches) {
    return tx.quest.update({
      where: { id: matches.id },
      data
    });
  }

  return tx.quest.create({
    data: {
      ...data,
      createdAt: input.createdAt
    }
  });
}

async function upsertTreasuryPayout(
  tx: TransactionClient,
  input: {
    questId: string;
    userId?: string | null;
    chainQuestId: bigint;
    playerWallet?: string | null;
    rewardAmount: number;
    stakeAmount: number;
    totalAmount: number;
    status: TreasuryPayoutStatus;
    reservationTx?: string | null;
    releaseTx?: string | null;
    payoutTx?: string | null;
    refundTx?: string | null;
    rewardReservedAt?: Date | null;
    rewardReleasedAt?: Date | null;
    rewardPaidAt?: Date | null;
    rewardRefundedAt?: Date | null;
  }
) {
  return tx.treasuryPayout.upsert({
    where: { questId: input.questId },
    create: {
      questId: input.questId,
      userId: input.userId ?? null,
      chainQuestId: input.chainQuestId,
      playerWallet: input.playerWallet ?? null,
      rewardAmount: input.rewardAmount,
      stakeAmount: input.stakeAmount,
      totalAmount: input.totalAmount,
      status: input.status,
      reservationTx: input.reservationTx ?? null,
      releaseTx: input.releaseTx ?? null,
      payoutTx: input.payoutTx ?? null,
      refundTx: input.refundTx ?? null,
      rewardReservedAt: input.rewardReservedAt ?? null,
      rewardReleasedAt: input.rewardReleasedAt ?? null,
      rewardPaidAt: input.rewardPaidAt ?? null,
      rewardRefundedAt: input.rewardRefundedAt ?? null
    },
    update: {
      questId: input.questId,
      userId: input.userId ?? undefined,
      playerWallet: input.playerWallet ?? undefined,
      rewardAmount: input.rewardAmount,
      stakeAmount: input.stakeAmount,
      totalAmount: input.totalAmount,
      status: input.status,
      reservationTx: input.reservationTx ?? undefined,
      releaseTx: input.releaseTx ?? undefined,
      payoutTx: input.payoutTx ?? undefined,
      refundTx: input.refundTx ?? undefined,
      rewardReservedAt: input.rewardReservedAt ?? undefined,
      rewardReleasedAt: input.rewardReleasedAt ?? undefined,
      rewardPaidAt: input.rewardPaidAt ?? undefined,
      rewardRefundedAt: input.rewardRefundedAt ?? undefined
    }
  });
}

async function ensureTransactionRecord(
  tx: TransactionClient,
  input: {
    userId?: string | null;
    wallet: string;
    type: string;
    txHash: string;
    details: Record<string, unknown>;
    createdAt?: Date;
  }
) {
  const existing = await tx.transaction.findFirst({
    where: {
      txHash: input.txHash,
      type: input.type,
      wallet: input.wallet
    },
    select: { id: true }
  });

  if (existing) {
    return existing;
  }

  return tx.transaction.create({
    data: {
      userId: input.userId ?? null,
      wallet: input.wallet,
      type: input.type,
      chainId: env.CELO_CHAIN_ID,
      txHash: input.txHash,
      details: input.details as Prisma.InputJsonValue,
      createdAt: input.createdAt ?? new Date()
    }
  });
}

async function ensureQuestHistoryRecord(
  tx: TransactionClient,
  input: {
    userId: string;
    questId: string;
    action: string;
    proofUri?: string | null;
    xpEarned?: number;
    createdAt?: Date;
  }
) {
  const existing = await tx.questHistory.findFirst({
    where: {
      userId: input.userId,
      questId: input.questId,
      action: input.action
    },
    select: { id: true }
  });

  if (existing) {
    return { created: false, id: existing.id };
  }

  const created = await tx.questHistory.create({
    data: {
      userId: input.userId,
      questId: input.questId,
      action: input.action,
      proofUri: input.proofUri ?? null,
      xpEarned: input.xpEarned ?? 0,
      createdAt: input.createdAt ?? new Date()
    }
  });

  return { created: true, id: created.id };
}

async function createRewardIfMissing(
  tx: TransactionClient,
  input: { userId: string; amount: number; txHash: string; createdAt?: Date }
) {
  const existing = await tx.reward.findFirst({
    where: {
      userId: input.userId,
      tokenTx: input.txHash
    },
    select: { id: true }
  });

  if (existing) {
    return false;
  }

  await tx.reward.create({
    data: {
      userId: input.userId,
      type: 'CELO',
      amount: input.amount,
      tokenTx: input.txHash,
      createdAt: input.createdAt ?? new Date()
    }
  });

  return true;
}

async function upsertDailyActivity(
  tx: TransactionClient,
  input: {
    userId: string;
    date: string;
    attempted?: number;
    completed?: number;
    xpEarned?: number;
    rewardsEarned?: number;
  }
) {
  return tx.dailyActivity.upsert({
    where: {
      userId_date: {
        userId: input.userId,
        date: input.date
      }
    },
    create: {
      userId: input.userId,
      date: input.date,
      questsAttempted: input.attempted ?? 0,
      questsCompleted: input.completed ?? 0,
      xpEarned: input.xpEarned ?? 0,
      rewardsEarned: input.rewardsEarned ?? 0
    },
    update: {
      questsAttempted: { increment: input.attempted ?? 0 },
      questsCompleted: { increment: input.completed ?? 0 },
      xpEarned: { increment: input.xpEarned ?? 0 },
      rewardsEarned: { increment: input.rewardsEarned ?? 0 }
    }
  });
}

async function upsertFailureCooldown(tx: TransactionClient, userId: string, eventTimestamp: Date) {
  const cooldownUntil = new Date(eventTimestamp.getTime() + 5 * 60 * 1000);
  return tx.questCooldown.upsert({
    where: { userId },
    create: {
      userId,
      cooldownUntil,
      reason: 'quest_failure'
    },
    update: {
      cooldownUntil,
      reason: 'quest_failure'
    }
  });
}

async function clearFailureCooldown(tx: TransactionClient, userId: string) {
  await tx.questCooldown.deleteMany({
    where: {
      userId,
      reason: 'quest_failure'
    }
  });
}

async function applyUserOutcomeStats(
  tx: TransactionClient,
  input: {
    userId: string;
    eventTimestamp: Date;
    success: boolean;
    xpReward: number;
  }
) {
  await tx.user.update({
    where: { id: input.userId },
    data: input.success
      ? {
          lastQuestCompletedAt: input.eventTimestamp,
          totalQuestsCompleted: { increment: 1 },
          streakDecayFactor: { increment: 0.02 }
        }
      : {
          lastFailedAt: input.eventTimestamp,
          totalQuestsFailed: { increment: 1 },
          streakDecayFactor: { decrement: 0.05 }
        }
  });

  await upsertDailyActivity(tx, {
    userId: input.userId,
    date: getNumericDateKey(input.eventTimestamp),
    completed: input.success ? 1 : 0,
    xpEarned: input.success ? input.xpReward : 0
  });

  if (input.success) {
    await clearFailureCooldown(tx, input.userId);
    return;
  }

  await upsertFailureCooldown(tx, input.userId, input.eventTimestamp);
}

async function materializeClanState(
  tx: TransactionClient,
  input: {
    userId: string;
    questId: string;
    rewardAmount: number;
    status: 'active' | 'completed' | 'failed';
    eventTimestamp: Date;
  }
) {
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { clanId: true }
  });

  if (!user?.clanId) {
    return;
  }

  const existingClanQuest = await tx.clanQuest.findFirst({
    where: {
      clanId: user.clanId,
      questId: input.questId
    },
    select: {
      id: true,
      status: true
    }
  });

  if (existingClanQuest) {
    await tx.clanQuest.update({
      where: { id: existingClanQuest.id },
      data: {
        status: input.status,
        completedAt: input.status === 'completed' ? input.eventTimestamp : undefined
      }
    });

    if (existingClanQuest.status !== 'completed' && input.status === 'completed') {
      await tx.clan.update({
        where: { id: user.clanId },
        data: {
          questsCompleted: { increment: 1 },
          totalRewards: { increment: input.rewardAmount }
        }
      });
    }

    return;
  }

  await tx.clanQuest.create({
    data: {
      clanId: user.clanId,
      questId: input.questId,
      status: input.status,
      rewardDistribution: {
        mode: 'equal',
        participantCount: 1
      },
      participantCount: 1,
      completedAt: input.status === 'completed' ? input.eventTimestamp : null,
      createdAt: input.eventTimestamp,
      updatedAt: input.eventTimestamp
    }
  });

  if (input.status === 'completed') {
    await tx.clan.update({
      where: { id: user.clanId },
      data: {
        questsCompleted: { increment: 1 },
        totalRewards: { increment: input.rewardAmount }
      }
    });
  }
}

class AuthoritativeEventProjector {
  private readonly projectorKey = 'authoritative-chain-state';
  private readonly projectionVersion = 2;
  private diagnostics: ProjectorDiagnostics = {
    projectorKey: this.projectorKey,
    projectionVersion: this.projectionVersion,
    totalProjected: 0,
    totalReplayed: 0,
    totalRecovered: 0,
    totalFailures: 0,
    lastEventKey: null,
    lastEventType: null,
    lastProjectedAt: null,
    lastDurationMs: null
  };

  async projectChainEvent(
    chainEvent: ChainEvent,
    options: {
      mode?: ProjectorMode;
      allowInvalidated?: boolean;
    } = {}
  ): Promise<void> {
    const mode = options.mode ?? 'live';
    const startedAt = Date.now();

    if (chainEvent.invalidatedAt && !options.allowInvalidated) {
      logger.warn('[PROJECTOR] Skipping invalidated event', {
        eventKey: chainEvent.eventKey,
        eventType: chainEvent.eventType
      });
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await this.materializeChainState(tx, chainEvent);
      });

      await gameStateProjector.projectChainEvent(chainEvent);
      await worldStateCoordinator.handleGameplaySignal({
        trigger: `projector:${chainEvent.eventType}`,
        chainQuestId: chainEvent.chainQuestId?.toString(),
        playerWallet: chainEvent.playerWallet ?? undefined
      });

      await aiMemoryGraph.upsertProjectionCursor({
        projectorKey: this.projectorKey,
        lastEventKey: chainEvent.eventKey,
        lastProcessedBlock: chainEvent.blockNumber,
        projectionVersion: this.projectionVersion,
        metrics: {
          mode,
          lastEventType: chainEvent.eventType,
          lastChainEventId: chainEvent.id,
          projectedAt: new Date().toISOString(),
          totalProjected: this.diagnostics.totalProjected + (mode === 'live' ? 1 : 0),
          totalReplayed: this.diagnostics.totalReplayed + (mode === 'replay' ? 1 : 0),
          totalRecovered: this.diagnostics.totalRecovered + (mode === 'recovery' ? 1 : 0)
        }
      });

      this.updateDiagnostics(chainEvent, mode, Date.now() - startedAt);
    } catch (error) {
      this.diagnostics.totalFailures += 1;

      await aiMemoryGraph.recordDeadLetter({
        projectorKey: this.projectorKey,
        chainEventId: chainEvent.id,
        eventKey: chainEvent.eventKey,
        payload: {
          eventType: chainEvent.eventType,
          eventName: chainEvent.eventName,
          transactionHash: chainEvent.transactionHash,
          blockNumber: chainEvent.blockNumber.toString(),
          mode
        },
        errorMessage: error instanceof Error ? error.message : 'Unknown projection failure'
      });

      throw error;
    }
  }

  async replayFromEventStore(input: { fromBlock?: bigint; toBlock?: bigint; limit?: number } = {}) {
    const events = await prisma.chainEvent.findMany({
      where: {
        invalidatedAt: null,
        ...(input.fromBlock ? { blockNumber: { gte: input.fromBlock } } : {}),
        ...(input.toBlock ? { blockNumber: { lte: input.toBlock } } : {})
      },
      orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
      take: input.limit
    });

    for (const event of events) {
      await this.projectChainEvent(event, { mode: 'replay' });
    }

    return {
      replayed: events.length,
      fromBlock: input.fromBlock?.toString() ?? null,
      toBlock: input.toBlock?.toString() ?? null
    };
  }

  async recoverDeadLetters(limit = 25) {
    const deadLetters = await prisma.$queryRaw<ProjectionDeadLetterRow[]>(
      Prisma.sql`
        SELECT id, "chainEventId"
        FROM "ProjectionDeadLetter"
        WHERE "projectorKey" = ${this.projectorKey}
          AND "resolvedAt" IS NULL
          AND "chainEventId" IS NOT NULL
        ORDER BY "updatedAt" ASC
        LIMIT ${limit}
      `
    );

    let recovered = 0;

    for (const deadLetter of deadLetters) {
      if (!deadLetter.chainEventId) {
        continue;
      }

      const chainEvent = await prisma.chainEvent.findUnique({
        where: { id: deadLetter.chainEventId }
      });

      if (!chainEvent) {
        continue;
      }

      await this.projectChainEvent(chainEvent, { mode: 'recovery' });
      await prisma.$executeRaw(
        Prisma.sql`
          UPDATE "ProjectionDeadLetter"
          SET "resolvedAt" = NOW(), "updatedAt" = NOW()
          WHERE id = ${deadLetter.id}
        `
      );
      recovered += 1;
    }

    return { recovered };
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }

  private updateDiagnostics(chainEvent: ChainEvent, mode: ProjectorMode, durationMs: number) {
    if (mode === 'replay') {
      this.diagnostics.totalReplayed += 1;
    } else if (mode === 'recovery') {
      this.diagnostics.totalRecovered += 1;
    } else {
      this.diagnostics.totalProjected += 1;
    }

    this.diagnostics.lastEventKey = chainEvent.eventKey;
    this.diagnostics.lastEventType = chainEvent.eventType;
    this.diagnostics.lastProjectedAt = new Date().toISOString();
    this.diagnostics.lastDurationMs = durationMs;
  }

  private async materializeChainState(tx: TransactionClient, event: ChainEvent) {
    switch (event.eventType) {
      case 'quest_created':
        await this.handleQuestCreated(tx, event);
        break;
      case 'quest_started':
        await this.handleQuestStarted(tx, event);
        break;
      case 'proof_submitted':
        await this.handleProofSubmitted(tx, event);
        break;
      case 'reward_claimed':
        await this.handleRewardClaimed(tx, event);
        break;
      case 'reward_reserved':
        await this.handleRewardReserved(tx, event);
        break;
      case 'stake_locked':
        await this.handleStakeLocked(tx, event);
        break;
      case 'reward_released':
        await this.handleRewardReleased(tx, event);
        break;
      case 'reward_paid':
        await this.handleRewardPaid(tx, event);
        break;
      case 'reward_refunded':
        await this.handleRewardRefunded(tx, event);
        break;
      case 'nft_minted':
        await this.handleRewardMinted(tx, event);
        break;
      default:
        logger.debug('[PROJECTOR] No materializer registered', {
          eventType: event.eventType,
          eventKey: event.eventKey
        });
    }
  }

  private async handleQuestCreated(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.creatorWallet) {
      return;
    }

    const snapshot = await readQuestSnapshot(event.chainQuestId);
    await upsertUserInTx(tx, normalizeWallet(event.creatorWallet));
    await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      forcedStatus: 'AVAILABLE'
    });

    await ensureTransactionRecord(tx, {
      wallet: normalizeWallet(event.creatorWallet),
      type: 'QUEST_CREATED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        title: snapshot.title
      }
    });
  }

  private async handleQuestStarted(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.playerWallet) {
      return;
    }

    const playerWallet = normalizeWallet(event.playerWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const profile = await fetchProfileSnapshot(playerWallet);
    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      startedAt: event.blockTimestamp,
      forcedStatus: 'ACTIVE',
      playerId: user.id
    });

    await ensureQuestHistoryRecord(tx, {
      userId: user.id,
      questId: quest.id,
      action: 'STARTED',
      createdAt: event.blockTimestamp
    });

    await upsertDailyActivity(tx, {
      userId: user.id,
      date: getNumericDateKey(event.blockTimestamp),
      attempted: 1
    });

    await materializeClanState(tx, {
      userId: user.id,
      questId: quest.id,
      rewardAmount: 0,
      status: 'active',
      eventTimestamp: event.blockTimestamp
    });

    await ensureTransactionRecord(tx, {
      userId: user.id,
      wallet: playerWallet,
      type: 'QUEST_STARTED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString()
      }
    });
  }

  private async handleProofSubmitted(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.playerWallet) {
      return;
    }

    const playerWallet = normalizeWallet(event.playerWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      forcedStatus: 'SUBMITTED',
      playerId: user.id,
      proofTxHash: event.transactionHash
    });

    const payload = getEventPayload(event);
    const proofHash = getStringValue(payload.proofHash);

    await ensureQuestHistoryRecord(tx, {
      userId: user.id,
      questId: quest.id,
      action: 'SUBMITTED',
      proofUri: snapshot.proofUri || null,
      createdAt: event.blockTimestamp
    });

    if (proofHash && snapshot.proofUri) {
      await tx.proofSubmission.upsert({
        where: { proofHash },
        create: {
          userId: user.id,
          questId: quest.id,
          proofUri: snapshot.proofUri,
          proofHash,
          submittedAt: event.blockTimestamp,
          verificationResult: 'pending',
          createdAt: event.blockTimestamp
        },
        update: {
          proofUri: snapshot.proofUri,
          submittedAt: event.blockTimestamp,
          verificationResult: 'pending'
        }
      });
    }

    await ensureTransactionRecord(tx, {
      userId: user.id,
      wallet: playerWallet,
      type: 'QUEST_PROOF_SUBMITTED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        proofHash
      }
    });
  }

  private async handleRewardClaimed(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.playerWallet) {
      return;
    }

    const playerWallet = normalizeWallet(event.playerWallet);
    const payload = getEventPayload(event);
    const success = getBooleanValue(payload.success);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const profile = await fetchProfileSnapshot(playerWallet);
    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      completedAt: success ? event.blockTimestamp : null,
      failedAt: success ? null : event.blockTimestamp,
      forcedStatus: success ? 'VERIFIED' : 'FAILED',
      playerId: user.id,
      verificationTx: event.transactionHash
    });

    const history = await ensureQuestHistoryRecord(tx, {
      userId: user.id,
      questId: quest.id,
      action: success ? 'COMPLETED' : 'FAILED',
      proofUri: snapshot.proofUri || null,
      xpEarned: success ? snapshot.xpReward : 0,
      createdAt: event.blockTimestamp
    });

    if (history.created) {
      await applyUserOutcomeStats(tx, {
        userId: user.id,
        eventTimestamp: event.blockTimestamp,
        success,
        xpReward: snapshot.xpReward
      });
    }

    await materializeClanState(tx, {
      userId: user.id,
      questId: quest.id,
      rewardAmount: success ? snapshot.rewardAmount : 0,
      status: success ? 'completed' : 'failed',
      eventTimestamp: event.blockTimestamp
    });

    const proofHash = getStringValue(payload.proofHash);
    if (proofHash) {
      await tx.proofSubmission.updateMany({
        where: { proofHash },
        data: {
          verifiedAt: event.blockTimestamp,
          verificationResult: success ? 'VERIFIED' : 'REJECTED',
          verificationReason: success ? 'verified_onchain' : 'rejected_onchain'
        }
      });
    }

    await ensureTransactionRecord(tx, {
      userId: user.id,
      wallet: playerWallet,
      type: 'QUEST_VERIFIED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        success,
        rewardAmount: snapshot.rewardAmount,
        xpReward: snapshot.xpReward
      }
    });
  }

  private async handleRewardReserved(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.creatorWallet) {
      return;
    }

    const creatorWallet = normalizeWallet(event.creatorWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      forcedStatus: 'AVAILABLE'
    });

    await upsertUserInTx(tx, creatorWallet);
    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      chainQuestId: event.chainQuestId,
      rewardAmount: snapshot.rewardAmount,
      stakeAmount: 0,
      totalAmount: snapshot.rewardAmount,
      status: 'RESERVED',
      reservationTx: event.transactionHash,
      rewardReservedAt: event.blockTimestamp
    });

    await ensureTransactionRecord(tx, {
      wallet: creatorWallet,
      type: 'TREASURY_REWARD_RESERVED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        rewardAmount: snapshot.rewardAmount
      }
    });
  }

  private async handleStakeLocked(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.playerWallet) {
      return;
    }

    const playerWallet = normalizeWallet(event.playerWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const profile = await fetchProfileSnapshot(playerWallet);
    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      startedAt: event.blockTimestamp,
      forcedStatus: 'ACTIVE',
      playerId: user.id
    });

    const payload = getEventPayload(event);
    const stakeAmount =
      Number(getBigIntValue(payload.amount ?? payload.stakeAmount) ?? BigInt(Math.round(snapshot.stakeAmount * 1e18))) / 1e18;

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user.id,
      chainQuestId: event.chainQuestId,
      playerWallet,
      rewardAmount: snapshot.rewardAmount,
      stakeAmount,
      totalAmount: snapshot.rewardAmount + stakeAmount,
      status: 'LOCKED'
    });

    await ensureTransactionRecord(tx, {
      userId: user.id,
      wallet: playerWallet,
      type: 'TREASURY_STAKE_LOCKED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        stakeAmount
      }
    });
  }

  private async handleRewardReleased(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.playerWallet) {
      return;
    }

    const playerWallet = normalizeWallet(event.playerWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      forcedStatus: 'VERIFIED',
      completedAt: event.blockTimestamp,
      playerId: user.id
    });

    const payload = getEventPayload(event);
    const rewardAmount = Number(getBigIntValue(payload.rewardAmount) ?? BigInt(Math.round(snapshot.rewardAmount * 1e18))) / 1e18;
    const stakeAmount = Number(getBigIntValue(payload.stakeAmount) ?? BigInt(Math.round(snapshot.stakeAmount * 1e18))) / 1e18;
    const totalAmount = Number(getBigIntValue(payload.totalPayout) ?? BigInt(Math.round((rewardAmount + stakeAmount) * 1e18))) / 1e18;

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user.id,
      chainQuestId: event.chainQuestId,
      playerWallet,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: 'RELEASED',
      releaseTx: event.transactionHash,
      rewardReleasedAt: event.blockTimestamp
    });

    await ensureTransactionRecord(tx, {
      userId: user.id,
      wallet: playerWallet,
      type: 'TREASURY_REWARD_RELEASED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        rewardAmount,
        stakeAmount,
        totalAmount
      }
    });
  }

  private async handleRewardPaid(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.playerWallet) {
      return;
    }

    const playerWallet = normalizeWallet(event.playerWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      forcedStatus: 'VERIFIED',
      completedAt: event.blockTimestamp,
      playerId: user.id
    });

    const payload = getEventPayload(event);
    const rewardAmount = Number(getBigIntValue(payload.rewardAmount) ?? BigInt(Math.round(snapshot.rewardAmount * 1e18))) / 1e18;
    const stakeAmount = Number(getBigIntValue(payload.stakeAmount) ?? BigInt(Math.round(snapshot.stakeAmount * 1e18))) / 1e18;
    const totalAmount = Number(getBigIntValue(payload.totalPayout) ?? BigInt(Math.round((rewardAmount + stakeAmount) * 1e18))) / 1e18;

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user.id,
      chainQuestId: event.chainQuestId,
      playerWallet,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: 'PAID',
      payoutTx: event.transactionHash,
      rewardPaidAt: event.blockTimestamp
    });

    const createdReward = await createRewardIfMissing(tx, {
      userId: user.id,
      amount: rewardAmount,
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp
    });

    if (createdReward) {
      await upsertDailyActivity(tx, {
        userId: user.id,
        date: getNumericDateKey(event.blockTimestamp),
        rewardsEarned: rewardAmount
      });
    }

    await materializeClanState(tx, {
      userId: user.id,
      questId: quest.id,
      rewardAmount,
      status: 'completed',
      eventTimestamp: event.blockTimestamp
    });

    await ensureTransactionRecord(tx, {
      userId: user.id,
      wallet: playerWallet,
      type: 'TREASURY_REWARD_PAID',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        rewardAmount,
        stakeAmount,
        totalAmount
      }
    });
  }

  private async handleRewardRefunded(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId) {
      return;
    }

    const payload = getEventPayload(event);
    const recipientWallet =
      normalizeOptionalWallet(event.playerWallet) ??
      normalizeOptionalWallet(getStringValue(payload.recipient)) ??
      normalizeOptionalWallet(event.creatorWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const forcedStatus: QuestStatus =
      snapshot.status === 'CANCELLED' ? 'CANCELLED' : snapshot.status === 'FAILED' ? 'FAILED' : 'CANCELLED';
    const user = recipientWallet ? await upsertUserInTx(tx, recipientWallet) : null;
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      forcedStatus,
      failedAt: forcedStatus === 'FAILED' ? event.blockTimestamp : null,
      playerId: user?.id ?? null
    });

    const rewardAmount = Number(getBigIntValue(payload.rewardAmount) ?? 0n) / 1e18;
    const stakeAmount = Number(getBigIntValue(payload.stakeAmount) ?? 0n) / 1e18;
    const totalAmount = rewardAmount + stakeAmount;

    await upsertTreasuryPayout(tx, {
      questId: quest.id,
      userId: user?.id ?? null,
      chainQuestId: event.chainQuestId,
      playerWallet: recipientWallet ?? null,
      rewardAmount,
      stakeAmount,
      totalAmount,
      status: 'REFUNDED',
      refundTx: event.transactionHash,
      rewardRefundedAt: event.blockTimestamp
    });

    if (user && forcedStatus === 'FAILED') {
      const history = await ensureQuestHistoryRecord(tx, {
        userId: user.id,
        questId: quest.id,
        action: 'FAILED',
        proofUri: snapshot.proofUri || null,
        createdAt: event.blockTimestamp
      });

      if (history.created) {
        await applyUserOutcomeStats(tx, {
          userId: user.id,
          eventTimestamp: event.blockTimestamp,
          success: false,
          xpReward: 0
        });
      }

      await materializeClanState(tx, {
        userId: user.id,
        questId: quest.id,
        rewardAmount: 0,
        status: 'failed',
        eventTimestamp: event.blockTimestamp
      });
    }

    await ensureTransactionRecord(tx, {
      userId: user?.id ?? null,
      wallet: recipientWallet ?? snapshot.creator,
      type: 'TREASURY_REWARD_REFUNDED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        rewardAmount,
        stakeAmount,
        status: forcedStatus
      }
    });
  }

  private async handleRewardMinted(tx: TransactionClient, event: ChainEvent) {
    if (!event.chainQuestId || !event.playerWallet) {
      return;
    }

    const playerWallet = normalizeWallet(event.playerWallet);
    const snapshot = await readQuestSnapshot(event.chainQuestId);
    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      createdAt: event.blockTimestamp,
      forcedStatus: snapshot.status,
      playerId: user.id,
      nftMintTx: event.transactionHash
    });

    const payload = getEventPayload(event);
    const tokenId = getStringValue(payload.tokenId);

    if (tokenId) {
      const existingNft = await tx.nFT.findFirst({
        where: { tokenId },
        select: { id: true }
      });

      if (!existingNft) {
        await tx.nFT.create({
          data: {
            userId: user.id,
            tokenId,
            metadataUri: snapshot.proofUri || snapshot.metadataUri,
            rarity: questRarityFromDifficulty(quest.difficulty),
            xpEarned: snapshot.xpReward,
            questHistory: quest.id,
            mintedAt: event.blockTimestamp
          }
        });
      }
    }

    await ensureTransactionRecord(tx, {
      userId: user.id,
      wallet: playerWallet,
      type: 'REWARD_MINTED',
      txHash: event.transactionHash,
      createdAt: event.blockTimestamp,
      details: {
        chainQuestId: event.chainQuestId.toString(),
        tokenId
      }
    });
  }
}

export const authoritativeEventProjector = new AuthoritativeEventProjector();

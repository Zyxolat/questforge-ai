import { Request, Response } from 'express';
import { Prisma, type QuestStatus, Quest } from '@prisma/client';
import { ethers } from 'ethers';
import { contracts } from '../services/contracts';
import { normalizeWallet, prisma, upsertUser } from '../services/chain';
import {
  checkDailyLimits,
  getDailyActivity,
  incrementDailyActivity,
  QUEST_CONFIG
} from '../services/antiAbuse';
import { buildQuestTemplate } from '../services/questTemplates';
import { logger } from '../services/logger';
import { ruleBasedQuestEngine } from '../services/ruleBasedQuestEngine';
import { npcRelationshipEngine } from '../services/npcRelationshipEngine';
import { QuestValidationError } from '../services/questValidationEngine';
import { worldStateCoordinator } from '../services/worldStateCoordinator';

const QUEST_FEED_STATUSES: QuestStatus[] = [
  'AVAILABLE',
  'ACCEPTED',
  'COMPLETED',
  'CLAIMABLE',
  'REWARDED'
];

type TreasuryPayoutRow = {
  questId: string;
  chainQuestId: bigint | string;
  playerWallet: string | null;
  rewardAmount: number;
  stakeAmount: number;
  totalAmount: number;
  status: string;
  reservationTx: string | null;
  releaseTx: string | null;
  payoutTx: string | null;
  refundTx: string | null;
  rewardReservedAt: Date | null;
  rewardReleasedAt: Date | null;
  rewardPaidAt: Date | null;
  rewardRefundedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type LatestProofState = {
  questId: string;
  verificationResult: string | null;
  verificationReason: string | null;
  submittedAt: Date;
  verifiedAt: Date | null;
};

function serializeMaybeBigInt(value: bigint | string | null | undefined) {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value ?? null;
}

function extractQuestOrchestrationId(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const orchestrationId = (metadata as { orchestrationId?: unknown }).orchestrationId;
  return typeof orchestrationId === 'string' ? orchestrationId : null;
}

type QuestSchemaColumnRow = {
  tableName: string;
  columnName: string;
};

let questTableColumnsCache: Set<string> | null = null;

async function getQuestTableColumns(): Promise<Set<string>> {
  if (questTableColumnsCache) return questTableColumnsCache;

  const rows = await prisma.$queryRaw<QuestSchemaColumnRow[]>`
    SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND lower(table_name) = lower('Quest')
  `;

  questTableColumnsCache = new Set(rows.map((row) => row.columnName.toLowerCase()));
  return questTableColumnsCache;
}

async function hasQuestColumn(columnName: string): Promise<boolean> {
  const columns = await getQuestTableColumns();
  return columns.has(columnName.toLowerCase());
}

function serializeQuest<
  T extends {
    chainQuestId?: bigint | null;
    orchestrationId?: string | null;
    metadata?: unknown;
    treasuryPayout?: { chainQuestId: bigint | string } | null;
  }
>(quest: T) {
  return {
    ...quest,
    orchestrationId: quest.orchestrationId ?? extractQuestOrchestrationId(quest.metadata),
    chainQuestId: serializeMaybeBigInt(quest.chainQuestId),
    treasuryPayout: quest.treasuryPayout
      ? {
          ...quest.treasuryPayout,
          chainQuestId: serializeMaybeBigInt(quest.treasuryPayout.chainQuestId)
        }
      : null
  };
}

async function loadLatestProofStateByQuestIds(questIds: string[]) {
  if (questIds.length === 0) {
    return new Map<string, LatestProofState>();
  }

  const proofRows = await prisma.proofSubmission.findMany({
    where: {
      questId: {
        in: questIds
      }
    },
    orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      questId: true,
      verificationResult: true,
      verificationReason: true,
      submittedAt: true,
      verifiedAt: true
    }
  });

  const latestByQuestId = new Map<string, LatestProofState>();
  proofRows.forEach((row) => {
    if (!latestByQuestId.has(row.questId)) {
      latestByQuestId.set(row.questId, row);
    }
  });

  return latestByQuestId;
}

function summarizeForgeQuestReceipt(receipt: Awaited<ReturnType<typeof contracts.provider.getTransactionReceipt>> | null) {
  if (!receipt) {
    return [];
  }

  return receipt.logs.map((log) => {
    const parsedEventName = (() => {
      try {
        return contracts.forgeQuestManager.interface.parseLog(log)?.name ?? null;
      } catch {
        return null;
      }
    })();

    return {
      address: log.address,
      logIndex: Number(log.index ?? 0),
      topic0: log.topics[0] ?? null,
      parsedEventName
    };
  });
}

function parseForgeQuestReceiptEvent(
  receipt: Awaited<ReturnType<typeof contracts.provider.getTransactionReceipt>> | null,
  eventName: string
) {
  if (!receipt) {
    return null;
  }

  for (const log of receipt.logs) {
    try {
      const parsed = contracts.forgeQuestManager.interface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed;
      }
    } catch {
      // Ignore unrelated logs.
    }
  }

  return null;
}

export async function generateQuest(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const chain = req.body.chain || 'Celo';

  if (!wallet) {
    return res.status(400).json({
      error: {
        code: 'QUEST_REQUEST_INVALID',
        message: 'Wallet is required'
      },
      details: ['Authenticated wallet context was missing on the quest generation request.']
    });
  }

  const normalizedWallet = normalizeWallet(wallet);

  logger.info('[QUEST] Generate quest request received', {
    wallet: normalizedWallet,
    userId: req.auth?.userId ?? null,
    chain,
    hasAccessToken: Boolean(req.get('authorization'))
  });

  try {
    const user = await upsertUser(normalizedWallet);
    const dailyLimits = await checkDailyLimits(user.id);
    const worldState = await worldStateCoordinator.getCurrentWorldState('quest_generation');

    if (!dailyLimits.canAttempt) {
      return res.status(429).json({
        error: {
          code: 'QUEST_DAILY_LIMIT_REACHED',
          message: dailyLimits.reason || 'Daily quest generation limit reached'
        },
        remaining: dailyLimits.remaining
      });
    }

    const generated = ruleBasedQuestEngine.generateQuest(user.level, {
      wallet: normalizeWallet(wallet),
      chain,
      userId: user.id,
      username: user.username,
      xp: user.xp,
      level: user.level,
      streak: user.streak,
      onchainActions: user.onchainActions,
      worldState
    });

    await incrementDailyActivity(user.id, { questsAttempted: 1 });
    const activitySnapshot = await getDailyActivity(user.id);

    const includeMetadataUri = await hasQuestColumn('metadataUri');

    const questPayload: Prisma.QuestCreateInput = {
      id: generated.quest.id,
      orchestrationId: generated.quest.orchestrationId,
      title: generated.quest.title,
      description: generated.quest.description,
      metadata: generated.quest.metadata as Prisma.InputJsonValue,
      difficulty: generated.quest.difficulty,
      questType: generated.quest.questType,
      objective: generated.quest.objective,
      lore: generated.quest.lore,
      worldStateVersion: generated.quest.worldStateVersion,
      stakeAmount: generated.quest.stakeAmount,
      rewardAmount: generated.quest.rewardAmount,
      xpReward: generated.quest.xpReward,
      transactionCount: generated.quest.transactionCount,
      requiredTxTypes: generated.quest.requiredTxTypes,
      durationSeconds: generated.quest.durationSeconds,
      expiresAt: generated.quest.expiresAt,
      status: generated.quest.status,
      creator: normalizedWallet,
      isEventQuest: generated.quest.isEventQuest
    };

    if (includeMetadataUri) {
      questPayload.metadataUri = generated.quest.metadataUri;
    }

    const questUpdate: Prisma.QuestUpdateInput = {
      title: generated.quest.title,
      description: generated.quest.description,
      metadata: generated.quest.metadata as Prisma.InputJsonValue,
      difficulty: generated.quest.difficulty,
      questType: generated.quest.questType,
      objective: generated.quest.objective,
      lore: generated.quest.lore,
      worldStateVersion: generated.quest.worldStateVersion,
      stakeAmount: generated.quest.stakeAmount,
      rewardAmount: generated.quest.rewardAmount,
      xpReward: generated.quest.xpReward,
      transactionCount: generated.quest.transactionCount,
      requiredTxTypes: generated.quest.requiredTxTypes,
      durationSeconds: generated.quest.durationSeconds,
      expiresAt: generated.quest.expiresAt,
      creator: normalizedWallet,
      isEventQuest: generated.quest.isEventQuest
    };

    if (includeMetadataUri) {
      questUpdate.metadataUri = generated.quest.metadataUri;
    }

    await prisma.quest.upsert({
      where: { id: generated.quest.id },
      create: questPayload,
      update: questUpdate
    });

    logger.info('[QUEST] Generate quest request succeeded', {
      wallet,
      userId: user.id,
      questId: generated.quest.id,
      orchestrationId: generated.quest.orchestrationId,
      rewardAmount: generated.quest.rewardAmount,
      provider: generated.quest.generation.provider,
      source: generated.quest.generation.source,
      fallbackReason: generated.quest.generation.fallbackReason,
      latencyMs: generated.quest.generation.latencyMs
    });

    res.json({
      success: true,
      source: 'rule_based',
      quest: {
        id: generated.quest.id,
        orchestrationId: generated.quest.orchestrationId,
        source: generated.quest.generation.source,
        provider: generated.quest.generation.provider,
        title: generated.quest.title,
        description: generated.quest.description,
        difficulty: generated.quest.difficulty,
        questType: generated.quest.questType,
        objective: generated.quest.objective,
        lore: generated.quest.lore,
        missionStructure: generated.quest.missionStructure,
        missionObjectives: generated.quest.missionObjectives,
        missionChapters: generated.quest.missionChapters,
        storyline: generated.quest.storyline,
        rewardRationale: generated.quest.rewardRationale,
        metadata: generated.quest.metadata,
        metadataUri: generated.quest.metadataUri,
        stakeAmount: generated.quest.stakeAmount,
        rewardAmount: generated.quest.rewardAmount,
        xpReward: generated.quest.xpReward,
        durationSeconds: generated.quest.durationSeconds,
        estimatedDurationSeconds: generated.quest.estimatedDurationSeconds,
        status: generated.quest.status,
        riskLevel: generated.quest.riskLevel,
        streakMultiplier: generated.streakMultiplier,
        difficultyReasoning: generated.difficultyProfile.reasoning,
        rewardReasoning: generated.rewardProfile.reasoning,
        adaptiveProfile: (generated.quest.metadata as { adaptive?: unknown }).adaptive ?? null,
        economyProfile: (generated.quest.metadata as { economy?: unknown }).economy ?? null,
        orchestrationProfile: (generated.quest.metadata as { orchestration?: unknown }).orchestration ?? null,
        transactionCount: generated.quest.transactionCount,
        requiredTxTypes: generated.quest.requiredTxTypes,
        worldStateVersion: generated.quest.worldStateVersion,
        npc: generated.quest.npc,
        faction: generated.quest.faction,
        worldInfluence: generated.quest.worldInfluence,
        branchingHooks: generated.quest.branchingHooks,
        txRequirements: generated.quest.txRequirements,
        chainInteraction: generated.quest.chainInteraction,
        coOpHooks: generated.quest.coOpHooks,
        loreContinuity: generated.quest.loreContinuity,
        generation: generated.quest.generation,
        expiresAt: generated.quest.expiresAt.toISOString(),
        remainingDailyCapacity: {
          quests: Math.max(0, QUEST_CONFIG.MAX_QUESTS_PER_DAY - (activitySnapshot?.questsAttempted || 0)),
          xp: Math.max(0, QUEST_CONFIG.MAX_XP_PER_DAY - (activitySnapshot?.xpEarned || 0)),
          rewards: Math.max(0, QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO - (activitySnapshot?.rewardsEarned || 0))
        },
        orchestrationDiagnostics: generated.orchestrationDiagnostics
      }
    });
  } catch (error) {
    if (error instanceof QuestValidationError) {
      logger.warn('[QUEST] Generate quest request failed deterministic validation', {
        wallet,
        details: error.details
      });
      return res.status(400).json({
        error: {
          code: 'QUEST_VALIDATION_FAILED',
          message: error.message
        },
        details: error.details
      });
    }

    logger.error('Quest generation failed', error, {
      wallet
    });
    const errorDetails = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: {
        code: 'QUEST_GENERATION_FAILED',
        message: 'Quest generation failed unexpectedly',
        details: errorDetails
      }
    });
  }
}

/**
 * Accept a quest that was created via createAndAcceptQuest()
 * Frontend calls this AFTER user wallet confirms the transaction
 * 
 * Updates the database with the chainQuestId returned from on-chain createAndAcceptQuest()
 * 
 * Request body: {
 *   chainQuestId: string,           // From QuestCreated event
 *   acceptanceTxHash: string        // From user's wallet tx
 * }
 */
/**
 * DATABASE-FIRST MODEL: Accept quest without blockchain
 *
 * - No chain registration needed
 * - Instant database update
 * - User must be authenticated
 * - Quest must be in AVAILABLE status
 *
 * Request body: {} (empty, no parameters)
 *
 * Response: { success: true, quest: {...} }
 */
export async function acceptQuest(req: Request, res: Response) {
  const questId = req.params.questId;
  const wallet = req.auth?.wallet;

  if (!questId) {
    return res.status(400).json({
      error: {
        code: 'QUEST_ID_REQUIRED',
        message: 'Quest ID is required in URL'
      }
    });
  }

  if (!wallet) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required to accept quest'
      }
    });
  }

  try {
    // Fetch the quest from database
    const quest = await prisma.quest.findUnique({
      where: { id: questId },
      include: { player: true }
    });

    if (!quest) {
      return res.status(404).json({
        error: {
          code: 'QUEST_NOT_FOUND',
          message: `Quest ${questId} not found`
        }
      });
    }

    // Verify quest is in AVAILABLE status
    if (quest.status !== 'AVAILABLE') {
      return res.status(400).json({
        error: {
          code: 'QUEST_INVALID_STATUS',
          message: `Quest status is ${quest.status}, expected AVAILABLE`,
          action: 'refresh'
        }
      });
    }

    // Verify quest hasn't already been accepted by another player
    if (quest.playerId !== null) {
      return res.status(400).json({
        error: {
          code: 'QUEST_ALREADY_ACCEPTED',
          message: 'Quest has already been accepted by another player',
          action: 'refresh'
        }
      });
    }

    // Get or create user
    const user = await upsertUser(wallet);

    // Update quest status to ACCEPTED (database only, no blockchain)
    const updatedQuest = await prisma.quest.update({
      where: { id: questId },
      data: {
        playerId: user.id,
        status: 'ACCEPTED',
        startedAt: new Date()
        // NOTE: NO chainQuestId update needed
        // NOTE: NO blockchain transaction hash stored
      },
      include: { player: true }
    });

    logger.info('[QUEST] Quest accepted (database-first)', {
      questId,
      wallet,
      player: user.username,
      status: updatedQuest.status
    });

    // No blockchain event publishing needed
    // (accept no longer involves blockchain)

    res.json({
      success: true,
      quest: {
        id: updatedQuest.id,
        orchestrationId: updatedQuest.orchestrationId,
        status: updatedQuest.status,
        playerId: updatedQuest.playerId,
        startedAt: updatedQuest.startedAt?.toISOString(),
        title: updatedQuest.title,
        description: updatedQuest.description,
        rewardAmount: updatedQuest.rewardAmount,
        xpReward: updatedQuest.xpReward,
        difficulty: updatedQuest.difficulty,
        questType: updatedQuest.questType,
        objective: updatedQuest.objective,
        lore: updatedQuest.lore,
        chainQuestId: updatedQuest.chainQuestId?.toString() ?? null,
        durationSeconds: updatedQuest.durationSeconds,
        expiresAt: updatedQuest.expiresAt?.toISOString(),
        player: updatedQuest.player?.username,
        metadata: updatedQuest.metadata
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error('[QUEST] Accept quest failed', {
      questId,
      wallet,
      error: errorMessage,
      stack: errorStack
    });

    // Return detailed error in development, generic in production
    const isDevelopment = process.env.NODE_ENV !== 'production';
    return res.status(500).json({
      error: {
        code: 'QUEST_ACCEPTANCE_ERROR',
        message: isDevelopment ? `Failed to accept quest: ${errorMessage}` : 'Failed to accept quest. Please try again.'
      }
    });
  }
}

export async function getDailyMissions(_req: Request, res: Response) {
  const missionDifficulties = [1, 2, 3];
  const missions = missionDifficulties.map((difficulty) => {
    const template = buildQuestTemplate(difficulty, '0x0000000000000000000000000000000000000000');

    return {
      id: `daily-${template.type}-${difficulty}`,
      title: template.questType,
      description: template.objective,
      reward: `${150 * difficulty} XP + bounded CELO payout`,
      validationRules: template.validationRules
    };
  });

  res.json({ missions });
}

export async function registerOnchainQuest(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const { questId, chainQuestId, creationTxHash } = req.body as {
    questId?: string;
    chainQuestId?: string | number;
    creationTxHash?: string;
  };

  if (!wallet || !questId || !chainQuestId || !creationTxHash) {
    return res.status(400).json({
      error: {
        code: 'QUEST_REGISTRATION_INVALID',
        message: 'Wallet, questId, chainQuestId, and creationTxHash are required'
      }
    });
  }

  let parsedChainQuestId: bigint;
  try {
    parsedChainQuestId = BigInt(String(chainQuestId));
  } catch {
    return res.status(400).json({
      error: {
        code: 'QUEST_CHAIN_ID_INVALID',
        message: 'chainQuestId must be a valid integer'
      }
    });
  }

  const normalizedWallet = normalizeWallet(wallet);

  try {
    logger.info('[QUEST] Register onchain quest request received', {
      wallet: normalizedWallet,
      questId,
      chainQuestId: parsedChainQuestId.toString(),
      creationTxHash
    });

    const quest = await prisma.quest.findUnique({
      where: { id: questId }
    });

    if (!quest) {
      return res.status(404).json({
        error: {
          code: 'QUEST_NOT_FOUND',
          message: 'Quest not found'
        }
      });
    }

    if (quest.creator !== normalizedWallet) {
      return res.status(403).json({
        error: {
          code: 'QUEST_NOT_OWNED',
          message: 'Only the quest creator can register onchain quest data'
        }
      });
    }

    if (quest.chainQuestId && quest.chainQuestId !== parsedChainQuestId) {
      return res.status(409).json({
        error: {
          code: 'QUEST_CHAIN_ID_CONFLICT',
          message: 'Quest is already linked to a different onchain quest id'
        },
        details: [
          `existing=${quest.chainQuestId.toString()}`,
          `received=${parsedChainQuestId.toString()}`
        ]
      });
    }

    const receipt = await contracts.provider.getTransactionReceipt(creationTxHash);
    logger.info('[QUEST] Register onchain quest receipt fetched', {
      questId,
      chainQuestId: parsedChainQuestId.toString(),
      creationTxHash,
      receiptStatus: receipt?.status ?? null,
      blockNumber: receipt?.blockNumber ?? null,
      logs: summarizeForgeQuestReceipt(receipt)
    });

    if (!receipt || receipt.status !== 1) {
      return res.status(409).json({
        error: {
          code: 'QUEST_CREATION_TX_UNCONFIRMED',
          message: 'Quest creation transaction is not confirmed onchain yet'
        }
      });
    }

    const parsedQuestCreated = parseForgeQuestReceiptEvent(receipt, 'QuestCreated');

    if (!parsedQuestCreated) {
      logger.warn('[QUEST] QuestCreated event missing from creation receipt', {
        questId,
        chainQuestId: parsedChainQuestId.toString(),
        creationTxHash,
        logs: summarizeForgeQuestReceipt(receipt)
      });
      return res.status(409).json({
        error: {
          code: 'QUEST_CREATION_EVENT_MISSING',
          message: 'Quest creation transaction did not emit QuestCreated'
        }
      });
    }

    const eventQuestId = BigInt(parsedQuestCreated.args.questId.toString());
    const eventCreator = normalizeWallet(String(parsedQuestCreated.args.creator));

    if (eventQuestId !== parsedChainQuestId) {
      return res.status(409).json({
        error: {
          code: 'QUEST_CHAIN_ID_MISMATCH',
          message: 'QuestCreated event quest id did not match the provided chainQuestId'
        },
        details: [
          `event=${eventQuestId.toString()}`,
          `received=${parsedChainQuestId.toString()}`
        ]
      });
    }

    if (eventCreator !== normalizedWallet) {
      return res.status(403).json({
        error: {
          code: 'QUEST_CREATOR_MISMATCH',
          message: 'QuestCreated event creator did not match the authenticated wallet'
        }
      });
    }

    const block = await contracts.provider.getBlock(receipt.blockNumber);
    const rewardReservedAt = block ? new Date(Number(block.timestamp) * 1000) : new Date();

    const user = await prisma.user.findUnique({
      where: { wallet: normalizedWallet }
    });

    if (!user) {
      return res.status(404).json({
        error: {
          code: 'PLAYER_NOT_FOUND',
          message: 'Player account not found for the authenticated wallet'
        }
      });
    }

    const updatedQuest = await prisma.$transaction(async (tx) => {
      const nextQuest = await tx.quest.update({
        where: { id: questId },
        data: {
          chainQuestId: parsedChainQuestId,
          status: 'ACCEPTED',
          player: {
            connect: { id: user.id }
          },
          startedAt: rewardReservedAt,
          stakeAmount: 0
        }
      });

      await tx.treasuryPayout.upsert({
        where: { questId },
        create: {
          questId,
          userId: user.id,
          chainQuestId: parsedChainQuestId,
          playerWallet: normalizedWallet,
          rewardAmount: quest.rewardAmount,
          stakeAmount: 0,
          totalAmount: quest.rewardAmount,
          status: 'RESERVED',
          reservationTx: creationTxHash,
          rewardReservedAt
        },
        update: {
          userId: user.id,
          chainQuestId: parsedChainQuestId,
          playerWallet: normalizedWallet,
          rewardAmount: quest.rewardAmount,
          stakeAmount: 0,
          totalAmount: quest.rewardAmount,
          status: 'RESERVED',
          reservationTx: creationTxHash,
          rewardReservedAt
        }
      });

      return nextQuest;
    });

    const treasuryPayout = await prisma.treasuryPayout.findUnique({
      where: { questId }
    });

    logger.info('[QUEST] Onchain quest registration DB persistence verified', {
      questId,
      storedChainQuestId: updatedQuest.chainQuestId?.toString() ?? null,
      storedStatus: updatedQuest.status,
      treasuryPayoutStatus: treasuryPayout?.status ?? null,
      treasuryPayoutChainQuestId: treasuryPayout?.chainQuestId?.toString?.() ?? null
    });

    logger.info('[QUEST] Onchain quest registration completed', {
      wallet: normalizedWallet,
      questId,
      chainQuestId: parsedChainQuestId.toString(),
      creationTxHash
    });

    return res.json({
      success: true,
      quest: serializeQuest({
        ...updatedQuest,
        treasuryPayout
      })
    });
  } catch (error) {
    logger.error('Quest onchain registration failed', error, {
      wallet: normalizedWallet,
      questId,
      chainQuestId: String(chainQuestId),
      creationTxHash
    });

    return res.status(500).json({
      error: {
        code: 'QUEST_REGISTRATION_FAILED',
        message: error instanceof Error ? error.message : 'Failed to register onchain quest data'
      }
    });
  }
}

export async function getQuestOrchestrationDiagnostics(_req: Request, res: Response) {
  try {
    const worldState = await worldStateCoordinator.getCurrentWorldState('diagnostics');
    res.json({
      orchestration: ruleBasedQuestEngine.getDiagnostics(),
      worldState: {
        version: worldState.version,
        season: worldState.season,
        activeEvents: worldState.activeEvents.length,
        factions: worldState.factions,
        diagnostics: worldState.diagnostics
      }
    });
  } catch (error) {
    logger.error('Failed to fetch orchestration diagnostics', error);
    res.status(500).json({ error: 'Unable to load orchestration diagnostics' });
  }
}

export async function getNPCDialogue(req: Request, res: Response) {
  const npcType = req.query.type?.toString() || 'Guild Master';
  const playerName = req.query.player?.toString() || 'Traveler';
  const wallet = req.query.wallet?.toString();

  try {
    const worldState = await worldStateCoordinator.getCurrentWorldState('npc_dialogue');
    let dialogue = `${npcType} studies you in silence, ${playerName}.`;

    if (wallet) {
      const user = await upsertUser(normalizeWallet(wallet));
      const npc =
        (await prisma.nPC.findFirst({
          where: { name: npcType },
          select: {
            id: true,
            name: true,
            type: true,
            personality: true
          }
        })) ??
        (await prisma.nPC.create({
          data: {
            name: npcType,
            type: npcType.toLowerCase().replace(/\s+/g, '_'),
            personality: {
              archetype: npcType,
              role: 'lore_keeper',
              traits: worldState.npcTones
            },
            lastInteractionAt: new Date()
          },
          select: {
            id: true,
            name: true,
            type: true,
            personality: true
          }
        }));
      const memory = await prisma.nPCMemory.findFirst({
        where: {
          npcId: npc.id,
          wallet: normalizeWallet(wallet)
        },
        orderBy: { updatedAt: 'desc' }
      });

      const personalitySummary =
        typeof npc.personality === 'object' && npc.personality && !Array.isArray(npc.personality)
          ? JSON.stringify(npc.personality).slice(0, 160)
          : 'measured and observant';
      const relationshipSummary = memory ? [memory.memory] : [`successes=${user.totalQuestsCompleted}`, `streak=${user.streak}`];
      dialogue = `${npc.name} says: ${npcType} watches over ${worldState.season.label}, ${playerName}. ${relationshipSummary[0] ?? 'Your path is still being written.'} ${personalitySummary}.`;

      // Conversation logging removed - not used in database-first model
      // Previously would have been stored/used for NPC interaction history

      await prisma.nPC.update({
        where: { id: npc.id },
        data: { lastInteractionAt: new Date() }
      });

      await npcRelationshipEngine.updateRelationship({
        userId: user.id,
        wallet: normalizeWallet(wallet),
        npcId: npc.id,
        eventType: 'npc_dialogue',
        summary: `${npc.name} referenced the player's remembered path during dialogue.`,
        trustDelta: 0.03,
        metadata: {
          dialogue,
          npcType
        }
      });

      // Real-time event publishing removed (database-first model)
      // Event was: await realtimeEventPublisher.publish({ ... })
    }

    res.json({ npcType, dialogue });
  } catch (error) {
    logger.error('NPC dialogue generation failed', error, {
      npcType,
      playerName
    });
    res.status(500).json({ error: 'NPC generation failed' });
  }
}

export async function getActiveQuests(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  if (!wallet) {
    return res.status(400).json({ error: 'Wallet is required' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { wallet: normalizeWallet(wallet) } });
    if (!user) {
      return res.json({ quests: [] });
    }

    const quests = await prisma.quest.findMany({
      where: {
        OR: [
          {
            creator: normalizeWallet(wallet),
            status: {
              in: QUEST_FEED_STATUSES
            }
          },
          {
            playerId: user.id,
            status: {
              in: QUEST_FEED_STATUSES
            }
          }
        ]
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      take: 50
    });

    const questIds = quests.map((quest) => quest.id);
    const latestProofByQuestId = await loadLatestProofStateByQuestIds(questIds);
    const payouts = questIds.length
      ? await prisma.$queryRaw<TreasuryPayoutRow[]>(
          Prisma.sql`
            SELECT
              "questId",
              "chainQuestId",
              "playerWallet",
              "rewardAmount",
              "stakeAmount",
              "totalAmount",
              status::text AS status,
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
            FROM "TreasuryPayout"
            WHERE "questId" IN (${Prisma.join(questIds)})
          `
        )
      : [];

    const payoutsByQuestId = new Map(payouts.map((payout) => [payout.questId, payout]));

    res.json({
      quests: quests.map((quest) =>
        serializeQuest({
          ...quest,
          treasuryPayout: payoutsByQuestId.get(quest.id) || null,
          ...(latestProofByQuestId.get(quest.id)
            ? {
                verificationResult: latestProofByQuestId.get(quest.id)?.verificationResult ?? null,
                verificationReason: latestProofByQuestId.get(quest.id)?.verificationReason ?? null,
                lastProofSubmittedAt: latestProofByQuestId.get(quest.id)?.submittedAt ?? null,
                lastProofVerifiedAt: latestProofByQuestId.get(quest.id)?.verifiedAt ?? null
              }
            : {})
        })
      ),
      total: quests.length
    });
  } catch (error) {
    logger.error('Active quest lookup failed', error, { wallet });
    res.status(500).json({ error: 'Unable to load active quests' });
  }
}

export async function submitProof(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const { questId, proofUri } = req.body;

  logger.info('[QUEST] Proof submission route entered', {
    wallet: wallet ?? null,
    userId: req.auth?.userId ?? null,
    questId: typeof questId === 'string' ? questId : null,
    hasProofUri: typeof proofUri === 'string' && proofUri.length > 0,
    proofUriPreview: typeof proofUri === 'string' ? proofUri.slice(0, 16) : null
  });

  if (!wallet || !questId || !proofUri) {
    return res.status(400).json({ error: 'Wallet, questId, and proofUri are required' });
  }

  if (typeof proofUri !== 'string' || proofUri.length === 0 || proofUri.length > 2048) {
    return res.status(400).json({ error: 'Proof must be a non-empty text description' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: {
        wallet: normalizeWallet(wallet)
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const quest = await prisma.quest.findUnique({ where: { id: questId } });
    if (!quest) {
      return res.status(404).json({ error: 'Quest not found' });
    }

    if (quest.playerId !== user.id) {
      return res.status(403).json({ error: 'Not your quest' });
    }

    if (quest.status !== 'ACCEPTED') {
      return res.status(400).json({ error: `Quest status is ${quest.status}` });
    }

    if (quest.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Quest has expired' });
    }

    logger.info('[QUEST] Proof submission accepted (off-chain)', {
      wallet,
      userId: user.id,
      questId,
      proofUriPreview: proofUri.slice(0, 16)
    });

    // Update quest status to CLAIMABLE after accepting off-chain proof
    const updatedQuest = await prisma.quest.update({
      where: { id: questId },
      data: {
        status: 'CLAIMABLE',
        proofTx: proofUri
      }
    });

    logger.info('[QUEST] Proof accepted and quest marked as claimable', {
      wallet,
      userId: user.id,
      questId,
      newStatus: updatedQuest.status,
      rewardAmount: updatedQuest.rewardAmount,
      reason: 'No blockchain quest creation needed - claimReward uses questId directly'
    });

    res.json({
      success: true,
      quest: {
        id: updatedQuest.id,
        status: updatedQuest.status,
        rewardAmount: updatedQuest.rewardAmount,
        xpReward: updatedQuest.xpReward,
        proofTx: updatedQuest.proofTx,
        title: updatedQuest.title,
        description: updatedQuest.description,
        difficulty: updatedQuest.difficulty,
        questType: updatedQuest.questType,
        objective: updatedQuest.objective,
        durationSeconds: updatedQuest.durationSeconds,
        expiresAt: updatedQuest.expiresAt?.toISOString(),
        metadata: updatedQuest.metadata
      },
      message: 'Proof accepted! Quest ready to claim reward on blockchain.'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to submit proof';
    logger.error('Proof submission failed', error, {
      wallet,
      questId
    });
    res.status(400).json({ error: message });
  }
}

export async function updateChainQuestId(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const { questId } = req.params;
  const { chainQuestId } = req.body;

  if (!wallet || !questId || !chainQuestId) {
    return res.status(400).json({
      error: 'Wallet, questId, and chainQuestId are required'
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { wallet: normalizeWallet(wallet) }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const quest = await prisma.quest.findUnique({
      where: { id: questId }
    });

    if (!quest) {
      return res.status(404).json({ error: 'Quest not found' });
    }

    if (quest.playerId !== user.id) {
      return res.status(403).json({ error: 'Not your quest' });
    }

    // Update chainQuestId
    const updatedQuest = await prisma.quest.update({
      where: { id: questId },
      data: {
        chainQuestId: BigInt(String(chainQuestId))
      }
    });

    logger.info('[QUEST] Chain quest ID updated', {
      wallet,
      questId,
      chainQuestId: chainQuestId.toString()
    });

    res.json({
      success: true,
      quest: {
        id: updatedQuest.id,
        chainQuestId: updatedQuest.chainQuestId?.toString() ?? null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update chain quest ID';
    logger.error('Update chain quest ID failed', error, { wallet, questId });
    res.status(500).json({ error: message });
  }
}

export async function getQuestById(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const { questId } = req.params;

  if (!questId) {
    return res.status(400).json({ error: 'Quest ID is required' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { wallet: normalizeWallet(wallet ?? '') }
    });

    const quest = await prisma.quest.findUnique({
      where: { id: questId },
      include: { player: true }
    });

    if (!quest) {
      return res.status(404).json({ error: 'Quest not found' });
    }

    // Allow access if user is the player or if it's a public quest
    if (quest.playerId && user?.id !== quest.playerId) {
      return res.status(403).json({ error: 'Not your quest' });
    }

    const questData = formatQuestResponse(quest);

    res.json({
      success: true,
      quest: questData
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch quest';
    logger.error('Get quest failed', error, { questId });
    res.status(500).json({ error: message });
  }
}

function formatQuestResponse(quest: Quest) {
  return {
    id: quest.id,
    orchestrationId: quest.orchestrationId,
    status: quest.status,
    chainQuestId: quest.chainQuestId?.toString() ?? null,
    title: quest.title,
    description: quest.description,
    objective: quest.objective,
    lore: quest.lore,
    questType: quest.questType,
    difficulty: quest.difficulty,
    rewardAmount: quest.rewardAmount,
    xpReward: quest.xpReward,
    durationSeconds: quest.durationSeconds,
    expiresAt: quest.expiresAt?.toISOString(),
    metadata: quest.metadata,
    proofTx: quest.proofTx,
    playerId: quest.playerId
  };
}

export async function getRealtimeBootstrap(req: Request, res: Response) {
  const wallet = req.auth?.wallet;

  try {
    // Get recently created quests (last hour) for the realtime feed
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const quests = await prisma.quest.findMany({
      where: {
        createdAt: {
          gte: oneHourAgo
        },
        status: {
          in: ['AVAILABLE', 'ACCEPTED', 'COMPLETED', 'CLAIMABLE', 'REWARDED']
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    const questIds = quests.map((quest) => quest.id);
    const latestProofByQuestId = await loadLatestProofStateByQuestIds(questIds);
    const payouts = questIds.length
      ? await prisma.$queryRaw<TreasuryPayoutRow[]>(
          Prisma.sql`
            SELECT
              "questId",
              "chainQuestId",
              "playerWallet",
              "rewardAmount",
              "stakeAmount",
              "totalAmount",
              status::text AS status,
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
            FROM "TreasuryPayout"
            WHERE "questId" IN (${Prisma.join(questIds)})
          `
        )
      : [];

    const payoutsByQuestId = new Map(payouts.map((payout) => [payout.questId, payout]));

    res.json({
      quests: quests.map((quest) =>
        serializeQuest({
          ...quest,
          treasuryPayout: payoutsByQuestId.get(quest.id) || null,
          ...(latestProofByQuestId.get(quest.id)
            ? {
                verificationResult: latestProofByQuestId.get(quest.id)?.verificationResult ?? null,
                verificationReason: latestProofByQuestId.get(quest.id)?.verificationReason ?? null,
                lastProofSubmittedAt: latestProofByQuestId.get(quest.id)?.submittedAt ?? null,
                lastProofVerifiedAt: latestProofByQuestId.get(quest.id)?.verifiedAt ?? null
              }
            : {})
        })
      ),
      total: quests.length
    });
  } catch (error) {
    logger.error('Realtime bootstrap lookup failed', error, { wallet });
    res.status(500).json({ error: 'Unable to load realtime bootstrap' });
  }
}

export async function createOnchainQuest(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const { questId } = req.params;

  if (!wallet || !questId) {
    return res.status(400).json({
      error: 'Wallet and questId are required'
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { wallet: normalizeWallet(wallet) }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const quest = await prisma.quest.findUnique({
      where: { id: questId }
    });

    if (!quest) {
      return res.status(404).json({ error: 'Quest not found' });
    }

    if (quest.playerId !== user.id) {
      return res.status(403).json({ error: 'Not your quest' });
    }

    // If quest already has chainQuestId, return it
    if (quest.chainQuestId) {
      return res.json({
        success: true,
        chainQuestId: quest.chainQuestId.toString()
      });
    }

    // Create quest on blockchain using backend signer
    if (!contracts.forgeQuestManagerWrite) {
      return res.status(500).json({ error: 'Blockchain write interface not available' });
    }

    logger.info('[QUEST] Creating quest on blockchain', {
      wallet,
      questId,
      title: quest.title,
      rewardAmount: quest.rewardAmount
    });

    const tx = await contracts.forgeQuestManagerWrite.createQuest(
      quest.title,
      quest.description || 'No description',
      ethers.parseEther(String(quest.rewardAmount || '0')),
      BigInt(String(quest.xpReward || '0')),
      BigInt(86400) // 1 day duration
    );

    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error('Transaction receipt is null');
    }

    logger.info('[QUEST] Transaction confirmed', {
      questId,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber
    });

    // Parse QuestCreated event to extract chainQuestId
    const iface = contracts.forgeQuestManagerInterface;
    let chainQuestId: bigint | null = null;

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === 'QuestCreated') {
          chainQuestId = parsed.args.questId as bigint;
          break;
        }
      } catch {
        // Skip logs that don't parse
      }
    }

    if (!chainQuestId) {
      throw new Error('Failed to extract questId from QuestCreated event');
    }

    logger.info('[QUEST] Quest created on blockchain', {
      questId,
      chainQuestId: chainQuestId.toString()
    });

    // Update database with chainQuestId
    const updatedQuest = await prisma.quest.update({
      where: { id: questId },
      data: {
        chainQuestId: chainQuestId
      }
    });

    res.json({
      success: true,
      chainQuestId: updatedQuest.chainQuestId?.toString() ?? null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create quest on blockchain';
    logger.error('[QUEST] Create onchain quest failed', error, { wallet, questId });
    res.status(500).json({ error: message });
  }
}

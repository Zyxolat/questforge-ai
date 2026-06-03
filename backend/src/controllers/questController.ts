import { Request, Response } from 'express';
import { Prisma, type QuestStatus } from '@prisma/client';
import { aiQuestGenerationEngine } from '../services/aiQuestGenerationEngine';
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
import { npcRelationshipEngine } from '../services/npcRelationshipEngine';
import { QuestGenerationError } from '../services/questGenerationErrors';
import { questNarrativeEngine } from '../services/questNarrativeEngine';
import { QuestValidationError } from '../services/questValidationEngine';
import { realtimeEventPublisher } from '../services/realtimeEventPublisher';
import { queueProofVerification } from '../services/verification';
import { worldStateCoordinator } from '../services/worldStateCoordinator';

const QUEST_FEED_STATUSES: QuestStatus[] = ['AVAILABLE', 'ACTIVE', 'SUBMITTED', 'VERIFIED', 'CANCELLED', 'FAILED'];

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

async function loadSerializedQuestById(questId: string) {
  const quest = await prisma.quest.findUnique({
    where: { id: questId }
  });

  if (!quest) {
    return null;
  }

  const treasuryPayout = await prisma.treasuryPayout.findUnique({
    where: { questId }
  });

  return serializeQuest({
    ...quest,
    treasuryPayout
  });
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

  logger.info('[QUEST] Generate quest request received', {
    wallet,
    userId: req.auth?.userId ?? null,
    chain,
    hasAccessToken: Boolean(req.get('authorization'))
  });

  try {
    const user = await upsertUser(normalizeWallet(wallet));
    const dailyLimits = await checkDailyLimits(user.id);

    if (!dailyLimits.canAttempt) {
      return res.status(429).json({
        error: {
          code: 'QUEST_DAILY_LIMIT_REACHED',
          message: dailyLimits.reason || 'Daily quest generation limit reached'
        },
        remaining: dailyLimits.remaining
      });
    }

    const generated = await aiQuestGenerationEngine.generateQuest({ wallet, chain });

    await incrementDailyActivity(user.id, { questsAttempted: 1 });
    const activitySnapshot = await getDailyActivity(user.id);

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
    if (error instanceof QuestGenerationError) {
      logger.warn('[QUEST] Generate quest request failed with structured service error', {
        wallet,
        code: error.code,
        status: error.status,
        details: error.details
      });
      return res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message
        },
        details: error.details
      });
    }

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
    res.status(500).json({
      error: {
        code: 'QUEST_GENERATION_FAILED',
        message: 'Quest generation failed unexpectedly'
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

    const updatedQuest = await prisma.$transaction(async (tx) => {
      const nextQuest = await tx.quest.update({
        where: { id: questId },
        data: {
          chainQuestId: parsedChainQuestId,
          status: 'AVAILABLE'
        }
      });

      await tx.treasuryPayout.upsert({
        where: { questId },
        create: {
          questId,
          chainQuestId: parsedChainQuestId,
          rewardAmount: quest.rewardAmount,
          stakeAmount: 0,
          totalAmount: quest.rewardAmount,
          status: 'RESERVED',
          reservationTx: creationTxHash,
          rewardReservedAt
        },
        update: {
          chainQuestId: parsedChainQuestId,
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

export async function registerQuestStart(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const { questId, chainQuestId, startTxHash } = req.body as {
    questId?: string;
    chainQuestId?: string | number;
    startTxHash?: string;
  };

  if (!wallet || !questId || !chainQuestId || !startTxHash) {
    return res.status(400).json({
      error: {
        code: 'QUEST_START_REGISTRATION_INVALID',
        message: 'Wallet, questId, chainQuestId, and startTxHash are required'
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
    logger.info('[QUEST] Register quest start request received', {
      wallet: normalizedWallet,
      questId,
      chainQuestId: parsedChainQuestId.toString(),
      startTxHash
    });

    const [user, quest] = await Promise.all([
      prisma.user.findUnique({
        where: { wallet: normalizedWallet }
      }),
      prisma.quest.findUnique({
        where: { id: questId }
      })
    ]);

    if (!user) {
      return res.status(404).json({
        error: {
          code: 'QUEST_PLAYER_NOT_FOUND',
          message: 'Player not found'
        }
      });
    }

    if (!quest) {
      return res.status(404).json({
        error: {
          code: 'QUEST_NOT_FOUND',
          message: 'Quest not found'
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

    const receipt = await contracts.provider.getTransactionReceipt(startTxHash);
    logger.info('[QUEST] Register quest start receipt fetched', {
      questId,
      chainQuestId: parsedChainQuestId.toString(),
      startTxHash,
      receiptStatus: receipt?.status ?? null,
      blockNumber: receipt?.blockNumber ?? null,
      logs: summarizeForgeQuestReceipt(receipt)
    });

    if (!receipt || receipt.status !== 1) {
      return res.status(409).json({
        error: {
          code: 'QUEST_START_TX_UNCONFIRMED',
          message: 'Quest start transaction is not confirmed onchain yet'
        }
      });
    }

    const parsedQuestStarted = parseForgeQuestReceiptEvent(receipt, 'QuestStarted');

    if (!parsedQuestStarted) {
      return res.status(409).json({
        error: {
          code: 'QUEST_START_EVENT_MISSING',
          message: 'Quest start transaction did not emit QuestStarted'
        }
      });
    }

    const eventQuestId = BigInt(parsedQuestStarted.args.questId.toString());
    const eventPlayer = normalizeWallet(String(parsedQuestStarted.args.player));
    const stakeAmount = Number(parsedQuestStarted.args.stakeAmount.toString()) / 1e18;

    if (eventQuestId !== parsedChainQuestId) {
      return res.status(409).json({
        error: {
          code: 'QUEST_CHAIN_ID_MISMATCH',
          message: 'QuestStarted event quest id did not match the provided chainQuestId'
        },
        details: [
          `event=${eventQuestId.toString()}`,
          `received=${parsedChainQuestId.toString()}`
        ]
      });
    }

    if (eventPlayer !== normalizedWallet) {
      return res.status(403).json({
        error: {
          code: 'QUEST_PLAYER_MISMATCH',
          message: 'QuestStarted event player did not match the authenticated wallet'
        }
      });
    }

    const onchainQuest = await contracts.forgeQuestManager.quests(parsedChainQuestId);
    if (Number(onchainQuest.status) !== 1) {
      return res.status(409).json({
        error: {
          code: 'QUEST_ONCHAIN_STATUS_INVALID',
          message: `Onchain quest status is ${onchainQuest.status.toString()}, not ACTIVE`
        }
      });
    }

    if (normalizeWallet(String(onchainQuest.player)) !== normalizedWallet) {
      return res.status(409).json({
        error: {
          code: 'QUEST_ONCHAIN_PLAYER_INVALID',
          message: 'Onchain quest player did not match the authenticated wallet'
        }
      });
    }

    const block = await contracts.provider.getBlock(receipt.blockNumber);
    const startedAt = block ? new Date(Number(block.timestamp) * 1000) : new Date();

    await prisma.$transaction(async (tx) => {
      await tx.quest.update({
        where: { id: questId },
        data: {
          chainQuestId: parsedChainQuestId,
          status: 'ACTIVE',
          playerId: user.id,
          startedAt,
          stakeTx: startTxHash,
          stakeTxHash: startTxHash
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
          stakeAmount,
          totalAmount: quest.rewardAmount + stakeAmount,
          status: 'LOCKED'
        },
        update: {
          userId: user.id,
          chainQuestId: parsedChainQuestId,
          playerWallet: normalizedWallet,
          rewardAmount: quest.rewardAmount,
          stakeAmount,
          totalAmount: quest.rewardAmount + stakeAmount,
          status: 'LOCKED'
        }
      });
    });

    const serializedQuest = await loadSerializedQuestById(questId);

    logger.info('[QUEST] Quest start registration DB persistence verified', {
      questId,
      chainQuestId: serializedQuest?.chainQuestId ?? null,
      status: serializedQuest?.status ?? null,
      treasuryPayoutStatus: serializedQuest?.treasuryPayout?.status ?? null
    });

    logger.info('[QUEST] Quest start registration completed', {
      wallet: normalizedWallet,
      userId: user.id,
      questId,
      chainQuestId: parsedChainQuestId.toString(),
      startTxHash,
      stakeAmount
    });

    return res.json({
      success: true,
      quest: serializedQuest
    });
  } catch (error) {
    logger.error('Quest start registration failed', error, {
      wallet: normalizedWallet,
      questId,
      chainQuestId: String(chainQuestId),
      startTxHash
    });

    return res.status(500).json({
      error: {
        code: 'QUEST_START_REGISTRATION_FAILED',
        message: error instanceof Error ? error.message : 'Failed to register quest start'
      }
    });
  }
}

export async function getQuestOrchestrationDiagnostics(_req: Request, res: Response) {
  try {
    const worldState = await worldStateCoordinator.getCurrentWorldState('diagnostics');
    res.json({
      orchestration: aiQuestGenerationEngine.getDiagnostics(),
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

      dialogue = await questNarrativeEngine.generateNPCDialogue({
        playerName,
        npc: {
          npcId: npc.id,
          name: npc.name,
          type: npc.type,
          role:
            typeof npc.personality === 'object' && npc.personality && !Array.isArray(npc.personality)
              ? String((npc.personality as Record<string, unknown>).role ?? 'lore_keeper')
              : 'lore_keeper',
          relationshipScore: Number((memory?.importanceScore ?? 0.5).toFixed(3)),
          personalitySummary:
            typeof npc.personality === 'object' && npc.personality && !Array.isArray(npc.personality)
              ? JSON.stringify(npc.personality).slice(0, 160)
              : 'measured and observant',
          openingDialogue: '',
          memoryReferences: memory ? [memory.memory] : [`guild=${user.clanId ?? 'none'}`, `streak=${user.streak}`]
        },
        worldState,
        relationshipSummary: memory ? [memory.memory] : [`successes=${user.totalQuestsCompleted}`, `streak=${user.streak}`]
      });

      const conversation = await prisma.nPCConversation.create({
        data: {
          userId: user.id,
          npcId: npc.id,
          messages: [{ role: 'npc', content: dialogue }, { role: 'player', content: `Hello ${playerName}` }]
        }
      });

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

      await realtimeEventPublisher.publish({
        replayKey: `npc-dialogue:${conversation.id}`,
        eventName: 'npc:interaction-updated',
        sourceType: 'npc_dialogue',
        sourceId: conversation.id,
        payload: {
          wallet: normalizeWallet(wallet),
          npcId: npc.id,
          npcName: npc.name,
          dialogue,
          timestamp: new Date().toISOString()
        },
        scopes: [
          { type: 'user', key: normalizeWallet(wallet) },
          { type: 'global', key: 'global' }
        ]
      });
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
  const { questId, proofUri, submissionTxHash } = req.body;

  if (!wallet || !questId || !proofUri || !submissionTxHash) {
    return res.status(400).json({ error: 'Wallet, questId, proofUri, and submissionTxHash are required' });
  }

  if (typeof proofUri !== 'string' || proofUri.length === 0 || proofUri.length > 2048) {
    return res.status(400).json({ error: 'Proof URI must be a non-empty transaction hash or explorer URL' });
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

    if (!quest.chainQuestId) {
      return res.status(409).json({ error: 'Quest has not been indexed with its onchain id yet' });
    }

    if (quest.status !== 'ACTIVE' && quest.status !== 'SUBMITTED') {
      return res.status(400).json({ error: `Quest status is ${quest.status}` });
    }

    if (quest.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Quest has expired' });
    }

    const queued = await queueProofVerification({
      userId: user.id,
      questId,
      proofUri,
      submissionTxHash
    });

    res.status(202).json({
      success: true,
      questId,
      proofHash: queued.proofHash,
      proofSubmissionId: queued.proofSubmissionId,
      verificationStatus: 'pending',
      message: 'Proof queued for deterministic verification'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to queue proof verification';
    logger.error('Proof submission queueing failed', error, {
      wallet,
      questId
    });
    res.status(400).json({ error: message });
  }
}

import { Request, Response } from 'express';
import { Prisma, type QuestStatus } from '@prisma/client';
import { aiQuestGenerationEngine } from '../services/aiQuestGenerationEngine';
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

function serializeMaybeBigInt(value: bigint | string | null | undefined) {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value ?? null;
}

function serializeQuest<
  T extends {
    chainQuestId?: bigint | null;
    treasuryPayout?: { chainQuestId: bigint | string } | null;
  }
>(quest: T) {
  return {
    ...quest,
    chainQuestId: serializeMaybeBigInt(quest.chainQuestId),
    treasuryPayout: quest.treasuryPayout
      ? {
          ...quest.treasuryPayout,
          chainQuestId: serializeMaybeBigInt(quest.treasuryPayout.chainQuestId)
        }
      : null
  };
}

export async function generateQuest(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const chain = req.body.chain || 'Celo';

  if (!wallet) {
    return res.status(400).json({ error: 'Wallet is required' });
  }

  try {
    const user = await upsertUser(normalizeWallet(wallet));
    const dailyLimits = await checkDailyLimits(user.id);

    if (!dailyLimits.canAttempt) {
      return res.status(429).json({
        error: dailyLimits.reason,
        remaining: dailyLimits.remaining
      });
    }

    const generated = await aiQuestGenerationEngine.generateQuest({ wallet, chain });

    await incrementDailyActivity(user.id, { questsAttempted: 1 });
    const activitySnapshot = await getDailyActivity(user.id);

    res.json({
      quest: {
        id: generated.quest.id,
        orchestrationId: generated.quest.orchestrationId,
        title: generated.quest.title,
        description: generated.quest.description,
        difficulty: generated.quest.difficulty,
        questType: generated.quest.questType,
        objective: generated.quest.objective,
        lore: generated.quest.lore,
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
      return res.status(400).json({
        error: error.message,
        details: error.details
      });
    }

    logger.error('Quest generation failed', error, {
      wallet
    });
    res.status(500).json({ error: 'Failed to generate quest' });
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
          treasuryPayout: payoutsByQuestId.get(quest.id) || null
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

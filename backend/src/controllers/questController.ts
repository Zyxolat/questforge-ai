import { Request, Response } from 'express';
import { generateNPCDialogue, generateQuestPrompt } from '../services/openai';
import { normalizeWallet, prisma, upsertUser } from '../services/chain';
import {
  calculateStreakMultiplier,
  checkDailyLimits,
  getDailyActivity,
  getUserAntiAbuseState,
  incrementDailyActivity,
  QUEST_CONFIG,
  validateRewardBounds
} from '../services/antiAbuse';
import { buildQuestTemplate } from '../services/questTemplates';
import { logger } from '../services/logger';
import { queueProofVerification } from '../services/verification';

const ACTIVE_QUEST_STATUSES = ['ACTIVE', 'SUBMITTED'] as const;

type QuestMetadataPayload = {
  version: 'questforge.quest.v2';
  title: string;
  description: string;
  difficulty: number;
  questType: string;
  objective: string;
  lore: string;
  validationRules: string[];
  chain: string;
  verification: {
    type: 'native_transfer' | 'contract_call' | 'token_approval';
    questType: string;
    minValueCelo: number;
    allowContractTarget: boolean;
    requireContractCall: boolean;
    requireTokenApproval: boolean;
  };
};

function getMaxDifficultyForLevel(level: number) {
  if (level >= QUEST_CONFIG.MIN_LEVEL_FOR_DIFFICULTY[5]) return 5;
  if (level >= QUEST_CONFIG.MIN_LEVEL_FOR_DIFFICULTY[4]) return 4;
  if (level >= QUEST_CONFIG.MIN_LEVEL_FOR_DIFFICULTY[3]) return 3;
  if (level >= QUEST_CONFIG.MIN_LEVEL_FOR_DIFFICULTY[2]) return 2;
  return 1;
}

function selectDifficultyForUser(level: number) {
  return Math.min(3, getMaxDifficultyForLevel(level));
}

function computeQuestEconomy(difficulty: number, streakMultiplier = 1) {
  let stakeAmount = 0.01 + (difficulty - 1) * 0.005;
  let rewardAmount = 0.03 + difficulty * 0.015;
  const xpReward = 150 * difficulty;

  rewardAmount *= streakMultiplier;

  stakeAmount = Math.max(
    QUEST_CONFIG.MIN_SINGLE_STAKE_CELO,
    Math.min(QUEST_CONFIG.MAX_SINGLE_STAKE_CELO, Number(stakeAmount.toFixed(4)))
  );
  rewardAmount = Math.max(0.01, Math.min(QUEST_CONFIG.MAX_SINGLE_REWARD_CELO, Number(rewardAmount.toFixed(4))));

  return {
    stakeAmount,
    rewardAmount,
    xpReward: Math.round(xpReward)
  };
}

function serializeQuest<T extends { chainQuestId?: bigint | null }>(quest: T) {
  return {
    ...quest,
    chainQuestId: typeof quest.chainQuestId === 'bigint' ? quest.chainQuestId.toString() : quest.chainQuestId ?? null
  };
}

function buildQuestMetadataPayload(data: {
  title: string;
  description: string;
  difficulty: number;
  questType: string;
  objective: string;
  lore: string;
  validationRules: string[];
  chain: string;
  verification: QuestMetadataPayload['verification'];
}): QuestMetadataPayload {
  return {
    version: 'questforge.quest.v2',
    title: data.title,
    description: data.description,
    difficulty: data.difficulty,
    questType: data.questType,
    objective: data.objective,
    lore: data.lore,
    validationRules: data.validationRules,
    chain: data.chain,
    verification: data.verification
  };
}

function encodeMetadataUri(metadata: QuestMetadataPayload) {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64')}`;
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

    const antiAbuseState = await getUserAntiAbuseState(user.id);
    const difficulty = selectDifficultyForUser(user.level);
    const streakMultiplier = calculateStreakMultiplier(user.streak, antiAbuseState?.streakDecayFactor ?? 1);
    const economy = computeQuestEconomy(difficulty, streakMultiplier);
    const rewardBounds = validateRewardBounds(economy.stakeAmount, economy.rewardAmount);

    if (!rewardBounds.valid) {
      return res.status(400).json({
        error: 'Quest economy validation failed',
        details: rewardBounds.errors
      });
    }

    const aiQuest = await generateQuestPrompt(wallet, chain, difficulty);
    const template = aiQuest.template;

    await incrementDailyActivity(user.id, { questsAttempted: 1 });
    const activitySnapshot = await getDailyActivity(user.id);

    const metadata = buildQuestMetadataPayload({
      title: aiQuest.data.title || `Forge Mission for ${wallet.slice(0, 8)}`,
      description: aiQuest.data.description || 'A deterministic onchain mission awaits.',
      difficulty,
      questType: template.questType,
      objective: template.objective,
      lore: aiQuest.data.lore || 'The Forge Master demands proof that survives onchain scrutiny.',
      validationRules: template.validationRules,
      chain,
      verification: {
        type: template.type,
        questType: template.questType,
        minValueCelo: template.minValueCelo,
        allowContractTarget: template.allowContractTarget,
        requireContractCall: template.requireContractCall,
        requireTokenApproval: template.requireTokenApproval
      }
    });

    res.json({
      quest: {
        title: metadata.title,
        description: metadata.description,
        difficulty,
        questType: metadata.questType,
        objective: metadata.objective,
        lore: metadata.lore,
        metadata,
        metadataUri: encodeMetadataUri(metadata),
        stakeAmount: economy.stakeAmount,
        rewardAmount: economy.rewardAmount,
        xpReward: economy.xpReward,
        durationSeconds: 60 * 60 * 6,
        status: 'AVAILABLE',
        streakMultiplier: Number(streakMultiplier.toFixed(2)),
        remainingDailyCapacity: {
          quests: Math.max(0, QUEST_CONFIG.MAX_QUESTS_PER_DAY - (activitySnapshot?.questsAttempted || 0)),
          xp: Math.max(0, QUEST_CONFIG.MAX_XP_PER_DAY - (activitySnapshot?.xpEarned || 0)),
          rewards: Math.max(0, QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO - (activitySnapshot?.rewardsEarned || 0))
        }
      }
    });
  } catch (error) {
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

export async function getNPCDialogue(req: Request, res: Response) {
  const npcType = req.query.type?.toString() || 'Guild Master';
  const playerName = req.query.player?.toString() || 'Traveler';
  const wallet = req.query.wallet?.toString();

  try {
    const dialogue = await generateNPCDialogue(npcType, playerName);
    if (wallet) {
      const user = await upsertUser(normalizeWallet(wallet));
      await prisma.nPCConversation.create({
        data: {
          userId: user.id,
          npcType,
          messages: [{ role: 'npc', content: dialogue }, { role: 'player', content: `Hello ${playerName}` }]
        }
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
          { creator: normalizeWallet(wallet), status: { in: [...ACTIVE_QUEST_STATUSES] as Array<'ACTIVE' | 'SUBMITTED'> } },
          { playerId: user.id, status: { in: [...ACTIVE_QUEST_STATUSES] as Array<'ACTIVE' | 'SUBMITTED'> } }
        ]
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      take: 50
    });

    res.json({
      quests: quests.map(serializeQuest),
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

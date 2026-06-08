/**
 * Anti-Abuse and Rate Limiting Service
 * 
 * Implements production-grade anti-spam, anti-farming, and anti-sybil protections.
 * All checks are deterministic and can be audited on-chain.
 */

import { prisma } from './chain';
import { ethers } from 'ethers';
import crypto from 'crypto';

type CooldownRow = {
  cooldownUntil: Date;
  reason: string;
};

type DailyActivityRow = {
  id: string;
  userId: string;
  date: string;
  questsAttempted: number;
  questsCompleted: number;
  xpEarned: number;
  rewardsEarned: number;
  createdAt: Date;
  updatedAt: Date;
};

type ProofSubmissionRow = {
  id: string;
  userId: string;
  questId: string;
  proofUri: string;
  proofHash: string;
  submittedAt: Date;
  verifiedAt: Date | null;
  verificationResult: string | null;
  verificationReason: string | null;
};

type AntiAbuseUserState = {
  id: string;
  level: number;
  streakDecayFactor: number;
};

// Constants for anti-abuse
export const QUEST_CONFIG = {
  // Cooldown system
  MIN_QUEST_COOLDOWN_MINUTES: 5, // Minimum time between quests
  FAILURE_COOLDOWN_MINUTES: 15, // Cooldown after quest failure
  SPAM_DETECTION_THRESHOLD: 10, // Quest attempts in 1 hour
  
  // Daily caps
  MAX_QUESTS_PER_DAY: 20,
  MAX_XP_PER_DAY: 3000,
  MAX_REWARDS_PER_DAY_CELO: 5.0,
  
  // Reward scaling
  MAX_SINGLE_REWARD_CELO: 0.5, // Hard cap on single quest reward
  MAX_SINGLE_STAKE_CELO: 10.0, // Hard cap on stake
  MIN_SINGLE_STAKE_CELO: 0.001, // Minimum stake to prevent dust spam
  
  // Progression gates
  MIN_LEVEL_FOR_DIFFICULTY: {
    1: 1,    // Novice
    2: 3,    // Adept
    3: 7,    // Veteran
    4: 15,   // Elite
    5: 30    // Legendary
  },
  
  // Streak and progression
  STREAK_DECAY_PER_FAILURE: 0.1, // 10% multiplier reduction per failure
  STREAK_BONUS_THRESHOLD: 3, // Streak bonus kicks in at 3+ streak
  STREAK_BONUS_MULTIPLIER: 1.15, // 15% bonus to rewards
};

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get SHA256 hash of proof URI
 */
export function hashProofUri(proofUri: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(proofUri.trim().toLowerCase()));
}

/**
 * Check if wallet has active cooldown
 */
export async function checkQuestCooldown(userId: string): Promise<{ active: boolean; untilTime: Date | null; reason: string | null }> {
  const [cooldown] = await prisma.$queryRaw<CooldownRow[]>`
    SELECT "cooldownUntil", reason
    FROM "QuestCooldown"
    WHERE "userId" = ${userId}
    LIMIT 1
  `;

  if (!cooldown) {
    return { active: false, untilTime: null, reason: null };
  }

  const now = new Date();
  if (cooldown.cooldownUntil > now) {
    return {
      active: true,
      untilTime: cooldown.cooldownUntil,
      reason: cooldown.reason
    };
  }

  // Cooldown expired, remove it
  await prisma.$executeRaw`
    DELETE FROM "QuestCooldown"
    WHERE "userId" = ${userId}
  `;
  return { active: false, untilTime: null, reason: null };
}

/**
 * Set cooldown for user
 */
export async function setQuestCooldown(
  userId: string,
  minutesFromNow: number,
  reason: 'quest_failure' | 'spam_prevention' | 'anti_sybil'
): Promise<void> {
  const cooldownUntil = new Date();
  cooldownUntil.setMinutes(cooldownUntil.getMinutes() + minutesFromNow);

  await prisma.$executeRaw`
    INSERT INTO "QuestCooldown" (id, "userId", "cooldownUntil", reason, "createdAt")
    VALUES (${crypto.randomUUID()}, ${userId}, ${cooldownUntil}, ${reason}, ${new Date()})
    ON CONFLICT ("userId")
    DO UPDATE SET "cooldownUntil" = EXCLUDED."cooldownUntil", reason = EXCLUDED.reason
  `;
}

/**
 * Clear cooldown for user
 */
export async function clearQuestCooldown(userId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "QuestCooldown"
    WHERE "userId" = ${userId}
  `;
}

/**
 * Get today's activity for user
 */
export async function getDailyActivity(userId: string, date?: string) {
  const targetDate = date || getTodayDate();
  
  const [activity] = await prisma.$queryRaw<DailyActivityRow[]>`
    SELECT
      id,
      "userId",
      date,
      "questsAttempted",
      "questsCompleted",
      "xpEarned",
      "rewardsEarned",
      "createdAt",
      "updatedAt"
    FROM "DailyActivity"
    WHERE "userId" = ${userId}
      AND date = ${targetDate}
    LIMIT 1
  `;

  return activity ?? null;
}

/**
 * Increment daily activity counters
 */
export async function incrementDailyActivity(
  userId: string,
  delta: {
    questsAttempted?: number;
    questsCompleted?: number;
    xpEarned?: number;
    rewardsEarned?: number;
  },
  date?: string
): Promise<void> {
  const targetDate = date || getTodayDate();

  await prisma.$executeRaw`
    INSERT INTO "DailyActivity" (
      id,
      "userId",
      date,
      "questsAttempted",
      "questsCompleted",
      "xpEarned",
      "rewardsEarned",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${crypto.randomUUID()},
      ${userId},
      ${targetDate},
      ${delta.questsAttempted || 0},
      ${delta.questsCompleted || 0},
      ${delta.xpEarned || 0},
      ${delta.rewardsEarned || 0},
      ${new Date()},
      ${new Date()}
    )
    ON CONFLICT ("userId", date)
    DO UPDATE SET
      "questsAttempted" = "DailyActivity"."questsAttempted" + ${delta.questsAttempted || 0},
      "questsCompleted" = "DailyActivity"."questsCompleted" + ${delta.questsCompleted || 0},
      "xpEarned" = "DailyActivity"."xpEarned" + ${delta.xpEarned || 0},
      "rewardsEarned" = "DailyActivity"."rewardsEarned" + ${delta.rewardsEarned || 0},
      "updatedAt" = ${new Date()}
  `;
}

/**
 * Check daily limits for quest attempt
 */
export async function checkDailyLimits(userId: string): Promise<{
  canAttempt: boolean;
  reason: string | null;
  remaining: { quests: number; xp: number; rewards: number };
}> {
  const activity = await getDailyActivity(userId);

  const questsRemaining = QUEST_CONFIG.MAX_QUESTS_PER_DAY - (activity?.questsAttempted || 0);
  const xpRemaining = QUEST_CONFIG.MAX_XP_PER_DAY - (activity?.xpEarned || 0);
  const rewardsRemaining = QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO - (activity?.rewardsEarned || 0);

  if (questsRemaining <= 0) {
    return {
      canAttempt: false,
      reason: 'Daily quest limit reached',
      remaining: { quests: 0, xp: xpRemaining, rewards: rewardsRemaining }
    };
  }

  if (rewardsRemaining <= 0) {
    return {
      canAttempt: false,
      reason: 'Daily reward limit reached',
      remaining: { quests: questsRemaining, xp: xpRemaining, rewards: 0 }
    };
  }

  return {
    canAttempt: true,
    reason: null,
    remaining: { quests: questsRemaining, xp: xpRemaining, rewards: rewardsRemaining }
  };
}

/**
 * Validate reward amounts against bounds
 */
export function validateRewardBounds(stakeAmount: number, rewardAmount: number): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (stakeAmount < QUEST_CONFIG.MIN_SINGLE_STAKE_CELO && stakeAmount !== 0) {
    errors.push(`Stake below minimum: ${QUEST_CONFIG.MIN_SINGLE_STAKE_CELO} CELO`);
  }

  if (stakeAmount > QUEST_CONFIG.MAX_SINGLE_STAKE_CELO) {
    errors.push(`Stake exceeds maximum: ${QUEST_CONFIG.MAX_SINGLE_STAKE_CELO} CELO`);
  }

  if (rewardAmount > QUEST_CONFIG.MAX_SINGLE_REWARD_CELO) {
    errors.push(`Reward exceeds maximum: ${QUEST_CONFIG.MAX_SINGLE_REWARD_CELO} CELO`);
  }

  if (rewardAmount <= 0) {
    errors.push('Reward must be positive');
  }

  if (stakeAmount > rewardAmount * 2) {
    errors.push('Stake cannot exceed 2x the reward');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Check if difficulty is gated by player level
 */
export function checkProgressionGate(playerLevel: number, difficulty: number): {
  canAttempt: boolean;
  reason: string | null;
} {
  const minLevel = QUEST_CONFIG.MIN_LEVEL_FOR_DIFFICULTY[difficulty as keyof typeof QUEST_CONFIG.MIN_LEVEL_FOR_DIFFICULTY];
  
  if (!minLevel) {
    return { canAttempt: false, reason: 'Invalid difficulty level' };
  }

  if (playerLevel < minLevel) {
    return {
      canAttempt: false,
      reason: `Requires level ${minLevel}, you are level ${playerLevel}`
    };
  }

  return { canAttempt: true, reason: null };
}

/**
 * Check for proof reuse (replay attack prevention)
 */
export async function checkProofReuse(userId: string, proofUri: string, questId: string): Promise<{
  isReuse: boolean;
  previousSubmission: ProofSubmissionRow | null;
}> {
  const proofHash = hashProofUri(proofUri);
  
  const [existingProof] = await prisma.$queryRaw<ProofSubmissionRow[]>`
    SELECT
      id,
      "userId",
      "questId",
      "proofUri",
      "proofHash",
      "submittedAt",
      "verifiedAt",
      "verificationResult",
      "verificationReason"
    FROM "ProofSubmission"
    WHERE "proofHash" = ${proofHash}
    LIMIT 1
  `;

  if (existingProof && existingProof.questId !== questId) {
    // Same proof used for different quest
    return {
      isReuse: true,
      previousSubmission: existingProof
    };
  }

  return { isReuse: false, previousSubmission: null };
}

/**
 * Register proof submission for deduplication
 */
export async function recordProofSubmission(
  userId: string,
  questId: string,
  proofUri: string,
  proofHash?: string
): Promise<void> {
  const hash = proofHash || hashProofUri(proofUri);

  await prisma.$executeRaw`
    INSERT INTO "ProofSubmission" (
      id,
      "userId",
      "questId",
      "proofUri",
      "proofHash",
      "submittedAt",
      "createdAt"
    )
    VALUES (
      ${crypto.randomUUID()},
      ${userId},
      ${questId},
      ${proofUri},
      ${hash},
      ${new Date()},
      ${new Date()}
    )
  `;
}

/**
 * Calculate reward multiplier based on streak
 */
export function calculateStreakMultiplier(streak: number, decayFactor: number = 1.0): number {
  if (streak < QUEST_CONFIG.STREAK_BONUS_THRESHOLD) {
    return decayFactor;
  }

  const bonusStreak = streak - QUEST_CONFIG.STREAK_BONUS_THRESHOLD + 1;
  const bonusMultiplier = 1.0 + (QUEST_CONFIG.STREAK_BONUS_MULTIPLIER - 1.0) * Math.min(bonusStreak / 5, 1); // Cap at 5 streak
  return bonusMultiplier * decayFactor;
}

export async function getUserAntiAbuseState(userId: string): Promise<AntiAbuseUserState | null> {
  const [user] = await prisma.$queryRaw<AntiAbuseUserState[]>`
    SELECT id, level, "streakDecayFactor"
    FROM "User"
    WHERE id = ${userId}
    LIMIT 1
  `;

  return user ?? null;
}

/**
 * Apply streak decay on failure
 */
export async function applyStreakDecay(userId: string): Promise<number> {
  const [user] = await prisma.$queryRaw<AntiAbuseUserState[]>`
    SELECT id, level, "streakDecayFactor"
    FROM "User"
    WHERE id = ${userId}
    LIMIT 1
  `;
  if (!user) throw new Error('User not found');

  const newDecayFactor = Math.max(0.5, user.streakDecayFactor - QUEST_CONFIG.STREAK_DECAY_PER_FAILURE);
  
  await prisma.$executeRaw`
    UPDATE "User"
    SET
      "streakDecayFactor" = ${newDecayFactor},
      "totalQuestsFailed" = "totalQuestsFailed" + 1,
      "lastFailedAt" = ${new Date()}
    WHERE id = ${userId}
  `;

  return newDecayFactor;
}

/**
 * Recovery streak decay (rebuild on successful completion)
 */
export async function recoverStreakDecay(userId: string): Promise<number> {
  const [user] = await prisma.$queryRaw<AntiAbuseUserState[]>`
    SELECT id, level, "streakDecayFactor"
    FROM "User"
    WHERE id = ${userId}
    LIMIT 1
  `;
  if (!user) throw new Error('User not found');

  // Gradual recovery: +0.05 per success (takes 10 successes to recover from 1 failure)
  const newDecayFactor = Math.min(1.0, user.streakDecayFactor + 0.05);
  
  await prisma.$executeRaw`
    UPDATE "User"
    SET
      "streakDecayFactor" = ${newDecayFactor},
      "totalQuestsCompleted" = "totalQuestsCompleted" + 1,
      "lastQuestCompletedAt" = ${new Date()}
    WHERE id = ${userId}
  `;

  return newDecayFactor;
}

/**
 * Comprehensive pre-quest checks
 */
export async function validateQuestAttempt(
  userId: string,
  difficulty: number,
  stakeAmount: number,
  rewardAmount: number
): Promise<{
  allowed: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  // Get user
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    errors.push('User not found');
    return { allowed: false, errors };
  }

  // Check cooldown
  const cooldown = await checkQuestCooldown(userId);
  if (cooldown.active) {
    errors.push(`Active cooldown until ${cooldown.untilTime?.toISOString()}: ${cooldown.reason}`);
  }

  // Check daily limits
  const daily = await checkDailyLimits(userId);
  if (!daily.canAttempt) {
    errors.push(daily.reason || 'Daily limit reached');
  }

  // Check progression gate
  const gate = checkProgressionGate(user.level, difficulty);
  if (!gate.canAttempt) {
    errors.push(gate.reason || 'Level gate failed');
  }

  // Check reward bounds
  const bounds = validateRewardBounds(stakeAmount, rewardAmount);
  if (!bounds.valid) {
    errors.push(...bounds.errors);
  }

  return {
    allowed: errors.length === 0,
    errors
  };
}

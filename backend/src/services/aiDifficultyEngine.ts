/**
 * AI Difficulty Engine
 *
 * Adaptive difficulty is now the authoritative quest-scaling path for quest
 * generation. It remains deterministic and auditable while persisting player
 * adaptation signals into the new agent identity models for later AI systems.
 */

import { Prisma } from '@prisma/client';
import { QUEST_CONFIG } from './antiAbuse';
import { prisma } from './chain';
import { logger } from './logger';

type DifficultyPlayerSnapshot = {
  id: string;
  wallet: string;
  level: number;
  xp: number;
  streak: number;
  onchainActions: number;
  agentId: string | null;
};

type RecentQuestRiskSignal = {
  difficulty: number;
};

type DifficultyMetrics = {
  user: DifficultyPlayerSnapshot;
  level: number;
  xp: number;
  streak: number;
  recentCompletionRate: number;
  failureCount: number;
  onchainActionsCount: number;
  lastQuestDifficulty: number | null;
  riskAppetite: number;
  questsAttemptedToday: number;
  questsCompletedToday: number;
};

type AgentMemoryGraph = {
  lastDifficultyProfile?: {
    difficulty: number;
    reasoning: string;
    recommendedStake: number;
    estimatedDuration: number;
    computedAt: string;
  };
  performance?: {
    completionRate: number;
    failureCount: number;
    streak: number;
    questsAttemptedToday: number;
    questsCompletedToday: number;
  };
  history?: Array<{
    difficulty: number;
    completionRate: number;
    recommendedStake: number;
    computedAt: string;
  }>;
};

export interface DifficultyCalculation {
  difficulty: number;
  reasoning: string;
  stakeBounds: { min: number; max: number };
  rewardBounds: { min: number; max: number };
  recommendedStake: number;
  estimatedDuration: number;
  agentId: string | null;
}

const BASE_STAKE_CELO = 0.01;
const DEFAULT_DURATION_SECONDS = 60 * 60;
const HISTORY_WINDOW = 5;

class AIDifficultyEngine {
  async calculateDifficulty(userId: string): Promise<DifficultyCalculation> {
    try {
      const metrics = await this.gatherPlayerMetrics(userId);
      const difficulty = this.computeDifficulty(metrics);
      const stakeBounds = this.calculateStakeBounds(difficulty, metrics);
      const rewardBounds = this.calculateRewardBounds(difficulty);
      const recommendedStake = this.calculateRecommendedStake(stakeBounds, metrics);
      const estimatedDuration = this.estimateDuration(difficulty, metrics);
      const reasoning = this.generateReasoning(metrics, difficulty);
      const agentId = await this.persistAgentProfile(metrics, {
        difficulty,
        reasoning,
        stakeBounds,
        rewardBounds,
        recommendedStake,
        estimatedDuration
      });

      return {
        difficulty,
        reasoning,
        stakeBounds,
        rewardBounds,
        recommendedStake,
        estimatedDuration,
        agentId
      };
    } catch (error) {
      logger.error('[DIFFICULTY] Calculation error', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown difficulty engine failure'
      });

      return this.getDefaultDifficulty();
    }
  }

  private async gatherPlayerMetrics(userId: string): Promise<DifficultyMetrics> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        wallet: true,
        level: true,
        xp: true,
        streak: true,
        onchainActions: true,
        agentId: true
      }
    });

    const recentQuests = await prisma.quest.findMany({
      where: {
        playerId: userId,
        status: { in: ['VERIFIED', 'FAILED', 'CANCELLED'] }
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        difficulty: true,
        status: true,
        createdAt: true
      }
    });

    const today = new Date().toISOString().split('T')[0];
    const dailyActivity = await prisma.dailyActivity.findUnique({
      where: { userId_date: { userId, date: today } },
      select: {
        questsAttempted: true,
        questsCompleted: true
      }
    });

    const completedRecent = recentQuests.filter((quest) => quest.status === 'VERIFIED').length;
    const recentCompletionRate = recentQuests.length > 0 ? completedRecent / recentQuests.length : 0;

    const failureCount = await prisma.quest.count({
      where: {
        playerId: userId,
        status: 'FAILED',
        failedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    });

    return {
      user,
      level: user.level,
      xp: user.xp,
      streak: user.streak,
      recentCompletionRate,
      failureCount,
      onchainActionsCount: user.onchainActions,
      lastQuestDifficulty: recentQuests[0]?.difficulty ?? null,
      riskAppetite: this.inferRiskAppetite(user, recentQuests, recentCompletionRate),
      questsAttemptedToday: dailyActivity?.questsAttempted ?? 0,
      questsCompletedToday: dailyActivity?.questsCompleted ?? 0
    };
  }

  private computeDifficulty(metrics: DifficultyMetrics): number {
    let difficulty = this.baseDifficultyFromLevel(metrics.level);

    if (metrics.recentCompletionRate >= 0.85) {
      difficulty += 1;
    } else if (metrics.recentCompletionRate > 0 && metrics.recentCompletionRate < 0.35) {
      difficulty -= 1;
    }

    if (metrics.streak >= QUEST_CONFIG.STREAK_BONUS_THRESHOLD + 3) {
      difficulty += 1;
    } else if (metrics.failureCount >= 2 && metrics.streak === 0) {
      difficulty -= 1;
    }

    if (metrics.onchainActionsCount >= 100 && metrics.recentCompletionRate >= 0.6) {
      difficulty += 1;
    }

    if (metrics.questsAttemptedToday >= Math.floor(QUEST_CONFIG.MAX_QUESTS_PER_DAY * 0.6)) {
      difficulty -= 1;
    }

    if (metrics.riskAppetite >= 0.8 && metrics.recentCompletionRate >= 0.75) {
      difficulty += 1;
    }

    difficulty = this.clampDifficulty(difficulty);

    if (metrics.lastQuestDifficulty !== null) {
      difficulty = Math.max(
        metrics.lastQuestDifficulty - 1,
        Math.min(metrics.lastQuestDifficulty + 1, difficulty)
      );
    }

    return this.clampDifficulty(difficulty);
  }

  private baseDifficultyFromLevel(level: number): number {
    const levelMap = QUEST_CONFIG.MIN_LEVEL_FOR_DIFFICULTY;

    if (level >= levelMap[5]) return 5;
    if (level >= levelMap[4]) return 4;
    if (level >= levelMap[3]) return 3;
    if (level >= levelMap[2]) return 2;
    return 1;
  }

  private calculateStakeBounds(
    difficulty: number,
    metrics: DifficultyMetrics
  ): { min: number; max: number } {
    const baseBounds = {
      1: { min: BASE_STAKE_CELO, max: 0.03 },
      2: { min: 0.015, max: 0.06 },
      3: { min: 0.02, max: 0.12 },
      4: { min: 0.03, max: 0.25 },
      5: { min: 0.05, max: 0.5 }
    } as const;

    const baseline = baseBounds[difficulty as keyof typeof baseBounds] ?? baseBounds[3];
    const riskSpread = 0.9 + metrics.riskAppetite * 0.4;
    const fatiguePenalty = metrics.questsAttemptedToday >= 8 ? 0.9 : 1;

    const min = this.roundCelo(Math.max(BASE_STAKE_CELO, baseline.min * fatiguePenalty));
    const max = this.roundCelo(
      Math.min(QUEST_CONFIG.MAX_SINGLE_STAKE_CELO, Math.max(min, baseline.max * riskSpread * fatiguePenalty))
    );

    return { min, max };
  }

  private calculateRewardBounds(difficulty: number): { min: number; max: number } {
    const baseReward = 0.03 + difficulty * 0.015;
    const min = this.roundCelo(Math.max(0.01, baseReward));
    const max = this.roundCelo(Math.min(QUEST_CONFIG.MAX_SINGLE_REWARD_CELO, baseReward * 1.5));

    return { min, max: Math.max(min, max) };
  }

  private calculateRecommendedStake(
    stakeBounds: { min: number; max: number },
    metrics: DifficultyMetrics
  ) {
    const spread = stakeBounds.max - stakeBounds.min;
    const appetiteWeight = Math.min(1, Math.max(0, metrics.riskAppetite));
    return this.roundCelo(stakeBounds.min + spread * appetiteWeight);
  }

  private estimateDuration(difficulty: number, metrics: DifficultyMetrics): number {
    const baseline = {
      1: 15 * 60,
      2: 30 * 60,
      3: 60 * 60,
      4: 2 * 60 * 60,
      5: 4 * 60 * 60
    } as const;

    let duration = baseline[difficulty as keyof typeof baseline] ?? DEFAULT_DURATION_SECONDS;

    if (metrics.recentCompletionRate > 0.85) {
      duration = Math.round(duration * 0.9);
    } else if (metrics.recentCompletionRate > 0 && metrics.recentCompletionRate < 0.35) {
      duration = Math.round(duration * 1.15);
    }

    return Math.max(15 * 60, duration);
  }

  private inferRiskAppetite(
    user: DifficultyPlayerSnapshot,
    recentQuests: RecentQuestRiskSignal[],
    completionRate: number
  ): number {
    let appetite = 0.35;

    appetite += Math.min(user.streak * 0.04, 0.2);
    appetite += Math.min(user.level * 0.015, 0.15);
    appetite += Math.min(user.onchainActions * 0.0025, 0.15);
    appetite += Math.min(completionRate * 0.25, 0.15);

    const recentAverageDifficulty =
      recentQuests.length > 0
        ? recentQuests.reduce((sum, quest) => sum + quest.difficulty, 0) / recentQuests.length
        : 0;

    appetite += Math.min(recentAverageDifficulty * 0.03, 0.1);

    return Math.min(1, Math.max(0, appetite));
  }

  private async persistAgentProfile(
    metrics: DifficultyMetrics,
    calculation: Omit<DifficultyCalculation, 'agentId'>
  ): Promise<string | null> {
    try {
      const now = new Date().toISOString();
      const agentName = `Forge Agent ${metrics.user.wallet.slice(2, 8)}`;
      const personalityVector = [
        this.normalize(metrics.level, 30),
        this.normalize(metrics.xp, 10000),
        metrics.recentCompletionRate,
        metrics.riskAppetite,
        this.normalize(metrics.streak, 10),
        this.normalize(metrics.onchainActionsCount, 250)
      ];

      const agent = await prisma.$transaction(async (tx) => {
        const existing = await tx.agentIdentity.findUnique({
          where: { wallet: metrics.user.wallet },
          select: {
            id: true,
            memoryGraph: true,
            worldStateVersion: true
          }
        });

        const mergedMemoryGraph = this.mergeMemoryGraph(existing?.memoryGraph, metrics, calculation, now);

        const persistedAgent = existing
          ? await tx.agentIdentity.update({
              where: { id: existing.id },
              data: {
                agentName,
                agentDescriptor: 'Adaptive quest difficulty controller for onchain progression pacing.',
                personalityVector,
                memoryGraph: mergedMemoryGraph,
                reputationScore: metrics.recentCompletionRate,
                worldStateVersion: existing.worldStateVersion
              }
            })
          : await tx.agentIdentity.create({
              data: {
                wallet: metrics.user.wallet,
                agentName,
                agentDescriptor: 'Adaptive quest difficulty controller for onchain progression pacing.',
                personalityVector,
                memoryGraph: mergedMemoryGraph,
                reputationScore: metrics.recentCompletionRate,
                worldStateVersion: 1
              }
            });

        if (metrics.user.agentId !== persistedAgent.id) {
          await tx.user.update({
            where: { id: metrics.user.id },
            data: { agentId: persistedAgent.id }
          });
        }

        return persistedAgent;
      });

      return agent.id;
    } catch (error) {
      logger.warn('[DIFFICULTY] Failed to persist agent profile', {
        userId: metrics.user.id,
        error: error instanceof Error ? error.message : 'Unknown agent persistence failure'
      });

      return metrics.user.agentId;
    }
  }

  private mergeMemoryGraph(
    existing: Prisma.JsonValue | null | undefined,
    metrics: DifficultyMetrics,
    calculation: Omit<DifficultyCalculation, 'agentId'>,
    now: string
  ): Prisma.InputJsonValue {
    const current = this.asAgentMemoryGraph(existing);
    const previousHistory = Array.isArray(current.history) ? current.history : [];

    const history = [
      ...previousHistory,
      {
        difficulty: calculation.difficulty,
        completionRate: metrics.recentCompletionRate,
        recommendedStake: calculation.recommendedStake,
        computedAt: now
      }
    ].slice(-HISTORY_WINDOW);

    return {
      ...current,
      lastDifficultyProfile: {
        difficulty: calculation.difficulty,
        reasoning: calculation.reasoning,
        recommendedStake: calculation.recommendedStake,
        estimatedDuration: calculation.estimatedDuration,
        computedAt: now
      },
      performance: {
        completionRate: metrics.recentCompletionRate,
        failureCount: metrics.failureCount,
        streak: metrics.streak,
        questsAttemptedToday: metrics.questsAttemptedToday,
        questsCompletedToday: metrics.questsCompletedToday
      },
      history
    } satisfies AgentMemoryGraph;
  }

  private asAgentMemoryGraph(value: Prisma.JsonValue | null | undefined): AgentMemoryGraph {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as unknown as AgentMemoryGraph;
  }

  private generateReasoning(metrics: DifficultyMetrics, difficulty: number): string {
    const reasons = [`Difficulty ${difficulty}/5 selected from Level ${metrics.level}`];

    if (metrics.streak > 0) {
      reasons.push(`streak ${metrics.streak}`);
    }

    if (metrics.recentCompletionRate > 0) {
      reasons.push(`recent success ${(metrics.recentCompletionRate * 100).toFixed(0)}%`);
    }

    if (metrics.failureCount > 0) {
      reasons.push(`recent failures ${metrics.failureCount}`);
    }

    if (metrics.questsAttemptedToday > 0) {
      reasons.push(`today attempts ${metrics.questsAttemptedToday}`);
    }

    return reasons.join(' | ');
  }

  private getDefaultDifficulty(): DifficultyCalculation {
    return {
      difficulty: 3,
      reasoning: 'Fallback moderate difficulty profile applied',
      stakeBounds: { min: BASE_STAKE_CELO, max: 0.12 },
      rewardBounds: { min: 0.075, max: 0.1125 },
      recommendedStake: 0.04,
      estimatedDuration: DEFAULT_DURATION_SECONDS,
      agentId: null
    };
  }

  private clampDifficulty(value: number) {
    return Math.max(1, Math.min(5, Math.round(value)));
  }

  private roundCelo(value: number) {
    return Number(value.toFixed(4));
  }

  private normalize(value: number, divisor: number) {
    return Math.min(1, Math.max(0, value / divisor));
  }
}

export const aiDifficultyEngine = new AIDifficultyEngine();

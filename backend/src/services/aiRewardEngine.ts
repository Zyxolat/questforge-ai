import { ethers } from 'ethers';
import { QUEST_CONFIG, getDailyActivity } from './antiAbuse';
import { prisma } from './chain';
import { contracts } from './contracts';
import { logger } from './logger';

type ActiveWorldModifier = {
  id: string;
  name: string;
  type: string;
  multiplier: number;
  reward: number;
};

export interface RewardCalculation {
  rewardAmount: number;
  xpReward: number;
  reasoning: string;
  worldMultiplier: number;
  treasuryCap: number;
  activeWorldModifiers: ActiveWorldModifier[];
}

const BASE_REWARD_FLOOR = 0.01;

class AIRewardEngine {
  async calculateRewardProfile(input: {
    userId: string;
    difficulty: number;
    stakeAmount: number;
    streakMultiplier: number;
  }): Promise<RewardCalculation> {
    try {
      const [activity, activeWorldModifiers, treasuryState] = await Promise.all([
        getDailyActivity(input.userId),
        this.loadActiveWorldModifiers(),
        this.loadTreasuryState()
      ]);

      const baseReward = 0.03 + input.difficulty * 0.015;
      const worldMultiplier = this.computeWorldMultiplier(activeWorldModifiers);
      const rewardsRemaining = Math.max(
        BASE_REWARD_FLOOR,
        QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO - (activity?.rewardsEarned ?? 0)
      );

      let rewardAmount = baseReward * input.streakMultiplier * worldMultiplier;
      rewardAmount = this.roundCelo(
        Math.min(
          QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
          rewardsRemaining,
          treasuryState.treasuryCap,
          Math.max(BASE_REWARD_FLOOR, rewardAmount)
        )
      );

      rewardAmount = Math.max(rewardAmount, this.minimumRewardForStake(input.stakeAmount));

      const xpReward = Math.max(
        150,
        Math.round(150 * input.difficulty * Math.min(1.5, 1 + (worldMultiplier - 1) * 0.5))
      );

      return {
        rewardAmount,
        xpReward,
        reasoning: this.buildReasoning({
          baseReward,
          streakMultiplier: input.streakMultiplier,
          worldMultiplier,
          rewardsRemaining,
          treasuryCap: treasuryState.treasuryCap,
          treasuryHealthy: treasuryState.treasuryHealthy
        }),
        worldMultiplier,
        treasuryCap: treasuryState.treasuryCap,
        activeWorldModifiers
      };
    } catch (error) {
      logger.warn('[REWARD] Falling back to deterministic reward profile', {
        userId: input.userId,
        error: error instanceof Error ? error.message : 'Unknown reward engine failure'
      });

      return {
        rewardAmount: this.roundCelo(Math.max(BASE_REWARD_FLOOR, 0.03 + input.difficulty * 0.015)),
        xpReward: 150 * input.difficulty,
        reasoning: 'Fallback deterministic reward profile applied',
        worldMultiplier: 1,
        treasuryCap: QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
        activeWorldModifiers: []
      };
    }
  }

  private async loadActiveWorldModifiers(): Promise<ActiveWorldModifier[]> {
    const now = new Date();

    return prisma.worldEvent.findMany({
      where: {
        isActive: true,
        startTime: { lte: now },
        endTime: { gte: now },
        affectsAllQuests: true
      },
      select: {
        id: true,
        name: true,
        type: true,
        multiplier: true,
        reward: true
      },
      orderBy: { multiplier: 'desc' },
      take: 3
    });
  }

  private async loadTreasuryState(): Promise<{ treasuryCap: number; treasuryHealthy: boolean }> {
    try {
      const [availableLiquidityRaw, isSolvent] = await Promise.all([
        contracts.treasury.availableRewardLiquidity(),
        contracts.treasury.isSolvent()
      ]);

      const availableLiquidity = Number(ethers.formatEther(availableLiquidityRaw));
      const treasuryCap = this.roundCelo(
        Math.min(
          QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
          Math.max(BASE_REWARD_FLOOR, availableLiquidity * 0.05)
        )
      );

      return {
        treasuryCap,
        treasuryHealthy: Boolean(isSolvent)
      };
    } catch (error) {
      logger.warn('[REWARD] Treasury state unavailable, using conservative cap', {
        error: error instanceof Error ? error.message : 'Unknown treasury read failure'
      });

      return {
        treasuryCap: 0.1,
        treasuryHealthy: false
      };
    }
  }

  private computeWorldMultiplier(modifiers: ActiveWorldModifier[]) {
    if (!modifiers.length) {
      return 1;
    }

    const combined = modifiers.reduce((multiplier, modifier) => multiplier * Math.max(1, modifier.multiplier), 1);
    return Number(Math.min(1.5, combined).toFixed(3));
  }

  private minimumRewardForStake(stakeAmount: number) {
    return this.roundCelo(Math.max(BASE_REWARD_FLOOR, stakeAmount * 0.6));
  }

  private buildReasoning(input: {
    baseReward: number;
    streakMultiplier: number;
    worldMultiplier: number;
    rewardsRemaining: number;
    treasuryCap: number;
    treasuryHealthy: boolean;
  }) {
    const reasons = [`base ${this.roundCelo(input.baseReward)} CELO`];

    if (input.streakMultiplier !== 1) {
      reasons.push(`streak x${input.streakMultiplier.toFixed(2)}`);
    }

    if (input.worldMultiplier !== 1) {
      reasons.push(`world x${input.worldMultiplier.toFixed(2)}`);
    }

    reasons.push(`daily remaining ${this.roundCelo(input.rewardsRemaining)} CELO`);
    reasons.push(`treasury cap ${this.roundCelo(input.treasuryCap)} CELO`);

    if (!input.treasuryHealthy) {
      reasons.push('treasury degraded');
    }

    return reasons.join(' | ');
  }

  private roundCelo(value: number) {
    return Number(value.toFixed(4));
  }
}

export const aiRewardEngine = new AIRewardEngine();

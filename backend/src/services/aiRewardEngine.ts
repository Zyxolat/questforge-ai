import { ethers } from 'ethers';
import { QUEST_CONFIG, getDailyActivity } from './antiAbuse';
import { prisma } from './chain';
import { contracts } from './contracts';
import { logger } from './logger';
import { QuestGenerationError } from './questGenerationErrors';

type ActiveWorldModifier = {
  id: string;
  name: string;
  type: string;
  multiplier: number;
  reward: number;
};

export interface RewardCalculation {
  rewardAmount: number;
  rewardBounds: {
    min: number;
    max: number;
  };
  minimumAllowedReward: number;
  maximumAllowedReward: number;
  xpReward: number;
  reasoning: string;
  worldMultiplier: number;
  treasuryCap: number;
  availableRewardLiquidity: number;
  treasuryHealthy: boolean;
  activeWorldModifiers: ActiveWorldModifier[];
}

const BASE_REWARD_FLOOR = 0.01;

class AIRewardEngine {
  async calculateRewardProfile(input: {
    userId: string;
    difficulty: number;
    stakeAmount: number;
    streakMultiplier: number;
    rewardBounds: {
      min: number;
      max: number;
    };
  }): Promise<RewardCalculation> {
    try {
      const [activity, activeWorldModifiers, treasuryState] = await Promise.all([
        getDailyActivity(input.userId),
        this.loadActiveWorldModifiers(),
        this.loadTreasuryState()
      ]);

      const baseReward = 0.03 + input.difficulty * 0.015;
      const worldMultiplier = this.computeWorldMultiplier(activeWorldModifiers);
      const rewardsRemaining = this.roundCelo(
        Math.max(0, QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO - (activity?.rewardsEarned ?? 0))
      );
      const minimumRewardForStake = this.minimumRewardForStake(input.stakeAmount);
      const rewardCeiling = this.roundCelo(
        Math.min(
          QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
          input.rewardBounds.max,
          rewardsRemaining,
          treasuryState.treasuryCap
        )
      );
      const preferredRewardFloor = this.roundCelo(
        Math.max(BASE_REWARD_FLOOR, input.rewardBounds.min, minimumRewardForStake)
      );
      const minimumAllowedReward = this.roundCelo(Math.min(preferredRewardFloor, rewardCeiling));

      if (treasuryState.availableRewardLiquidity <= 0) {
        throw new QuestGenerationError(
          'QUEST_TREASURY_DEPLETED',
          'Quest generation is temporarily unavailable because the reward treasury has no available liquidity.',
          503,
          [
            `Treasury address: ${contracts.treasury.target?.toString() ?? 'unknown'}`,
            `Available reward liquidity: ${treasuryState.availableRewardLiquidity.toFixed(4)} CELO`,
            `Minimum reward required for difficulty ${input.difficulty}: ${baseReward.toFixed(4)} CELO`
          ]
        );
      }

      if (rewardCeiling <= 0) {
        const dailyRewardsEarned = activity?.rewardsEarned ?? 0;
        const reasonDetails = [
          `Reward ceiling: ${rewardCeiling.toFixed(4)} CELO`,
          `Daily rewards earned: ${dailyRewardsEarned.toFixed(4)} / ${QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO.toFixed(4)} CELO`,
          `Treasury reward cap: ${treasuryState.treasuryCap.toFixed(4)} CELO`,
          `Available reward liquidity: ${treasuryState.availableRewardLiquidity.toFixed(4)} CELO`
        ];

        throw new QuestGenerationError(
          dailyRewardsEarned >= QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO
            ? 'QUEST_DAILY_REWARD_CAPACITY_EXHAUSTED'
            : 'QUEST_REWARD_CAPACITY_UNAVAILABLE',
          dailyRewardsEarned >= QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO
            ? 'Quest generation is temporarily unavailable because the remaining daily reward capacity is exhausted.'
            : 'Quest generation is temporarily unavailable because the treasury cannot support any reward.',
          dailyRewardsEarned >= QUEST_CONFIG.MAX_REWARDS_PER_DAY_CELO ? 429 : 503,
          reasonDetails
        );
      }

      let rewardAmount = baseReward * input.streakMultiplier * worldMultiplier;
      rewardAmount = this.roundCelo(Math.max(BASE_REWARD_FLOOR, rewardAmount));

      if (rewardCeiling < preferredRewardFloor) {
        logger.warn('[REWARD] Reward floor adapted to treasury capacity', {
          userId: input.userId,
          stakeAmount: input.stakeAmount,
          preferredRewardFloor,
          minimumAllowedReward,
          rewardCeiling,
          minimumRewardForStake,
          treasuryCap: treasuryState.treasuryCap,
          availableRewardLiquidity: treasuryState.availableRewardLiquidity
        });
      }

      rewardAmount = this.roundCelo(Math.max(minimumAllowedReward, Math.min(rewardAmount, rewardCeiling)));
      const adaptedRewardBounds = {
        min: minimumAllowedReward,
        max: rewardCeiling
      };

      if (
        adaptedRewardBounds.min !== input.rewardBounds.min ||
        adaptedRewardBounds.max !== input.rewardBounds.max
      ) {
        logger.warn('[REWARD] Treasury-constrained reward bounds adapted', {
          userId: input.userId,
          originalBounds: input.rewardBounds,
          adaptedBounds: adaptedRewardBounds,
          rewardAmount,
          treasuryCap: treasuryState.treasuryCap,
          availableRewardLiquidity: treasuryState.availableRewardLiquidity
        });
      }

      const xpReward = Math.max(
        150,
        Math.round(150 * input.difficulty * Math.min(1.5, 1 + (worldMultiplier - 1) * 0.5))
      );

      return {
        rewardAmount,
        rewardBounds: adaptedRewardBounds,
        minimumAllowedReward,
        maximumAllowedReward: rewardCeiling,
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
        availableRewardLiquidity: treasuryState.availableRewardLiquidity,
        treasuryHealthy: treasuryState.treasuryHealthy,
        activeWorldModifiers
      };
    } catch (error) {
      if (error instanceof QuestGenerationError) {
        throw error;
      }

      logger.warn('[REWARD] Falling back to deterministic reward profile', {
        userId: input.userId,
        error: error instanceof Error ? error.message : 'Unknown reward engine failure'
      });

      return {
        rewardAmount: this.roundCelo(Math.max(BASE_REWARD_FLOOR, 0.03 + input.difficulty * 0.015)),
        rewardBounds: {
          min: this.roundCelo(Math.max(BASE_REWARD_FLOOR, 0.03 + input.difficulty * 0.015)),
          max: this.roundCelo(
            Math.min(
              QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
              Math.max(BASE_REWARD_FLOOR, 0.03 + input.difficulty * 0.015) * 1.5
            )
          )
        },
        minimumAllowedReward: this.roundCelo(Math.max(BASE_REWARD_FLOOR, 0.03 + input.difficulty * 0.015)),
        maximumAllowedReward: this.roundCelo(
          Math.min(
            QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
            Math.max(BASE_REWARD_FLOOR, 0.03 + input.difficulty * 0.015) * 1.5
          )
        ),
        xpReward: 150 * input.difficulty,
        reasoning: 'Fallback deterministic reward profile applied',
        worldMultiplier: 1,
        treasuryCap: QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
        availableRewardLiquidity: QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
        treasuryHealthy: false,
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

  private async loadTreasuryState(): Promise<{ treasuryCap: number; availableRewardLiquidity: number; treasuryHealthy: boolean }> {
    try {
      const [availableLiquidityRaw, isSolvent] = await Promise.all([
        contracts.treasury.availableRewardLiquidity(),
        contracts.treasury.isSolvent()
      ]);

      const availableLiquidity = Number(ethers.formatEther(availableLiquidityRaw));
      const treasuryCap = this.roundCelo(
        Math.min(
          QUEST_CONFIG.MAX_SINGLE_REWARD_CELO,
          Math.max(0, availableLiquidity * 0.05)
        )
      );

      return {
        treasuryCap,
        availableRewardLiquidity: availableLiquidity,
        treasuryHealthy: Boolean(isSolvent)
      };
    } catch (error) {
      logger.warn('[REWARD] Treasury state unavailable, using conservative cap', {
        error: error instanceof Error ? error.message : 'Unknown treasury read failure'
      });

      return {
        treasuryCap: 0.1,
        availableRewardLiquidity: 2,
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

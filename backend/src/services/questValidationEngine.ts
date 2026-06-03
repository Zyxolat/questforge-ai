import crypto from 'crypto';
import { aiValidator } from './aiSafety';
import { QUEST_CONFIG, validateRewardBounds } from './antiAbuse';
import { logger } from './logger';
import { buildQuestTemplateForType, type ObjectiveType } from './questTemplates';
import type {
  QuestTxRequirement,
  QuestValidationInput,
  ValidatedQuestOutput
} from './questOrchestrationTypes';

const REQUIRED_TX_STAGES = [
  'createQuest',
  'startQuestStake',
  'gameplay',
  'submitProof',
  'verifierSettlement',
  'rewardPayout',
  'nftMint'
] as const;

export class QuestValidationError extends Error {
  constructor(
    message: string,
    readonly details: string[]
  ) {
    super(message);
    this.name = 'QuestValidationError';
  }
}

class QuestValidationEngine {
  validateGeneratedQuest(input: QuestValidationInput): ValidatedQuestOutput {
    const warnings: string[] = [];
    const errors: string[] = [];

    const primaryType = input.narrative.chainInteraction.primary;
    const verificationTemplate = buildQuestTemplateForType(primaryType, input.wallet, input.difficulty);

    const narrativeCheck = aiValidator.comprehensiveValidation(
      {
        title: input.narrative.title,
        description: input.narrative.description,
        difficulty: input.difficulty,
        type: verificationTemplate.questType,
        objective: verificationTemplate.objective,
        lore: input.narrative.lore,
        validationRules: verificationTemplate.validationRules
      },
      input.wallet
    );

    warnings.push(...narrativeCheck.warnings);
    errors.push(...narrativeCheck.errors);

    if (input.recommendedStake < input.stakeBounds.min || input.recommendedStake > input.stakeBounds.max) {
      warnings.push('Recommended stake fell outside deterministic stake bounds and was normalized');
    }

    const normalizedRewardBounds = this.normalizeRewardBounds(input.rewardBounds, input.treasuryCap);
    const rewardAmount = this.roundCelo(
      Math.max(normalizedRewardBounds.min, Math.min(input.rewardAmount, normalizedRewardBounds.max))
    );

    if (
      normalizedRewardBounds.min !== input.rewardBounds.min ||
      normalizedRewardBounds.max !== input.rewardBounds.max
    ) {
      warnings.push(
        `Reward bounds normalized to ${normalizedRewardBounds.min.toFixed(4)}-${normalizedRewardBounds.max.toFixed(4)} CELO`
      );
    }

    const stakeAmount = this.normalizeStakeAmount(input.stakeBounds, input.recommendedStake, rewardAmount);

    if (rewardAmount !== input.rewardAmount) {
      warnings.push(
        `Reward amount normalized from ${input.rewardAmount.toFixed(4)} CELO to ${rewardAmount.toFixed(4)} CELO`
      );
    }

    if (stakeAmount !== input.recommendedStake) {
      warnings.push(
        `Stake amount normalized from ${input.recommendedStake.toFixed(4)} CELO to ${stakeAmount.toFixed(4)} CELO`
      );
    }

    const rewardBoundsCheck = validateRewardBounds(stakeAmount, rewardAmount);
    if (!rewardBoundsCheck.valid) {
      errors.push(...rewardBoundsCheck.errors);
    }

    this.validateMissionComplexity(input, errors);
    this.validateChainInteraction(input, verificationTemplate.type, errors);
    this.validateVerifierCompatibility(input.narrative.txRequirements, errors);

    const transactionCount = input.narrative.txRequirements.reduce((sum, requirement) => sum + requirement.minimumCount, 0);
    if (transactionCount < REQUIRED_TX_STAGES.length) {
      errors.push('Quest transaction chain does not satisfy the minimum multi-transaction requirement');
    }

    const orchestrationId = crypto.randomUUID();

    if (errors.length > 0) {
      logger.warn('[QUEST-VALIDATION] Validation rejected generated quest', {
        wallet: input.wallet,
        errors,
        warnings
      });
      throw new QuestValidationError('Generated quest failed deterministic validation', errors);
    }

    const metadata = this.buildMetadata(
      orchestrationId,
      input,
      verificationTemplate.type,
      stakeAmount,
      rewardAmount,
      normalizedRewardBounds,
      warnings
    );

    return {
      orchestrationId,
      metadata,
      metadataUri: this.encodeMetadataUri(metadata),
      title: input.narrative.title,
      description: input.narrative.description,
      difficulty: input.difficulty,
      questType: verificationTemplate.questType,
      objective: verificationTemplate.objective,
      lore: input.narrative.lore,
      missionStructure: input.narrative.missionStructure,
      missionObjectives: input.narrative.missionObjectives,
      missionChapters: input.narrative.missionChapters,
      storyline: input.narrative.storyline,
      rewardRationale: input.narrative.rewardRationale,
      stakeAmount,
      rewardAmount,
      xpReward: Math.round(input.xpReward),
      transactionCount,
      requiredTxTypes: input.narrative.txRequirements.map((requirement) => requirement.stage),
      durationSeconds: Math.max(60 * 60, Math.round(input.estimatedDurationSeconds)),
      estimatedDurationSeconds: Math.max(15 * 60, Math.round(input.estimatedDurationSeconds)),
      riskLevel: input.narrative.riskLevel,
      validationWarnings: warnings,
      npc: input.narrative.npc,
      faction: input.narrative.faction,
      worldInfluence: input.narrative.worldInfluence,
      branchingHooks: input.narrative.branchingHooks,
      txRequirements: input.narrative.txRequirements,
      chainInteraction: input.narrative.chainInteraction,
      coOpHooks: input.narrative.coOpHooks,
      loreContinuity: input.narrative.loreContinuity,
      worldStateVersion: input.worldState.version,
      isEventQuest: input.worldState.activeEvents.length > 0,
      generation: input.narrative.generation
    };
  }

  private validateMissionComplexity(input: QuestValidationInput, errors: string[]) {
    if (input.narrative.missionObjectives.length < 3) {
      errors.push('Quest must contain at least three mission objectives');
    }

    if (input.narrative.missionChapters.length < 2) {
      errors.push('Quest must contain at least two mission chapters');
    }

    if (input.narrative.branchingHooks.length < 1) {
      errors.push('Quest must include at least one branching hook');
    }

    const gameplayObjectives = input.narrative.missionObjectives.filter((objective) => objective.stage === 'gameplay');
    if (gameplayObjectives.length < 1) {
      errors.push('Quest must contain a gameplay objective tied to verifier-compatible execution');
    }

    const loreContinuity = input.narrative.loreContinuity.filter(Boolean);
    if (loreContinuity.length < 1) {
      errors.push('Lore continuity references are required for persistent quest generation');
    }
  }

  private validateChainInteraction(
    input: QuestValidationInput,
    verifierType: ObjectiveType,
    errors: string[]
  ) {
    const interaction = input.narrative.chainInteraction;
    const allowedTargets = new Set(['wallet', 'contract', 'token']);
    const invalidTarget = interaction.allowedTargets.find((target) => !allowedTargets.has(target));
    if (invalidTarget) {
      errors.push(`Unsupported chain interaction target: ${invalidTarget}`);
    }

    if (interaction.primary !== verifierType) {
      errors.push('Primary chain interaction must match the verifier template type');
    }

    if (interaction.primary === 'native_transfer') {
      if (interaction.requireContractCall || interaction.requireTokenApproval) {
        errors.push('Native transfer quests cannot require contract calls or token approvals');
      }

      if (!interaction.allowedTargets.includes('wallet')) {
        errors.push('Native transfer quests must target wallets');
      }
    }

    if (interaction.primary === 'token_approval' && !interaction.requireTokenApproval) {
      errors.push('Token approval quests must require token approval receipts');
    }

    if (interaction.primary !== 'native_transfer' && !interaction.requireContractCall) {
      errors.push('Contract-based quests must require a contract call');
    }
  }

  private validateVerifierCompatibility(txRequirements: QuestTxRequirement[], errors: string[]) {
    const stageMap = new Map(txRequirements.map((requirement) => [requirement.stage, requirement]));

    REQUIRED_TX_STAGES.forEach((stage) => {
      const requirement = stageMap.get(stage);
      if (!requirement) {
        errors.push(`Missing required transaction stage: ${stage}`);
        return;
      }

      if (requirement.minimumCount < 1) {
        errors.push(`Transaction stage ${stage} must require at least one transaction`);
      }

      if (!requirement.verifierCompatible) {
        errors.push(`Transaction stage ${stage} is not marked verifier compatible`);
      }
    });
  }

  private normalizeRewardBounds(
    rewardBounds: QuestValidationInput['rewardBounds'],
    treasuryCap: number
  ) {
    const max = this.roundCelo(Math.max(0, Math.min(rewardBounds.max, treasuryCap)));
    const min = this.roundCelo(Math.min(Math.max(0.01, rewardBounds.min), max));

    return { min, max };
  }

  private normalizeStakeAmount(
    stakeBounds: QuestValidationInput['stakeBounds'],
    recommendedStake: number,
    rewardAmount: number
  ) {
    const boundedStake = this.roundCelo(Math.max(stakeBounds.min, Math.min(stakeBounds.max, recommendedStake)));
    const rewardConstrainedStake = this.roundCelo(
      Math.max(
        QUEST_CONFIG.MIN_SINGLE_STAKE_CELO,
        Math.min(boundedStake, rewardAmount * 2)
      )
    );

    return rewardConstrainedStake;
  }

  private buildMetadata(
    orchestrationId: string,
    input: QuestValidationInput,
    verifierType: ObjectiveType,
    stakeAmount: number,
    rewardAmount: number,
    rewardBounds: { min: number; max: number },
    warnings: string[]
  ) {
    const verificationTemplate = buildQuestTemplateForType(verifierType, input.wallet, input.difficulty);

    return {
      version: 'questforge.quest.v3',
      orchestrationId,
      title: input.narrative.title,
      description: input.narrative.description,
      difficulty: input.difficulty,
      questType: verificationTemplate.questType,
      objective: verificationTemplate.objective,
      lore: input.narrative.lore,
      validationRules: verificationTemplate.validationRules,
      chain: input.chain,
      verification: {
        type: verificationTemplate.type,
        questType: verificationTemplate.questType,
        minValueCelo:
          verifierType === 'native_transfer'
            ? Math.max(verificationTemplate.minValueCelo, input.narrative.chainInteraction.minValueCelo)
            : verificationTemplate.minValueCelo,
        allowContractTarget: verificationTemplate.allowContractTarget,
        requireContractCall: verificationTemplate.requireContractCall,
        requireTokenApproval: verificationTemplate.requireTokenApproval
      },
      adaptive: {
        reasoning: input.difficultyReasoning,
        stakeBounds: input.stakeBounds,
        rewardBounds,
        recommendedStake: stakeAmount,
        recommendedReward: rewardAmount,
        estimatedDurationSeconds: input.estimatedDurationSeconds,
        agentId: input.agentId
      },
      economy: {
        rewardReasoning: input.rewardReasoning,
        worldMultiplier: input.worldMultiplier,
        treasuryCap: input.treasuryCap,
        activeWorldModifiers: input.activeWorldModifiers
      },
      generation: input.narrative.generation,
      orchestration: {
        missionStructure: input.narrative.missionStructure,
        missionObjectives: input.narrative.missionObjectives,
        missionChapters: input.narrative.missionChapters,
        storyline: input.narrative.storyline,
        txRequirements: input.narrative.txRequirements,
        rewardRationale: input.narrative.rewardRationale,
        riskLevel: input.narrative.riskLevel,
        branchingHooks: input.narrative.branchingHooks,
        loreContinuity: input.narrative.loreContinuity,
        coOpHooks: input.narrative.coOpHooks,
        chainInteraction: input.narrative.chainInteraction,
        faction: input.narrative.faction,
        worldInfluence: input.narrative.worldInfluence,
        npc: input.narrative.npc,
        validationWarnings: warnings,
        diagnostics: {
          validatedAt: new Date().toISOString(),
          transactionCount: input.narrative.txRequirements.reduce((sum, requirement) => sum + requirement.minimumCount, 0)
        }
      },
      worldStateVersion: input.worldState.version,
      requiredTxTypes: input.narrative.txRequirements.map((requirement) => requirement.stage),
      transactionCount: input.narrative.txRequirements.reduce((sum, requirement) => sum + requirement.minimumCount, 0)
    } satisfies Record<string, unknown>;
  }

  private encodeMetadataUri(metadata: Record<string, unknown>) {
    const onchainMetadata = this.compactMetadataForOnchain(metadata);
    return `data:application/json;base64,${Buffer.from(JSON.stringify(onchainMetadata), 'utf8').toString('base64')}`;
  }

  private compactMetadataForOnchain(metadata: Record<string, unknown>) {
    const orchestration =
      metadata.orchestration && typeof metadata.orchestration === 'object' && !Array.isArray(metadata.orchestration)
        ? (metadata.orchestration as Record<string, unknown>)
        : null;
    const generation =
      metadata.generation && typeof metadata.generation === 'object' && !Array.isArray(metadata.generation)
        ? (metadata.generation as Record<string, unknown>)
        : null;
    const adaptive =
      metadata.adaptive && typeof metadata.adaptive === 'object' && !Array.isArray(metadata.adaptive)
        ? (metadata.adaptive as Record<string, unknown>)
        : null;

    return {
      version: metadata.version,
      orchestrationId: metadata.orchestrationId,
      title: metadata.title,
      questType: metadata.questType,
      objective: metadata.objective,
      chain: metadata.chain,
      difficulty: metadata.difficulty,
      worldStateVersion: metadata.worldStateVersion,
      requiredTxTypes: metadata.requiredTxTypes,
      transactionCount: metadata.transactionCount,
      verification:
        metadata.verification && typeof metadata.verification === 'object' && !Array.isArray(metadata.verification)
          ? {
              type: (metadata.verification as Record<string, unknown>).type,
              questType: (metadata.verification as Record<string, unknown>).questType,
              minValueCelo: (metadata.verification as Record<string, unknown>).minValueCelo,
              allowContractTarget: (metadata.verification as Record<string, unknown>).allowContractTarget,
              requireContractCall: (metadata.verification as Record<string, unknown>).requireContractCall,
              requireTokenApproval: (metadata.verification as Record<string, unknown>).requireTokenApproval
            }
          : undefined,
      generation: generation
        ? {
            source: generation.source,
            provider: generation.provider,
            model: generation.model,
            promptHash: generation.promptHash
          }
        : undefined,
      adaptive: adaptive
        ? {
            recommendedStake: adaptive.recommendedStake,
            recommendedReward: adaptive.recommendedReward,
            estimatedDurationSeconds: adaptive.estimatedDurationSeconds
          }
        : undefined,
      orchestration: orchestration
        ? {
            riskLevel: orchestration.riskLevel,
            validationWarnings: orchestration.validationWarnings,
            txRequirements: Array.isArray(orchestration.txRequirements)
              ? orchestration.txRequirements.slice(0, 2)
              : undefined
          }
        : undefined
    } satisfies Record<string, unknown>;
  }

  private roundCelo(value: number) {
    return Number(value.toFixed(4));
  }
}

export const questValidationEngine = new QuestValidationEngine();

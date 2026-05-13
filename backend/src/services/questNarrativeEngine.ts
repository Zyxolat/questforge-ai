import OpenAI from 'openai';
import { env } from '../config/env';
import { aiValidator } from './aiSafety';
import { logger } from './logger';
import type {
  QuestChainInteractionPattern,
  PlayerQuestProfile,
  QuestBranchingHook,
  QuestChapterDraft,
  QuestNarrativeDraft,
  QuestNpcDraft,
  QuestObjectiveDraft,
  QuestTxRequirement,
  WorldStateSnapshotData
} from './questOrchestrationTypes';

type NarrativeContext = {
  wallet: string;
  chain: string;
  difficulty: number;
  rewardAmount: number;
  stakeAmount: number;
  playerProfile: PlayerQuestProfile;
  worldState: WorldStateSnapshotData;
  npc: QuestNpcDraft;
};

type NPCDialogueContext = {
  playerName: string;
  npc: QuestNpcDraft;
  worldState: WorldStateSnapshotData;
  relationshipSummary: string[];
};

type NarrativeResponseShape = {
  title?: unknown;
  description?: unknown;
  lore?: unknown;
  missionStructure?: unknown;
  storyline?: unknown;
  rewardRationale?: unknown;
  riskLevel?: unknown;
  worldTheme?: unknown;
  seasonalHook?: unknown;
  coOpHooks?: unknown;
  loreContinuity?: unknown;
  objectives?: unknown;
  chapters?: unknown;
  branchingHooks?: unknown;
  openingDialogue?: unknown;
  txRequirements?: unknown;
  chainInteraction?: unknown;
};

const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;
const MAX_ITEMS = 4;
const RISK_LEVELS = new Set(['low', 'moderate', 'high', 'extreme']);

function safeJsonParse<T>(value: string): T | null {
  try {
    const firstBrace = value.indexOf('{');
    const body = firstBrace >= 0 ? value.slice(firstBrace) : value;
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function normalizeString(value: unknown, fallback: string, maxLength = 400) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const cleaned = value
    .trim()
    .slice(0, maxLength)
    .replace(/[<>"'`]/g, '')
    .replace(/\s{2,}/g, ' ');

  return cleaned || fallback;
}

function normalizeStringArray(value: unknown, fallback: string[], maxLength = 160) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeString(item, '', maxLength))
    .filter(Boolean);

  return items.length > 0 ? items.slice(0, MAX_ITEMS) : fallback;
}

function buildAIQuestPrompt(context: NarrativeContext) {
  return `You are the authoritative quest orchestration AI for QuestForge on ${context.chain}.

You are generating a persistent onchain RPG quest for wallet ${context.wallet}.
Player level: ${context.playerProfile.level}
Player streak: ${context.playerProfile.streak}
Player onchain actions: ${context.playerProfile.onchainActions}
Recent quest titles: ${context.playerProfile.questHistory.recentQuestTitles.join(' | ') || 'none'}
Recent factions: ${context.playerProfile.questHistory.recentFactionIds.join(' | ') || 'none'}
Current season: ${context.worldState.season.label}
World theme: ${context.worldState.season.theme}
Active world events: ${context.worldState.activeEvents.map((event) => `${event.name} (${event.type})`).join(' | ') || 'none'}
Faction pressures: ${context.worldState.factions.map((faction) => `${faction.name}:${faction.status}`).join(' | ')}
Quest NPC: ${context.npc.name} (${context.npc.role}) personality=${context.npc.personalitySummary}
Reward amount: ${context.rewardAmount} CELO
Stake amount: ${context.stakeAmount} CELO
Difficulty: ${context.difficulty}/5

Return strict JSON only with these fields:
- title
- description
- lore
- missionStructure
- storyline (array of 3 strings)
- rewardRationale
- riskLevel
- worldTheme
- seasonalHook
- coOpHooks (array of 2-3 strings)
- loreContinuity (array of 2-3 strings)
- openingDialogue
- objectives (array of 3 objects with id, summary, stage, verifierHint, mandatory)
- chapters (array of 2-3 objects with id, title, summary, objectiveIds)
- branchingHooks (array of 2 objects with id, trigger, branch, riskDelta)
- txRequirements (array of 7 objects with stage, label, description, type, minimumCount, verifierCompatible)
- chainInteraction (object with primary, secondary, allowedTargets, minValueCelo, requireContractCall, requireTokenApproval)

Rules:
- Keep the quest grounded in Celo transaction gameplay.
- Avoid financial guarantees, admin powers, phishing, or impossible actions.
- Objectives must support a multi-step quest progression, not a single action.
- Reference recurring lore, factions, and the named NPC.
- Co-op hooks must be optional and future clan compatible.
- Output JSON only.`;
}

class QuestNarrativeEngine {
  async generateQuestNarrative(context: NarrativeContext): Promise<QuestNarrativeDraft> {
    const fallback = this.buildDeterministicNarrative(context);

    if (!openai) {
      return fallback;
    }

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        temperature: 0.45,
        max_tokens: 1100,
        messages: [
          {
            role: 'system',
            content:
              'You generate persistent, verifier-safe, lore-consistent quest narratives for an onchain RPG. Do not introduce unsafe or protocol-critical values.'
          },
          {
            role: 'user',
            content: buildAIQuestPrompt(context)
          }
        ]
      });

      const raw = response.choices[0]?.message?.content || '';
      const parsed = safeJsonParse<NarrativeResponseShape>(raw);
      if (!parsed) {
        return fallback;
      }

      const hallCheck = aiValidator.detectHallucinations(
        `${String(parsed.title ?? '')} ${String(parsed.description ?? '')} ${String(parsed.lore ?? '')}`
      );
      if (hallCheck.isHallucinated) {
        logger.warn('[NARRATIVE] Falling back after hallucination detection', {
          wallet: context.wallet,
          reason: hallCheck.reason
        });
        return fallback;
      }

      return this.mergeWithFallback(parsed, fallback);
    } catch (error) {
      logger.warn('[NARRATIVE] OpenAI generation failed, using deterministic fallback', {
        wallet: context.wallet,
        error: error instanceof Error ? error.message : 'Unknown narrative generation failure'
      });
      return fallback;
    }
  }

  async generateNPCDialogue(context: NPCDialogueContext): Promise<string> {
    const fallback = `${context.npc.name} says: ${context.worldState.season.label} has sharpened every oath in the realm, ${context.playerName}. ${context.relationshipSummary[0] ?? 'You have been noticed.'}`;

    if (!openai) {
      return fallback;
    }

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.65,
        max_tokens: 180,
        messages: [
          {
            role: 'system',
            content:
              'Generate immersive fantasy blockchain RPG NPC dialogue. Avoid promises, scams, financial advice, and unsafe instructions.'
          },
          {
            role: 'user',
            content: `NPC ${context.npc.name} (${context.npc.role}) personality=${context.npc.personalitySummary}. Season=${context.worldState.season.label}. Player=${context.playerName}. Relationship notes=${context.relationshipSummary.join(' | ') || 'none'}.`
          }
        ]
      });

      return normalizeString(response.choices[0]?.message?.content, fallback, 240);
    } catch (error) {
      logger.warn('[NARRATIVE] NPC dialogue fallback applied', {
        npcId: context.npc.npcId,
        error: error instanceof Error ? error.message : 'Unknown dialogue generation failure'
      });
      return fallback;
    }
  }

  private mergeWithFallback(raw: NarrativeResponseShape, fallback: QuestNarrativeDraft): QuestNarrativeDraft {
    const title = normalizeString(raw.title, fallback.title, 120);
    const description = normalizeString(raw.description, fallback.description, 320);
    const lore = normalizeString(raw.lore, fallback.lore, 500);
    const missionStructure = normalizeString(raw.missionStructure, fallback.missionStructure, 200);
    const rewardRationale = normalizeString(raw.rewardRationale, fallback.rewardRationale, 220);
    const riskLevel = this.normalizeRiskLevel(raw.riskLevel, fallback.riskLevel);
    const worldTheme = normalizeString(raw.worldTheme, fallback.worldInfluence.theme, 120);
    const seasonalHook = normalizeString(raw.seasonalHook, fallback.worldInfluence.seasonalHook, 160);
    const storyline = normalizeStringArray(raw.storyline, fallback.storyline, 160);
    const coOpHooks = normalizeStringArray(raw.coOpHooks, fallback.coOpHooks, 140);
    const loreContinuity = normalizeStringArray(raw.loreContinuity, fallback.loreContinuity, 160);
    const objectives = this.normalizeObjectives(raw.objectives, fallback.missionObjectives);
    const chapters = this.normalizeChapters(raw.chapters, fallback.missionChapters, objectives);
    const branchingHooks = this.normalizeBranchingHooks(raw.branchingHooks, fallback.branchingHooks);
    const txRequirements = this.normalizeTxRequirements(raw.txRequirements, fallback.txRequirements);
    const chainInteraction = this.normalizeChainInteraction(raw.chainInteraction, fallback.chainInteraction);
    const openingDialogue = normalizeString(raw.openingDialogue, fallback.npc.openingDialogue, 200);

    return {
      ...fallback,
      title,
      description,
      lore,
      missionStructure,
      storyline,
      rewardRationale,
      riskLevel,
      missionObjectives: objectives,
      missionChapters: chapters,
      txRequirements,
      branchingHooks,
      coOpHooks,
      loreContinuity,
      npc: {
        ...fallback.npc,
        openingDialogue
      },
      worldInfluence: {
        ...fallback.worldInfluence,
        theme: worldTheme,
        seasonalHook
      },
      chainInteraction
    };
  }

  private normalizeRiskLevel(value: unknown, fallback: QuestNarrativeDraft['riskLevel']) {
    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim().toLowerCase();
    return RISK_LEVELS.has(normalized) ? (normalized as QuestNarrativeDraft['riskLevel']) : fallback;
  }

  private normalizeObjectives(value: unknown, fallback: QuestObjectiveDraft[]) {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const normalized = value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map((item, index) => ({
        id: normalizeString(item.id, fallback[index]?.id ?? `objective-${index + 1}`, 40),
        summary: normalizeString(item.summary, fallback[index]?.summary ?? fallback[0].summary, 160),
        stage: fallback[index]?.stage ?? fallback[Math.min(index, fallback.length - 1)].stage,
        verifierHint: normalizeString(item.verifierHint, fallback[index]?.verifierHint ?? fallback[0].verifierHint, 120),
        mandatory: typeof item.mandatory === 'boolean' ? item.mandatory : true
      }));

    return normalized.length >= 3 ? normalized.slice(0, 3) : fallback;
  }

  private normalizeChapters(
    value: unknown,
    fallback: QuestChapterDraft[],
    objectives: QuestObjectiveDraft[]
  ) {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const objectiveIds = new Set(objectives.map((objective) => objective.id));
    const normalized = value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map((item, index) => ({
        id: normalizeString(item.id, fallback[index]?.id ?? `chapter-${index + 1}`, 40),
        title: normalizeString(item.title, fallback[index]?.title ?? `Chapter ${index + 1}`, 90),
        summary: normalizeString(item.summary, fallback[index]?.summary ?? fallback[0].summary, 160),
        objectiveIds: Array.isArray(item.objectiveIds)
          ? item.objectiveIds
              .filter((id): id is string => typeof id === 'string' && objectiveIds.has(id))
              .slice(0, 3)
          : fallback[index]?.objectiveIds ?? fallback[0].objectiveIds
      }))
      .filter((chapter) => chapter.objectiveIds.length > 0);

    return normalized.length >= 2 ? normalized.slice(0, 3) : fallback;
  }

  private normalizeBranchingHooks(value: unknown, fallback: QuestBranchingHook[]) {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const normalized = value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map((item, index) => ({
        id: normalizeString(item.id, fallback[index]?.id ?? `branch-${index + 1}`, 40),
        trigger: normalizeString(item.trigger, fallback[index]?.trigger ?? fallback[0].trigger, 120),
        branch: normalizeString(item.branch, fallback[index]?.branch ?? fallback[0].branch, 160),
        riskDelta:
          typeof item.riskDelta === 'number' && Number.isFinite(item.riskDelta)
            ? Math.max(-1, Math.min(2, item.riskDelta))
            : fallback[index]?.riskDelta ?? 0
      }));

    return normalized.length >= 2 ? normalized.slice(0, 2) : fallback;
  }

  private normalizeTxRequirements(value: unknown, fallback: QuestTxRequirement[]) {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const fallbackByStage = new Map(fallback.map((requirement) => [requirement.stage, requirement]));
    const normalized = value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map((item) => {
        const stage = typeof item.stage === 'string' ? item.stage : '';
        const basis = fallbackByStage.get(stage as QuestTxRequirement['stage']);
        if (!basis) {
          return null;
        }

        return {
          stage: basis.stage,
          label: normalizeString(item.label, basis.label, 80),
          description: normalizeString(item.description, basis.description, 180),
          type:
            typeof item.type === 'string'
              ? (item.type as QuestTxRequirement['type'])
              : basis.type,
          minimumCount:
            typeof item.minimumCount === 'number' && Number.isFinite(item.minimumCount)
              ? Math.max(1, Math.round(item.minimumCount))
              : basis.minimumCount,
          verifierCompatible:
            typeof item.verifierCompatible === 'boolean' ? item.verifierCompatible : basis.verifierCompatible
        };
      })
      .filter((value): value is QuestTxRequirement => Boolean(value));

    return normalized.length === fallback.length ? normalized : fallback;
  }

  private normalizeChainInteraction(value: unknown, fallback: QuestChainInteractionPattern) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fallback;
    }

    const record = value as Record<string, unknown>;
    const primary =
      typeof record.primary === 'string' &&
      ['native_transfer', 'contract_call', 'token_approval'].includes(record.primary)
        ? (record.primary as QuestChainInteractionPattern['primary'])
        : fallback.primary;
    const secondary =
      typeof record.secondary === 'string' &&
      ['native_transfer', 'contract_call', 'token_approval'].includes(record.secondary)
        ? (record.secondary as QuestChainInteractionPattern['secondary'])
        : fallback.secondary;
    const allowedTargets = Array.isArray(record.allowedTargets)
      ? record.allowedTargets.filter(
          (target): target is 'wallet' | 'contract' | 'token' =>
            target === 'wallet' || target === 'contract' || target === 'token'
        )
      : fallback.allowedTargets;

    return {
      primary,
      secondary,
      allowedTargets: allowedTargets.length > 0 ? allowedTargets.slice(0, 3) : fallback.allowedTargets,
      minValueCelo:
        typeof record.minValueCelo === 'number' && Number.isFinite(record.minValueCelo)
          ? Math.max(0, Number(record.minValueCelo.toFixed(4)))
          : fallback.minValueCelo,
      requireContractCall:
        typeof record.requireContractCall === 'boolean' ? record.requireContractCall : fallback.requireContractCall,
      requireTokenApproval:
        typeof record.requireTokenApproval === 'boolean' ? record.requireTokenApproval : fallback.requireTokenApproval
    };
  }

  private buildDeterministicNarrative(context: NarrativeContext): QuestNarrativeDraft {
    const worldTheme = context.worldState.questThemes[0] ?? 'stabilize an unstable frontier';
    const seasonalHook = context.worldState.seasonalContent[0] ?? context.worldState.season.theme;
    const primaryFaction = context.worldState.factions[0];
    const opposingFaction =
      context.worldState.factions.find((faction) => faction.alignment === 'rival') ?? context.worldState.factions[1];
    const riskLevel =
      context.difficulty >= 5 ? 'extreme' : context.difficulty >= 4 ? 'high' : context.difficulty >= 3 ? 'moderate' : 'low';
    const primaryInteraction = this.pickPrimaryInteraction(context);
    const secondaryInteraction = primaryInteraction === 'contract_call' ? 'token_approval' : 'contract_call';
    const rarity = this.pickRarity(context.worldState);
    const memoryReferences = context.npc.memoryReferences.length
      ? context.npc.memoryReferences
      : context.playerProfile.relationshipSummary.slice(0, 2);

    const objectives: QuestObjectiveDraft[] = [
      {
        id: 'accept-path',
        summary: `Accept ${context.npc.name}'s assignment and prepare the ${primaryFaction.name} operation.`,
        mandatory: true,
        stage: 'createQuest',
        verifierHint: 'Quest metadata and wallet ownership must align.'
      },
      {
        id: 'prove-action',
        summary: `Execute the primary ${primaryInteraction.replace('_', ' ')} action that secures ${worldTheme}.`,
        mandatory: true,
        stage: 'gameplay',
        verifierHint: 'Gameplay transaction must be signed after quest start and remain verifier compatible.'
      },
      {
        id: 'seal-proof',
        summary: `Submit proof before ${opposingFaction.name} can twist the public record against you.`,
        mandatory: true,
        stage: 'submitProof',
        verifierHint: 'Proof hash and settlement must match the onchain verifier pipeline.'
      }
    ];

    const txRequirements: QuestTxRequirement[] = [
      {
        stage: 'createQuest',
        label: 'Forge the mission',
        description: 'Create the quest onchain with the orchestrated metadata payload.',
        type: 'contract_call',
        minimumCount: 1,
        verifierCompatible: true
      },
      {
        stage: 'startQuestStake',
        label: 'Bind the stake',
        description: 'Start the quest and lock the required stake.',
        type: 'contract_call',
        minimumCount: 1,
        verifierCompatible: true
      },
      {
        stage: 'gameplay',
        label: 'Advance the mission',
        description: `Perform at least one ${primaryInteraction.replace('_', ' ')} gameplay transaction in the live world state.`,
        type: primaryInteraction,
        minimumCount: 1,
        verifierCompatible: true
      },
      {
        stage: 'submitProof',
        label: 'Seal your proof',
        description: 'Submit the gameplay proof transaction hash through the quest contract.',
        type: 'proof_submission',
        minimumCount: 1,
        verifierCompatible: true
      },
      {
        stage: 'verifierSettlement',
        label: 'Await settlement',
        description: 'Backend verifier settlement must confirm the proof hash deterministically.',
        type: 'verifier_call',
        minimumCount: 1,
        verifierCompatible: true
      },
      {
        stage: 'rewardPayout',
        label: 'Receive payout',
        description: 'Treasury settlement releases the reward and stake outcome.',
        type: 'reward_claim',
        minimumCount: 1,
        verifierCompatible: true
      },
      {
        stage: 'nftMint',
        label: 'Claim the relic',
        description: 'Reward NFT mint finalizes the quest record.',
        type: 'nft_mint',
        minimumCount: 1,
        verifierCompatible: true
      }
    ];

    return {
      title: `${context.npc.name}'s ${context.worldState.season.label} Mandate`,
      description: `Coordinate a ${worldTheme} mission for ${primaryFaction.name}, navigate faction pressure from ${opposingFaction.name}, and return with proof that survives deterministic settlement.`,
      lore: `${context.npc.name} remembers ${memoryReferences.join(' and ') || 'your recent progress'} and believes this operation can shift the balance of ${context.worldState.activeConflicts[0]?.label ?? 'the frontier conflict'}.`,
      missionStructure: 'Three-act onchain operation with preparation, live execution, and verifier-backed resolution.',
      missionObjectives: objectives,
      missionChapters: [
        {
          id: 'chapter-briefing',
          title: 'Briefing at the Ember Table',
          summary: `${context.npc.name} frames the mission in the language of faction consequence and public proof.`,
          objectiveIds: ['accept-path']
        },
        {
          id: 'chapter-escalation',
          title: 'Escalation in the Open Ledger',
          summary: `The player executes the live-chain action while ${opposingFaction.name} contests the route.`,
          objectiveIds: ['prove-action']
        },
        {
          id: 'chapter-settlement',
          title: 'Settlement Under Witness',
          summary: 'The mission resolves only after proof submission and deterministic verifier settlement.',
          objectiveIds: ['seal-proof']
        }
      ],
      txRequirements,
      storyline: [
        `${context.npc.name} recruits the player to stabilize ${worldTheme}.`,
        `${opposingFaction.name} pressures the corridor, forcing a visible and timely onchain response.`,
        `Only a proof trail that survives verifier settlement can secure the final standing.`
      ],
      rewardRationale: `Reward is justified by the stake risk, current ${context.worldState.season.label} pressure, and the need to act inside a contested faction window.`,
      riskLevel,
      npc: {
        ...context.npc,
        openingDialogue: `${context.npc.name} says: I remember ${memoryReferences[0] ?? 'your earlier service'}. The ${seasonalHook} has opened a narrow path, and only a public chain of action will hold it.`
      },
      faction: {
        primaryFactionId: primaryFaction.id,
        primaryFactionName: primaryFaction.name,
        opposingFactionId: opposingFaction?.id ?? null,
        opposingFactionName: opposingFaction?.name ?? null,
        playerAlignment: primaryFaction.alignment,
        conflictSummary: context.worldState.activeConflicts[0]?.summary ?? `${primaryFaction.name} is under pressure.`,
        coOpEligible: context.playerProfile.level >= 2,
        clanRaidCompatible: context.playerProfile.clanId !== null || context.difficulty >= 4
      },
      worldInfluence: {
        rarity,
        theme: worldTheme,
        modifiers: context.worldState.activeEvents.map((event) => `${event.name} x${event.multiplier.toFixed(2)}`).slice(0, 3),
        seasonalHook
      },
      branchingHooks: [
        {
          id: 'branch-speed',
          trigger: 'Player completes the gameplay step quickly and without retries.',
          branch: 'NPC trust improves and future faction escort options open.',
          riskDelta: -1
        },
        {
          id: 'branch-conflict',
          trigger: 'Player delays during active faction pressure.',
          branch: `${opposingFaction.name} gains narrative leverage and later missions escalate.`,
          riskDelta: 1
        }
      ],
      chainInteraction: {
        primary: primaryInteraction,
        secondary: secondaryInteraction,
        allowedTargets: primaryInteraction === 'native_transfer' ? ['wallet'] : ['contract', 'token'],
        minValueCelo: primaryInteraction === 'native_transfer' ? Number(Math.max(0.01, context.stakeAmount * 0.4).toFixed(4)) : 0,
        requireContractCall: primaryInteraction !== 'native_transfer',
        requireTokenApproval: primaryInteraction === 'token_approval'
      },
      coOpHooks: [
        'Allow a guild ally to scout the route and mirror the storyline in party chat.',
        'Mark the mission as raid-compatible if the faction conflict intensifies later.'
      ],
      loreContinuity: [
        `${context.npc.name} references the player streak of ${context.playerProfile.questHistory.questStreak}.`,
        `${primaryFaction.name} is tracking the same conflict across multiple quests.`
      ]
    };
  }

  private pickPrimaryInteraction(context: NarrativeContext) {
    const remainder = (context.difficulty + context.playerProfile.onchainActions + context.worldState.activeEvents.length) % 3;
    return remainder === 0 ? 'native_transfer' : remainder === 1 ? 'contract_call' : 'token_approval';
  }

  private pickRarity(worldState: WorldStateSnapshotData) {
    const entries = Object.entries(worldState.rarityWeights).sort((left, right) => right[1] - left[1]);
    return (entries[0]?.[0] ?? 'rare') as QuestNarrativeDraft['worldInfluence']['rarity'];
  }
}

export const questNarrativeEngine = new QuestNarrativeEngine();

import crypto from 'crypto';
import { env } from '../config/env';
import { aiGroqClient } from './aiGroqClient';
import { aiValidator } from './aiSafety';
import { logger } from './logger';
import type {
  QuestGenerationDiagnostics,
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

const MAX_ITEMS = 4;
const RISK_LEVELS = new Set(['low', 'moderate', 'high', 'extreme']);
const GROQ_MODEL = env.GROQ_MODEL;

function extractJsonObject(value: string) {
  const sanitized = value
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBrace = sanitized.indexOf('{');
  if (firstBrace < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = firstBrace; index < sanitized.length; index += 1) {
    const char = sanitized[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return sanitized.slice(firstBrace, index + 1);
      }
    }
  }

  return sanitized.slice(firstBrace);
}

function safeJsonParse<T>(value: string): T | null {
  const candidates = [value, extractJsonObject(value)].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
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

function hashPrompt(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function promptPreview(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function buildAIQuestPrompt(context: NarrativeContext) {
  const activeEventsStr = context.worldState.activeEvents.length
    ? context.worldState.activeEvents
        .map((e) => `${e.name} (magnitude: ${e.type})`)
        .join('; ')
    : 'none at this moment';

  const factionsStr = context.worldState.factions
    .map((f) => `${f.name} ${f.alignment === 'rival' ? 'threatens' : 'supports'} the realm`)
    .join(' | ');

  const difficultyNames = ['Easy fortune', 'Worthy challenge', 'Dangerous venture', 'Legendary test', 'Impossible dream'];
  const difficultyLabel = difficultyNames[Math.max(0, Math.min(4, context.difficulty - 1))];

  return `You are the legendary Dungeon Master orchestrating an epic quest for an on-chain RPG called QuestForge on ${context.chain}.

A worthy adventurer appears before you:
- Level: ${context.playerProfile.level} | Streak: ${context.playerProfile.streak} | On-chain deeds: ${context.playerProfile.onchainActions}
- Recent trials: ${context.playerProfile.questHistory.recentQuestTitles.join(', ') || 'untested in recent memory'}
- Allegiances: ${context.playerProfile.questHistory.recentFactionIds.join(', ') || 'uncommitted'}

The world shifts around you:
- Age: ${context.worldState.season.label} (${context.worldState.season.theme})
- Urgent threats: ${activeEventsStr}
- Faction tensions: ${factionsStr}
- The hero you've chosen: ${context.npc.name}, ${context.npc.role} - personality: ${context.npc.personalitySummary}

The stakes crystallize:
- Reward for success: ${context.rewardAmount} CELO | Risk required: ${context.stakeAmount} CELO
- Peril level: ${context.difficulty}/5 ${difficultyLabel}

Your task: Weave a cinematic, immersive quest that feels like a chapter from an epic fantasy novel. The quest MUST:

1. **Title** - A vivid, memorable operation name that evokes fantasy and urgency (NOT generic)
2. **Description** - Explain the on-chain action in dramatic, player-facing language that makes the blockchain interaction feel heroic
3. **Lore** - Reference the season's theme, faction conflict, and what hangs in the balance
4. **Mission Structure** - Poetic summary of the three-act structure
5. **Storyline** - Three narrative beats that build tension and meaning
6. **Reward Rationale** - Justify the reward through stakes and season pressure
7. **Risk Level** - low | moderate | high | extreme
8. **World Theme** - The single most important thing at stake
9. **Seasonal Hook** - What makes THIS season unique for this quest
10. **Co-Op Hooks** - Optional multiplayer possibilities (feel free to be creative)
11. **Lore Continuity** - References to recurring elements and the NPC's memory
12. **Opening Dialogue** - The NPC's compelling call to adventure

13. **Objectives** (array of 3):
    - id: objective-1, objective-2, objective-3
    - summary: What the hero must do (vivid language)
    - stage: createQuest | gameplay | submitProof
    - verifierHint: How the chain verifies this
    - mandatory: true/false

14. **Chapters** (array of 2-3):
    - id: chapter-{name}
    - title: Evocative chapter name
    - summary: What happens here
    - objectiveIds: [list of objective ids from above]

15. **Branching Hooks** (array of 2):
    - id: branch-{name}
    - trigger: When does this happen?
    - branch: What's the consequence?
    - riskDelta: -1 to 2 (how does this change danger?)

16. **TX Requirements** (array of 7, one per stage):
    - stage: createQuest | startQuestStake | gameplay | submitProof | verifierSettlement | rewardPayout | nftMint
    - label: What this stage accomplishes
    - description: The on-chain action explained dramatically
    - type: contract_call | native_transfer | token_approval | proof_submission | verifier_call | reward_claim | nft_mint
    - minimumCount: 1+
    - verifierCompatible: true/false

17. **Chain Interaction**:
    - primary: native_transfer | contract_call | token_approval
    - secondary: (different from primary)
    - allowedTargets: [wallet | contract | token]
    - minValueCelo: 0+
    - requireContractCall: true/false
    - requireTokenApproval: true/false

CRITICAL RULES:
- Make every quest feel UNIQUE and NON-REPETITIVE. Vary the narrative structure, metaphors, and dramatic hooks
- Ground everything in real Celo transactions, but make them feel like heroic deeds
- Avoid impossible actions, financial scams, phishing, or admin powers
- Reference ${context.npc.name} by name in the lore and opening dialogue
- Each objective should be distinct and progressive
- Make the world feel alive and consequential
- Be cinematic, evocative, and emotionally engaging
- Return STRICT JSON ONLY (no markdown, no preamble)`;
}

class QuestNarrativeEngine {
  private buildFallbackNarrative(
    context: NarrativeContext,
    generation: QuestGenerationDiagnostics
  ) {
    return this.buildDeterministicNarrative(context, generation);
  }

  async generateQuestNarrative(context: NarrativeContext): Promise<QuestNarrativeDraft> {
    const prompt = buildAIQuestPrompt(context);
    const promptHash = hashPrompt(prompt);
    const promptSummary = promptPreview(prompt);

    logger.info('[QUEST-AI-GENERATION] Initiating AI quest generation', {
      wallet: context.wallet,
      chain: context.chain,
      difficulty: context.difficulty,
      rewardAmount: context.rewardAmount,
      stakeAmount: context.stakeAmount,
      groqAvailable: aiGroqClient.isAvailable(),
      promptHash,
      npc: context.npc.name
    });

    if (!aiGroqClient.isAvailable()) {
      logger.warn('[QUEST-AI-GENERATION] Groq not available - FALLBACK MODE ACTIVATED', {
        wallet: context.wallet,
        reason: 'GROQ_API_KEY not configured',
        promptHash
      });

      const fallback = this.buildFallbackNarrative(context, {
        source: 'deterministic_fallback',
        provider: 'deterministic',
        model: null,
        promptHash,
        promptPreview: promptSummary,
        fallbackReason: 'GROQ_API_KEY not configured',
        generatedAt: new Date().toISOString(),
        requestId: null,
        latencyMs: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        attemptCount: null
      });

      return fallback;
    }

    // Build fallback for potential use
    const baseFallbackGeneration = {
      source: 'deterministic_fallback' as const,
      provider: 'deterministic' as const,
      model: null as null,
      promptHash,
      promptPreview: promptSummary,
      fallbackReason: 'API request failed after retries',
      generatedAt: new Date().toISOString(),
      requestId: null,
      latencyMs: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      attemptCount: null
    };

    try {
      // Request with exponential backoff retry
      const result = await aiGroqClient.createChatCompletion(
        {
          model: GROQ_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You are a legendary Dungeon Master. Generate immersive, cinematic, non-repetitive quest narratives for an on-chain RPG. Each quest should feel unique and memorable. Return strict JSON only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.82, // Increased for more creativity
          maxTokens: 1200,
          responseFormat: { type: 'json_object' }
        },
        {
          maxAttempts: 3,
          initialDelayMs: 800,
          maxDelayMs: 15000,
          backoffMultiplier: 2.5,
          jitterFactor: 0.15
        }
      );

      logger.info('[QUEST-AI-GENERATION] Groq request completed successfully', {
        wallet: context.wallet,
        requestId: result.telemetry.requestId,
        model: result.telemetry.model,
        promptTokens: result.telemetry.promptTokens,
        completionTokens: result.telemetry.completionTokens,
        totalTokens: result.telemetry.totalTokens,
        latencyMs: result.telemetry.latencyMs,
        attemptCount: result.telemetry.attemptCount,
        contentLength: result.content.length
      });

      // Parse JSON response
      const parsed = safeJsonParse<NarrativeResponseShape>(result.content);
      if (!parsed) {
        logger.error('[QUEST-AI-GENERATION] Failed to parse Groq response as JSON', {
          wallet: context.wallet,
          requestId: result.telemetry.requestId,
          contentPreview: result.content.slice(0, 200)
        });
        return this.buildFallbackNarrative(context, {
          ...baseFallbackGeneration,
          fallbackReason: 'Response parsing failed',
          generatedAt: new Date().toISOString()
        });
      }

      // Validate against hallucinations
      const hallCheck = aiValidator.detectHallucinations(
        `${String(parsed.title ?? '')} ${String(parsed.description ?? '')} ${String(parsed.lore ?? '')}`
      );

      if (hallCheck.isHallucinated) {
        logger.warn('[QUEST-AI-GENERATION] Hallucination detected in AI response', {
          wallet: context.wallet,
          requestId: result.telemetry.requestId,
          hallucination: hallCheck.reason
        });
        // For hallucinations, we still accept the response but mark it as suspicious
        // Retry would be wasteful here because the response is structurally valid.
      }

      // Merge with fallback and return
      const merged = this.mergeWithFallback(parsed, this.buildDeterministicNarrative(context, baseFallbackGeneration), {
        source: 'groq',
        provider: 'groq',
        model: GROQ_MODEL,
        promptHash,
        promptPreview: promptSummary,
        fallbackReason: hallCheck.isHallucinated ? `Hallucination detected: ${hallCheck.reason}` : null,
        generatedAt: new Date().toISOString(),
        requestId: result.telemetry.requestId,
        latencyMs: result.telemetry.latencyMs,
        promptTokens: result.telemetry.promptTokens,
        completionTokens: result.telemetry.completionTokens,
        totalTokens: result.telemetry.totalTokens,
        attemptCount: result.telemetry.attemptCount
      });

      logger.info('[QUEST-AI-GENERATION] AI-generated quest accepted and merged', {
        wallet: context.wallet,
        requestId: result.telemetry.requestId,
        title: merged.title,
        riskLevel: merged.riskLevel
      });

      return merged;
    } catch (error) {
      // Groq request failed - activate fallback
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[QUEST-AI-GENERATION] Groq request failed - FALLBACK ACTIVATED', {
        wallet: context.wallet,
        error: errorMessage,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        promptHash
      });

      return this.buildFallbackNarrative(context, {
        ...baseFallbackGeneration,
        fallbackReason: errorMessage,
        generatedAt: new Date().toISOString()
      });
    }
  }

  async generateNPCDialogue(context: NPCDialogueContext): Promise<string> {
    const fallback = `${context.npc.name} says: The sands of fate shift, ${context.playerName}. ${context.relationshipSummary[0] ?? 'Your path is marked.'}`;

    if (!aiGroqClient.isAvailable()) {
      logger.debug('[NPC-DIALOGUE] Groq not available, using static fallback', {
        npcId: context.npc.npcId,
        npcName: context.npc.name,
        playerName: context.playerName
      });
      return fallback;
    }

    try {
      logger.info('[NPC-DIALOGUE] Generating AI dialogue', {
        npcId: context.npc.npcId,
        npcName: context.npc.name,
        npcRole: context.npc.role,
        playerName: context.playerName,
        relationshipSummary: context.relationshipSummary.join(' | ')
      });

      const result = await aiGroqClient.createChatCompletion(
        {
          model: GROQ_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'Generate immersive, brief fantasy NPC dialogue for an on-chain RPG tavern. Be mysterious, wise, or cunning. Reference the relationship if mentioned. Avoid promises, scams, and financial advice. Keep under 180 characters.'
            },
            {
              role: 'user',
              content: `${context.npc.name} (${context.npc.role}), personality: ${context.npc.personalitySummary}. Addressing ${context.playerName} in season ${context.worldState.season.label}. Relationship notes: ${context.relationshipSummary.join(' / ') || 'first meeting'}. Generate one line of dialogue only.`
            }
          ],
          temperature: 0.75, // Balanced for variety and coherence
          maxTokens: 120
        },
        {
          maxAttempts: 2, // NPC dialogue is less critical, fewer retries
          initialDelayMs: 400,
          maxDelayMs: 8000,
          backoffMultiplier: 2,
          jitterFactor: 0.1
        }
      );

      const dialogue = normalizeString(result.content, fallback, 240);

      logger.info('[NPC-DIALOGUE] AI dialogue generated successfully', {
        npcId: context.npc.npcId,
        requestId: result.telemetry.requestId,
        promptTokens: result.telemetry.promptTokens,
        completionTokens: result.telemetry.completionTokens,
        latencyMs: result.telemetry.latencyMs,
        dialogueLength: dialogue.length
      });

      return dialogue;
    } catch (error) {
      logger.warn('[NPC-DIALOGUE] AI dialogue generation failed, using fallback', {
        npcId: context.npc.npcId,
        npcName: context.npc.name,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return fallback;
    }
  }

  private mergeWithFallback(
    raw: NarrativeResponseShape,
    fallback: QuestNarrativeDraft,
    generation: QuestGenerationDiagnostics
  ): QuestNarrativeDraft {
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
      generation,
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

  private buildDeterministicNarrative(
    context: NarrativeContext,
    generation: QuestGenerationDiagnostics
  ): QuestNarrativeDraft {
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
    const titleLead = this.pickTitleLead(primaryInteraction, riskLevel);
    const themeAnchor = this.pickThemeAnchor(worldTheme, seasonalHook, primaryFaction.name);
    const titleSuffix = this.pickTitleSuffix(context.difficulty, context.worldState.activeEvents.length);

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
      title: `${titleLead} the ${themeAnchor} ${titleSuffix}`,
      description: `Coordinate a ${worldTheme} operation for ${primaryFaction.name}. You will start the quest by staking ${context.stakeAmount.toFixed(4)} CELO, complete a verifier-compatible ${primaryInteraction.replace('_', ' ')} action on Celo, and return with proof that survives deterministic settlement.`,
      lore: `${context.npc.name} remembers ${memoryReferences.join(' and ') || 'your recent progress'} and believes this operation can shift the balance of ${context.worldState.activeConflicts[0]?.label ?? 'the frontier conflict'}. ${opposingFaction.name} is already moving against the corridor, so the chain record itself must become your witness.`,
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
      ],
      generation
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

  private pickTitleLead(primaryInteraction: QuestChainInteractionPattern['primary'], riskLevel: QuestNarrativeDraft['riskLevel']) {
    const byInteraction: Record<QuestChainInteractionPattern['primary'], string[]> = {
      native_transfer: ['Stabilize', 'Secure', 'Escort'],
      contract_call: ['Reignite', 'Fortify', 'Restore'],
      token_approval: ['Recover', 'Unseal', 'Sanction']
    };
    const options = byInteraction[primaryInteraction];
    if (riskLevel === 'extreme') {
      return options[1] ?? options[0];
    }
    return options[0];
  }

  private pickThemeAnchor(worldTheme: string, seasonalHook: string, factionName: string) {
    const candidates = [worldTheme, seasonalHook, factionName]
      .flatMap((entry) => entry.split(/[^a-zA-Z0-9]+/))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 4);

    return candidates[0] ?? 'Onchain';
  }

  private pickTitleSuffix(difficulty: number, activeEventCount: number) {
    if (difficulty >= 5) return 'Sigil';
    if (difficulty >= 4) return activeEventCount > 0 ? 'Conduit' : 'Relay';
    if (activeEventCount > 1) return 'Accord';
    return 'Mandate';
  }
}

export const questNarrativeEngine = new QuestNarrativeEngine();

import type { ObjectiveType } from './questTemplates';

export type QuestRiskLevel = 'low' | 'moderate' | 'high' | 'extreme';
export type QuestRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type FactionStatus = 'rising' | 'stable' | 'contested' | 'dominant' | 'weakened';
export type InteractionPatternType = ObjectiveType;
export type QuestTxStage =
  | 'createQuest'
  | 'startQuestStake'
  | 'gameplay'
  | 'submitProof'
  | 'verifierSettlement'
  | 'rewardPayout'
  | 'nftMint';

export interface WorldStateEventSummary {
  id: string;
  name: string;
  type: string;
  multiplier: number;
  reward: number;
  difficulty: number;
  description: string;
}

export interface WorldFactionState {
  id: string;
  name: string;
  status: FactionStatus;
  influence: number;
  alignment: 'ally' | 'neutral' | 'rival';
  conflictScore: number;
  narrativeHooks: string[];
}

export interface WorldConflictState {
  id: string;
  label: string;
  factions: string[];
  intensity: number;
  summary: string;
}

export interface WorldStateSnapshotData {
  version: number;
  generatedAt: string;
  season: {
    key: string;
    label: string;
    theme: string;
  };
  activeEvents: WorldStateEventSummary[];
  factions: WorldFactionState[];
  activeConflicts: WorldConflictState[];
  questThemes: string[];
  seasonalContent: string[];
  npcTones: string[];
  rarityWeights: Record<QuestRarity, number>;
  worldMultiplier: number;
  diagnostics: {
    trigger: string;
    stateHash: string;
    sourceEventCount: number;
  };
}

export interface PlayerQuestHistoryDigest {
  recentQuestTitles: string[];
  recentObjectives: string[];
  recentNpcNames: string[];
  recentFactionIds: string[];
  recentDifficultyAverage: number;
  verifiedCount: number;
  failedCount: number;
  questStreak: number;
}

export interface PlayerQuestProfile {
  userId: string;
  wallet: string;
  username: string | null;
  level: number;
  xp: number;
  streak: number;
  onchainActions: number;
  clanId: string | null;
  agentId: string | null;
  walletHistoryScore: number;
  questHistory: PlayerQuestHistoryDigest;
  relationshipSummary: string[];
}

export interface QuestObjectiveDraft {
  id: string;
  summary: string;
  mandatory: boolean;
  stage: QuestTxStage;
  verifierHint: string;
}

export interface QuestChapterDraft {
  id: string;
  title: string;
  summary: string;
  objectiveIds: string[];
}

export interface QuestTxRequirement {
  stage: QuestTxStage;
  label: string;
  description: string;
  type: InteractionPatternType | 'proof_submission' | 'verifier_call' | 'reward_claim' | 'nft_mint';
  minimumCount: number;
  verifierCompatible: boolean;
}

export interface QuestBranchingHook {
  id: string;
  trigger: string;
  branch: string;
  riskDelta: number;
}

export interface QuestNpcDraft {
  npcId: string;
  name: string;
  type: string;
  role: string;
  relationshipScore: number;
  personalitySummary: string;
  openingDialogue: string;
  memoryReferences: string[];
}

export interface QuestFactionContext {
  primaryFactionId: string;
  primaryFactionName: string;
  opposingFactionId: string | null;
  opposingFactionName: string | null;
  playerAlignment: 'ally' | 'neutral' | 'rival';
  conflictSummary: string;
  coOpEligible: boolean;
  clanRaidCompatible: boolean;
}

export interface QuestChainInteractionPattern {
  primary: InteractionPatternType;
  secondary: InteractionPatternType | null;
  allowedTargets: Array<'wallet' | 'contract' | 'token'>;
  minValueCelo: number;
  requireContractCall: boolean;
  requireTokenApproval: boolean;
}

export interface QuestGenerationDiagnostics {
  source: 'groq' | 'deterministic_fallback';
  provider: 'groq' | 'deterministic';
  model: string | null;
  promptHash: string;
  promptPreview: string;
  fallbackReason: string | null;
  generatedAt: string;
  requestId?: string | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  attemptCount?: number | null;
}

export interface QuestNarrativeDraft {
  title: string;
  description: string;
  lore: string;
  missionStructure: string;
  missionObjectives: QuestObjectiveDraft[];
  missionChapters: QuestChapterDraft[];
  txRequirements: QuestTxRequirement[];
  storyline: string[];
  rewardRationale: string;
  riskLevel: QuestRiskLevel;
  npc: QuestNpcDraft;
  faction: QuestFactionContext;
  worldInfluence: {
    rarity: QuestRarity;
    theme: string;
    modifiers: string[];
    seasonalHook: string;
  };
  branchingHooks: QuestBranchingHook[];
  chainInteraction: QuestChainInteractionPattern;
  coOpHooks: string[];
  loreContinuity: string[];
  generation: QuestGenerationDiagnostics;
}

export interface QuestValidationInput {
  wallet: string;
  chain: string;
  difficulty: number;
  stakeBounds: { min: number; max: number };
  rewardBounds: { min: number; max: number };
  recommendedStake: number;
  rewardAmount: number;
  xpReward: number;
  estimatedDurationSeconds: number;
  worldState: WorldStateSnapshotData;
  playerProfile: PlayerQuestProfile;
  narrative: QuestNarrativeDraft;
  difficultyReasoning: string;
  rewardReasoning: string;
  worldMultiplier: number;
  treasuryCap: number;
  activeWorldModifiers: Array<{
    id: string;
    name: string;
    type: string;
    multiplier: number;
    reward: number;
  }>;
  agentId: string | null;
}

export interface ValidatedQuestOutput {
  orchestrationId: string;
  metadata: Record<string, unknown>;
  metadataUri: string;
  title: string;
  description: string;
  difficulty: number;
  questType: string;
  objective: string;
  lore: string;
  missionStructure: string;
  missionObjectives: QuestObjectiveDraft[];
  missionChapters: QuestChapterDraft[];
  storyline: string[];
  rewardRationale: string;
  stakeAmount: number;
  rewardAmount: number;
  xpReward: number;
  transactionCount: number;
  requiredTxTypes: string[];
  durationSeconds: number;
  estimatedDurationSeconds: number;
  riskLevel: QuestRiskLevel;
  validationWarnings: string[];
  npc: QuestNpcDraft;
  faction: QuestFactionContext;
  worldInfluence: QuestNarrativeDraft['worldInfluence'];
  branchingHooks: QuestBranchingHook[];
  txRequirements: QuestTxRequirement[];
  chainInteraction: QuestChainInteractionPattern;
  coOpHooks: string[];
  loreContinuity: string[];
  worldStateVersion: number;
  isEventQuest: boolean;
  generation: QuestGenerationDiagnostics;
}

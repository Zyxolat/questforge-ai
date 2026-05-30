import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useWallet } from './WalletContext';
import { env } from '../lib/env';
import { fetchActiveQuests, fetchRealtimeBootstrap, fetchRealtimeSync } from '../lib/api';

type JsonObject = Record<string, unknown>;

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
type HydrationStatus = 'idle' | 'loading' | 'ready' | 'error';

type Scope = {
  type: 'global' | 'user' | 'clan' | 'faction';
  key: string;
};

type QuestMatcher = {
  id?: string;
  chainQuestId?: string;
  orchestrationId?: string;
};

export type RealtimeEventEnvelope = {
  id?: number;
  eventName: string;
  scopeType?: string;
  scopeKey?: string;
  sourceType?: string;
  sourceId?: string | null;
  payload: JsonObject;
  createdAt?: string;
};

export type PlayerState = {
  id?: string;
  wallet: string;
  username?: string | null;
  xp?: number;
  level?: number;
  questCount?: number;
  streak?: number;
  onchainActions?: number;
  [key: string]: unknown;
};

export type GuildState = {
  id?: string;
  name?: string;
  description?: string;
  level?: number;
  reputation?: number;
  treasuryBalance?: number;
  [key: string]: unknown;
} | null;

export type LeaderboardEntry = {
  id: string;
  wallet: string;
  xp: number;
  level: number;
  questCount: number;
  streak?: number;
  [key: string]: unknown;
};

export type TreasuryPayoutState = {
  status?: string;
  [key: string]: unknown;
};

export type QuestState = {
  id?: string;
  chainQuestId?: string;
  orchestrationId?: string;
  title?: string;
  description?: string;
  lore?: string;
  missionStructure?: string;
  missionObjectives?: Array<{ id?: string; summary?: string; stage?: string }>;
  missionChapters?: Array<{ id?: string; title?: string; summary?: string }>;
  storyline?: string[];
  rewardRationale?: string;
  difficulty?: number | string;
  questType?: string;
  objective?: string;
  rewardAmount?: number | string;
  stakeAmount?: number | string;
  xpReward?: number | string;
  durationSeconds?: number | string;
  estimatedDurationSeconds?: number | string;
  requiredTxTypes?: string[];
  metadataUri?: string;
  metadata?: JsonObject;
  generation?: JsonObject;
  txRequirements?: Array<{ stage?: string; type?: string; label?: string; description?: string }>;
  status?: string;
  treasuryPayout?: TreasuryPayoutState | null;
  proofTx?: string | null;
  proofTxHash?: string | null;
  verificationTx?: string | null;
  [key: string]: unknown;
};

export type InventoryItem = {
  id?: string;
  tokenId?: string;
  metadataUri?: string;
  rarity?: string;
  xpEarned?: number;
  questHistory?: string;
  mintedAt?: string | Date;
  [key: string]: unknown;
};

export type WorldState = {
  version?: number | string;
  season?: number | string;
  activeEvents?: unknown;
  [key: string]: unknown;
} | null;

export type NarrativeState = JsonObject | null;

export type FactionStanding = {
  factionId?: string;
  factionName?: string;
  standingScore?: number;
  allianceStatus?: string;
  influenceRank?: number;
  liveStatus?: string;
  liveInfluence?: number;
  [key: string]: unknown;
};

export type NpcRelationship = {
  npcId?: string;
  npcName?: string;
  npcType?: string;
  trust?: number;
  opinion?: string;
  unlocks: string[];
  references?: string[];
  recentMemories?: string[];
  interactionCount?: number;
  [key: string]: unknown;
};

type BootstrapPayload = {
  connection: {
    scopes: Scope[];
    lastEventId?: number;
  };
  player: PlayerState | null;
  guild: GuildState;
  leaderboard?: LeaderboardEntry[];
  quests?: QuestState[];
  inventory?: InventoryItem[];
  worldState: WorldState;
  narrativeState: NarrativeState;
  factionStandings?: FactionStanding[];
  npcRelationships?: NpcRelationship[];
  notifications?: RealtimeEventEnvelope[];
};

type SyncPayload = {
  lastEventId?: number;
  events: RealtimeEventEnvelope[];
};

type RealtimeStateContextValue = {
  connectionStatus: ConnectionStatus;
  hydrationStatus: HydrationStatus;
  isRealtimeReady: boolean;
  lastEventId: number;
  player: PlayerState | null;
  guild: GuildState;
  leaderboard: LeaderboardEntry[];
  quests: QuestState[];
  activeQuest: QuestState | null;
  inventory: InventoryItem[];
  worldState: WorldState;
  narrativeState: NarrativeState;
  factionStandings: FactionStanding[];
  npcRelationships: NpcRelationship[];
  notifications: RealtimeEventEnvelope[];
  npcDialogues: Record<string, string>;
  syncNow: () => Promise<void>;
  refreshQuestFeed: () => Promise<void>;
  upsertQuest: (quest: QuestState) => void;
  patchQuest: (matcher: QuestMatcher, patch: Partial<QuestState>) => void;
  getQuest: (matcher: QuestMatcher) => QuestState | null;
  setNpcDialogue: (npcName: string, dialogue: string) => void;
};

const RealtimeContext = createContext<RealtimeStateContextValue | undefined>(undefined);

function socketBaseUrl() {
  if (env.API_BASE_URL.startsWith('/')) {
    return window.location.origin;
  }

  try {
    return new URL(env.API_BASE_URL).origin;
  } catch {
    return window.location.origin;
  }
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function asObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function questOrchestrationIdFromMetadata(metadata: unknown) {
  const record = asObject(metadata);
  const orchestrationId = record?.orchestrationId;
  return typeof orchestrationId === 'string' ? orchestrationId : undefined;
}

function asObjectArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as JsonObject[];
  }

  return value
    .map((item) => asObject(item))
    .filter((item): item is JsonObject => Boolean(item));
}

function sortNotifications(events: RealtimeEventEnvelope[]) {
  return [...events].sort((left, right) => (right.id ?? 0) - (left.id ?? 0)).slice(0, 120);
}

function pickActiveQuest(quests: QuestState[]) {
  const statusPriority = ['ACTIVE', 'SUBMITTED', 'AVAILABLE'];
  for (const status of statusPriority) {
    const match = quests.find((quest) => quest.status === status);
    if (match) {
      return match;
    }
  }

  return quests[0] ?? null;
}

function eventDedupeKey(event: RealtimeEventEnvelope) {
  const payloadReplayKey = asString(asObject(event.payload)?.realtimeReplayKey);
  if (payloadReplayKey) {
    return `${event.eventName}:${payloadReplayKey}`;
  }

  return `${event.eventName}:${event.sourceType ?? 'unknown'}:${event.sourceId ?? 'none'}:${String(event.id ?? '')}`;
}

// removed unused _uniqueById
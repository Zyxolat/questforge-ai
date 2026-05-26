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

function uniqueById<T extends { id?: string | number }>(items: T[]) {
  const seen = new Set<string>();
  const output: T[] = [];

  items.forEach((item) => {
    const key = String(item.id ?? JSON.stringify(item));
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(item);
  });

  return output;
}

export function matchesQuest(quest: QuestState, matcher: QuestMatcher) {
  return (
    (matcher.id && quest.id === matcher.id) ||
    (matcher.chainQuestId && quest.chainQuestId === matcher.chainQuestId) ||
    (matcher.orchestrationId && quest.orchestrationId === matcher.orchestrationId)
  );
}

function uniqueInventory(items: InventoryItem[]) {
  const seen = new Set<string>();
  const output: InventoryItem[] = [];

  items.forEach((item) => {
    const key = String(item.tokenId ?? item.id ?? item.metadataUri ?? JSON.stringify(item));
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(item);
  });

  return output;
}

function questStatusForEvent(eventName: string, payload: JsonObject) {
  const nestedData = asObject(payload.data);

  if (eventName === 'quest:started') return 'ACTIVE';
  if (eventName === 'proof:submitted') return 'SUBMITTED';
  if (eventName === 'reward:claimed') {
    return nestedData?.success === true ? 'VERIFIED' : 'FAILED';
  }
  if (eventName === 'reward:refunded') return 'FAILED';
  return undefined;
}

function verificationPatchForEvent(eventName: string, payload: JsonObject) {
  const nestedData = asObject(payload.data);
  const reason =
    asString(nestedData?.reason) ??
    asString(payload.verificationReason) ??
    undefined;

  if (eventName === 'proof:submitted') {
    return {
      verificationResult: 'pending',
      verificationReason: reason
    };
  }

  if (eventName === 'reward:claimed') {
    return {
      verificationResult:
        nestedData?.success === true ? 'approved' : nestedData?.success === false ? 'rejected' : undefined,
      verificationReason: reason
    };
  }

  if (eventName === 'reward:refunded') {
    return {
      verificationResult: 'rejected',
      verificationReason: reason
    };
  }

  return {
    verificationResult: undefined,
    verificationReason: reason
  };
}

function treasuryStatusForEvent(eventName: string) {
  if (eventName === 'reward:reserved') return 'RESERVED';
  if (eventName === 'stake:locked') return 'LOCKED';
  if (eventName === 'reward:released') return 'RELEASED';
  if (eventName === 'reward:paid') return 'PAID';
  if (eventName === 'reward:refunded') return 'REFUNDED';
  return undefined;
}

const QUEST_STATUS_RANK: Record<string, number> = {
  AVAILABLE: 0,
  ACTIVE: 1,
  SUBMITTED: 2,
  VERIFIED: 3,
  FAILED: 3,
  CANCELLED: 3
};

const TREASURY_STATUS_RANK: Record<string, number> = {
  RESERVED: 0,
  LOCKED: 1,
  RELEASED: 2,
  PAID: 3,
  REFUNDED: 3
};

function compactDefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry !== 'undefined')) as Partial<T>;
}

function preferStatus(current?: string, incoming?: string, ranking?: Record<string, number>) {
  if (!incoming) {
    return current;
  }

  if (!current || !ranking) {
    return incoming;
  }

  const currentRank = ranking[current] ?? 0;
  const incomingRank = ranking[incoming] ?? 0;
  return incomingRank >= currentRank ? incoming : current;
}

export function normalizeQuestState(quest: QuestState) {
  return {
    ...quest,
    chainQuestId: asString(quest.chainQuestId),
    orchestrationId: asString(quest.orchestrationId) ?? questOrchestrationIdFromMetadata(quest.metadata),
    id: asString(quest.id),
    status: asString(quest.status),
    treasuryPayout: quest.treasuryPayout
      ? {
          ...quest.treasuryPayout,
          status: asString(quest.treasuryPayout.status)
        }
      : quest.treasuryPayout
  };
}

function mergeTreasuryPayoutState(current?: TreasuryPayoutState | null, incoming?: TreasuryPayoutState | null) {
  if (!incoming) {
    return current ?? incoming ?? null;
  }

  if (!current) {
    return incoming;
  }

  const merged = {
    ...current,
    ...compactDefined(incoming)
  };
  merged.status = preferStatus(current.status, incoming.status, TREASURY_STATUS_RANK);
  return merged;
}

export function mergeQuestState(current: QuestState, incoming: QuestState, reason: string) {
  const normalizedIncoming = normalizeQuestState(incoming);
  const merged: QuestState = {
    ...current,
    ...compactDefined(normalizedIncoming as Record<string, unknown>)
  };

  merged.id = asString(normalizedIncoming.id) ?? current.id;
  merged.orchestrationId = asString(normalizedIncoming.orchestrationId) ?? current.orchestrationId;
  merged.chainQuestId = asString(normalizedIncoming.chainQuestId) ?? current.chainQuestId;
  merged.status = preferStatus(current.status, normalizedIncoming.status, QUEST_STATUS_RANK);
  merged.treasuryPayout = mergeTreasuryPayoutState(current.treasuryPayout, normalizedIncoming.treasuryPayout);

  console.debug('[Realtime] Quest merge', {
    reason,
    questId: merged.id ?? current.id ?? normalizedIncoming.id ?? null,
    currentChainQuestId: current.chainQuestId ?? null,
    incomingChainQuestId: normalizedIncoming.chainQuestId ?? null,
    mergedChainQuestId: merged.chainQuestId ?? null,
    currentStatus: current.status ?? null,
    incomingStatus: normalizedIncoming.status ?? null,
    mergedStatus: merged.status ?? null
  });

  return merged;
}

export function mergeQuestCollections(current: QuestState[], incoming: QuestState[], reason: string) {
  const next = [...current];

  incoming
    .map((quest) => normalizeQuestState(quest))
    .forEach((quest) => {
      const index = next.findIndex((item) => matchesQuest(item, quest));

      if (index >= 0) {
        next[index] = mergeQuestState(next[index], quest, reason);
      } else {
        next.unshift(quest);
      }
    });

  return next;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { address, authStatus, isAuthReady, status } = useWallet();
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [hydrationStatus, setHydrationStatus] = useState<HydrationStatus>('idle');
  const [lastEventId, setLastEventId] = useState(0);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [guild, setGuild] = useState<GuildState>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [quests, setQuests] = useState<QuestState[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [worldState, setWorldState] = useState<WorldState>(null);
  const [narrativeState, setNarrativeState] = useState<NarrativeState>(null);
  const [factionStandings, setFactionStandings] = useState<FactionStanding[]>([]);
  const [npcRelationships, setNpcRelationships] = useState<NpcRelationship[]>([]);
  const [notifications, setNotifications] = useState<RealtimeEventEnvelope[]>([]);
  const [npcDialogues, setNpcDialogues] = useState<Record<string, string>>({});
  const questsRef = useRef<QuestState[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const scopesRef = useRef<Scope[]>([]);
  const lastEventIdRef = useRef(0);
  const hasSubmittedQuest = quests.some((quest) => quest.status === 'SUBMITTED');

  function clearState() {
    setHydrationStatus('idle');
    setConnectionStatus('idle');
    setLastEventId(0);
    lastEventIdRef.current = 0;
    setPlayer(null);
    setGuild(null);
    setLeaderboard([]);
    setQuests([]);
    setInventory([]);
    setWorldState(null);
    setNarrativeState(null);
    setFactionStandings([]);
    setNpcRelationships([]);
    setNotifications([]);
    setNpcDialogues({});
    scopesRef.current = [];
    questsRef.current = [];
  }

  function disconnectSocket() {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }

  useEffect(() => {
    questsRef.current = quests;
  }, [quests]);

  function upsertQuest(quest: QuestState) {
    setQuests((current) => {
      const next = mergeQuestCollections(current, [quest], 'local-upsert');
      console.info('[Realtime] Quest upsert applied', {
        questId: quest.id ?? null,
        chainQuestId: quest.chainQuestId ?? null,
        totalQuests: next.length
      });
      return next;
    });
  }

  function patchQuest(matcher: QuestMatcher, patch: Partial<QuestState>) {
    const normalizedPatch = normalizeQuestState(compactDefined(patch as Record<string, unknown>) as QuestState);

    setQuests((current) =>
      current.map((quest) =>
        matchesQuest(quest, matcher) ? mergeQuestState(quest, normalizedPatch, 'local-patch') : quest
      )
    );
  }

  function getQuest(matcher: QuestMatcher) {
    return questsRef.current.find((quest) => matchesQuest(quest, matcher)) ?? null;
  }

  function setNpcDialogue(npcName: string, dialogue: string) {
    setNpcDialogues((current) => ({
      ...current,
      [npcName]: dialogue
    }));
  }

  function applyRealtimeEvent(event: RealtimeEventEnvelope) {
    const payload = event.payload;
    const questId = asString(payload.questId);
    const chainQuestId = asString(payload.chainQuestId);
    const orchestrationId = asString(payload.orchestrationId);

    console.debug('[Realtime] Applying event', {
      eventName: event.eventName,
      eventId: event.id ?? null,
      questId: questId ?? null,
      chainQuestId: chainQuestId ?? null,
      orchestrationId: orchestrationId ?? null
    });

    setNotifications((current) => sortNotifications(uniqueById([{ ...event, id: event.id ?? Date.now() }, ...current])));
    if (event.id && event.id > lastEventIdRef.current) {
      lastEventIdRef.current = event.id;
      setLastEventId(event.id);
    }

    switch (event.eventName) {
      case 'quest:generated':
      case 'quest:escalated':
        if (questId) {
          const generation = asObject(payload.generation);
          const npc = asObject(payload.npc);
          upsertQuest({
            id: questId,
            orchestrationId,
            title: asString(payload.title),
            description: asString(payload.description),
            lore: asString(payload.lore),
            difficulty: payload.difficulty as QuestState['difficulty'],
            questType: asString(payload.questType),
            objective: asString(payload.objective),
            stakeAmount: payload.stakeAmount as QuestState['stakeAmount'],
            rewardAmount: payload.rewardAmount as QuestState['rewardAmount'],
            xpReward: payload.xpReward as QuestState['xpReward'],
            durationSeconds: payload.durationSeconds as QuestState['durationSeconds'],
            estimatedDurationSeconds: payload.estimatedDurationSeconds as QuestState['estimatedDurationSeconds'],
            requiredTxTypes: Array.isArray(payload.requiredTxTypes)
              ? payload.requiredTxTypes.filter((value): value is string => typeof value === 'string')
              : undefined,
            riskLevel: payload.riskLevel,
            generation: generation ?? undefined,
            npc: npc ?? undefined,
            worldStateVersion: payload.worldStateVersion,
            status: asString(payload.status) ?? 'AVAILABLE'
          });
        }
        break;
      case 'quest:created':
      case 'quest:started':
      case 'proof:submitted':
      case 'reward:claimed':
      case 'reward:reserved':
      case 'stake:locked':
      case 'reward:released':
      case 'reward:paid':
      case 'reward:refunded':
      case 'nft:minted':
        if (questId || chainQuestId) {
          const treasuryStatus = treasuryStatusForEvent(event.eventName);
          const verificationPatch = verificationPatchForEvent(event.eventName, payload);
          patchQuest(
            { id: questId, chainQuestId },
            {
              chainQuestId,
              status: questStatusForEvent(event.eventName, payload),
              proofTx: asString(payload.proofTx),
              proofTxHash: asString(payload.proofTxHash),
              verificationTx: asString(payload.verificationTx),
              verificationResult: verificationPatch.verificationResult,
              verificationReason: verificationPatch.verificationReason,
              treasuryPayout:
                event.eventName.startsWith('reward:') || event.eventName === 'stake:locked'
                  ? {
                      ...(asObject(payload.treasuryPayout) ?? {}),
                      status: treasuryStatus
                    }
                  : undefined
            }
          );
        }

        if (event.eventName === 'nft:minted') {
          const nestedData = asObject(payload.data);
          const tokenId = nestedData?.tokenId !== undefined ? String(nestedData.tokenId) : undefined;

          if (tokenId) {
            setInventory((current) =>
              uniqueInventory([
                {
                  id: `token-${tokenId}`,
                  tokenId,
                  mintedAt: event.createdAt,
                  metadataUri: '',
                  rarity: 'Unrevealed'
                },
                ...current
              ])
            );
          }
        }
        break;
      case 'world:event-changed':
        setWorldState((current) => ({
          ...(current ?? {}),
          version: payload.version as number | string | undefined,
          season: payload.season as number | string | undefined,
          activeEvents: payload.activeEvents
        }));
        break;
      case 'faction:status-changed': {
        const factionUpdates = asObjectArray(payload.factions);
        if (factionUpdates.length > 0) {
          setFactionStandings((current) =>
            current.map((standing) => {
              const update = factionUpdates.find((faction) => asString(faction.id) === standing.factionId);
              return update
                ? {
                    ...standing,
                    liveStatus: asString(update.status),
                    liveInfluence: typeof update.influence === 'number' ? update.influence : standing.liveInfluence
                  }
                : standing;
            })
          );
        }
        break;
      }
      case 'npc:interaction-updated': {
        const npcName = asString(payload.npcName);
        const dialogue = asString(payload.dialogue);
        const npcId = asString(payload.npcId);
        const relationshipScore = typeof payload.relationshipScore === 'number' ? payload.relationshipScore : undefined;

        if (npcName && dialogue) {
          setNpcDialogue(npcName, dialogue);
        }

        if (npcId) {
          setNpcRelationships((current) =>
            current.map((relationship) =>
              relationship.npcId === npcId
                ? {
                    ...relationship,
                    trust: relationshipScore ?? relationship.trust
                  }
                : relationship
            )
          );
        }
        break;
      }
      case 'guild:event':
        break;
      default:
        break;
    }
  }

  async function syncNow() {
    if (!address || authStatus !== 'authenticated') {
      return;
    }

    console.info('[Realtime] Sync request started', {
      afterId: lastEventIdRef.current,
      wallet: address
    });

    const response = await fetchRealtimeSync(lastEventIdRef.current);
    const data = response.data as SyncPayload;
    console.info('[Realtime] Sync response received', {
      eventCount: data.events.length,
      afterId: lastEventIdRef.current,
      lastEventId: data.lastEventId ?? null
    });
    data.events.forEach((event) => applyRealtimeEvent(event));
    if (data.lastEventId) {
      lastEventIdRef.current = data.lastEventId;
      setLastEventId(data.lastEventId);
    }
  }

  async function refreshQuestFeed() {
    if (!address || authStatus !== 'authenticated') {
      return;
    }

    console.info('[Realtime] Refreshing quest feed from API', {
      wallet: address
    });

    const response = await fetchActiveQuests();
    const payload = response.data as { quests?: QuestState[] };
    const nextQuests = payload.quests ?? [];

    setQuests((current) => {
      const merged = mergeQuestCollections(current, nextQuests, 'quest-feed-refresh');
      console.info('[Realtime] Quest feed merge completed', {
        incomingQuests: nextQuests.length,
        mergedQuests: merged.length
      });
      return merged;
    });
  }

  async function hydrate() {
    if (!address || authStatus !== 'authenticated') {
      return;
    }

    setHydrationStatus('loading');
    try {
      console.info('[Realtime] Bootstrap hydration started', {
        wallet: address
      });
      const response = await fetchRealtimeBootstrap();
      const data = response.data as BootstrapPayload;

      scopesRef.current = data.connection.scopes;
      lastEventIdRef.current = data.connection.lastEventId ?? 0;
      setLastEventId(data.connection.lastEventId ?? 0);
      setPlayer(data.player);
      setGuild(data.guild);
      setLeaderboard(data.leaderboard ?? []);
      setQuests((current) => mergeQuestCollections(current, data.quests ?? [], 'bootstrap-hydration'));
      setInventory(uniqueInventory(data.inventory ?? []));
      setWorldState(data.worldState);
      setNarrativeState(data.narrativeState);
      setFactionStandings(data.factionStandings ?? []);
      setNpcRelationships(data.npcRelationships ?? []);
      setNotifications(sortNotifications(data.notifications ?? []));
      setHydrationStatus('ready');
      console.info('[Realtime] Bootstrap hydration completed', {
        scopes: data.connection.scopes.length,
        quests: data.quests?.length ?? 0,
        lastEventId: data.connection.lastEventId ?? 0
      });
    } catch (error) {
      console.error(error);
      setHydrationStatus('error');
    }
  }

  useEffect(() => {
    if (!isAuthReady || status !== 'connected' || authStatus !== 'authenticated' || !address) {
      disconnectSocket();
      clearState();
      return;
    }

    void hydrate();
  }, [address, authStatus, isAuthReady, status]);

  useEffect(() => {
    if (!address || hydrationStatus !== 'ready' || authStatus !== 'authenticated') {
      return;
    }

    const socket = io(socketBaseUrl(), {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling']
    });
    socketRef.current = socket;
    setConnectionStatus('connecting');

    const subscribeScopes = () => {
      socket.emit('subscribe:user', address.toLowerCase());
      scopesRef.current.forEach((scope) => {
        if (scope.type === 'clan') {
          socket.emit('subscribe:clan', scope.key);
        }
        if (scope.type === 'faction') {
          socket.emit('subscribe:faction', scope.key);
        }
      });
    };

    const handleEnvelope = (eventName: string) => (payload: RealtimeEventEnvelope) => {
      applyRealtimeEvent({
        ...payload,
        eventName
      });
    };

    const handlers: Array<[string, (payload: RealtimeEventEnvelope) => void]> = [
      ['quest:generated', handleEnvelope('quest:generated')],
      ['quest:escalated', handleEnvelope('quest:escalated')],
      ['quest:created', handleEnvelope('quest:created')],
      ['quest:started', handleEnvelope('quest:started')],
      ['proof:submitted', handleEnvelope('proof:submitted')],
      ['reward:claimed', handleEnvelope('reward:claimed')],
      ['reward:reserved', handleEnvelope('reward:reserved')],
      ['stake:locked', handleEnvelope('stake:locked')],
      ['reward:released', handleEnvelope('reward:released')],
      ['reward:paid', handleEnvelope('reward:paid')],
      ['reward:refunded', handleEnvelope('reward:refunded')],
      ['nft:minted', handleEnvelope('nft:minted')],
      ['world:event-changed', handleEnvelope('world:event-changed')],
      ['faction:status-changed', handleEnvelope('faction:status-changed')],
      ['npc:interaction-updated', handleEnvelope('npc:interaction-updated')],
      ['guild:event', handleEnvelope('guild:event')]
    ];

    socket.on('connect', () => {
      setConnectionStatus('connected');
      subscribeScopes();
      void syncNow();
    });

    socket.io.on('reconnect_attempt', () => {
      setConnectionStatus('reconnecting');
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
    });

    socket.on('connect_error', () => {
      setConnectionStatus('error');
    });

    handlers.forEach(([eventName, handler]) => {
      socket.on(eventName, handler);
    });

    return () => {
      handlers.forEach(([eventName, handler]) => {
        socket.off(eventName, handler);
      });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [address, authStatus, hydrationStatus]);

  useEffect(() => {
    if (authStatus !== 'authenticated') {
      return;
    }

    if (connectionStatus === 'connected') {
      return;
    }

    const intervalMs = hasSubmittedQuest ? 2500 : 10000;
    const timer = window.setInterval(() => {
      void syncNow();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [authStatus, connectionStatus, hasSubmittedQuest]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || connectionStatus === 'connected' || !hasSubmittedQuest) {
      return;
    }

    void syncNow();
  }, [authStatus, connectionStatus, hasSubmittedQuest]);

  const value: RealtimeStateContextValue = {
    connectionStatus,
    hydrationStatus,
    isRealtimeReady: hydrationStatus === 'ready',
    lastEventId,
    player,
    guild,
    leaderboard,
    quests,
    activeQuest: pickActiveQuest(quests),
    inventory,
    worldState,
    narrativeState,
    factionStandings,
    npcRelationships,
    notifications,
    npcDialogues,
    syncNow,
    refreshQuestFeed,
    upsertQuest,
    patchQuest,
    getQuest,
    setNpcDialogue
  };

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeState() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtimeState must be used within RealtimeProvider');
  }

  return context;
}

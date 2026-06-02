import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useWallet } from './WalletContext';
import { env } from '../lib/env';
import { fetchActiveQuests, fetchRealtimeSync } from '../lib/api';

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

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { address } = useWallet();
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [hydrationStatus, setHydrationStatus] = useState<HydrationStatus>('idle');
  const [lastEventId, setLastEventId] = useState(0);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [guild, setGuild] = useState<GuildState>({});
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [quests, setQuests] = useState<QuestState[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [worldState, setWorldState] = useState<WorldState>({});
  const [narrativeState, setNarrativeState] = useState<NarrativeState>(null);
  const [factionStandings, setFactionStandings] = useState<FactionStanding[]>([]);
  const [npcRelationships, setNpcRelationships] = useState<NpcRelationship[]>([]);
  const [notifications, setNotifications] = useState<RealtimeEventEnvelope[]>([]);
  const [npcDialogues, setNpcDialogues] = useState<Record<string, string>>({});
  const socketRef = useRef<Socket | null>(null);

  const activeQuest = player?.id ? pickActiveQuest(quests) : null;
  const isRealtimeReady = connectionStatus === 'connected' && hydrationStatus === 'ready';

  const syncNow = async () => {
    try {
      setHydrationStatus('loading');
      const res = await fetchRealtimeSync(lastEventId);
      if (res.data?.events) {
        setLastEventId(res.data.lastEventId ?? lastEventId);
        setNotifications(prev => sortNotifications([...prev, ...res.data.events]));
      }
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setHydrationStatus('ready');
    }
  };

  const refreshQuestFeed = async () => {
    try {
      const res = await fetchActiveQuests();
      if (res.data?.quests) {
        setQuests(res.data.quests);
      }
    } catch (err) {
      console.error('Failed to refresh quest feed:', err);
    }
  };

  const upsertQuest = (quest: QuestState) => {
    setQuests(prev => {
      const idx = prev.findIndex(q => q.id === quest.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...quest };
        return updated;
      }
      return [...prev, quest];
    });
  };

  const patchQuest = (matcher: QuestMatcher, patch: Partial<QuestState>) => {
    setQuests(prev =>
      prev.map(q => {
        if (matcher.id && q.id === matcher.id) return { ...q, ...patch };
        if (matcher.chainQuestId && q.chainQuestId === matcher.chainQuestId) return { ...q, ...patch };
        if (matcher.orchestrationId && q.orchestrationId === matcher.orchestrationId) return { ...q, ...patch };
        return q;
      })
    );
  };

  const getQuest = (matcher: QuestMatcher) => {
    return quests.find(q => {
      if (matcher.id && q.id === matcher.id) return true;
      if (matcher.chainQuestId && q.chainQuestId === matcher.chainQuestId) return true;
      if (matcher.orchestrationId && q.orchestrationId === matcher.orchestrationId) return true;
      return false;
    }) ?? null;
  };

  const setNpcDialogue = (npcName: string, dialogue: string) => {
    setNpcDialogues(prev => ({ ...prev, [npcName]: dialogue }));
  };

  useEffect(() => {
    if (!address) {
      setConnectionStatus('disconnected');
      setHydrationStatus('idle');
      return;
    }

    setConnectionStatus('connecting');
    setHydrationStatus('loading');

    const url = socketBaseUrl();
    const socket = io(url, {
      path: '/socket.io',
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setConnectionStatus('connected');
      socket.emit('auth', { address });
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
    });

    socket.on('error', () => {
      setConnectionStatus('error');
    });

    socket.on('reconnecting', () => {
      setConnectionStatus('reconnecting');
    });

    socket.on('bootstrap', async (payload: BootstrapPayload) => {
      try {
        setLastEventId(payload.connection.lastEventId ?? 0);
        setPlayer(payload.player);
        setGuild(payload.guild);
        setLeaderboard(payload.leaderboard ?? []);
        setQuests(payload.quests ?? []);
        setInventory(payload.inventory ?? []);
        setWorldState(payload.worldState);
        setNarrativeState(payload.narrativeState);
        setFactionStandings(payload.factionStandings ?? []);
        setNpcRelationships(payload.npcRelationships ?? []);
        setNotifications(payload.notifications ?? []);
        setHydrationStatus('ready');
      } catch (err) {
        console.error('Bootstrap failed:', err);
        setHydrationStatus('error');
      }
    });

    socket.on('event', (event: RealtimeEventEnvelope) => {
      setNotifications(prev => sortNotifications([...prev, event]));
      setLastEventId(Math.max(lastEventId, event.id ?? 0));
    });

    return () => {
      socket.disconnect();
    };
  }, [address]);

  const value: RealtimeStateContextValue = {
    connectionStatus,
    hydrationStatus,
    isRealtimeReady,
    lastEventId,
    player,
    guild,
    leaderboard,
    quests,
    activeQuest,
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
    setNpcDialogue,
  };

  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtimeState() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtimeState must be used within RealtimeProvider');
  }
  return context;
}

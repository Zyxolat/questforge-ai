import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './chain';
import { logger } from './logger';
import type {
  FactionStatus,
  QuestRarity,
  WorldConflictState,
  WorldFactionState,
  WorldStateEventSummary,
  WorldStateSnapshotData
} from './questOrchestrationTypes';
import { realtimeEventPublisher } from './realtimeEventPublisher';

const DEFAULT_FACTIONS = [
  {
    id: 'forgeguard',
    name: 'Forgeguard Compact',
    alignment: 'ally' as const,
    hooks: ['protect supply routes', 'guard the proving grounds']
  },
  {
    id: 'ledgerborn',
    name: 'Ledgerborn Syndicate',
    alignment: 'neutral' as const,
    hooks: ['extract hidden value', 'broker risky pacts']
  },
  {
    id: 'verdant-circle',
    name: 'Verdant Circle',
    alignment: 'ally' as const,
    hooks: ['restore sacred groves', 'stabilize seasonal shrines']
  },
  {
    id: 'ashen-dagger',
    name: 'Ashen Dagger',
    alignment: 'rival' as const,
    hooks: ['sabotage rival factions', 'capture unstable relics']
  }
] as const;

type StoredStateRecord = {
  id: string;
  version: number;
  trigger: string;
  seasonKey: string;
  stateHash: string;
  state: Prisma.JsonValue;
  sourceEventIds: string[];
  changedKeys: string[];
  createdAt: Date;
};

type CoordinatorDiagnostics = {
  initialized: boolean;
  activeVersion: number | null;
  lastStateHash: string | null;
  lastRefreshAt: string | null;
  totalRefreshes: number;
  emittedWorldChanges: number;
  emittedFactionChanges: number;
};

class WorldStateCoordinator {
  private initialized = false;
  private diagnostics: CoordinatorDiagnostics = {
    initialized: false,
    activeVersion: null,
    lastStateHash: null,
    lastRefreshAt: null,
    totalRefreshes: 0,
    emittedWorldChanges: 0,
    emittedFactionChanges: 0
  };

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.refreshWorldState({ trigger: 'startup' });
    this.initialized = true;
    this.diagnostics.initialized = true;
  }

  async getCurrentWorldState(trigger = 'read'): Promise<WorldStateSnapshotData> {
    const current = await this.findLatestSnapshot();

    if (current) {
      this.updateDiagnostics(current);
      return this.fromStoredSnapshot(current);
    }

    return this.refreshWorldState({ trigger });
  }

  async refreshWorldState(input: { trigger: string; force?: boolean } ): Promise<WorldStateSnapshotData> {
    const [activeEvents, latestSnapshot, recentQuests] = await Promise.all([
      prisma.worldEvent.findMany({
        where: {
          isActive: true,
          startTime: { lte: new Date() },
          endTime: { gte: new Date() }
        },
        orderBy: [{ multiplier: 'desc' }, { reward: 'desc' }],
        take: 8
      }),
      this.findLatestSnapshot(),
      prisma.quest.findMany({
        where: {
          status: { in: ['ACCEPTED', 'COMPLETED', 'CLAIMABLE', 'REWARDED'] }
        },
        select: {
          id: true,
          difficulty: true,
          status: true,
          metadata: true
        },
        orderBy: { updatedAt: 'desc' },
        take: 40
      })
    ]);

    const failureCount = await prisma.questHistory.count({
      where: {
        questId: { in: recentQuests.map((quest) => quest.id) },
        action: 'FAILED'
      }
    });

    const recentFailureRate = recentQuests.length > 0 ? failureCount / recentQuests.length : 0;
    const season = this.computeSeason(new Date());
    const eventSummaries = activeEvents.map<WorldStateEventSummary>((event: {
      id: string;
      name: string;
      type: string;
      multiplier: number;
      reward: number;
      difficulty: number;
      description: string;
    }) => ({
      id: event.id,
      name: event.name,
      type: event.type,
      multiplier: event.multiplier,
      reward: event.reward,
      difficulty: event.difficulty,
      description: event.description
    }));
    const factions = this.computeFactionStates(eventSummaries, recentQuests, recentFailureRate);
    const activeConflicts = this.computeActiveConflicts(eventSummaries, factions);
    const questThemes = this.computeQuestThemes(season.key, eventSummaries, factions);
    const seasonalContent = this.computeSeasonalContent(season.key, eventSummaries);
    const npcTones = this.computeNpcTones(season.key, factions);
    const rarityWeights = this.computeRarityWeights(eventSummaries, activeConflicts);
    const worldMultiplier = this.computeWorldMultiplier(eventSummaries);

    const stateWithoutDiagnostics = {
      version: latestSnapshot?.version ? latestSnapshot.version + 1 : 1,
      generatedAt: new Date().toISOString(),
      season,
      activeEvents: eventSummaries,
      factions,
      activeConflicts,
      questThemes,
      seasonalContent,
      npcTones,
      rarityWeights,
      worldMultiplier
    };

    const stateHash = this.hashState(stateWithoutDiagnostics);
    const previous = latestSnapshot ? this.fromStoredSnapshot(latestSnapshot) : null;

    if (!input.force && latestSnapshot && latestSnapshot.stateHash === stateHash) {
      this.updateDiagnostics(latestSnapshot);
      return previous!;
    }

    const changedKeys = this.computeChangedKeys(previous, stateWithoutDiagnostics);
    const nextVersion = latestSnapshot?.version ? latestSnapshot.version + 1 : 1;
    const snapshotState: WorldStateSnapshotData = {
      ...stateWithoutDiagnostics,
      version: nextVersion,
      diagnostics: {
        trigger: input.trigger,
        stateHash,
        sourceEventCount: eventSummaries.length
      }
    };

    const persisted = await prisma.$transaction(async (tx) => {
      if (latestSnapshot) {
        await tx.$executeRaw`
          UPDATE "WorldStateSnapshot"
          SET "isActive" = false
          WHERE "isActive" = true
        `;
      }

      const id = crypto.randomUUID();
      const [created] = await tx.$queryRaw<StoredStateRecord[]>(
        Prisma.sql`
          INSERT INTO "WorldStateSnapshot" (
            id,
            version,
            "snapshotType",
            trigger,
            "seasonKey",
            "stateHash",
            "sourceEventIds",
            "changedKeys",
            "isActive",
            state,
            "createdAt",
            "updatedAt"
          )
          VALUES (
            ${id},
            ${nextVersion},
            'global',
            ${input.trigger},
            ${season.key},
            ${stateHash},
            ${eventSummaries.map((event: WorldStateEventSummary) => event.id)},
            ${changedKeys},
            true,
            ${JSON.stringify(snapshotState)}::jsonb,
            NOW(),
            NOW()
          )
          RETURNING
            id,
            version,
            trigger,
            "seasonKey" AS "seasonKey",
            "stateHash" AS "stateHash",
            state,
            "sourceEventIds" AS "sourceEventIds",
            "changedKeys" AS "changedKeys",
            "createdAt" AS "createdAt"
        `
      );

      return created;
    });

    this.updateDiagnostics(persisted);
    await this.emitSnapshotChanges(previous, snapshotState, changedKeys);

    logger.info('[WORLD] Snapshot refreshed', {
      version: snapshotState.version,
      trigger: input.trigger,
      stateHash,
      activeEvents: snapshotState.activeEvents.length,
      factionCount: snapshotState.factions.length
    });

    return snapshotState;
  }

  async handleGameplaySignal(input: {
    trigger: string;
    chainQuestId?: string;
    playerWallet?: string;
  }): Promise<void> {
    await this.refreshWorldState({ trigger: input.trigger });
    logger.debug('[WORLD] Gameplay signal processed', input);
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }

  private async findLatestSnapshot(): Promise<StoredStateRecord | null> {
    const [snapshot] = await prisma.$queryRaw<StoredStateRecord[]>(
      Prisma.sql`
        SELECT
          id,
          version,
          trigger,
          "seasonKey" AS "seasonKey",
          "stateHash" AS "stateHash",
          state,
          "sourceEventIds" AS "sourceEventIds",
          "changedKeys" AS "changedKeys",
          "createdAt" AS "createdAt"
        FROM "WorldStateSnapshot"
        WHERE "isActive" = true
        ORDER BY version DESC
        LIMIT 1
      `
    );

    return snapshot ?? null;
  }

  private computeSeason(now: Date) {
    const month = now.getUTCMonth() + 1;

    if (month >= 3 && month <= 5) {
      return { key: 'season-vernal', label: 'Vernal Reawakening', theme: 'renewal and discovery' };
    }

    if (month >= 6 && month <= 8) {
      return { key: 'season-solar', label: 'Solar Ascendance', theme: 'heat, ambition, and escalation' };
    }

    if (month >= 9 && month <= 11) {
      return { key: 'season-harvest', label: 'Harvest of Echoes', theme: 'reckoning and consolidation' };
    }

    return { key: 'season-ember', label: 'Ember Vigil', theme: 'scarcity, resilience, and omen' };
  }

  private computeFactionStates(
    activeEvents: WorldStateEventSummary[],
    recentQuests: Array<{ difficulty: number; status: string; metadata: Prisma.JsonValue }>,
    recentFailureRate: number
  ): WorldFactionState[] {
    const activeConflictBonus = activeEvents.some((event) => event.type.includes('faction')) ? 0.15 : 0;
    const recentDifficultyAverage =
      recentQuests.length > 0
        ? recentQuests.reduce((sum, quest) => sum + quest.difficulty, 0) / recentQuests.length
        : 2.5;

    return DEFAULT_FACTIONS.map((faction, index) => {
      const pressure = (index + 1) * 0.08 + activeConflictBonus + recentFailureRate * 0.2;
      const influence = Number(Math.min(1, 0.35 + pressure + recentDifficultyAverage * 0.05).toFixed(3));
      const conflictScore = Number(
        Math.min(1, pressure + activeEvents.filter((event) => event.type.includes('war')).length * 0.12).toFixed(3)
      );

      return {
        id: faction.id,
        name: faction.name,
        alignment: faction.alignment,
        influence,
        conflictScore,
        status: this.statusFromFactionSignals(influence, conflictScore),
        narrativeHooks: [...faction.hooks]
      };
    });
  }

  private statusFromFactionSignals(influence: number, conflictScore: number): FactionStatus {
    if (conflictScore >= 0.8) return 'contested';
    if (influence >= 0.85) return 'dominant';
    if (influence >= 0.65) return 'rising';
    if (influence <= 0.4) return 'weakened';
    return 'stable';
  }

  private computeActiveConflicts(
    activeEvents: WorldStateEventSummary[],
    factions: WorldFactionState[]
  ): WorldConflictState[] {
    const factionWar = activeEvents.find((event) => event.type.includes('faction'));
    const primary = factions[0];
    const rival = factions.find((faction) => faction.alignment === 'rival') ?? factions[1];

    const conflicts: WorldConflictState[] = [
      {
        id: factionWar?.id ?? 'baseline-conflict',
        label: factionWar?.name ?? `${primary.name} vs ${rival.name}`,
        factions: [primary.id, rival.id],
        intensity: Number(Math.min(1, 0.45 + (factionWar?.multiplier ?? 1) * 0.2).toFixed(3)),
        summary:
          factionWar?.description ??
          `${primary.name} and ${rival.name} are contesting control of the current mission lanes.`
      }
    ];

    if (activeEvents.some((event) => event.type.includes('seasonal'))) {
      conflicts.push({
        id: 'seasonal-pressure',
        label: 'Seasonal Pressure Front',
        factions: [primary.id, factions[2]?.id ?? primary.id],
        intensity: 0.52,
        summary: 'Seasonal instability is forcing allied factions into uneasy cooperation.'
      });
    }

    return conflicts;
  }

  private computeQuestThemes(
    seasonKey: string,
    activeEvents: WorldStateEventSummary[],
    factions: WorldFactionState[]
  ) {
    const themes = new Set<string>([
      'prove control of an onchain corridor',
      'secure a contested asset before rivals arrive',
      'restore order through verifiable action'
    ]);

    if (seasonKey === 'season-solar') themes.add('outrun a rising heatwave of faction ambition');
    if (seasonKey === 'season-harvest') themes.add('collect fractured relic signatures before they decay');
    if (seasonKey === 'season-ember') themes.add('hold a fragile route against attrition and sabotage');
    if (seasonKey === 'season-vernal') themes.add('reawaken dormant shrines with precise chain actions');

    activeEvents.forEach((event) => themes.add(`${event.name.toLowerCase()} fallout response`));
    factions.slice(0, 2).forEach((faction) => themes.add(`${faction.name.toLowerCase()} operational pressure`));

    return [...themes].slice(0, 8);
  }

  private computeSeasonalContent(seasonKey: string, activeEvents: WorldStateEventSummary[]) {
    const content = new Set<string>();

    if (seasonKey === 'season-vernal') content.add('bloom rites');
    if (seasonKey === 'season-solar') content.add('sunforge skirmishes');
    if (seasonKey === 'season-harvest') content.add('echo harvest rites');
    if (seasonKey === 'season-ember') content.add('ember watch rotations');

    activeEvents.forEach((event) => content.add(event.type.replace(/_/g, ' ')));
    return [...content].slice(0, 6);
  }

  private computeNpcTones(seasonKey: string, factions: WorldFactionState[]) {
    const tones = new Set<string>(['measured', 'watchful', 'strategic']);

    if (seasonKey === 'season-solar') tones.add('urgent');
    if (seasonKey === 'season-ember') tones.add('grim');

    factions.filter((faction) => faction.status === 'contested').forEach(() => tones.add('suspicious'));
    factions.filter((faction) => faction.status === 'dominant').forEach(() => tones.add('confident'));

    return [...tones].slice(0, 5);
  }

  private computeRarityWeights(
    activeEvents: WorldStateEventSummary[],
    activeConflicts: WorldConflictState[]
  ): Record<QuestRarity, number> {
    const pressure = Math.min(
      0.35,
      activeEvents.length * 0.03 + activeConflicts.reduce((sum, conflict) => sum + conflict.intensity, 0) * 0.05
    );

    return {
      common: Number(Math.max(0.2, 0.45 - pressure).toFixed(3)),
      uncommon: Number(Math.max(0.18, 0.25 - pressure * 0.3).toFixed(3)),
      rare: Number(Math.min(0.28, 0.18 + pressure * 0.5).toFixed(3)),
      epic: Number(Math.min(0.2, 0.08 + pressure * 0.35).toFixed(3)),
      legendary: Number(Math.min(0.1, 0.04 + pressure * 0.2).toFixed(3))
    };
  }

  private computeWorldMultiplier(activeEvents: WorldStateEventSummary[]) {
    const combined = activeEvents.reduce((max, event) => Math.max(max, event.multiplier), 1);
    return Number(Math.min(1.5, combined).toFixed(3));
  }

  private hashState(value: Omit<WorldStateSnapshotData, 'diagnostics'>) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private computeChangedKeys(
    previous: WorldStateSnapshotData | null,
    next: Omit<WorldStateSnapshotData, 'diagnostics'>
  ) {
    if (!previous) {
      return ['bootstrap'];
    }

    const changed: string[] = [];

    if (previous.season.key !== next.season.key) changed.push('season');
    if (JSON.stringify(previous.activeEvents) !== JSON.stringify(next.activeEvents)) changed.push('activeEvents');
    if (JSON.stringify(previous.factions) !== JSON.stringify(next.factions)) changed.push('factions');
    if (JSON.stringify(previous.activeConflicts) !== JSON.stringify(next.activeConflicts)) changed.push('conflicts');
    if (JSON.stringify(previous.questThemes) !== JSON.stringify(next.questThemes)) changed.push('questThemes');
    if (JSON.stringify(previous.seasonalContent) !== JSON.stringify(next.seasonalContent)) changed.push('seasonalContent');
    if (JSON.stringify(previous.npcTones) !== JSON.stringify(next.npcTones)) changed.push('npcTones');
    if (JSON.stringify(previous.rarityWeights) !== JSON.stringify(next.rarityWeights)) changed.push('rarityWeights');

    return changed.length ? changed : ['no-op'];
  }

  private async emitSnapshotChanges(
    previous: WorldStateSnapshotData | null,
    next: WorldStateSnapshotData,
    changedKeys: string[]
  ) {
    await realtimeEventPublisher.publish({
      replayKey: `world-state:${next.version}`,
      eventName: 'world:event-changed',
      sourceType: 'world_state',
      sourceId: String(next.version),
      payload: {
        version: next.version,
        changedKeys,
        activeEvents: next.activeEvents,
        season: next.season,
        timestamp: next.generatedAt
      },
      scopes: [{ type: 'global', key: 'global' }]
    });
    this.diagnostics.emittedWorldChanges += 1;

    const previousStatusByFaction = new Map(
      (previous?.factions ?? []).map((faction) => [faction.id, faction.status])
    );
    const changedFactions = next.factions.filter(
      (faction) => previousStatusByFaction.get(faction.id) !== faction.status
    );

    if (changedFactions.length > 0) {
      await realtimeEventPublisher.publish({
        replayKey: `faction-status:${next.version}`,
        eventName: 'faction:status-changed',
        sourceType: 'world_state',
        sourceId: String(next.version),
        payload: {
          version: next.version,
          factions: changedFactions,
          timestamp: next.generatedAt
        },
        scopes: [
          { type: 'global', key: 'global' },
          ...changedFactions.map((faction) => ({ type: 'faction' as const, key: faction.id }))
        ]
      });
      this.diagnostics.emittedFactionChanges += 1;
    }
  }

  private fromStoredSnapshot(record: StoredStateRecord | {
    version: number;
    trigger: string;
    stateHash: string;
    state: Prisma.JsonValue;
  }) {
    if (typeof record.state !== 'object' || !record.state || Array.isArray(record.state)) {
      throw new Error('Stored world state snapshot is malformed');
    }

    return record.state as unknown as WorldStateSnapshotData;
  }

  private updateDiagnostics(record: {
    version: number;
    stateHash: string;
    createdAt?: Date;
  }) {
    this.diagnostics.activeVersion = record.version;
    this.diagnostics.lastStateHash = record.stateHash;
    this.diagnostics.lastRefreshAt = record.createdAt?.toISOString() ?? new Date().toISOString();
    this.diagnostics.totalRefreshes += 1;
  }
}

export const worldStateCoordinator = new WorldStateCoordinator();

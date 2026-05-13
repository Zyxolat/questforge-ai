import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './chain';
import { aiMemoryGraph } from './aiMemoryGraph';

type FactionInfluenceInput = {
  userId: string;
  factionId: string;
  factionName: string;
  questId?: string | null;
  chainEventId?: string | null;
  eventType: string;
  standingDelta: number;
  summary: string;
  flags?: string[];
  metadata?: Record<string, unknown>;
  seasonKey?: string | null;
  eventTimestamp?: Date;
};

type FactionStandingRow = {
  id: string;
  userId: string;
  factionId: string;
  factionName: string;
  standingScore: number;
  influenceRank: string;
  allianceStatus: string;
  narrativeFlags: string[];
  metadata: Prisma.JsonValue;
  lastChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function influenceRankFromScore(score: number) {
  if (score >= 80) return 'paragon';
  if (score >= 45) return 'champion';
  if (score >= 15) return 'ally';
  if (score <= -45) return 'enemy';
  if (score < 0) return 'suspect';
  return 'neutral';
}

function allianceStatusFromScore(score: number) {
  if (score >= 45) return 'allied';
  if (score >= 10) return 'friendly';
  if (score <= -35) return 'hostile';
  if (score < 0) return 'contested';
  return 'neutral';
}

class FactionInfluenceEngine {
  async applyInfluence(input: FactionInfluenceInput) {
    const existingRows = await prisma.$queryRaw<FactionStandingRow[]>(
      Prisma.sql`
        SELECT
          id,
          "userId",
          "factionId",
          "factionName",
          "standingScore",
          "influenceRank",
          "allianceStatus",
          "narrativeFlags",
          metadata,
          "lastChangedAt",
          "createdAt",
          "updatedAt"
        FROM "FactionStanding"
        WHERE "userId" = ${input.userId}
          AND "factionId" = ${input.factionId}
        LIMIT 1
      `
    );
    const existing = existingRows[0] ?? null;
    const nextStanding = Number(Math.max(-100, Math.min(100, (existing?.standingScore ?? 0) + input.standingDelta)).toFixed(3));
    const allianceStatus = allianceStatusFromScore(nextStanding);
    const influenceRank = influenceRankFromScore(nextStanding);
    const mergedFlags = [...new Set([...(existing?.narrativeFlags ?? []), ...(input.flags ?? [])])];
    const mergedMetadata = {
      ...(existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata : {}),
      ...(input.metadata ?? {}),
      lastSummary: input.summary
    };

    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "FactionStanding" (
          id,
          "userId",
          "factionId",
          "factionName",
          "standingScore",
          "influenceRank",
          "allianceStatus",
          "narrativeFlags",
          metadata,
          "lastChangedAt",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${existing?.id ?? crypto.randomUUID()},
          ${input.userId},
          ${input.factionId},
          ${input.factionName},
          ${nextStanding},
          ${influenceRank},
          ${allianceStatus},
          ARRAY[${Prisma.join(mergedFlags.map((flag) => Prisma.sql`${flag}`))}]::TEXT[],
          ${JSON.stringify(mergedMetadata)}::jsonb,
          ${input.eventTimestamp ?? new Date()},
          COALESCE(${existing?.createdAt ?? null}, NOW()),
          NOW()
        )
        ON CONFLICT ("userId", "factionId") DO UPDATE
        SET
          "factionName" = EXCLUDED."factionName",
          "standingScore" = EXCLUDED."standingScore",
          "influenceRank" = EXCLUDED."influenceRank",
          "allianceStatus" = EXCLUDED."allianceStatus",
          "narrativeFlags" = EXCLUDED."narrativeFlags",
          metadata = EXCLUDED.metadata,
          "lastChangedAt" = EXCLUDED."lastChangedAt",
          "updatedAt" = NOW()
      `
    );

    await aiMemoryGraph.recordMemory({
      replayKey: `faction:${input.userId}:${input.factionId}:${input.eventType}:${input.chainEventId ?? input.questId ?? 'none'}`,
      memoryType: 'faction_choice',
      summary: input.summary,
      metadata: {
        standingScore: nextStanding,
        allianceStatus,
        influenceRank,
        eventType: input.eventType,
        ...(input.metadata ?? {})
      },
      userId: input.userId,
      questId: input.questId ?? null,
      seasonKey: input.seasonKey ?? null,
      eventTimestamp: input.eventTimestamp,
      importanceScore: 1 + Math.abs(input.standingDelta) / 10
    });

    return {
      factionId: input.factionId,
      factionName: input.factionName,
      standingScore: nextStanding,
      allianceStatus,
      influenceRank,
      narrativeFlags: mergedFlags
    };
  }

  async getFactionStandings(userId: string) {
    return prisma.$queryRaw<FactionStandingRow[]>(
      Prisma.sql`
        SELECT
          id,
          "userId",
          "factionId",
          "factionName",
          "standingScore",
          "influenceRank",
          "allianceStatus",
          "narrativeFlags",
          metadata,
          "lastChangedAt",
          "createdAt",
          "updatedAt"
        FROM "FactionStanding"
        WHERE "userId" = ${userId}
        ORDER BY "standingScore" DESC, "updatedAt" DESC
      `
    );
  }
}

export const factionInfluenceEngine = new FactionInfluenceEngine();

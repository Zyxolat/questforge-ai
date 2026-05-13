import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './chain';
import { aiMemoryGraph } from './aiMemoryGraph';
import { factionInfluenceEngine } from './factionInfluenceEngine';
import { npcRelationshipEngine } from './npcRelationshipEngine';

type NarrativeStateRow = {
  id: string;
  userId: string;
  currentArc: string;
  narrativeVersion: number;
  reputationTier: string;
  lastMemoryAt: Date | null;
  factionStandingSummary: Prisma.JsonValue;
  npcTrustSummary: Prisma.JsonValue;
  stateData: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

function reputationTierFromSignals(input: {
  verifiedCount: number;
  failedCount: number;
  maxFactionScore: number;
  maxNpcTrust: number;
}) {
  const baseScore = input.verifiedCount * 2 - input.failedCount + input.maxFactionScore / 20 + input.maxNpcTrust * 4;
  if (baseScore >= 18) return 'legend';
  if (baseScore >= 10) return 'vanguard';
  if (baseScore >= 4) return 'seasoned';
  return 'initiate';
}

class PlayerNarrativeStateService {
  async projectForUser(userId: string) {
    const [memories, factionStandings, npcRelationships] = await Promise.all([
      aiMemoryGraph.restorePlayerMemoryGraph({ userId, limit: 24 }),
      factionInfluenceEngine.getFactionStandings(userId),
      this.getNpcRelationshipsForUser(userId)
    ]);

    const verifiedCount = memories.timeline.filter((entry) => entry.memoryType === 'quest_outcome' && entry.summary.toLowerCase().includes('verified')).length;
    const failedCount = memories.timeline.filter((entry) => entry.summary.toLowerCase().includes('failed')).length;
    const maxFactionScore = factionStandings[0]?.standingScore ?? 0;
    const maxNpcTrust = npcRelationships[0]?.trust ?? 0;
    const reputationTier = reputationTierFromSignals({
      verifiedCount,
      failedCount,
      maxFactionScore,
      maxNpcTrust
    });
    const currentArc = this.determineArc({
      factionStandings,
      npcRelationships,
      recentMemories: memories.summary
    });
    const factionSummary = factionStandings.slice(0, 4).map((standing) => ({
      factionId: standing.factionId,
      factionName: standing.factionName,
      standingScore: standing.standingScore,
      allianceStatus: standing.allianceStatus,
      influenceRank: standing.influenceRank
    }));
    const npcSummary = npcRelationships.slice(0, 5).map((relationship) => ({
      npcId: relationship.npcId,
      npcName: relationship.npcName,
      trust: relationship.trust,
      opinion: relationship.opinion,
      unlocks: relationship.unlocks
    }));
    const stateData = {
      recentMemories: memories.summary,
      semanticHighlights: memories.semanticMatches.map((entry) => entry.summary),
      rivalryCount: factionStandings.filter((standing) => standing.allianceStatus === 'hostile').length,
      allianceCount: factionStandings.filter((standing) => standing.allianceStatus === 'allied').length,
      specialMissionEligible: npcRelationships.some((relationship) => relationship.unlocks.includes('special_missions'))
    };

    const existingRows = await prisma.$queryRaw<NarrativeStateRow[]>(
      Prisma.sql`
        SELECT
          id,
          "userId",
          "currentArc",
          "narrativeVersion",
          "reputationTier",
          "lastMemoryAt",
          "factionStandingSummary",
          "npcTrustSummary",
          "stateData",
          "createdAt",
          "updatedAt"
        FROM "PlayerNarrativeState"
        WHERE "userId" = ${userId}
        LIMIT 1
      `
    );
    const existing = existingRows[0] ?? null;
    const nextVersion = existing ? existing.narrativeVersion + 1 : 1;

    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "PlayerNarrativeState" (
          id,
          "userId",
          "currentArc",
          "narrativeVersion",
          "reputationTier",
          "lastMemoryAt",
          "factionStandingSummary",
          "npcTrustSummary",
          "stateData",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${existing?.id ?? crypto.randomUUID()},
          ${userId},
          ${currentArc},
          ${nextVersion},
          ${reputationTier},
          ${memories.timeline[0]?.eventTimestamp ?? null},
          ${JSON.stringify(factionSummary)}::jsonb,
          ${JSON.stringify(npcSummary)}::jsonb,
          ${JSON.stringify(stateData)}::jsonb,
          COALESCE(${existing?.createdAt ?? null}, NOW()),
          NOW()
        )
        ON CONFLICT ("userId") DO UPDATE
        SET
          "currentArc" = EXCLUDED."currentArc",
          "narrativeVersion" = EXCLUDED."narrativeVersion",
          "reputationTier" = EXCLUDED."reputationTier",
          "lastMemoryAt" = EXCLUDED."lastMemoryAt",
          "factionStandingSummary" = EXCLUDED."factionStandingSummary",
          "npcTrustSummary" = EXCLUDED."npcTrustSummary",
          "stateData" = EXCLUDED."stateData",
          "updatedAt" = NOW()
      `
    );

    return {
      userId,
      currentArc,
      narrativeVersion: nextVersion,
      reputationTier,
      lastMemoryAt: memories.timeline[0]?.eventTimestamp ?? null,
      factionStandingSummary: factionSummary,
      npcTrustSummary: npcSummary,
      stateData
    };
  }

  async getNarrativeState(userId: string) {
    const rows = await prisma.$queryRaw<NarrativeStateRow[]>(
      Prisma.sql`
        SELECT
          id,
          "userId",
          "currentArc",
          "narrativeVersion",
          "reputationTier",
          "lastMemoryAt",
          "factionStandingSummary",
          "npcTrustSummary",
          "stateData",
          "createdAt",
          "updatedAt"
        FROM "PlayerNarrativeState"
        WHERE "userId" = ${userId}
        LIMIT 1
      `
    );

    return rows[0] ?? null;
  }

  private async getNpcRelationshipsForUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { wallet: true }
    });

    if (!user) {
      return [];
    }

    return npcRelationshipEngine.getRelationshipsForUser(userId, user.wallet);
  }

  private determineArc(input: {
    factionStandings: Awaited<ReturnType<typeof factionInfluenceEngine.getFactionStandings>>;
    npcRelationships: Awaited<ReturnType<typeof npcRelationshipEngine.getRelationshipsForUser>>;
    recentMemories: string[];
  }) {
    if (input.factionStandings.some((standing) => standing.allianceStatus === 'hostile')) {
      return 'walking a contested path between rival banners';
    }

    if (input.npcRelationships.some((relationship) => relationship.unlocks.includes('special_missions'))) {
      return 'trusted envoy of the forge’s inner circle';
    }

    if (input.recentMemories.some((summary) => summary.toLowerCase().includes('season'))) {
      return 'participant in a season-defining campaign';
    }

    return 'forging a steady reputation across the frontier';
  }
}

export const playerNarrativeState = new PlayerNarrativeStateService();

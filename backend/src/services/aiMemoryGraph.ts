import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './chain';
import { logger } from './logger';

type MemoryRecordInput = {
  replayKey: string;
  memoryType: string;
  summary: string;
  metadata: Record<string, unknown>;
  userId?: string | null;
  npcId?: string | null;
  agentId?: string | null;
  questId?: string | null;
  seasonKey?: string | null;
  eventTimestamp?: Date;
  importanceScore?: number;
};

type MemoryLedgerRow = {
  id: string;
  replayKey: string;
  memoryType: string;
  summary: string;
  importanceScore: number;
  embedding: number[];
  metadata: Prisma.JsonValue;
  seasonKey: string | null;
  eventTimestamp: Date;
  createdAt: Date;
  updatedAt: Date;
  userId: string | null;
  npcId: string | null;
  agentId: string | null;
  questId: string | null;
};

type RestoredMemoryGraph = {
  timeline: MemoryLedgerRow[];
  semanticMatches: MemoryLedgerRow[];
  summary: string[];
};

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function cosineSimilarity(a: number[], b: number[]) {
  const limit = Math.max(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < limit; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class AIMemoryGraph {
  buildEmbedding(text: string) {
    const tokens = tokenize(text);
    const vector = new Array<number>(12).fill(0);

    tokens.forEach((token, tokenIndex) => {
      const hash = crypto.createHash('sha256').update(`${token}:${tokenIndex}`).digest();
      for (let index = 0; index < vector.length; index += 1) {
        vector[index] += hash[index] / 255;
      }
    });

    const normalized = vector.map((value) => Number((value / Math.max(1, tokens.length)).toFixed(6)));
    return normalized;
  }

  async recordMemory(input: MemoryRecordInput): Promise<void> {
    const summary = input.summary.trim().slice(0, 500);
    const embedding = this.buildEmbedding(`${input.memoryType} ${summary} ${JSON.stringify(input.metadata)}`);
    const embeddingSql = Prisma.sql`ARRAY[${Prisma.join(embedding)}]::DOUBLE PRECISION[]`;
    const metadataJson = JSON.stringify(input.metadata);

    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "MemoryLedgerEntry" (
          id,
          "replayKey",
          "memoryType",
          summary,
          "importanceScore",
          embedding,
          metadata,
          "seasonKey",
          "eventTimestamp",
          "createdAt",
          "updatedAt",
          "userId",
          "npcId",
          "agentId",
          "questId"
        )
        VALUES (
          ${crypto.randomUUID()},
          ${input.replayKey},
          ${input.memoryType},
          ${summary},
          ${Number((input.importanceScore ?? 1).toFixed(3))},
          ${embeddingSql},
          ${metadataJson}::jsonb,
          ${input.seasonKey ?? null},
          ${input.eventTimestamp ?? new Date()},
          NOW(),
          NOW(),
          ${input.userId ?? null},
          ${input.npcId ?? null},
          ${input.agentId ?? null},
          ${input.questId ?? null}
        )
        ON CONFLICT ("replayKey") DO NOTHING
      `
    );
  }

  async restorePlayerMemoryGraph(input: {
    userId: string;
    query?: string;
    limit?: number;
  }): Promise<RestoredMemoryGraph> {
    const timeline = await prisma.$queryRaw<MemoryLedgerRow[]>(
      Prisma.sql`
        SELECT
          id,
          "replayKey",
          "memoryType",
          summary,
          "importanceScore",
          embedding,
          metadata,
          "seasonKey",
          "eventTimestamp",
          "createdAt",
          "updatedAt",
          "userId",
          "npcId",
          "agentId",
          "questId"
        FROM "MemoryLedgerEntry"
        WHERE "userId" = ${input.userId}
        ORDER BY "eventTimestamp" DESC, "createdAt" DESC
        LIMIT ${Math.max(10, input.limit ?? 20)}
      `
    );

    const semanticMatches = input.query
      ? [...timeline]
          .map((entry) => ({
            entry,
            score: cosineSimilarity(this.buildEmbedding(input.query || ''), entry.embedding ?? [])
          }))
          .sort((left, right) => right.score - left.score || right.entry.importanceScore - left.entry.importanceScore)
          .slice(0, 5)
          .map((item) => item.entry)
      : timeline.slice(0, 5);

    return {
      timeline,
      semanticMatches,
      summary: timeline.slice(0, 5).map((entry) => entry.summary)
    };
  }

  async getRecentMemoriesForNpc(input: { userId: string; npcId: string; limit?: number }) {
    return prisma.$queryRaw<MemoryLedgerRow[]>(
      Prisma.sql`
        SELECT
          id,
          "replayKey",
          "memoryType",
          summary,
          "importanceScore",
          embedding,
          metadata,
          "seasonKey",
          "eventTimestamp",
          "createdAt",
          "updatedAt",
          "userId",
          "npcId",
          "agentId",
          "questId"
        FROM "MemoryLedgerEntry"
        WHERE "userId" = ${input.userId}
          AND "npcId" = ${input.npcId}
        ORDER BY "eventTimestamp" DESC, "createdAt" DESC
        LIMIT ${input.limit ?? 6}
      `
    );
  }

  async upsertProjectionCursor(input: {
    projectorKey: string;
    lastEventKey: string;
    lastProcessedBlock?: bigint | null;
    projectionVersion: number;
    metrics: Record<string, unknown>;
  }) {
    const stateHash = crypto.createHash('sha256').update(JSON.stringify(input.metrics)).digest('hex');
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "ProjectionCursor" (
          id,
          "projectorKey",
          "projectionVersion",
          "lastEventKey",
          "lastProcessedBlock",
          "lastProcessedAt",
          "stateHash",
          metrics,
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${crypto.randomUUID()},
          ${input.projectorKey},
          ${input.projectionVersion},
          ${input.lastEventKey},
          ${input.lastProcessedBlock ?? null},
          NOW(),
          ${stateHash},
          ${JSON.stringify(input.metrics)}::jsonb,
          NOW(),
          NOW()
        )
        ON CONFLICT ("projectorKey") DO UPDATE
        SET
          "projectionVersion" = EXCLUDED."projectionVersion",
          "lastEventKey" = EXCLUDED."lastEventKey",
          "lastProcessedBlock" = EXCLUDED."lastProcessedBlock",
          "lastProcessedAt" = EXCLUDED."lastProcessedAt",
          "stateHash" = EXCLUDED."stateHash",
          metrics = EXCLUDED.metrics,
          "updatedAt" = NOW()
      `
    );
  }

  async recordDeadLetter(input: {
    projectorKey: string;
    eventKey: string;
    chainEventId?: string | null;
    payload: Record<string, unknown>;
    errorMessage: string;
  }) {
    logger.error('[MEMORY] Projection dead letter recorded', {
      projectorKey: input.projectorKey,
      eventKey: input.eventKey,
      errorMessage: input.errorMessage
    });

    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "ProjectionDeadLetter" (
          id,
          "projectorKey",
          "chainEventId",
          "eventKey",
          payload,
          "errorMessage",
          "retryCount",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${crypto.randomUUID()},
          ${input.projectorKey},
          ${input.chainEventId ?? null},
          ${input.eventKey},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.errorMessage},
          0,
          NOW(),
          NOW()
        )
        ON CONFLICT ("projectorKey", "eventKey") DO UPDATE
        SET
          "errorMessage" = EXCLUDED."errorMessage",
          payload = EXCLUDED.payload,
          "retryCount" = "ProjectionDeadLetter"."retryCount" + 1,
          "updatedAt" = NOW()
      `
    );
  }
}

export const aiMemoryGraph = new AIMemoryGraph();

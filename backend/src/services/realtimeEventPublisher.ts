import { Prisma } from '@prisma/client';
import { prisma } from './chain';
import { productionWebSocketBroadcaster } from './productionWebSocketBroadcaster';

type RealtimeScope = {
  type: 'global' | 'user' | 'clan' | 'faction';
  key: string;
};

type PublishRealtimeEventInput = {
  replayKey: string;
  eventName: string;
  sourceType: string;
  sourceId?: string | null;
  payload: Record<string, unknown>;
  scopes: RealtimeScope[];
};

type RealtimeFeedEventRow = {
  id: number;
  eventName: string;
  scopeType: string;
  scopeKey: string;
  sourceType: string;
  sourceId: string | null;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

function serializeJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeJsonValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, serializeJsonValue(nested)])
    );
  }

  return value;
}

function normalizeScope(scope: RealtimeScope): RealtimeScope {
  return {
    type: scope.type,
    key: scope.key.trim().toLowerCase()
  };
}

function roomForScope(scope: RealtimeScope) {
  if (scope.type === 'global') {
    return null;
  }

  return `${scope.type}:${scope.key}`;
}

class RealtimeEventPublisher {
  async publish(input: PublishRealtimeEventInput): Promise<number[]> {
    const scopes = [...new Map(input.scopes.map((scope) => {
      const normalized = normalizeScope(scope);
      return [`${normalized.type}:${normalized.key}`, normalized];
    })).values()];

    const insertedEventIds: number[] = [];
    const serializedPayload = serializeJsonValue(input.payload);
    const payloadJson = JSON.stringify(serializedPayload);

    for (const scope of scopes) {
      const replayKey = `${input.replayKey}:${scope.type}:${scope.key}`;
      const [created] = await prisma.$queryRaw<RealtimeFeedEventRow[]>(
        Prisma.sql`
          INSERT INTO "RealtimeFeedEvent" (
            "replayKey",
            "eventName",
            "scopeType",
            "scopeKey",
            "sourceType",
            "sourceId",
            payload,
            "createdAt"
          )
          VALUES (
            ${replayKey},
            ${input.eventName},
            ${scope.type},
            ${scope.key},
            ${input.sourceType},
            ${input.sourceId ?? null},
            ${payloadJson}::jsonb,
            NOW()
          )
          ON CONFLICT ("replayKey") DO NOTHING
          RETURNING
            id,
            "eventName",
            "scopeType",
            "scopeKey",
            "sourceType",
            "sourceId",
            payload,
            "createdAt"
        `
      );

      if (!created) {
        continue;
      }

      insertedEventIds.push(created.id);
      this.emitToScope(scope, created);
    }

    return insertedEventIds;
  }

  async getScopedEvents(input: { scopes: RealtimeScope[]; afterId?: number; limit?: number }) {
    const scopes = input.scopes.map(normalizeScope);
    if (scopes.length === 0) {
      return [];
    }

    const conditions = scopes.map((scope) =>
      Prisma.sql`("scopeType" = ${scope.type} AND "scopeKey" = ${scope.key})`
    );

    return prisma.$queryRaw<RealtimeFeedEventRow[]>(
      Prisma.sql`
        SELECT
          id,
          "eventName",
          "scopeType",
          "scopeKey",
          "sourceType",
          "sourceId",
          payload,
          "createdAt"
        FROM "RealtimeFeedEvent"
        WHERE (${Prisma.join(conditions, ' OR ')})
          AND id > ${input.afterId ?? 0}
        ORDER BY id ASC
        LIMIT ${input.limit ?? 200}
      `
    );
  }

  private emitToScope(scope: RealtimeScope, event: RealtimeFeedEventRow) {
    const io = productionWebSocketBroadcaster.getIO();
    if (!io) {
      return;
    }

      const payload = {
        id: event.id,
        eventName: event.eventName,
        scopeType: event.scopeType,
        scopeKey: event.scopeKey,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        payload: serializeJsonValue(event.payload),
        createdAt: event.createdAt.toISOString()
      };

    const room = roomForScope(scope);
    if (!room) {
      io.emit(event.eventName, payload);
      return;
    }

    io.to(room).emit(event.eventName, payload);
  }
}

export const realtimeEventPublisher = new RealtimeEventPublisher();

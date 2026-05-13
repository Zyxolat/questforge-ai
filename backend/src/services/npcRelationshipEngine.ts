import { prisma } from './chain';
import { aiMemoryGraph } from './aiMemoryGraph';

type RelationshipUpdateInput = {
  userId: string;
  wallet: string;
  npcId: string;
  questId?: string | null;
  eventType: string;
  summary: string;
  trustDelta: number;
  seasonKey?: string | null;
  metadata?: Record<string, unknown>;
  eventTimestamp?: Date;
};

function parseStructuredMemory(value: string | null | undefined) {
  if (!value) {
    return {
      trust: 0,
      opinion: 'curious',
      references: [] as string[],
      unlocks: [] as string[]
    };
  }

  try {
    const parsed = JSON.parse(value) as {
      trust?: number;
      opinion?: string;
      references?: string[];
      unlocks?: string[];
    };
    return {
      trust: typeof parsed.trust === 'number' ? parsed.trust : 0,
      opinion: typeof parsed.opinion === 'string' ? parsed.opinion : 'curious',
      references: Array.isArray(parsed.references) ? parsed.references.filter((item): item is string => typeof item === 'string') : [],
      unlocks: Array.isArray(parsed.unlocks) ? parsed.unlocks.filter((item): item is string => typeof item === 'string') : []
    };
  } catch {
    return {
      trust: 0,
      opinion: value.slice(0, 120),
      references: [] as string[],
      unlocks: [] as string[]
    };
  }
}

class NPCRelationshipEngine {
  async updateRelationship(input: RelationshipUpdateInput) {
    const existing = await prisma.nPCMemory.findFirst({
      where: {
        npcId: input.npcId,
        wallet: input.wallet
      }
    });

    const current = parseStructuredMemory(existing?.memory);
    const trust = Number(Math.max(-1, Math.min(1, current.trust + input.trustDelta)).toFixed(3));
    const opinion =
      trust >= 0.75 ? 'loyal' : trust >= 0.3 ? 'warm' : trust <= -0.35 ? 'hostile' : trust < 0 ? 'wary' : 'curious';
    const references = [input.summary, ...current.references].slice(0, 6);
    const unlocks = [...new Set([
      ...current.unlocks,
      ...(trust >= 0.65 ? ['special_missions'] : []),
      ...(trust <= -0.25 ? ['rival_dialogue'] : [])
    ])];
    const memoryPayload = JSON.stringify({
      trust,
      opinion,
      references,
      unlocks
    });
    const embedding = aiMemoryGraph.buildEmbedding(`${input.eventType} ${input.summary} trust:${trust}`);

    if (existing) {
      await prisma.nPCMemory.update({
        where: { id: existing.id },
        data: {
          memory: memoryPayload,
          embedding,
          importanceScore: Number(Math.max(0.5, Math.min(3, existing.importanceScore + Math.abs(input.trustDelta) + 0.05)).toFixed(3)),
          interactionCount: existing.interactionCount + 1
        }
      });
    } else {
      await prisma.nPCMemory.create({
        data: {
          npcId: input.npcId,
          wallet: input.wallet,
          memory: memoryPayload,
          embedding,
          importanceScore: Number((1 + Math.abs(input.trustDelta)).toFixed(3)),
          interactionCount: 1
        }
      });
    }

    await aiMemoryGraph.recordMemory({
      replayKey: `npc:${input.npcId}:${input.userId}:${input.eventType}:${input.questId ?? 'none'}`,
      memoryType: 'npc_relationship',
      summary: input.summary,
      metadata: {
        eventType: input.eventType,
        trust,
        opinion,
        unlocks,
        ...(input.metadata ?? {})
      },
      userId: input.userId,
      npcId: input.npcId,
      questId: input.questId ?? null,
      seasonKey: input.seasonKey ?? null,
      eventTimestamp: input.eventTimestamp,
      importanceScore: 1 + Math.abs(input.trustDelta)
    });

    return {
      trust,
      opinion,
      unlocks,
      references
    };
  }

  async getRelationshipsForUser(userId: string, wallet: string) {
    const entries = await prisma.nPCMemory.findMany({
      where: { wallet },
      include: {
        npc: {
          select: {
            id: true,
            name: true,
            type: true
          }
        }
      },
      orderBy: [{ importanceScore: 'desc' }, { updatedAt: 'desc' }],
      take: 12
    });

    return Promise.all(
      entries.map(async (entry) => {
        const parsed = parseStructuredMemory(entry.memory);
        const recentMemories = await aiMemoryGraph.getRecentMemoriesForNpc({
          userId,
          npcId: entry.npcId,
          limit: 3
        });

        return {
          npcId: entry.npcId,
          npcName: entry.npc.name,
          npcType: entry.npc.type,
          trust: parsed.trust,
          opinion: parsed.opinion,
          unlocks: parsed.unlocks,
          references: parsed.references,
          recentMemories: recentMemories.map((memory) => memory.summary),
          interactionCount: entry.interactionCount
        };
      })
    );
  }
}

export const npcRelationshipEngine = new NPCRelationshipEngine();

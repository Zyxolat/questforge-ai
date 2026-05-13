import type { ChainEvent, Prisma } from '@prisma/client';
import { prisma } from './chain';
import { aiMemoryGraph } from './aiMemoryGraph';
import { factionInfluenceEngine } from './factionInfluenceEngine';
import { npcRelationshipEngine } from './npcRelationshipEngine';
import { playerNarrativeState } from './playerNarrativeState';
import { realtimeEventPublisher } from './realtimeEventPublisher';

type ProjectableQuest = {
  id: string;
  title: string;
  status: string;
  metadata: Prisma.JsonValue;
  npcGiverId: string | null;
  playerId: string | null;
  creator: string;
};

function asObject(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function eventNameForType(eventType: string) {
  const mapping: Record<string, string> = {
    quest_created: 'quest:created',
    quest_started: 'quest:started',
    proof_submitted: 'proof:submitted',
    reward_claimed: 'reward:claimed',
    nft_minted: 'nft:minted',
    reward_reserved: 'reward:reserved',
    stake_locked: 'stake:locked',
    reward_released: 'reward:released',
    reward_paid: 'reward:paid',
    reward_refunded: 'reward:refunded'
  };

  return mapping[eventType] ?? `event:${eventType}`;
}

function memoryEffectForEvent(eventType: string) {
  switch (eventType) {
    case 'quest_started':
      return { npcTrust: 0.08, factionStanding: 4 };
    case 'proof_submitted':
      return { npcTrust: 0.05, factionStanding: 3 };
    case 'reward_claimed':
      return { npcTrust: 0.18, factionStanding: 7 };
    case 'reward_refunded':
      return { npcTrust: -0.12, factionStanding: -6 };
    case 'nft_minted':
      return { npcTrust: 0.1, factionStanding: 5 };
    default:
      return { npcTrust: 0, factionStanding: 0 };
  }
}

function buildEventSummary(event: ChainEvent, quest: ProjectableQuest | null, factionName?: string | null) {
  const base = quest?.title ?? `quest ${event.chainQuestId?.toString() ?? 'unknown'}`;

  switch (event.eventType) {
    case 'quest_created':
      return `A new quest draft became onchain reality: ${base}.`;
    case 'quest_started':
      return `The player committed stake and began ${base}.`;
    case 'proof_submitted':
      return `Proof for ${base} was submitted into deterministic review.`;
    case 'reward_claimed':
      return `Quest resolution landed for ${base}${factionName ? ` with ${factionName} watching closely` : ''}.`;
    case 'nft_minted':
      return `A reward NFT was forged from ${base}.`;
    case 'reward_refunded':
      return `Treasury settlement reversed the outcome for ${base}.`;
    default:
      return `World state shifted through ${event.eventName}.`;
  }
}

class GameStateProjector {
  private readonly projectorKey = 'realtime-game-state';
  private readonly projectionVersion = 1;

  async projectChainEvent(chainEvent: ChainEvent): Promise<void> {
    const eventKey = chainEvent.eventKey;

    try {
      const quest = chainEvent.chainQuestId
        ? await prisma.quest.findFirst({
            where: { chainQuestId: chainEvent.chainQuestId },
            select: {
              id: true,
              title: true,
              status: true,
              metadata: true,
              npcGiverId: true,
              playerId: true,
              creator: true
            }
          })
        : null;

      const wallets = [chainEvent.playerWallet, chainEvent.creatorWallet].filter((value): value is string => Boolean(value));
      const users = wallets.length
        ? await prisma.user.findMany({
            where: {
              wallet: {
                in: wallets
              }
            },
            select: {
              id: true,
              wallet: true,
              clanId: true
            }
          })
        : [];
      const userByWallet = new Map(users.map((user) => [user.wallet.toLowerCase(), user]));
      const playerUser = chainEvent.playerWallet ? userByWallet.get(chainEvent.playerWallet.toLowerCase()) ?? null : null;
      const metadata = asObject(quest?.metadata);
      const orchestration = asObject(metadata?.orchestration as Prisma.JsonValue | undefined);
      const faction = asObject(orchestration?.faction as Prisma.JsonValue | undefined);
      const worldStateVersion = typeof metadata?.worldStateVersion === 'number' ? metadata.worldStateVersion : null;
      const factionId = typeof faction?.primaryFactionId === 'string' ? faction.primaryFactionId : null;
      const factionName = typeof faction?.primaryFactionName === 'string' ? faction.primaryFactionName : null;
      const memoryEffect = memoryEffectForEvent(chainEvent.eventType);
      const summary = buildEventSummary(chainEvent, quest, factionName);

      if (playerUser) {
        await aiMemoryGraph.recordMemory({
          replayKey: `event:${chainEvent.eventKey}:player`,
          memoryType: 'world_event',
          summary,
          metadata: {
            eventType: chainEvent.eventType,
            eventName: chainEvent.eventName,
            transactionHash: chainEvent.transactionHash,
            worldStateVersion,
            factionId,
            factionName
          },
          userId: playerUser.id,
          questId: quest?.id ?? null,
          npcId: quest?.npcGiverId ?? null,
          eventTimestamp: chainEvent.blockTimestamp,
          importanceScore: 1.15 + Math.abs(memoryEffect.factionStanding) / 10
        });

        if (quest?.npcGiverId && memoryEffect.npcTrust !== 0) {
          await npcRelationshipEngine.updateRelationship({
            userId: playerUser.id,
            wallet: playerUser.wallet,
            npcId: quest.npcGiverId,
            questId: quest.id,
            eventType: chainEvent.eventType,
            summary,
            trustDelta: memoryEffect.npcTrust,
            seasonKey: null,
            metadata: {
              chainEventId: chainEvent.id,
              transactionHash: chainEvent.transactionHash
            },
            eventTimestamp: chainEvent.blockTimestamp
          });
        }

        if (factionId && factionName && memoryEffect.factionStanding !== 0) {
          await factionInfluenceEngine.applyInfluence({
            userId: playerUser.id,
            factionId,
            factionName,
            questId: quest?.id ?? null,
            chainEventId: chainEvent.id,
            eventType: chainEvent.eventType,
            standingDelta: memoryEffect.factionStanding,
            summary,
            flags: [chainEvent.eventType],
            metadata: {
              chainEventId: chainEvent.id,
              transactionHash: chainEvent.transactionHash
            },
            seasonKey: null,
            eventTimestamp: chainEvent.blockTimestamp
          });
        }

        await playerNarrativeState.projectForUser(playerUser.id);
      }

      const payload = {
        chainEventId: chainEvent.id,
        chainQuestId: chainEvent.chainQuestId?.toString() ?? null,
        eventType: chainEvent.eventType,
        eventName: chainEvent.eventName,
        transactionHash: chainEvent.transactionHash,
        blockNumber: chainEvent.blockNumber.toString(),
        playerWallet: chainEvent.playerWallet,
        creatorWallet: chainEvent.creatorWallet,
        summary,
        data: chainEvent.decodedData ?? chainEvent.data,
        questId: quest?.id ?? null
      };

      const scopes: Array<{ type: 'global' | 'user' | 'clan' | 'faction'; key: string }> = [{ type: 'global', key: 'global' }];
      if (chainEvent.playerWallet) scopes.push({ type: 'user', key: chainEvent.playerWallet });
      if (chainEvent.creatorWallet) scopes.push({ type: 'user', key: chainEvent.creatorWallet });
      if (playerUser?.clanId) scopes.push({ type: 'clan', key: playerUser.clanId });
      if (factionId) scopes.push({ type: 'faction', key: factionId });

      await realtimeEventPublisher.publish({
        replayKey: `chain:${chainEvent.eventKey}`,
        eventName: eventNameForType(chainEvent.eventType),
        sourceType: 'chain_event',
        sourceId: chainEvent.id,
        payload,
        scopes
      });

      if (playerUser?.clanId && ['quest_started', 'reward_claimed', 'nft_minted'].includes(chainEvent.eventType)) {
        await realtimeEventPublisher.publish({
          replayKey: `clan:${chainEvent.eventKey}`,
          eventName: 'guild:event',
          sourceType: 'chain_event',
          sourceId: chainEvent.id,
          payload: {
            summary,
            wallet: playerUser.wallet,
            questId: quest?.id ?? null,
            chainQuestId: chainEvent.chainQuestId?.toString() ?? null,
            eventType: chainEvent.eventType
          },
          scopes: [{ type: 'clan', key: playerUser.clanId }]
        });
      }

      await aiMemoryGraph.upsertProjectionCursor({
        projectorKey: this.projectorKey,
        lastEventKey: eventKey,
        lastProcessedBlock: chainEvent.blockNumber,
        projectionVersion: this.projectionVersion,
        metrics: {
          eventType: chainEvent.eventType,
          chainQuestId: chainEvent.chainQuestId?.toString() ?? null,
          projectedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      await aiMemoryGraph.recordDeadLetter({
        projectorKey: this.projectorKey,
        eventKey,
        chainEventId: chainEvent.id,
        payload: {
          eventType: chainEvent.eventType,
          transactionHash: chainEvent.transactionHash
        },
        errorMessage: error instanceof Error ? error.message : 'Unknown projector error'
      });
      throw error;
    }
  }
}

export const gameStateProjector = new GameStateProjector();

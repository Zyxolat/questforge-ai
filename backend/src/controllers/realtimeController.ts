import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { normalizeWallet, prisma } from '../services/chain';
import { factionInfluenceEngine } from '../services/factionInfluenceEngine';
import { logger } from '../services/logger';
import { npcRelationshipEngine } from '../services/npcRelationshipEngine';
import { playerNarrativeState } from '../services/playerNarrativeState';
import { realtimeEventPublisher } from '../services/realtimeEventPublisher';
import { worldStateCoordinator } from '../services/worldStateCoordinator';

type TreasuryPayoutRow = {
  questId: string;
  chainQuestId: bigint | string;
  playerWallet: string | null;
  rewardAmount: number;
  stakeAmount: number;
  totalAmount: number;
  status: string;
  reservationTx: string | null;
  releaseTx: string | null;
  payoutTx: string | null;
  refundTx: string | null;
};

function serializeMaybeBigInt(value: bigint | string | null | undefined) {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  return value ?? null;
}

function extractQuestOrchestrationId(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const orchestrationId = (metadata as { orchestrationId?: unknown }).orchestrationId;
  return typeof orchestrationId === 'string' ? orchestrationId : null;
}

async function loadQuestFeed(userId: string, wallet: string) {
  const quests = await prisma.quest.findMany({
    where: {
      OR: [
        { creator: wallet },
        { playerId: userId }
      ]
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    take: 50
  });

  const questIds = quests.map((quest) => quest.id);
  const payouts = questIds.length
    ? await prisma.$queryRaw<TreasuryPayoutRow[]>(
        Prisma.sql`
          SELECT
            "questId",
            "chainQuestId",
            "playerWallet",
            "rewardAmount",
            "stakeAmount",
            "totalAmount",
            status::text AS status,
            "reservationTx",
            "releaseTx",
            "payoutTx",
            "refundTx"
          FROM "TreasuryPayout"
          WHERE "questId" IN (${Prisma.join(questIds)})
        `
      )
    : [];

  const payoutsByQuestId = new Map(payouts.map((payout) => [payout.questId, payout]));

  return quests.map((quest) => ({
    ...quest,
    orchestrationId: extractQuestOrchestrationId(quest.metadata),
    chainQuestId: serializeMaybeBigInt(quest.chainQuestId),
    treasuryPayout: payoutsByQuestId.get(quest.id)
      ? {
          ...payoutsByQuestId.get(quest.id)!,
          chainQuestId: serializeMaybeBigInt(payoutsByQuestId.get(quest.id)!.chainQuestId)
        }
      : null
  }));
}

async function loadRealtimeScopes(userId: string, wallet: string, clanId: string | null) {
  const standings = await factionInfluenceEngine.getFactionStandings(userId);
  return [
    { type: 'global' as const, key: 'global' },
    { type: 'user' as const, key: wallet },
    ...(clanId ? [{ type: 'clan' as const, key: clanId }] : []),
    ...standings.slice(0, 4).map((standing) => ({ type: 'faction' as const, key: standing.factionId }))
  ];
}

export async function getRealtimeBootstrap(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  if (!wallet) {
    return res.status(400).json({ error: 'Wallet is required' });
  }

  try {
    const normalizedWallet = normalizeWallet(wallet);
    const user = await prisma.user.findUnique({
      where: { wallet: normalizedWallet },
      include: {
        clan: {
          select: {
            id: true,
            name: true,
            description: true,
            level: true,
            reputation: true,
            treasuryBalance: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [quests, inventory, leaderboard, worldState, factionStandings, npcRelationships, scopes] = await Promise.all([
      loadQuestFeed(user.id, normalizedWallet),
      prisma.nFT.findMany({
        where: { userId: user.id },
        orderBy: { mintedAt: 'desc' },
        take: 50
      }),
      prisma.user.findMany({
        orderBy: [{ xp: 'desc' }, { level: 'desc' }],
        take: 20,
        select: {
          id: true,
          wallet: true,
          xp: true,
          level: true,
          questCount: true,
          streak: true
        }
      }),
      worldStateCoordinator.getCurrentWorldState('realtime_bootstrap'),
      factionInfluenceEngine.getFactionStandings(user.id),
      npcRelationshipEngine.getRelationshipsForUser(user.id, normalizedWallet),
      loadRealtimeScopes(user.id, normalizedWallet, user.clanId)
    ]);

    const narrativeState =
      (await playerNarrativeState.getNarrativeState(user.id)) ?? (await playerNarrativeState.projectForUser(user.id));
    const events = await realtimeEventPublisher.getScopedEvents({
      scopes,
      limit: 100
    });

    res.json({
      connection: {
        wallet: normalizedWallet,
        clanId: user.clanId,
        scopes,
        lastEventId: events.length ? events[events.length - 1].id : 0
      },
      player: {
        id: user.id,
        wallet: user.wallet,
        username: user.username,
        xp: user.xp,
        level: user.level,
        questCount: user.questCount,
        streak: user.streak,
        onchainActions: user.onchainActions
      },
      guild: user.clan,
      leaderboard,
      quests,
      inventory,
      worldState,
      narrativeState,
      factionStandings,
      npcRelationships,
      notifications: events.map((event) => ({
        id: event.id,
        eventName: event.eventName,
        scopeType: event.scopeType,
        scopeKey: event.scopeKey,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        payload: event.payload,
        createdAt: event.createdAt.toISOString()
      }))
    });
  } catch (error) {
    logger.error('Realtime bootstrap failed', error, { wallet });
    res.status(500).json({ error: 'Failed to bootstrap realtime state' });
  }
}

export async function getRealtimeSync(req: Request, res: Response) {
  const wallet = req.auth?.wallet;
  const afterId = Number(req.query.afterId ?? 0);

  if (!wallet) {
    return res.status(400).json({ error: 'Wallet is required' });
  }

  try {
    const normalizedWallet = normalizeWallet(wallet);
    const user = await prisma.user.findUnique({
      where: { wallet: normalizedWallet },
      select: {
        id: true,
        wallet: true,
        clanId: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const scopes = await loadRealtimeScopes(user.id, normalizedWallet, user.clanId);
    const events = await realtimeEventPublisher.getScopedEvents({
      scopes,
      afterId: Number.isFinite(afterId) && afterId > 0 ? afterId : 0,
      limit: 200
    });

    res.json({
      afterId: Number.isFinite(afterId) ? afterId : 0,
      lastEventId: events.length ? events[events.length - 1].id : afterId || 0,
      events: events.map((event) => ({
        id: event.id,
        eventName: event.eventName,
        scopeType: event.scopeType,
        scopeKey: event.scopeKey,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        payload: event.payload,
        createdAt: event.createdAt.toISOString()
      }))
    });
  } catch (error) {
    logger.error('Realtime sync failed', error, { wallet });
    res.status(500).json({ error: 'Failed to sync realtime state' });
  }
}

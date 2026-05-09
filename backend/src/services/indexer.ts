import { ethers } from 'ethers';
import { contracts } from './contracts';
import { normalizeWallet, prisma } from './chain';
import { logger } from './logger';

const INDEXER_CURSOR_KEY = 'questforge_event_indexer_last_block';
const STATUS_BY_INDEX = ['AVAILABLE', 'ACTIVE', 'SUBMITTED', 'VERIFIED', 'CANCELLED', 'FAILED'] as const;
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
const METADATA_PREFIX = 'data:application/json;base64,';

type IndexedEventName = 'QuestStarted' | 'QuestVerified' | 'RewardMinted';

type ParsedIndexedLog = {
  blockNumber: number;
  eventIndex: number;
  transactionHash: string;
  name: IndexedEventName;
  args: any;
};

type QuestMetadata = {
  title?: string;
  description?: string;
  difficulty?: number;
  questType?: string;
  objective?: string;
  lore?: string;
  validationRules?: string[];
  chain?: string;
  version?: string;
};

type QuestSnapshot = {
  chainQuestId: bigint;
  creator: string;
  title: string;
  metadataUri: string;
  proofUri: string;
  stakeAmount: number;
  rewardAmount: number;
  xpReward: number;
  expiresAt: number;
  status: 'AVAILABLE' | 'ACTIVE' | 'SUBMITTED' | 'VERIFIED' | 'CANCELLED' | 'FAILED';
  player: string;
  metadata: QuestMetadata;
};

type OnchainProfileSnapshot = {
  xp: number;
  level: number;
  questCount: number;
  streak: number;
  onchainActions: number;
};

let indexerTimer: NodeJS.Timeout | null = null;
let isSyncing = false;
let nextBlock: number | null = null;

function isConfiguredAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

function parseInteger(value: string | undefined, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function parseEventIndex(log: any) {
  if (typeof log.index === 'number') return log.index;
  if (typeof log.logIndex === 'number') return log.logIndex;
  return 0;
}

function eventKeyFor(log: ParsedIndexedLog) {
  return `${log.transactionHash}:${log.eventIndex}`;
}

function questRarityFromDifficulty(difficulty: number) {
  if (difficulty >= 5) return 'Legendary';
  if (difficulty === 4) return 'Epic';
  if (difficulty === 3) return 'Rare';
  if (difficulty === 2) return 'Uncommon';
  return 'Common';
}

function decodeQuestMetadata(metadataUri: string): QuestMetadata {
  if (!metadataUri.startsWith(METADATA_PREFIX)) {
    return {};
  }

  try {
    const encoded = metadataUri.slice(METADATA_PREFIX.length);
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as QuestMetadata;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureIndexerTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS processed_chain_events (
      event_key TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number BIGINT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getStoredCursor() {
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    SELECT value
    FROM indexer_state
    WHERE key = ${INDEXER_CURSOR_KEY}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const numeric = Number(rows[0].value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

async function setStoredCursor(blockNumber: number) {
  await prisma.$executeRaw`
    INSERT INTO indexer_state (key, value, updated_at)
    VALUES (${INDEXER_CURSOR_KEY}, ${blockNumber.toString()}, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

async function getBlockTimestamp(blockNumber: number, cache: Map<number, Date>) {
  const cached = cache.get(blockNumber);
  if (cached) return cached;

  const block = await contracts.provider.getBlock(blockNumber);
  const timestamp = new Date(((block?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000));
  cache.set(blockNumber, timestamp);
  return timestamp;
}

async function fetchOnchainQuest(chainQuestId: bigint) {
  const quest = await contracts.forgeQuestManager.quests(chainQuestId);
  return {
    questId: BigInt(quest.questId.toString()),
    creator: normalizeWallet(quest.creator),
    title: quest.title,
    metadataUri: quest.metadataUri,
    proofUri: quest.proofUri,
    stakeAmount: Number(ethers.formatEther(quest.stakeAmount)),
    rewardAmount: Number(ethers.formatEther(quest.rewardAmount)),
    xpReward: Number(quest.xpReward),
    expiresAt: Number(quest.expiresAt),
    status: STATUS_BY_INDEX[Number(quest.status)] ?? 'AVAILABLE',
    player: normalizeWallet(quest.player)
  };
}

async function fetchProfileSnapshot(wallet: string): Promise<OnchainProfileSnapshot> {
  const profile = await contracts.reputation.profileFor(wallet);
  return {
    xp: Number(profile.xp),
    level: Number(profile.level),
    questCount: Number(profile.questCount),
    streak: Number(profile.streak),
    onchainActions: Number(profile.onchainActions)
  };
}

async function readQuestSnapshot(chainQuestId: bigint): Promise<QuestSnapshot> {
  const quest = await fetchOnchainQuest(chainQuestId);
  return {
    chainQuestId,
    creator: quest.creator,
    title: quest.title,
    metadataUri: quest.metadataUri,
    proofUri: quest.proofUri,
    stakeAmount: quest.stakeAmount,
    rewardAmount: quest.rewardAmount,
    xpReward: quest.xpReward,
    expiresAt: quest.expiresAt,
    status: quest.status,
    player: quest.player,
    metadata: decodeQuestMetadata(quest.metadataUri)
  };
}

async function upsertUserInTx(tx: any, wallet: string, profile?: OnchainProfileSnapshot) {
  return tx.user.upsert({
    where: { wallet },
    update: profile ? {
      xp: profile.xp,
      level: profile.level,
      questCount: profile.questCount,
      streak: profile.streak,
      onchainActions: profile.onchainActions
    } : {},
    create: {
      wallet,
      ...(profile ? {
        xp: profile.xp,
        level: profile.level,
        questCount: profile.questCount,
        streak: profile.streak,
        onchainActions: profile.onchainActions
      } : {})
    }
  });
}

async function applyQuestSnapshot(tx: any, input: {
  snapshot: QuestSnapshot;
  startedAt: Date;
  forcedStatus?: 'ACTIVE' | 'VERIFIED' | 'CANCELLED' | 'FAILED';
  playerId?: string;
}) {
  const existing = await tx.quest.findFirst({
    where: { chainQuestId: input.snapshot.chainQuestId }
  });
  const metadata = input.snapshot.metadata;
  const data = {
    title: metadata.title || input.snapshot.title,
    description: metadata.description || 'Quest indexed from onchain state.',
    metadata: {
      ...metadata,
      metadataUri: input.snapshot.metadataUri,
      proofUri: input.snapshot.proofUri || null,
      indexedFrom: 'chain-events'
    },
    difficulty: typeof metadata.difficulty === 'number' && Number.isFinite(metadata.difficulty) ? metadata.difficulty : 3,
    questType: metadata.questType || 'AI Quest',
    objective: metadata.objective || 'Submit proof onchain.',
    lore: metadata.lore || 'Recovered from onchain quest metadata.',
    stakeAmount: input.snapshot.stakeAmount,
    rewardAmount: input.snapshot.rewardAmount,
    chainQuestId: input.snapshot.chainQuestId,
    status: input.forcedStatus || input.snapshot.status,
    creator: input.snapshot.creator,
    startedAt: existing?.startedAt ?? input.startedAt,
    expiresAt: new Date(input.snapshot.expiresAt * 1000)
  };

  if (existing) {
    return tx.quest.update({
      where: { id: existing.id },
      data: {
        ...data,
        player: input.playerId ? { connect: { id: input.playerId } } : undefined
      }
    });
  }

  return tx.quest.create({
    data: {
      ...data,
      createdAt: input.startedAt,
      player: input.playerId ? { connect: { id: input.playerId } } : undefined
    }
  });
}

async function claimEvent(tx: any, log: ParsedIndexedLog) {
  const rows = await tx.$queryRaw<Array<{ event_key: string }>>`
    INSERT INTO processed_chain_events (event_key, event_name, tx_hash, log_index, block_number)
    VALUES (${eventKeyFor(log)}, ${log.name}, ${log.transactionHash}, ${log.eventIndex}, ${log.blockNumber})
    ON CONFLICT (event_key) DO NOTHING
    RETURNING event_key
  `;
  return rows.length > 0;
}

async function handleQuestStarted(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = BigInt(log.args.questId.toString());
  const playerWallet = normalizeWallet(log.args.player);
  const snapshot = await readQuestSnapshot(chainQuestId);
  const profile = await fetchProfileSnapshot(playerWallet);

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      startedAt: blockTimestamp,
      forcedStatus: 'ACTIVE',
      playerId: user.id
    });

    await tx.questHistory.create({
      data: {
        userId: user.id,
        questId: quest.id,
        action: 'STARTED'
      }
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'QUEST_STARTED',
        chainId: parseInteger(process.env.CELO_CHAIN_ID, 44787),
        txHash: log.transactionHash,
        details: { chainQuestId: chainQuestId.toString() }
      }
    });
  });
}

async function handleQuestCompleted(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = BigInt(log.args.questId.toString());
  const playerWallet = normalizeWallet(log.args.player);
  const success = Boolean(log.args.success);
  const rewardAmount = Number(ethers.formatEther(log.args.rewardAmount));
  const xpReward = Number(log.args.xpReward);
  const snapshot = await readQuestSnapshot(chainQuestId);
  const profile = await fetchProfileSnapshot(playerWallet);
  const proofUri = snapshot.proofUri || null;

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet, profile);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      startedAt: blockTimestamp,
      forcedStatus: success ? 'VERIFIED' : 'FAILED',
      playerId: user.id
    });

    await tx.quest.update({
      where: { id: quest.id },
      data: {
        verificationTx: log.transactionHash
      }
    });

    await tx.questHistory.create({
      data: {
        userId: user.id,
        questId: quest.id,
        action: success ? 'COMPLETED' : 'FAILED',
        proofUri,
        xpEarned: success ? xpReward : 0
      }
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'QUEST_VERIFIED',
        chainId: parseInteger(process.env.CELO_CHAIN_ID, 44787),
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          success,
          rewardAmount,
          xpReward
        }
      }
    });

    if (success) {
      await tx.reward.create({
        data: {
          userId: user.id,
          type: 'CELO',
          amount: rewardAmount,
          tokenTx: log.transactionHash
        }
      });
    }
  });
}

async function handleRewardMinted(log: ParsedIndexedLog, blockTimestamp: Date) {
  const chainQuestId = BigInt(log.args.questId.toString());
  const tokenId = log.args.tokenId.toString();
  const playerWallet = normalizeWallet(log.args.player);
  const snapshot = await readQuestSnapshot(chainQuestId);
  const metadataUri = snapshot.proofUri || snapshot.metadataUri;

  await prisma.$transaction(async (tx) => {
    const inserted = await claimEvent(tx, log);
    if (!inserted) return;

    const user = await upsertUserInTx(tx, playerWallet);
    const quest = await applyQuestSnapshot(tx, {
      snapshot,
      startedAt: blockTimestamp,
      playerId: user.id
    });
    const existingNft = await tx.nFT.findFirst({ where: { tokenId } });
    if (!existingNft) {
      await tx.nFT.create({
        data: {
          userId: user.id,
          tokenId,
          metadataUri,
          rarity: questRarityFromDifficulty(quest.difficulty),
          xpEarned: 0,
          questHistory: quest.id
        }
      });
    }

    await tx.quest.update({
      where: { id: quest.id },
      data: {
        nftMintTx: log.transactionHash
      }
    });

    await tx.transaction.create({
      data: {
        userId: user.id,
        wallet: playerWallet,
        type: 'REWARD_MINTED',
        chainId: parseInteger(process.env.CELO_CHAIN_ID, 44787),
        txHash: log.transactionHash,
        details: {
          chainQuestId: chainQuestId.toString(),
          tokenId
        }
      }
    });
  });
}

async function fetchLogs(fromBlock: number, toBlock: number) {
  const forgeLogs = await contracts.provider.getLogs({
    address: await contracts.forgeQuestManager.getAddress(),
    fromBlock,
    toBlock
  });
  const rewardLogs = await contracts.provider.getLogs({
    address: await contracts.rewardNFT.getAddress(),
    fromBlock,
    toBlock
  });

  const parsed: ParsedIndexedLog[] = [];

  for (const log of forgeLogs) {
    try {
      const description = contracts.forgeQuestManager.interface.parseLog(log);
      if (description && (description.name === 'QuestStarted' || description.name === 'QuestVerified')) {
        parsed.push({
          blockNumber: Number(log.blockNumber),
          eventIndex: parseEventIndex(log),
          transactionHash: log.transactionHash,
          name: description.name as IndexedEventName,
          args: description.args
        });
      }
    } catch {
      continue;
    }
  }

  for (const log of rewardLogs) {
    try {
      const description = contracts.rewardNFT.interface.parseLog(log);
      if (description && description.name === 'RewardMinted') {
        parsed.push({
          blockNumber: Number(log.blockNumber),
          eventIndex: parseEventIndex(log),
          transactionHash: log.transactionHash,
          name: 'RewardMinted',
          args: description.args
        });
      }
    } catch {
      continue;
    }
  }

  return parsed.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) return left.blockNumber - right.blockNumber;
    return left.eventIndex - right.eventIndex;
  });
}

async function syncRange(fromBlock: number, toBlock: number) {
  if (toBlock < fromBlock) return;

  const blockTimestamps = new Map<number, Date>();
  const logs = await fetchLogs(fromBlock, toBlock);

  for (const log of logs) {
    const blockTimestamp = await getBlockTimestamp(log.blockNumber, blockTimestamps);
    if (log.name === 'QuestStarted') {
      await handleQuestStarted(log, blockTimestamp);
      continue;
    }

    if (log.name === 'QuestVerified') {
      await handleQuestCompleted(log, blockTimestamp);
      continue;
    }

    await handleRewardMinted(log, blockTimestamp);
  }
}

async function performSync() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    await ensureIndexerTables();

    if (nextBlock === null) {
      const storedCursor = await getStoredCursor();
      nextBlock = storedCursor ?? parseInteger(process.env.INDEXER_FROM_BLOCK, 0);
    }

    const latestBlock = await contracts.provider.getBlockNumber();
    if (latestBlock < nextBlock) return;

    await syncRange(nextBlock, latestBlock);
    await setStoredCursor(latestBlock + 1);
    nextBlock = latestBlock + 1;
  } catch (error) {
    logger.error('QuestForge indexer sync failed', error);
  } finally {
    isSyncing = false;
  }
}

export function startQuestIndexer() {
  if (
    !isConfiguredAddress(process.env.FORGE_QUEST_MANAGER_ADDRESS || '') ||
    !isConfiguredAddress(process.env.REWARD_NFT_ADDRESS || '') ||
    !isConfiguredAddress(process.env.REPUTATION_ADDRESS || '')
  ) {
    logger.warn('QuestForge indexer disabled: contract addresses are not configured');
    return;
  }

  if (indexerTimer) return;

  const pollIntervalMs = parseInteger(process.env.INDEXER_POLL_INTERVAL_MS, 10000);
  void performSync();
  indexerTimer = setInterval(() => {
    void performSync();
  }, pollIntervalMs);
}

import { Prisma, type ChainEvent } from '@prisma/client';
import { ethers } from 'ethers';
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from './chain';
import { rpcFailoverManager } from './rpcFailoverManager';
import { productionEventQueue } from './productionEventQueue';
import { eventDecoder } from './eventDecoder';

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

class ProductionEventIngestor {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private isSyncing = false;
  private lastBlockProcessed: number | null = null;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 10;
  private reorgCheckInterval = 20; // Check reorg every 20 blocks

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[INDEXER] Already running');
      return;
    }

    if (!env.ENABLE_EVENT_STREAM) {
      logger.info('[INDEXER] Disabled via ENABLE_EVENT_STREAM');
      return;
    }

    this.isRunning = true;
    logger.info('[INDEXER] Started');

    // Initialize RPC failover
    const rpcUrls = [
      env.CELO_RPC_URL,
      'https://celo-mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161',
      'https://alfajores-forno.celo-testnet.org'
    ].filter(Boolean);

    try {
      await rpcFailoverManager.initialize(rpcUrls);
    } catch (error) {
      logger.error('[INDEXER] Failed to initialize RPC failover', { error: (error as Error).message });
    }

    // Initial sync
    await this.syncEvents();

    // Setup polling with error isolation
    this.timer = setInterval(() => {
      this.syncEvents().catch((error) => {
        logger.error('[INDEXER] Unhandled error in poll', { error: (error as Error).message });
      });
    }, env.EVENT_POLL_INTERVAL_MS);
  }

  private async syncEvents(): Promise<void> {
    if (this.isSyncing) {
      logger.debug('[INDEXER] Sync in progress, skipping');
      return;
    }

    this.isSyncing = true;

    try {
      // Get current block
      const currentBlock = await rpcFailoverManager.getBlockNumber();
      if (!currentBlock) {
        this.recordError('Failed to get block number');
        return;
      }

      // Get last processed block from DB
      let lastBlock = await this.getLastProcessedBlock();
      if (lastBlock === null) {
        lastBlock = env.INDEXER_FROM_BLOCK;
      }

      // Sanity check
      if (lastBlock > currentBlock) {
        logger.warn('[INDEXER] Last block ahead of current, resetting', { lastBlock, currentBlock });
        lastBlock = Math.max(currentBlock - 1000, env.INDEXER_FROM_BLOCK);
      }

      const blockRange = currentBlock - lastBlock;

      if (blockRange <= 0) {
        logger.debug('[INDEXER] No new blocks', { lastBlock, currentBlock });
        this.recordSuccess();
        return;
      }

      logger.debug('[INDEXER] Fetching events', {
        fromBlock: lastBlock + 1,
        toBlock: currentBlock,
        blockRange
      });

      // Check for reorg before fetching
      await this.checkForReorg(lastBlock);

      // Fetch logs
      const logs = await this.fetchLogsWithFailover(lastBlock + 1, currentBlock);

      if (logs && logs.length > 0) {
        logger.info('[INDEXER] Fetched logs', {
          count: logs.length,
          blockRange
        });

        await this.processLogsIdempotent(logs, currentBlock);
        await this.setLastProcessedBlock(currentBlock);
        this.recordSuccess();
      } else {
        logger.debug('[INDEXER] No logs in range');
        await this.setLastProcessedBlock(currentBlock);
        this.recordSuccess();
      }
    } catch (error) {
      logger.error('[INDEXER] Sync error', { error: (error as Error).message });
      this.recordError((error as Error).message);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Check for blockchain reorg
   */
  private async checkForReorg(lastBlock: number): Promise<void> {
    try {
      // Get last known block header from DB
      const lastKnownHeader = await prisma.blockHeader.findFirst({
        where: { blockNumber: BigInt(lastBlock) }
      });

      if (!lastKnownHeader) {
        logger.debug('[INDEXER] No known header for reorg check', { blockNumber: lastBlock });
        return;
      }

      // Fetch current block hash
      const currentBlock = await rpcFailoverManager.getBlock(lastBlock);
      if (!currentBlock) {
        logger.warn('[INDEXER] Failed to fetch current block for reorg check', { blockNumber: lastBlock });
        return;
      }

      // Detect reorg
      if (currentBlock.hash !== lastKnownHeader.blockHash) {
        logger.warn('[INDEXER] Blockchain reorg detected', {
          blockNumber: lastBlock,
          knownHash: lastKnownHeader.blockHash,
          currentHash: currentBlock.hash
        });

        await this.handleReorg(lastBlock, lastKnownHeader.blockHash);
      }
    } catch (error) {
      logger.error('[INDEXER] Reorg check failed', { error: (error as Error).message });
    }
  }

  /**
   * Handle blockchain reorg
   */
  private async handleReorg(reorgBlockNumber: number, oldHash: string): Promise<void> {
    try {
      logger.warn('[INDEXER] Handling reorg from block', { reorgBlockNumber, oldHash });

      // Mark all events from this block onwards as invalidated
      await prisma.chainEvent.updateMany({
        where: {
          blockNumber: {
            gte: BigInt(reorgBlockNumber)
          }
        },
        data: {
          invalidatedAt: new Date(),
          processed: false
        }
      });

      // Mark block headers as unfinalized
      await prisma.blockHeader.updateMany({
        where: {
          blockNumber: {
            gte: BigInt(reorgBlockNumber)
          }
        },
        data: {
          isFinalized: false
        }
      });

      // Reset last processed block
      await this.setLastProcessedBlock(reorgBlockNumber - 1);

      logger.info('[INDEXER] Reorg handled, events invalidated', { fromBlock: reorgBlockNumber });
    } catch (error) {
      logger.error('[INDEXER] Error handling reorg', { error: (error as Error).message });
    }
  }

  /**
   * Fetch logs with RPC failover
   */
  private async fetchLogsWithFailover(fromBlock: number, toBlock: number): Promise<ethers.Log[]> {
    const contractAddresses = [
      env.FORGE_QUEST_MANAGER_ADDRESS,
      env.REWARD_NFT_ADDRESS,
      env.TREASURY_ADDRESS
    ].filter((addr) => addr && addr !== ethers.ZeroAddress);

    if (contractAddresses.length === 0) {
      logger.warn('[INDEXER] No contract addresses configured');
      return [];
    }

    const filter = {
      address: contractAddresses,
      fromBlock,
      toBlock
    };

    return rpcFailoverManager.getLogs(filter as ethers.Filter, env.EVENT_CHUNK_SIZE);
  }

  /**
   * Process logs with idempotency guarantees
   */
  private async processLogsIdempotent(logs: ethers.Log[], toBlock: number): Promise<void> {
    const blockTimestampMap = new Map<number, Date>();
    const blockHashMap = new Map<number, string>();
    const processedEventKeys = new Set<string>();

    // Fetch block metadata for reorg detection
    const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
    for (const blockNumber of uniqueBlocks) {
      try {
        const block = await rpcFailoverManager.getBlock(blockNumber);
        if (block) {
          const timestamp = new Date(block.timestamp * 1000);
          blockTimestampMap.set(blockNumber, timestamp);
          blockHashMap.set(blockNumber, block.hash ?? '');

          // Store block header for reorg detection
          await prisma.blockHeader
            .upsert({
              where: { blockNumber: BigInt(blockNumber) },
              create: {
                blockNumber: BigInt(blockNumber),
                blockHash: block.hash || '',
                parentHash: block.parentHash || '',
                timestamp: BigInt(block.timestamp),
                isFinalized: blockNumber < toBlock - 10 // Finalize after 10 blocks
              },
              update: {
                blockHash: block.hash || '',
                parentHash: block.parentHash || '',
                isFinalized: blockNumber < toBlock - 10
              }
            })
            .catch(() => null); // Ignore conflicts
        }
      } catch (error) {
        logger.warn('[INDEXER] Failed to fetch block metadata', {
          blockNumber,
          error: (error as Error).message
        });
      }
    }

    const chainEvents: ChainEvent[] = [];

    for (const log of logs) {
      const blockTimestamp = blockTimestampMap.get(log.blockNumber) || new Date();
      const decodedEvent = eventDecoder.decodeLog(log, blockTimestamp);

      if (!decodedEvent) continue;

      const eventKey = `${log.transactionHash}:${Number(log.index ?? 0)}`;

      // Check idempotency
      if (processedEventKeys.has(eventKey)) {
        logger.debug('[INDEXER] Duplicate event in batch, skipping', { eventKey });
        continue;
      }
      processedEventKeys.add(eventKey);

      try {
        // Upsert with conflict handling
        const chainEvent = await prisma.chainEvent
          .upsert({
            where: { eventKey },
            create: {
              eventKey,
              eventName: decodedEvent.eventName,
              eventType: decodedEvent.eventType,
              blockNumber: decodedEvent.blockNumber,
              blockHash: blockHashMap.get(log.blockNumber) || '',
              blockTimestamp,
              transactionHash: decodedEvent.transactionHash,
              logIndex: decodedEvent.logIndex,
              fromAddress: decodedEvent.fromAddress,
              toAddress: decodedEvent.toAddress,
              contractAddress: decodedEvent.contractAddress,
              data: asJsonObject(decodedEvent.data),
              decodedData: asJsonObject(decodedEvent.data),
              chainQuestId: decodedEvent.chainQuestId,
              playerWallet: decodedEvent.playerWallet,
              creatorWallet: decodedEvent.creatorWallet,
              processed: false
            },
            update: {} // If exists, don't update
          })
          .catch((error) => {
            if (hasPrismaErrorCode(error, 'P2002')) {
              logger.debug('[INDEXER] Event already exists', { eventKey });
              return null;
            }
            throw error;
          });

        if (chainEvent) {
          chainEvents.push(chainEvent);
        }
      } catch (error) {
        logger.error('[INDEXER] Failed to upsert event', {
          eventKey,
          error: (error as Error).message
        });
      }
    }

    logger.info('[INDEXER] Chain events created', {
      count: chainEvents.length,
      logsProcessed: logs.length
    });

    // Enqueue for processing
    if (chainEvents.length > 0) {
      const jobsData = chainEvents.map((event) => ({
        chainEventId: event.id,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        eventName: event.eventName,
        contractAddress: event.contractAddress,
        data: event.data
      }));

      try {
        await productionEventQueue.enqueueBatch(jobsData);
        logger.info('[INDEXER] Events enqueued', { count: jobsData.length });
      } catch (error) {
        logger.error('[INDEXER] Failed to enqueue', { error: (error as Error).message });
      }
    }
  }

  private async getLastProcessedBlock(): Promise<number | null> {
    try {
      const state = await prisma.indexerState.findUnique({
        where: { key: 'last_block_processed' }
      });
      if (!state) return null;
      const blockNum = Number(state.lastBlockProcessed || state.value);
      return Number.isFinite(blockNum) && blockNum >= 0 ? blockNum : null;
    } catch (error) {
      logger.error('[INDEXER] Failed to get last block', { error: (error as Error).message });
      return null;
    }
  }

  private async setLastProcessedBlock(blockNumber: number): Promise<void> {
    try {
      await prisma.indexerState.upsert({
        where: { key: 'last_block_processed' },
        create: {
          key: 'last_block_processed',
          value: blockNumber.toString(),
          lastBlockProcessed: BigInt(blockNumber),
          isHealthy: true
        },
        update: {
          value: blockNumber.toString(),
          lastBlockProcessed: BigInt(blockNumber),
          lastBlockTimestamp: new Date(),
          isHealthy: true,
          errorCount: 0
        }
      });
      this.lastBlockProcessed = blockNumber;
    } catch (error) {
      logger.error('[INDEXER] Failed to set last block', { error: (error as Error).message });
    }
  }

  private recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  private recordError(reason: string): void {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      logger.error('[INDEXER] Max errors reached', {
        consecutiveErrors: this.consecutiveErrors,
        reason
      });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.isRunning = false;
    await rpcFailoverManager.cleanup();
    logger.info('[INDEXER] Stopped');
  }

  getStatus() {
    return {
      running: this.isRunning,
      syncing: this.isSyncing,
      lastBlockProcessed: this.lastBlockProcessed,
      consecutiveErrors: this.consecutiveErrors,
      enabled: env.ENABLE_EVENT_STREAM
    };
  }
}

export const productionEventIngestor = new ProductionEventIngestor();

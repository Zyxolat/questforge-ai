import { Prisma, type ChainEvent } from '@prisma/client';
import { ethers } from 'ethers';
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from './chain';
import { rpcProvider } from './rpcProvider';
import { eventQueue } from './eventQueue';
import { eventDecoder } from './eventDecoder';

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

class EventIngestor {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private isSyncing = false;
  private lastBlockProcessed: number | null = null;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 10;

  /**
   * Start the event ingestor
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Event ingestor already running');
      return;
    }

    if (!env.ENABLE_EVENT_STREAM) {
      logger.info('Event streaming disabled via ENABLE_EVENT_STREAM');
      return;
    }

    this.isRunning = true;
    logger.info('Event ingestor started');

    // Initial sync
    await this.syncEvents();

    // Setup polling
    this.timer = setInterval(() => {
      this.syncEvents().catch(error => {
        logger.error('Unhandled error in event ingestor poll', {
          error: (error as Error).message
        });
      });
    }, env.EVENT_POLL_INTERVAL_MS);
  }

  /**
   * Main event synchronization loop
   */
  private async syncEvents(): Promise<void> {
    if (this.isSyncing) {
      logger.debug('Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;

    try {
      // Get current block
      const currentBlock = await rpcProvider.getBlockNumber();
      if (!currentBlock) {
        this.recordError('Failed to get current block number');
        return;
      }

      // Get last processed block
      let lastBlock = await this.getLastProcessedBlock();
      if (lastBlock === null) {
        lastBlock = env.INDEXER_FROM_BLOCK;
      }

      // Sanity check
      if (lastBlock > currentBlock) {
        logger.warn('Last processed block ahead of current block, resetting', {
          lastBlock,
          currentBlock
        });
        lastBlock = Math.max(currentBlock - 1000, env.INDEXER_FROM_BLOCK);
      }

      const blockRange = currentBlock - lastBlock;

      if (blockRange <= 0) {
        logger.debug('No new blocks to process', { lastBlock, currentBlock });
        this.recordSuccess();
        return;
      }

      logger.debug('Fetching events', {
        fromBlock: lastBlock + 1,
        toBlock: currentBlock,
        blockRange
      });

      // Fetch logs in chunks
      const logs = await this.fetchLogsInChunks(lastBlock + 1, currentBlock);

      if (logs && logs.length > 0) {
        logger.info('Fetched logs', {
          count: logs.length,
          blockRange
        });

        // Process logs
        await this.processLogs(logs);

        // Update last processed block
        await this.setLastProcessedBlock(currentBlock);

        this.recordSuccess();
      } else {
        logger.debug('No logs found in range', { blockRange });
        // Still update the block number even if no events
        await this.setLastProcessedBlock(currentBlock);
        this.recordSuccess();
      }
    } catch (error) {
      logger.error('Error during event sync', {
        error: (error as Error).message
      });
      this.recordError((error as Error).message);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Fetch logs in chunks to avoid RPC limits
   */
  private async fetchLogsInChunks(fromBlock: number, toBlock: number): Promise<ethers.Log[]> {
    const chunkSize = env.EVENT_CHUNK_SIZE;

    const contractAddresses = [
      env.FORGE_QUEST_MANAGER_ADDRESS,
      env.REWARD_NFT_ADDRESS,
      env.TREASURY_ADDRESS
    ].filter(addr => addr && addr !== ethers.ZeroAddress);

    if (contractAddresses.length === 0) {
      logger.warn('No contract addresses configured for event indexing');
      return [];
    }

    const filter = {
      address: contractAddresses,
      fromBlock,
      toBlock
    };

    try {
      const logs = await rpcProvider.getLogs(filter as ethers.Filter, chunkSize);
      return logs || [];
    } catch (error) {
      logger.error('Failed to fetch logs', {
        error: (error as Error).message,
        fromBlock,
        toBlock
      });
      return [];
    }
  }

  /**
   * Process and store fetched logs
   */
  private async processLogs(logs: ethers.Log[]): Promise<void> {
    const blockTimestampMap = new Map<number, Date>();
    const blockHashMap = new Map<number, string>();

    // Fetch block timestamps (cached)
    const uniqueBlocks = [...new Set(logs.map(l => l.blockNumber))];
    for (const blockNumber of uniqueBlocks) {
      const block = await rpcProvider.getBlock(blockNumber);
      if (block) {
        const timestamp = new Date(block.timestamp * 1000);
        blockTimestampMap.set(blockNumber, timestamp);
        blockHashMap.set(blockNumber, block.hash ?? '');
      }
    }

    // Process each log
    const chainEvents: ChainEvent[] = [];

    for (const log of logs) {
      const blockTimestamp = blockTimestampMap.get(log.blockNumber) || new Date();
      const decodedEvent = eventDecoder.decodeLog(log, blockTimestamp);

      if (!decodedEvent) {
        continue; // Skip unknown events
      }

      // Build event key for deduplication
      const eventKey = `${log.transactionHash}:${Number(log.index ?? 0)}`;

      try {
        // Check if already processed
        const existing = await prisma.chainEvent.findUnique({
          where: { eventKey }
        });

        if (existing) {
          logger.debug('Event already exists', { eventKey });
          continue;
        }

        // Create chain event in database
        const chainEvent = await prisma.chainEvent.create({
          data: {
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
          }
        });

        chainEvents.push(chainEvent);
      } catch (error) {
        if (!hasPrismaErrorCode(error, 'P2002')) {
          // Not a unique constraint error
          logger.error('Error creating chain event', {
            error: (error as Error).message,
            eventKey
          });
        }
      }
    }

    logger.info('Chain events created', {
      count: chainEvents.length,
      logsProcessed: logs.length
    });

    // Enqueue events for processing
    if (chainEvents.length > 0) {
      const jobsData = chainEvents.map(event => ({
        chainEventId: event.id,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        eventName: event.eventName,
        contractAddress: event.contractAddress,
        data: event.data
      }));

      try {
        const jobIds = await eventQueue.enqueueBatch(jobsData);
        logger.info('Events enqueued for processing', {
          count: jobIds.length
        });
      } catch (error) {
        logger.error('Failed to enqueue events', {
          error: (error as Error).message
        });
      }
    }
  }

  /**
   * Get last processed block from database
   */
  private async getLastProcessedBlock(): Promise<number | null> {
    try {
      const state = await prisma.indexerState.findUnique({
        where: { key: 'last_block_processed' }
      });

      if (!state) return null;

      const blockNum = Number(state.lastBlockProcessed || state.value);
      return Number.isFinite(blockNum) && blockNum >= 0 ? blockNum : null;
    } catch (error) {
      logger.error('Error getting last processed block', {
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Set last processed block in database
   */
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
      logger.error('Error setting last processed block', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Record successful sync
   */
  private recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  /**
   * Record error
   */
  private recordError(reason: string): void {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      logger.error('Event ingestor exceeded max consecutive errors', {
        consecutiveErrors: this.consecutiveErrors,
        reason
      });
    }
  }

  /**
   * Stop the event ingestor
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.isRunning = false;
    logger.info('Event ingestor stopped');
  }

  /**
   * Get ingestor status
   */
  getStatus() {
    return {
      running: this.isRunning,
      syncing: this.isSyncing,
      lastBlockProcessed: this.lastBlockProcessed,
      consecutiveErrors: this.consecutiveErrors,
      enabled: env.ENABLE_EVENT_STREAM,
      pollIntervalMs: env.EVENT_POLL_INTERVAL_MS,
      chunkSize: env.EVENT_CHUNK_SIZE
    };
  }
}

export const eventIngestor = new EventIngestor();

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
  private lastSuccessfulSyncAt: string | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 10;
  private validatedContractAddresses: string[] = [];

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[INDEXER] Already running');
      return;
    }

    if (!env.ENABLE_EVENT_STREAM) {
      logger.info('[INDEXER] Disabled via ENABLE_EVENT_STREAM');
      this.lastError = null;
      return;
    }

    try {
      const rpcUrls = [env.CELO_RPC_URL, ...env.CELO_RPC_FALLBACK_URLS].filter(Boolean);

      await rpcFailoverManager.initialize(rpcUrls);
      await this.validateContractDeployments();

      this.isRunning = true;
      this.lastError = null;
      logger.info('[INDEXER] Starting initial sync');

      await this.syncEvents({ throwOnFailure: true, trigger: 'startup' });

      this.timer = setInterval(() => {
        void this.syncEvents({ trigger: 'poll' }).catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          logger.error('[INDEXER] Unhandled error in poll', error, {
            service: 'eventIngestor'
          });
        });
      }, env.EVENT_POLL_INTERVAL_MS);

      logger.info('[INDEXER] Started', {
        pollIntervalMs: env.EVENT_POLL_INTERVAL_MS,
        validatedContracts: this.validatedContractAddresses
      });
    } catch (error) {
      this.isRunning = false;
      this.lastError = error instanceof Error ? error.message : String(error);

      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      await rpcFailoverManager.cleanup().catch((cleanupError) => {
        logger.error('[INDEXER] Failed to cleanup RPC failover after startup error', cleanupError);
      });

      logger.error('[INDEXER] Failed to start', error, {
        service: 'eventIngestor'
      });
      throw error;
    }
  }

  private async validateContractDeployments(): Promise<void> {
    const requiredContracts = [
      { name: 'FORGE_QUEST_MANAGER_ADDRESS', address: env.FORGE_QUEST_MANAGER_ADDRESS },
      { name: 'REWARD_NFT_ADDRESS', address: env.REWARD_NFT_ADDRESS },
      { name: 'REPUTATION_ADDRESS', address: env.REPUTATION_ADDRESS },
      { name: 'TREASURY_ADDRESS', address: env.TREASURY_ADDRESS }
    ];

    const validatedContracts: string[] = [];

    for (const contract of requiredContracts) {
      const bytecode = await rpcFailoverManager.callWithFailover(
        (provider) => provider.getCode(contract.address),
        `getCode ${contract.name}`,
        3
      );

      if (!bytecode || bytecode === '0x') {
        throw new Error(
          `${contract.name} (${contract.address}) has no deployed bytecode on Celo Mainnet. Check Railway contract env vars.`
        );
      }

      validatedContracts.push(contract.name);
    }

    this.validatedContractAddresses = validatedContracts;
    logger.info('[INDEXER] Contract deployment validation passed', {
      contracts: validatedContracts
    });
  }

  private async syncEvents(options?: { throwOnFailure?: boolean; trigger?: 'startup' | 'poll' }): Promise<void> {
    const throwOnFailure = options?.throwOnFailure ?? false;
    const trigger = options?.trigger ?? 'poll';

    if (this.isSyncing) {
      if (throwOnFailure) {
        throw new Error('Event sync is already in progress');
      }

      logger.debug('[INDEXER] Sync in progress, skipping', { trigger });
      return;
    }

    this.isSyncing = true;

    try {
      // Get current block
      const currentBlock = await rpcFailoverManager.getBlockNumber();
      if (currentBlock === null) {
        const error = new Error('Failed to get block number from any RPC endpoint');
        this.recordError(error.message);
        this.lastError = error.message;
        if (throwOnFailure) {
          throw error;
        }
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
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      logger.error('[INDEXER] Sync error', error, {
        service: 'eventIngestor',
        trigger
      });
      this.recordError(message);
      if (throwOnFailure) {
        throw error;
      }
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
            .catch((error) => {
              logger.error('[INDEXER] Failed to upsert block header', error, {
                blockNumber
              });
              return null;
            });
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
        logger.error('[INDEXER] Failed to enqueue', error, {
          count: jobsData.length
        });
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
    this.lastError = null;
    this.lastSuccessfulSyncAt = new Date().toISOString();
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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    await rpcFailoverManager.cleanup();
    logger.info('[INDEXER] Stopped');
  }

  getStatus() {
    return {
      running: this.isRunning,
      syncing: this.isSyncing,
      lastBlockProcessed: this.lastBlockProcessed,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      enabled: env.ENABLE_EVENT_STREAM,
      validatedContracts: this.validatedContractAddresses
    };
  }
}

export const productionEventIngestor = new ProductionEventIngestor();

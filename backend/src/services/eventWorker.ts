import { Prisma, type ChainEvent, type TreasuryPayoutStatus } from '@prisma/client';
import { Worker, Job } from 'bullmq';
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from './chain';
import { ChainEventJob } from './eventQueue';
import { webSocketBroadcaster } from './webSocketBroadcaster';

const TREASURY_STATUS_BY_EVENT: Record<string, TreasuryPayoutStatus> = {
  reward_reserved: 'RESERVED',
  reward_released: 'RELEASED',
  reward_paid: 'PAID',
  reward_refunded: 'REFUNDED'
};

function isJsonObject(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getEventPayload(event: ChainEvent): Prisma.JsonObject {
  const payload = event.decodedData ?? event.data;
  return isJsonObject(payload) ? payload : {};
}

class EventWorkerService {
  private worker: Worker<ChainEventJob> | null = null;
  private isRunning = false;

  /**
   * Start the event worker
   */
  async startWorker(): Promise<void> {
    if (!env.REDIS_URL) {
      logger.warn('Redis not configured, skipping event worker');
      return;
    }

    if (this.isRunning) {
      logger.warn('Event worker already running');
      return;
    }

    try {
      const redisUrl = new URL(env.REDIS_URL);
      const redisConfig = {
        host: redisUrl.hostname || 'localhost',
        port: redisUrl.port ? parseInt(redisUrl.port) : 6379,
        password: redisUrl.password || undefined
      };

      this.worker = new Worker<ChainEventJob>(
        'celo-events',
        async (job) => this.processEvent(job),
        {
          connection: redisConfig,
          concurrency: env.EVENT_WORKER_CONCURRENCY
        }
      );

      this.worker.on('completed', (job) => {
        logger.debug('Event job completed', { jobId: job.id });
      });

      this.worker.on('failed', (job, error) => {
        logger.error('Event job failed', {
          jobId: job?.id,
          error: error.message
        });
      });

      this.isRunning = true;
      logger.info('Event worker started', {
        concurrency: env.EVENT_WORKER_CONCURRENCY
      });
    } catch (error) {
      logger.error('Failed to start event worker', {
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Process a single blockchain event
   */
  private async processEvent(job: Job<ChainEventJob>): Promise<void> {
    const startTime = Date.now();

    try {
      const { chainEventId, eventName } = job.data;

      logger.debug('Processing event', {
        jobId: job.id,
        eventName,
        chainEventId
      });

      // Retrieve full event from database
      const chainEvent = await prisma.chainEvent.findUnique({
        where: { id: chainEventId }
      });

      if (!chainEvent) {
        logger.warn('Chain event not found', { chainEventId });
        return;
      }

      // Skip if already processed
      if (chainEvent.processed) {
        logger.debug('Event already processed', { chainEventId });
        return;
      }

      // Decode and process event based on type
      await this.handleEventByType(chainEvent);

      // Mark as processed
      await prisma.chainEvent.update({
        where: { id: chainEventId },
        data: {
          processed: true,
          processedAt: new Date()
        }
      });

      // Update queue tracking
      if (job.id) {
        await prisma.eventQueue.update(
          {
            where: { jobId: job.id },
            data: { status: 'completed', processedAt: new Date() }
          },
          // Handle case where it doesn't exist
        ).catch(() => null);
      }

      // Broadcast event to WebSocket clients
      const broadcastEvent = {
        eventType: chainEvent.eventType,
        eventName: chainEvent.eventName,
        blockNumber: chainEvent.blockNumber,
        transactionHash: chainEvent.transactionHash,
        timestamp: chainEvent.blockTimestamp,
        data: chainEvent.decodedData || chainEvent.data,
        chainQuestId: chainEvent.chainQuestId || undefined,
        playerWallet: chainEvent.playerWallet || undefined,
        creatorWallet: chainEvent.creatorWallet || undefined
      };

      webSocketBroadcaster.broadcastQuestEvent(broadcastEvent);

      const processingTime = Date.now() - startTime;
      logger.debug('Event processed successfully', {
        jobId: job.id,
        eventName,
        processingTimeMs: processingTime
      });
    } catch (error) {
      logger.error('Error processing event', {
        jobId: job.id,
        error: (error as Error).message
      });

      // Update error tracking
      const chainEventId = job.data.chainEventId;
      await prisma.chainEvent
        .update({
          where: { id: chainEventId },
          data: {
            processingError: (error as Error).message
          }
        })
        .catch(() => null);

      throw error;
    }
  }

  /**
   * Handle event based on type
   */
  private async handleEventByType(chainEvent: ChainEvent): Promise<void> {
    switch (chainEvent.eventType) {
      case 'quest_created':
        await this.handleQuestCreated(chainEvent);
        break;
      case 'proof_submitted':
        await this.handleProofSubmitted(chainEvent);
        break;
      case 'reward_claimed':
        await this.handleRewardClaimed(chainEvent);
        break;
      case 'nft_minted':
        await this.handleNFTMinted(chainEvent);
        break;
      case 'reward_reserved':
      case 'reward_released':
      case 'reward_paid':
      case 'reward_refunded':
        await this.handleTreasuryEvent(chainEvent);
        break;
      default:
        logger.debug('Unknown event type', { eventType: chainEvent.eventType });
    }
  }

  /**
   * Handle quest created event
   */
  private async handleQuestCreated(event: ChainEvent): Promise<void> {
    try {
      const data = getEventPayload(event);

      // Store or update quest in database
      // This would sync with your existing quest management logic
      logger.debug('Quest created event processed', {
        questId: data.questId,
        creator: data.creator
      });
    } catch (error) {
      logger.error('Error handling quest created event', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Handle proof submitted event
   */
  private async handleProofSubmitted(event: ChainEvent): Promise<void> {
    try {
      const data = getEventPayload(event);

      logger.debug('Proof submitted event processed', {
        questId: data.questId,
        player: data.player
      });
    } catch (error) {
      logger.error('Error handling proof submitted event', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Handle reward claimed event
   */
  private async handleRewardClaimed(event: ChainEvent): Promise<void> {
    try {
      const data = getEventPayload(event);

      logger.debug('Reward claimed event processed', {
        questId: data.questId,
        player: data.player,
        success: data.success
      });
    } catch (error) {
      logger.error('Error handling reward claimed event', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Handle NFT minted event
   */
  private async handleNFTMinted(event: ChainEvent): Promise<void> {
    try {
      const data = getEventPayload(event);

      logger.debug('NFT minted event processed', {
        player: data.player,
        tokenId: data.tokenId,
        questId: data.questId
      });
    } catch (error) {
      logger.error('Error handling NFT minted event', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Handle treasury events
   */
  private async handleTreasuryEvent(event: ChainEvent): Promise<void> {
    try {
      const data = getEventPayload(event);

      logger.debug('Treasury event processed', {
        eventType: event.eventType,
        questId: data.questId
      });

      // Update treasury payout status based on event type
      if (event.chainQuestId) {
        const status = TREASURY_STATUS_BY_EVENT[event.eventType];
        if (status) {
          await prisma.treasuryPayout
            .updateMany({
              where: { chainQuestId: event.chainQuestId },
              data: { status }
            })
            .catch(() => null);
        }
      }
    } catch (error) {
      logger.error('Error handling treasury event', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Stop the event worker
   */
  async stopWorker(): Promise<void> {
    if (!this.worker) return;

    try {
      await this.worker.close();
      this.isRunning = false;
      logger.info('Event worker stopped');
    } catch (error) {
      logger.error('Error stopping event worker', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      running: this.isRunning,
      concurrency: env.EVENT_WORKER_CONCURRENCY
    };
  }
}

export const eventWorker = new EventWorkerService();

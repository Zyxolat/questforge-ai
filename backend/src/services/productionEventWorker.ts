import { Prisma, type ChainEvent, type TreasuryPayoutStatus } from '@prisma/client';
import { Worker, Job } from 'bullmq';
import { env } from '../config/env';
import { gameStateProjector } from './gameStateProjector';
import { logger } from './logger';
import { prisma } from './chain';
import { ChainEventJob } from './productionEventQueue';
import { worldStateCoordinator } from './worldStateCoordinator';

const TREASURY_STATUS_BY_EVENT: Record<string, TreasuryPayoutStatus> = {
  reward_reserved: 'RESERVED',
  stake_locked: 'LOCKED',
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

class ProductionEventWorker {
  private worker: Worker<ChainEventJob> | null = null;
  private isRunning = false;

  async startWorker(): Promise<void> {
    if (!env.REDIS_URL) {
      logger.warn('[WORKER] Redis not configured');
      return;
    }

    if (this.isRunning) {
      logger.warn('[WORKER] Already running');
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
        async (job) => this.processEventWithErrorIsolation(job),
        {
          connection: redisConfig,
          concurrency: env.EVENT_WORKER_CONCURRENCY
        }
      );

      this.worker.on('completed', (job) => {
        logger.debug('[WORKER] Job completed', { jobId: job.id });
      });

      this.worker.on('failed', (job, error) => {
        logger.error('[WORKER] Job failed', { jobId: job?.id, error: error.message });
      });

      this.isRunning = true;
      logger.info('[WORKER] Started', { concurrency: env.EVENT_WORKER_CONCURRENCY });
    } catch (error) {
      logger.error('[WORKER] Failed to start', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Process event with full error isolation (prevent worker crash)
   */
  private async processEventWithErrorIsolation(job: Job<ChainEventJob>): Promise<void> {
    const startTime = Date.now();

    try {
      const { chainEventId } = job.data;

      logger.debug('[WORKER] Processing', { jobId: job.id, chainEventId });

      // Retrieve event from DB
      const chainEvent = await prisma.chainEvent.findUnique({ where: { id: chainEventId } }).catch(() => null);

      if (!chainEvent) {
        logger.warn('[WORKER] Event not found', { chainEventId });
        return;
      }

      // Skip if already processed or invalidated
      if (chainEvent.processed || chainEvent.invalidatedAt) {
        logger.debug('[WORKER] Event already processed or invalidated', { chainEventId });
        return;
      }

      // Check idempotency before processing
      const existingQueue = await prisma.eventQueue.findFirst({
        where: { chainEventId, status: 'completed' }
      });

      if (existingQueue) {
        logger.debug('[WORKER] Event already completed', { chainEventId });
        return;
      }

      // Process based on event type
      await this.handleEventByType(chainEvent);

      // Mark as processed
      await prisma.chainEvent
        .update({
          where: { id: chainEventId },
          data: {
            processed: true,
            processedAt: new Date(),
            broadcastedAt: new Date()
          }
        })
        .catch((e) => logger.error('[WORKER] Failed to mark processed', { error: e.message }));

      // Update queue tracking
      if (job.id) {
        await prisma.eventQueue
          .update({
            where: { jobId: job.id },
            data: { status: 'completed', processedAt: new Date() }
          })
          .catch(() => null);
      }

      await gameStateProjector.projectChainEvent(chainEvent);

      const processingTime = Date.now() - startTime;
      logger.debug('[WORKER] Processed', { jobId: job.id, processingTimeMs: processingTime });
    } catch (error) {
      logger.error('[WORKER] Processing error', {
        jobId: job.id,
        chainEventId: job.data.chainEventId,
        error: (error as Error).message
      });

      // Record error in DB
      await prisma.chainEvent
        .update({
          where: { id: job.data.chainEventId },
          data: {
            processingError: (error as Error).message
          }
        })
        .catch(() => null);

      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }

  /**
   * Route event handling by type
   */
  private async handleEventByType(chainEvent: ChainEvent): Promise<void> {
    try {
      const eventType = chainEvent.eventType;

      switch (eventType) {
        case 'quest_created':
          await this.handleQuestCreated(chainEvent);
          await worldStateCoordinator.handleGameplaySignal({
            trigger: 'event:quest_created',
            chainQuestId: chainEvent.chainQuestId?.toString(),
            playerWallet: chainEvent.playerWallet || undefined
          });
          break;
        case 'quest_started':
          await this.handleQuestStarted(chainEvent);
          await worldStateCoordinator.handleGameplaySignal({
            trigger: 'event:quest_started',
            chainQuestId: chainEvent.chainQuestId?.toString(),
            playerWallet: chainEvent.playerWallet || undefined
          });
          break;
        case 'proof_submitted':
          await this.handleProofSubmitted(chainEvent);
          break;
        case 'reward_claimed':
          await this.handleRewardClaimed(chainEvent);
          await worldStateCoordinator.handleGameplaySignal({
            trigger: 'event:reward_claimed',
            chainQuestId: chainEvent.chainQuestId?.toString(),
            playerWallet: chainEvent.playerWallet || undefined
          });
          break;
        case 'nft_minted':
          await this.handleNFTMinted(chainEvent);
          await worldStateCoordinator.handleGameplaySignal({
            trigger: 'event:nft_minted',
            chainQuestId: chainEvent.chainQuestId?.toString(),
            playerWallet: chainEvent.playerWallet || undefined
          });
          break;
        case 'reward_reserved':
        case 'stake_locked':
        case 'reward_released':
        case 'reward_paid':
        case 'reward_refunded':
          await this.handleTreasuryEvent(chainEvent);
          await worldStateCoordinator.handleGameplaySignal({
            trigger: `event:${eventType}`,
            chainQuestId: chainEvent.chainQuestId?.toString(),
            playerWallet: chainEvent.playerWallet || undefined
          });
          break;
        default:
          logger.debug('[WORKER] Unknown event type', { eventType });
      }
    } catch (error) {
      logger.error('[WORKER] Event handler error', { error: (error as Error).message });
      throw error;
    }
  }

  private async handleQuestCreated(event: ChainEvent): Promise<void> {
    try {
      logger.debug('[WORKER] Quest created', {
        questId: event.chainQuestId,
        creator: event.creatorWallet
      });
    } catch (error) {
      logger.error('[WORKER] Quest created handler error', { error: (error as Error).message });
    }
  }

  private async handleQuestStarted(event: ChainEvent): Promise<void> {
    try {
      logger.debug('[WORKER] Quest started', {
        questId: event.chainQuestId,
        player: event.playerWallet
      });
    } catch (error) {
      logger.error('[WORKER] Quest started handler error', { error: (error as Error).message });
    }
  }

  private async handleProofSubmitted(event: ChainEvent): Promise<void> {
    try {
      logger.debug('[WORKER] Proof submitted', {
        questId: event.chainQuestId,
        player: event.playerWallet
      });
    } catch (error) {
      logger.error('[WORKER] Proof submitted handler error', { error: (error as Error).message });
    }
  }

  private async handleRewardClaimed(event: ChainEvent): Promise<void> {
    try {
      logger.debug('[WORKER] Reward claimed', {
        questId: event.chainQuestId,
        player: event.playerWallet
      });
    } catch (error) {
      logger.error('[WORKER] Reward claimed handler error', { error: (error as Error).message });
    }
  }

  private async handleNFTMinted(event: ChainEvent): Promise<void> {
    try {
      logger.debug('[WORKER] NFT minted', {
        questId: event.chainQuestId,
        player: event.playerWallet
      });
    } catch (error) {
      logger.error('[WORKER] NFT minted handler error', { error: (error as Error).message });
    }
  }

  private async handleTreasuryEvent(event: ChainEvent): Promise<void> {
    try {
      const data = getEventPayload(event);
      if (event.chainQuestId) {
        const status = TREASURY_STATUS_BY_EVENT[event.eventType];
        if (status) {
          await prisma.treasuryPayout
            .update({
              where: { chainQuestId: event.chainQuestId },
              data: { status }
            })
            .catch(() => null);
        }
      }

      logger.debug('[WORKER] Treasury event', { eventType: event.eventType, questId: data.questId });
    } catch (error) {
      logger.error('[WORKER] Treasury event handler error', { error: (error as Error).message });
    }
  }

  async stopWorker(): Promise<void> {
    if (!this.worker) return;

    try {
      await this.worker.close();
      this.isRunning = false;
      logger.info('[WORKER] Stopped');
    } catch (error) {
      logger.error('[WORKER] Stop error', { error: (error as Error).message });
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      concurrency: env.EVENT_WORKER_CONCURRENCY
    };
  }
}

export const productionEventWorker = new ProductionEventWorker();

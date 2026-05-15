import { Worker, Job } from 'bullmq';
import { env } from '../config/env';
import { authoritativeEventProjector } from './authoritativeEventProjector';
import { logger } from './logger';
import { prisma } from './chain';
import { ChainEventJob } from './productionEventQueue';

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

      if (job.id) {
        await prisma.eventQueue
          .updateMany({
            where: { jobId: job.id },
            data: {
              status: 'processing',
              attempts: { increment: 1 }
            }
          })
          .catch(() => null);
      }

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

      await authoritativeEventProjector.projectChainEvent(chainEvent);

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
      concurrency: env.EVENT_WORKER_CONCURRENCY,
      projector: authoritativeEventProjector.getDiagnostics()
    };
  }
}

export const productionEventWorker = new ProductionEventWorker();

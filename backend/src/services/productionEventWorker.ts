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
      throw new Error('REDIS_URL is required for the production event worker when ENABLE_EVENT_STREAM=true');
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

      await this.worker.waitUntilReady();

      this.worker.on('completed', (job) => {
        logger.debug('[WORKER] Job completed', { jobId: job.id });
      });

      this.worker.on('failed', (job, error) => {
        logger.error('[WORKER] Job failed', error, { jobId: job?.id });
      });

      this.worker.on('error', (error) => {
        logger.error('[WORKER] Worker runtime error', error, {
          service: 'eventWorker'
        });
      });

      this.isRunning = true;
      logger.info('[WORKER] Started', { concurrency: env.EVENT_WORKER_CONCURRENCY });
    } catch (error) {
      if (this.worker) {
        await this.worker.close().catch((closeError) => {
          logger.error('[WORKER] Failed to close worker after startup error', closeError);
        });
        this.worker = null;
      }
      this.isRunning = false;
      logger.error('[WORKER] Failed to start', error, {
        service: 'eventWorker'
      });
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
          .catch((error) => {
            logger.error('[WORKER] Failed to mark queue job as processing', error, {
              jobId: job.id,
              chainEventId
            });
            return null;
          });
      }

      // Retrieve event from DB
      const chainEvent = await prisma.chainEvent.findUnique({ where: { id: chainEventId } }).catch((error) => {
        logger.error('[WORKER] Failed to fetch chain event', error, {
          jobId: job.id,
          chainEventId
        });
        return null;
      });

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
        .catch((error) =>
          logger.error('[WORKER] Failed to mark processed', error, {
            jobId: job.id,
            chainEventId
          })
        );

      // Update queue tracking
      if (job.id) {
        await prisma.eventQueue
          .update({
            where: { jobId: job.id },
            data: { status: 'completed', processedAt: new Date() }
          })
          .catch((error) => {
            logger.error('[WORKER] Failed to mark queue job completed', error, {
              jobId: job.id,
              chainEventId
            });
            return null;
          });
      }

      const processingTime = Date.now() - startTime;
      logger.debug('[WORKER] Processed', { jobId: job.id, processingTimeMs: processingTime });
    } catch (error) {
      logger.error('[WORKER] Processing error', error, {
        jobId: job.id,
        chainEventId: job.data.chainEventId
      });

      // Record error in DB
      await prisma.chainEvent
        .update({
          where: { id: job.data.chainEventId },
          data: {
            processingError: (error as Error).message
          }
        })
        .catch((updateError) => {
          logger.error('[WORKER] Failed to persist processing error', updateError, {
            jobId: job.id,
            chainEventId: job.data.chainEventId
          });
          return null;
        });

      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }

  async stopWorker(): Promise<void> {
    if (!this.worker) return;

    try {
      await this.worker.close();
      this.worker = null;
      this.isRunning = false;
      logger.info('[WORKER] Stopped');
    } catch (error) {
      logger.error('[WORKER] Stop error', error, {
        service: 'eventWorker'
      });
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

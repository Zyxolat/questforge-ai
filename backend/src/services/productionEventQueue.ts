import { Prisma } from '@prisma/client';
import type { RedisOptions } from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from './chain';

export interface ChainEventJob {
  chainEventId: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  eventName: string;
  contractAddress: string;
  data: Prisma.JsonValue;
}

type QueueCompletedEvent = {
  jobId: string;
};

type QueueFailedEvent = {
  jobId: string;
  failedReason?: string;
};

class ProductionEventQueue {
  private queue: Queue<ChainEventJob> | null = null;
  private queueEvents: QueueEvents | null = null;
  private isInitialized = false;
  private maxQueueDepth = 10000;
  private lastDepthWarning = 0;
  private depthMonitor: NodeJS.Timeout | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('[QUEUE] Already initialized');
      return;
    }

    if (!env.REDIS_URL) {
      throw new Error('REDIS_URL is required for the production event queue when ENABLE_EVENT_STREAM=true');
    }

    try {
      const redisUrl = new URL(env.REDIS_URL);
      const redisConfig: RedisOptions = {
        host: redisUrl.hostname || 'localhost',
        port: redisUrl.port ? parseInt(redisUrl.port) : 6379,
        password: redisUrl.password || undefined,
        maxRetriesPerRequest: null
      };

      this.queue = new Queue<ChainEventJob>('celo-events', {
        connection: redisConfig
      });

      this.queueEvents = new QueueEvents('celo-events', {
        connection: redisConfig
      });

      await Promise.all([this.queue.waitUntilReady(), this.queueEvents.waitUntilReady()]);

      this.queueEvents.on('completed', (data: QueueCompletedEvent) => {
        logger.debug('[QUEUE] Job completed', { jobId: data.jobId });
      });

      this.queueEvents.on('failed', (data: QueueFailedEvent) => {
        logger.error('[QUEUE] Job failed', { jobId: data.jobId, failedReason: data.failedReason });
      });

      // Monitor queue depth
      this.monitorQueueDepth();

      this.isInitialized = true;
      logger.info('[QUEUE] Initialized', {
        redisHost: redisUrl.hostname || 'localhost',
        redisPort: redisConfig.port
      });
    } catch (error) {
      await this.cleanup();
      logger.error('[QUEUE] Failed to initialize', error, {
        service: 'eventQueue'
      });
      throw error;
    }
  }

  /**
   * Add event with backpressure control
   */
  async enqueueEvent(event: ChainEventJob, priority?: number): Promise<string> {
    if (!this.queue) {
      logger.warn('[QUEUE] Not initialized');
      return '';
    }

    // Check queue depth
    const counts = await this.queue.getJobCounts();
    const depth = counts.wait || 0;
    if (depth > this.maxQueueDepth) {
      logger.error('[QUEUE] Backpressure: queue depth exceeded', {
        depth,
        maxDepth: this.maxQueueDepth
      });

      // Reject if too backed up
      if (depth > this.maxQueueDepth * 1.5) {
        throw new Error('Queue overloaded');
      }
    }

    try {
      const job = await this.queue.add(`event-${event.transactionHash}-${event.logIndex}`, event, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: env.INDEXER_BACKOFF_MS || 1000
        },
        removeOnComplete: {
          age: 3600
        },
        removeOnFail: false,
        priority: priority || 0
      });

      await prisma.eventQueue.create({
        data: {
          jobId: job.id || '',
          chainEventId: event.chainEventId,
          status: 'pending'
        }
      });

      logger.debug('[QUEUE] Event enqueued', { jobId: job.id, eventKey: `${event.transactionHash}:${event.logIndex}` });
      return job.id || '';
    } catch (error) {
      logger.error('[QUEUE] Failed to enqueue', error, {
        transactionHash: event.transactionHash,
        logIndex: event.logIndex
      });
      throw error;
    }
  }

  /**
   * Batch enqueue with rate limiting
   */
  async enqueueBatch(events: ChainEventJob[], delayMs = 10): Promise<string[]> {
    const jobIds: string[] = [];

    for (let i = 0; i < events.length; i++) {
      try {
        const jobId = await this.enqueueEvent(events[i]);
        jobIds.push(jobId);

        // Rate limiting
        if ((i + 1) % 100 === 0) {
          await this.sleep(delayMs);
        }
      } catch (error) {
        logger.error('[QUEUE] Failed to enqueue item in batch', error, {
          index: i,
          transactionHash: events[i]?.transactionHash,
          logIndex: events[i]?.logIndex
        });
      }
    }

    logger.info('[QUEUE] Batch enqueued', { count: jobIds.length, total: events.length });
    return jobIds;
  }

  /**
   * Monitor queue depth
   */
  private monitorQueueDepth(): void {
    this.depthMonitor = setInterval(async () => {
      if (!this.queue) return;

      try {
        const counts = await this.queue.getJobCounts();
        const waiting = counts.wait || 0;
        const active = counts.active || 0;
        const delayed = counts.delayed || 0;
        const failed = counts.failed || 0;
        const completed = counts.completed || 0;

        const total = waiting + active + delayed + failed + completed;

        // Store metrics
        await prisma.queueMetrics.create({
          data: {
            queueDepth: waiting,
            processingRate: active,
            errorRate: failed,
            avgLatencyMs: 0,
            activeWorkers: active,
            rpcLatencyMs: 0,
            websocketConnections: 0
          }
        });

        if (waiting > this.maxQueueDepth * 0.8 && Date.now() - this.lastDepthWarning > 60000) {
          logger.warn('[QUEUE] High queue depth', {
            waiting,
            active,
            delayed,
            failed,
            total
          });
          this.lastDepthWarning = Date.now();
        }

        logger.debug('[QUEUE] Depth', { waiting, active, delayed, failed, completed, total });
      } catch (error) {
        logger.error('[QUEUE] Failed to monitor depth', error, {
          service: 'eventQueueMonitor'
        });
      }
    }, 10000);
  }

  /**
   * Get queue stats
   */
  async getQueueStats() {
    if (!this.queue) return null;

    try {
      const counts = await this.queue.getJobCounts();
      const waiting = counts.wait || 0;
      const active = counts.active || 0;
      const delayed = counts.delayed || 0;
      const failed = counts.failed || 0;
      const completed = counts.completed || 0;

      return {
        waiting,
        active,
        delayed,
        failed,
        completed,
        total: waiting + active + delayed + failed + completed,
        healthy: waiting < this.maxQueueDepth
      };
    } catch (error) {
      logger.error('[QUEUE] Failed to get stats', error, {
        service: 'eventQueue'
      });
      return null;
    }
  }

  getQueue(): Queue | null {
    return this.queue;
  }

  async cleanup(): Promise<void> {
    try {
      if (this.depthMonitor) {
        clearInterval(this.depthMonitor);
        this.depthMonitor = null;
      }
      if (this.queueEvents) await this.queueEvents.close();
      if (this.queue) await this.queue.close();
      this.queueEvents = null;
      this.queue = null;
      this.isInitialized = false;
      logger.info('[QUEUE] Cleaned up');
    } catch (error) {
      logger.error('[QUEUE] Cleanup error', error, {
        service: 'eventQueue'
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const productionEventQueue = new ProductionEventQueue();

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

class EventQueueService {
  private queue: Queue<ChainEventJob> | null = null;
  private queueEvents: QueueEvents | null = null;
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized || !env.REDIS_URL) {
      logger.warn('EventQueueService: Redis not configured or already initialized');
      return;
    }

    try {
      // Parse Redis URL
      const redisUrl = new URL(env.REDIS_URL);
      const redisConfig: RedisOptions = {
        host: redisUrl.hostname || 'localhost',
        port: redisUrl.port ? parseInt(redisUrl.port) : 6379,
        password: redisUrl.password || undefined,
        maxRetriesPerRequest: null
      };

      // Create queue with connection
      this.queue = new Queue<ChainEventJob>('celo-events', {
        connection: redisConfig
      });

      // Setup queue events
      this.queueEvents = new QueueEvents('celo-events', {
        connection: redisConfig
      });

      // Event listeners
      this.queueEvents.on('completed', async (data: QueueCompletedEvent) => {
        logger.debug('Job completed', { jobId: data.jobId });
      });

      this.queueEvents.on('failed', (data: QueueFailedEvent) => {
        logger.error('Job failed', {
          jobId: data.jobId,
          failedReason: data.failedReason
        });
      });

      this.isInitialized = true;
      logger.info('EventQueueService initialized');
    } catch (error) {
      logger.error('Failed to initialize EventQueueService', {
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Add a chain event to the queue
   */
  async enqueueEvent(event: ChainEventJob, priority?: number): Promise<string> {
    if (!this.queue) {
      logger.warn('Queue not initialized, skipping enqueue');
      return '';
    }

    try {
      const job = await this.queue.add(
        `event-${event.transactionHash}-${event.logIndex}`,
        event,
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: env.INDEXER_BACKOFF_MS
          },
          removeOnComplete: {
            age: 3600 // Keep for 1 hour
          },
          removeOnFail: false, // Keep failed jobs for debugging
          priority: priority || 0
        }
      );

      // Track in database
      await prisma.eventQueue.create({
        data: {
          jobId: job.id || '',
          chainEventId: event.chainEventId,
          status: 'pending'
        }
      });

      logger.debug('Event enqueued', { jobId: job.id });
      return job.id || '';
    } catch (error) {
      logger.error('Failed to enqueue event', {
        error: (error as Error).message,
        event
      });
      throw error;
    }
  }

  /**
   * Batch enqueue events
   */
  async enqueueBatch(events: ChainEventJob[]): Promise<string[]> {
    const jobIds = await Promise.all(events.map(e => this.enqueueEvent(e)));
    logger.info('Batch enqueued', { count: events.length, jobIds });
    return jobIds;
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
        total: waiting + active + delayed + failed + completed
      };
    } catch (error) {
      logger.error('Failed to get queue stats', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * Get queue instance (for worker setup)
   */
  getQueue(): Queue<ChainEventJob> | null {
    return this.queue;
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    try {
      if (this.queueEvents) {
        await this.queueEvents.close();
      }
      if (this.queue) {
        await this.queue.close();
      }
      this.isInitialized = false;
      logger.info('EventQueueService cleaned up');
    } catch (error) {
      logger.error('Error during EventQueueService cleanup', {
        error: (error as Error).message
      });
    }
  }
}

export const eventQueue = new EventQueueService();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { env } from './config/env';
import { performHealthCheck } from './config/production';
import { globalLimiter } from './middleware/rateLimits';
import { apiRouter } from './routes/api';
import { logger } from './services/logger';
import { productionEventIngestor } from './services/productionEventIngestor';
import { productionEventQueue } from './services/productionEventQueue';
import { productionEventWorker } from './services/productionEventWorker';
import { productionWebSocketBroadcaster } from './services/productionWebSocketBroadcaster';
import { rpcFailoverManager } from './services/rpcFailoverManager';
import { prisma } from './services/chain';
import { aiQuestGenerationEngine } from './services/aiQuestGenerationEngine';
import { worldStateCoordinator } from './services/worldStateCoordinator';

const app = express();
const httpServer = createServer(app);

let isShuttingDown = false;

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} not allowed`));
    },
    credentials: true
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(globalLimiter);

// Initialize WebSocket
if (env.WEBSOCKET_ENABLED) {
  productionWebSocketBroadcaster.initialize(httpServer);
}

app.get('/health', async (_req, res) => {
  const health = await performHealthCheck();
  res.status(health.healthy ? 200 : 503).json(health);
});

/**
 * Comprehensive event streaming health endpoint
 */
app.get('/health/events', async (_req, res) => {
  try {
    const ingestorStatus = productionEventIngestor.getStatus();
    const workerStatus = productionEventWorker.getStatus();
    const queueStats = await productionEventQueue.getQueueStats();
    const wsStats = productionWebSocketBroadcaster.getStats();
    const rpcHealth = await rpcFailoverManager.getHealthStatus();
    const worldDiagnostics = worldStateCoordinator.getDiagnostics();
    const questDiagnostics = aiQuestGenerationEngine.getDiagnostics();

    res.json({
      timestamp: new Date().toISOString(),
      ingestor: ingestorStatus,
      worker: workerStatus,
      queue: queueStats,
      websocket: wsStats,
      rpc: {
        endpoints: rpcHealth,
        lastSuccessful: rpcFailoverManager.getLastSuccessfulEndpoint(),
        healthCount: rpcHealth.filter((e) => e.healthy).length,
        totalCount: rpcHealth.length
      },
      orchestration: {
        questGeneration: questDiagnostics,
        worldState: worldDiagnostics
      },
      healthy:
        ingestorStatus.running &&
        workerStatus.running &&
        (queueStats?.healthy ?? false) &&
        rpcHealth.filter((e) => e.healthy).length > 0 &&
        worldDiagnostics.activeVersion !== null
    });
  } catch (error) {
    logger.error('Failed to generate health report', { error: (error as Error).message });
    res.status(500).json({ error: 'Health check failed' });
  }
});

app.use('/api', apiRouter);

app.get('/', (_req, res) => {
  res.json({ status: 'QuestForge AI backend online' });
});

/**
 * Graceful shutdown with error isolation
 */
const gracefulShutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutting down gracefully');

  const shutdownTasks = [
    {
      name: 'Ingestor',
      fn: () => productionEventIngestor.stop()
    },
    {
      name: 'Worker',
      fn: () => productionEventWorker.stopWorker()
    },
    {
      name: 'Queue',
      fn: () => productionEventQueue.cleanup()
    },
    {
      name: 'WebSocket',
      fn: () => productionWebSocketBroadcaster.cleanup()
    },
    {
      name: 'RPC Failover',
      fn: () => rpcFailoverManager.cleanup()
    },
    {
      name: 'Prisma',
      fn: () => prisma.$disconnect()
    }
  ];

  for (const task of shutdownTasks) {
    try {
      await task.fn();
      logger.info(`[SHUTDOWN] ${task.name} stopped`);
    } catch (error) {
      logger.error(`[SHUTDOWN] ${task.name} error`, { error: (error as Error).message });
    }
  }

  logger.info('[SHUTDOWN] All services stopped');
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

/**
 * Start server
 */
const startServer = async () => {
  try {
    logger.info('[STARTUP] Initializing services');

    await worldStateCoordinator.initialize();

    // Initialize queue
    await productionEventQueue.initialize();

    // Start worker
    await productionEventWorker.startWorker();

    // Start ingestor with auto-restart on failure
    const startIngestorWithRestart = async () => {
      try {
        await productionEventIngestor.start();
      } catch (error) {
        logger.error('[STARTUP] Ingestor failed', { error: (error as Error).message });
        // Retry after 10 seconds
        setTimeout(startIngestorWithRestart, 10000);
      }
    };

    await startIngestorWithRestart();

    // Listen
    httpServer.listen(env.PORT, () => {
      logger.info('[STARTUP] Server listening', {
        port: env.PORT,
        environment: env.NODE_ENV,
        eventStreamingEnabled: env.ENABLE_EVENT_STREAM,
        websocketEnabled: env.WEBSOCKET_ENABLED
      });
    });
  } catch (error) {
    logger.error('[STARTUP] Failed', { error: (error as Error).message });
    process.exit(1);
  }
};

startServer();

/**
 * Online ForgeQuest Game - Backend Entry Point
 *
 * Environment variables are validated eagerly when `./config/env` is imported
 * below. If any required variable is missing the process will exit before
 * binding to a port, causing all Railway healthchecks to fail.
 *
 * Required variables that MUST be set in the Railway dashboard before deploy:
 *   DATABASE_URL, FRONTEND_URL, CORS_ORIGIN, JWT_SECRET, JWT_EXPIRES_IN,
 *   CELO_RPC_URL, CELO_CHAIN_ID, FORGE_QUEST_MANAGER_ADDRESS,
 *   REWARD_NFT_ADDRESS, REPUTATION_ADDRESS, TREASURY_ADDRESS
 *
 * See backend/.env.example for the full list and backend/README.md for setup
 * instructions.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import {
  EnvValidationError,
  formatEnvironmentValidation,
  initializeEnvironment
} from './config/env';
import { logger } from './services/logger';

type StartupServiceKey =
  | 'database'
  | 'worldState'
  | 'proofVerificationWorker';

type StartupServiceStatus = 'pending' | 'initializing' | 'ready' | 'failed' | 'skipped';

type StartupServiceState = {
  status: StartupServiceStatus;
  optional: boolean;
  attempts: number;
  lastStartedAt: string | null;
  lastReadyAt: string | null;
  lastError: string | null;
};

type StartupState = {
  servicesReady: boolean;
  isInitializing: boolean;
  initializationAttempts: number;
  lastStartedAt: string | null;
  lastReadyAt: string | null;
  lastError: string | null;
  retryDelayMs: number | null;
  nextRetryAt: string | null;
  services: Record<StartupServiceKey, StartupServiceState>;
};

const STARTUP_RETRY_BASE_DELAY_MS = 5000;
const STARTUP_RETRY_MAX_DELAY_MS = 60000;

function createServiceState(optional: boolean): StartupServiceState {
  return {
    status: 'pending',
    optional,
    attempts: 0,
    lastStartedAt: null,
    lastReadyAt: null,
    lastError: null
  };
}

function nowIso() {
  return new Date().toISOString();
}

function formatRootCause(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function withTimeout<T>(label: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

async function bootstrap() {
  let envResult;

  try {
    envResult = initializeEnvironment();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${formatEnvironmentValidation(error.result)}\n`);
      process.exit(1);
      return;
    }

    throw error;
  }

  if (envResult.warnings.length > 0) {
    logger.warn('[ENV] Optional configuration ignored', {
      warnings: envResult.warnings.map((warning) => ({
        group: warning.group,
        name: warning.name,
        message: warning.message
      }))
    });
  }

  const { env } = await import('./config/env');
  const { performHealthCheck } = await import('./config/production');
  const { globalLimiter } = await import('./middleware/rateLimits');
  const { apiRouter } = await import('./routes/api');
  const { prisma } = await import('./services/chain');
  const { assertAuthStorageReady } = await import('./services/auth');
  const { startProofVerificationWorker, stopProofVerificationWorker } = await import('./services/verification');
  const { worldStateCoordinator } = await import('./services/worldStateCoordinator');

  await prisma.$queryRaw`SELECT 1`;
  await assertAuthStorageReady(prisma);

  const app = express();
  const httpServer = createServer(app);
  const openSockets = new Set<import('net').Socket>();

  httpServer.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => {
      openSockets.delete(socket);
    });
  });

  const startupState: StartupState = {
    servicesReady: false,
    isInitializing: false,
    initializationAttempts: 0,
    lastStartedAt: null,
    lastReadyAt: null,
    lastError: null,
    retryDelayMs: null,
    nextRetryAt: null,
    services: {
      database: createServiceState(false),
      worldState: createServiceState(false),
      proofVerificationWorker: createServiceState(true)
    }
  };

  let isShuttingDown = false;
  let retryTimer: NodeJS.Timeout | null = null;

  const runStartupStep = async <T>(
    service: StartupServiceKey,
    attempt: number,
    fn: () => Promise<T>,
    options?: {
      optional?: boolean;
      timeoutMs?: number;
      swallowFailure?: boolean;
    }
  ): Promise<T | null> => {
    const timeoutMs = options?.timeoutMs ?? 30000;
    const optional = options?.optional ?? startupState.services[service].optional;
    const startedAt = nowIso();

    startupState.services[service] = {
      ...startupState.services[service],
      optional,
      status: 'initializing',
      attempts: startupState.services[service].attempts + 1,
      lastStartedAt: startedAt,
      lastError: null
    };

    logger.info(`[STARTUP] Service initializing: ${service}`, {
      service,
      attempt,
      timeoutMs,
      optional
    });

    try {
      const result = await withTimeout(`${service} initialization`, fn, timeoutMs);
      startupState.services[service] = {
        ...startupState.services[service],
        status: 'ready',
        lastReadyAt: nowIso(),
        lastError: null
      };

      logger.info(`[STARTUP] Service ready: ${service}`, {
        service,
        attempt
      });

      return result;
    } catch (error) {
      const rootCause = formatRootCause(error);
      startupState.services[service] = {
        ...startupState.services[service],
        status: 'failed',
        lastError: rootCause
      };

      logger.error(`[STARTUP] Service initialization failed: ${service}`, error, {
        service,
        attempt,
        optional
      });

      if (options?.swallowFailure) {
        return null;
      }

      throw error;
    }
  };

  const getLatestFailedService = () => {
    const failedService = (Object.entries(startupState.services) as Array<[StartupServiceKey, StartupServiceState]>)
      .filter(([, service]) => service.status === 'failed')
      .sort(([, left], [, right]) => {
        const leftStarted = left.lastStartedAt ? Date.parse(left.lastStartedAt) : 0;
        const rightStarted = right.lastStartedAt ? Date.parse(right.lastStartedAt) : 0;
        return rightStarted - leftStarted;
      })[0];

    if (!failedService) {
      return null;
    }

    return `${failedService[0]}: ${failedService[1].lastError ?? 'unknown error'}`;
  };

  const scheduleServiceRetry = () => {
    if (retryTimer || isShuttingDown) {
      return;
    }

    const retryDelayMs = Math.min(
      STARTUP_RETRY_MAX_DELAY_MS,
      STARTUP_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, startupState.initializationAttempts - 1)
    );
    const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();

    startupState.retryDelayMs = retryDelayMs;
    startupState.nextRetryAt = nextRetryAt;

    logger.warn('[STARTUP] Scheduling background service retry', {
      attempt: startupState.initializationAttempts,
      retryDelayMs,
      nextRetryAt,
      lastError: startupState.lastError
    });

    retryTimer = setTimeout(() => {
      retryTimer = null;
      void initializeBackgroundServices();
    }, retryDelayMs);
  };

  const initializeOptionalRuntimeServices = async () => {
    // Optional services initialization (currently empty)
  };

  const initializeBackgroundServices = async () => {
    if (startupState.isInitializing || startupState.servicesReady || isShuttingDown) {
      return;
    }

    const attempt = startupState.initializationAttempts + 1;

    startupState.isInitializing = true;
    startupState.initializationAttempts = attempt;
    startupState.lastStartedAt = nowIso();
    startupState.lastError = null;

    logger.info('[STARTUP] Initializing background services', {
      attempt
    });

    try {
      await initializeOptionalRuntimeServices();

      await runStartupStep('database', attempt, async () => {
        await prisma.$queryRaw`SELECT 1`;
        await assertAuthStorageReady(prisma);
      }, { timeoutMs: 5000 });

      await runStartupStep('worldState', attempt, async () => {
        await worldStateCoordinator.initialize();
      }, { timeoutMs: 15000 });

      await runStartupStep('proofVerificationWorker', attempt, async () => {
        startProofVerificationWorker();
      }, { timeoutMs: 5000, optional: true });

      startupState.servicesReady = true;
      startupState.lastReadyAt = nowIso();
      startupState.lastError = null;
      startupState.retryDelayMs = null;
      startupState.nextRetryAt = null;

      logger.info('[STARTUP] Background services ready', {
        attempt,
        readyAt: startupState.lastReadyAt
      });
    } catch (error) {
      startupState.servicesReady = false;
      startupState.lastError = getLatestFailedService() ?? formatRootCause(error);

      logger.error(
        `[STARTUP] Background service initialization failed: ${startupState.lastError ?? formatRootCause(error)}`,
        error,
        {
        attempt,
        lastError: startupState.lastError
        }
      );

      scheduleServiceRetry();
    } finally {
      startupState.isInitializing = false;
    }
  };

  const gracefulShutdown = async (exitCode = 0) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    logger.info('[SHUTDOWN] Shutting down gracefully', {
      exitCode
    });

    const forceExitTimer = setTimeout(() => {
      logger.error('[SHUTDOWN] Force exiting after shutdown timeout');
      process.exit(exitCode);
    }, 15000);

    // Forcefully close any remaining open sockets so the server can terminate cleanly.
    for (const socket of [...openSockets]) {
      socket.destroy();
      openSockets.delete(socket);
    }

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    }).catch((error) => {
      logger.error('[SHUTDOWN] HTTP server close failed', error);
      return undefined;
    });

    const shutdownTasks = [
      { name: 'Proof Verification Worker', fn: () => stopProofVerificationWorker() },
      { name: 'Prisma', fn: () => prisma.$disconnect() }
    ];

    for (const task of shutdownTasks) {
      try {
        await task.fn();
        logger.info(`[SHUTDOWN] ${task.name} stopped`);
      } catch (error) {
        logger.error(`[SHUTDOWN] ${task.name} error`, error);
      }
    }

    logger.info('[SHUTDOWN] All services stopped');
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => {
    void gracefulShutdown(0);
  });
  process.on('SIGINT', () => {
    void gracefulShutdown(0);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('[PROCESS] Unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('[PROCESS] Uncaught exception', error);
    void gracefulShutdown(1);
  });

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.CORS_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        logger.warn('[CORS] Rejected request origin', {
          origin,
          allowedOrigins: env.CORS_ORIGINS
        });
        callback(new Error(`Origin ${origin} not allowed`));
      },
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      optionsSuccessStatus: 204
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'questforge-backend',
      environment: env.NODE_ENV,
      startup: startupState,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/health/ready', async (_req, res) => {
    const health = await performHealthCheck({
      servicesReady: startupState.servicesReady,
      lastError: startupState.lastError
    });
    const ready = startupState.servicesReady && health.healthy;

    res.status(ready ? 200 : 503).json({
      ...health,
      startup: startupState,
      ready
    });
  });

  app.use(globalLimiter);
  // Import admin router
  const { adminRouter } = await import('./routes/admin');
  app.use('/admin', adminRouter);
  app.use('/api', apiRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: {
        code: 'API_ROUTE_NOT_FOUND',
        message: 'Backend API route not found'
      },
      action: 'none'
    });
  });

  app.get('/', (_req, res) => {
    res.json({ status: 'Online ForgeQuest Game backend online' });
  });

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    void next;
    const message = error instanceof Error ? error.message : String(error);
    const isCorsOriginError = /Origin .* not allowed/.test(message);

    logger.error('[HTTP] Unhandled request error', error, {
      method: req.method,
      path: req.path,
      origin: req.get('origin') ?? null
    });

    res.status(isCorsOriginError ? 403 : 500).json({
      error: {
        code: isCorsOriginError ? 'CORS_ORIGIN_NOT_ALLOWED' : 'INTERNAL_SERVER_ERROR',
        message: isCorsOriginError
          ? 'This frontend origin is not allowed by the backend CORS configuration.'
          : 'Internal server error'
      },
      action: 'none'
    });
  });

  httpServer.once('error', (error) => {
    logger.error('[STARTUP] HTTP server failed to bind', error, {
      port: env.PORT
    });
    process.exit(1);
  });

  httpServer.listen(env.PORT, '0.0.0.0', () => {
    logger.info('[STARTUP] Server listening', {
      port: env.PORT,
      host: '0.0.0.0',
      environment: env.NODE_ENV
    });

    void initializeBackgroundServices();
  });
}

bootstrap().catch((error) => {
  logger.error('[STARTUP] Fatal bootstrap failure', error);
  process.exit(1);
});

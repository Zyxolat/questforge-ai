import { env } from './env';
import { prisma } from '../services/chain';
import { contracts } from '../services/contracts';
import { aiOpenAIClient } from '../services/aiOpenAIClient';
import { aiQuestGenerationEngine } from '../services/aiQuestGenerationEngine';
import { worldStateCoordinator } from '../services/worldStateCoordinator';
import { productionEventIngestor } from '../services/productionEventIngestor';
import { productionEventQueue } from '../services/productionEventQueue';
import { productionEventWorker } from '../services/productionEventWorker';
import { productionWebSocketBroadcaster } from '../services/productionWebSocketBroadcaster';
import { rpcFailoverManager } from '../services/rpcFailoverManager';

type StartupSnapshot = {
  servicesReady: boolean;
  lastError: string | null;
};

type HealthCheckEntry = {
  ok: boolean;
  required: boolean;
  message: string;
};

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

export async function performHealthCheck(startup?: StartupSnapshot) {
  const heapUsage = process.memoryUsage();
  const heapUtilization = heapUsage.heapTotal > 0 ? heapUsage.heapUsed / heapUsage.heapTotal : 0;
  const openAIHealth = aiOpenAIClient.getHealthStatus();
  const ingestorStatus = productionEventIngestor.getStatus();
  const queueStats = await withTimeout(
    'queue health check',
    () => productionEventQueue.getQueueStats().catch(() => null),
    2000
  ).catch(() => null);
  const workerStatus = productionEventWorker.getStatus();
  const eventStreamingRequired = env.NODE_ENV === 'production' || env.ENABLE_EVENT_STREAM;
  const openAIRequired = !env.ALLOW_AI_FALLBACK;
  const recentSyncWindowMs = Math.max(env.EVENT_POLL_INTERVAL_MS * 3, 120000);
  const lastSuccessfulSyncAt = ingestorStatus.lastSuccessfulSyncAt
    ? Date.parse(ingestorStatus.lastSuccessfulSyncAt)
    : Number.NaN;
  const hasRecentSuccessfulSync =
    Number.isFinite(lastSuccessfulSyncAt) && Date.now() - lastSuccessfulSyncAt <= recentSyncWindowMs;

  const checks: Record<string, HealthCheckEntry> = {
    database: {
      ok: false,
      required: true,
      message: 'Database not checked yet'
    },
    blockchain: {
      ok: false,
      required: eventStreamingRequired,
      message: eventStreamingRequired ? 'Blockchain not checked yet' : 'Event streaming disabled'
    },
    worldState: {
      ok: false,
      required: eventStreamingRequired,
      message: eventStreamingRequired ? 'World state not initialized yet' : 'Event streaming disabled'
    },
    openai: {
      ok: openAIRequired ? openAIHealth.validated : openAIHealth.configured,
      required: openAIRequired,
      message: openAIHealth.validated
        ? `OpenAI model ${openAIHealth.model} validated`
        : openAIHealth.lastError || (openAIRequired ? 'OpenAI has not been validated yet' : 'Fallback mode allowed')
    },
    verifier: {
      ok: Boolean(contracts.verifierSigner),
      required: env.NODE_ENV === 'production',
      message: contracts.verifierSigner ? 'Verifier signer configured' : 'Verifier signer not configured'
    },
    memory: {
      ok: heapUsage.heapTotal === 0 || heapUtilization < 0.98,
      required: true,
      message: `Heap utilization ${(heapUtilization * 100).toFixed(1)}%`
    }
  };

  try {
    await withTimeout('database health check', () => prisma.$queryRaw`SELECT 1`, 2000);
    checks.database = {
      ok: true,
      required: true,
      message: 'Database query succeeded'
    };
  } catch (error) {
    checks.database = {
      ok: false,
      required: true,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const worldDiagnostics = worldStateCoordinator.getDiagnostics();
  checks.worldState = eventStreamingRequired
    ? {
        ok: worldDiagnostics.activeVersion !== null,
        required: true,
        message:
          worldDiagnostics.activeVersion !== null
            ? `World state version ${worldDiagnostics.activeVersion} active`
            : 'World state has not reached an active version yet'
      }
    : {
        ok: true,
        required: false,
        message: 'Event streaming disabled'
      };

  if (!eventStreamingRequired) {
    checks.blockchain = {
      ok: true,
      required: false,
      message: 'Event streaming disabled'
    };
  } else if (hasRecentSuccessfulSync) {
    checks.blockchain = {
      ok: true,
      required: true,
      message: `Recent successful chain sync at ${ingestorStatus.lastSuccessfulSyncAt}`
    };
  } else {
    try {
      const latestBlock = await withTimeout('blockchain health check', async () => {
        const rpcHealth = await rpcFailoverManager.getHealthStatus();
        if (rpcHealth.length > 0) {
          const healthyEndpointCount = rpcHealth.filter((endpoint) => endpoint.healthy).length;
          if (healthyEndpointCount > 0) {
            return healthyEndpointCount;
          }
        }

        const fallbackBlock = await contracts.provider.getBlockNumber();
        return fallbackBlock >= env.INDEXER_FROM_BLOCK ? 1 : 0;
      }, 4000);

      checks.blockchain = {
        ok: latestBlock > 0,
        required: true,
        message:
          latestBlock > 0
            ? `Blockchain connectivity available via ${rpcFailoverManager.getLastSuccessfulEndpoint() ?? 'fallback provider'}`
            : 'No healthy RPC endpoint available'
      };
    } catch (error) {
      checks.blockchain = {
        ok: false,
        required: true,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const requiredChecksHealthy = Object.values(checks).every((check) => !check.required || check.ok);
  const backgroundHealthy = eventStreamingRequired
    ? Boolean(
        startup?.servicesReady &&
          ingestorStatus.running &&
          hasRecentSuccessfulSync &&
          workerStatus.running &&
          queueStats?.healthy
      )
    : Boolean(startup?.servicesReady ?? true);

  return {
    healthy: requiredChecksHealthy && backgroundHealthy,
    environment: env.NODE_ENV,
    chainId: env.CELO_CHAIN_ID,
    checks,
    dependencies: {
      queue: queueStats,
      worker: workerStatus,
      ingestor: ingestorStatus,
      websocket: productionWebSocketBroadcaster.getStats(),
      openai: openAIHealth,
      rpcLastSuccessfulEndpoint: rpcFailoverManager.getLastSuccessfulEndpoint()
    },
    orchestration: {
      questGeneration: aiQuestGenerationEngine.getDiagnostics(),
      worldState: worldDiagnostics
    },
    startup: startup ?? null,
    timestamp: new Date().toISOString()
  };
}

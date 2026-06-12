import { env } from './env';
import { prisma } from '../services/chain';
import { contracts } from '../services/contracts';
import { ruleBasedQuestEngine } from '../services/ruleBasedQuestEngine';
import { worldStateCoordinator } from '../services/worldStateCoordinator';

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

  const checks: Record<string, HealthCheckEntry> = {
    database: {
      ok: false,
      required: true,
      message: 'Database not checked yet'
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
  checks.worldState = {
    ok: worldDiagnostics.activeVersion !== null,
    required: true,
    message:
      worldDiagnostics.activeVersion !== null
        ? `World state version ${worldDiagnostics.activeVersion} active`
        : 'World state has not reached an active version yet'
  };

  try {
    const latestBlock = await withTimeout('blockchain health check', async () => {
      const fallbackBlock = await contracts.provider.getBlockNumber();
      return fallbackBlock >= env.INDEXER_FROM_BLOCK ? 1 : 0;
    }, 4000);

    checks.blockchain = {
      ok: latestBlock > 0,
      required: true,
      message: latestBlock > 0 ? 'Blockchain connectivity available' : 'Blockchain not reachable'
    };
  } catch (error) {
    checks.blockchain = {
      ok: false,
      required: true,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const requiredChecksHealthy = Object.values(checks).every((check) => !check.required || check.ok);

  return {
    healthy: requiredChecksHealthy && Boolean(startup?.servicesReady ?? true),
    environment: env.NODE_ENV,
    chainId: env.CELO_CHAIN_ID,
    checks,
    orchestration: {
      questGeneration: ruleBasedQuestEngine.getDiagnostics(),
      worldState: worldDiagnostics
    },
    startup: startup ?? null,
    timestamp: new Date().toISOString()
  };
}

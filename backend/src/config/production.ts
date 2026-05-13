import { env } from './env';
import { prisma } from '../services/chain';
import { contracts } from '../services/contracts';
import { aiQuestGenerationEngine } from '../services/aiQuestGenerationEngine';
import { worldStateCoordinator } from '../services/worldStateCoordinator';

export async function performHealthCheck() {
  const checks = {
    database: false,
    blockchain: false,
    verifier: false,
    memory: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal < 0.9,
    worldState: false
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }

  try {
    const latestBlock = await contracts.provider.getBlockNumber();
    checks.blockchain = latestBlock >= env.INDEXER_FROM_BLOCK;
  } catch {
    checks.blockchain = false;
  }

  checks.verifier = Boolean(contracts.verifierSigner);
  try {
    const worldState = await worldStateCoordinator.getCurrentWorldState('healthcheck');
    checks.worldState = worldState.version >= 1;
  } catch {
    checks.worldState = false;
  }

  return {
    healthy: Object.values(checks).every(Boolean),
    environment: env.NODE_ENV,
    chainId: env.CELO_CHAIN_ID,
    checks,
    orchestration: {
      questGeneration: aiQuestGenerationEngine.getDiagnostics(),
      worldState: worldStateCoordinator.getDiagnostics()
    },
    timestamp: new Date().toISOString()
  };
}

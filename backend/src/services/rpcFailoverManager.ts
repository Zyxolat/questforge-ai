import { ethers } from 'ethers';
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from './chain';

interface RpcHealth {
  endpoint: string;
  healthy: boolean;
  healthScore: number;
  lastCheckedAt: Date | null;
  consecutiveErrors: number;
  avgLatencyMs: number;
}

class RpcFailoverManager {
  private providers: Map<string, ethers.JsonRpcProvider> = new Map();
  private endpoints: Array<{ url: string; priority: number }> = [];
  private currentEndpointIndex = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastSuccessfulEndpoint: string | null = null;

  async initialize(endpointUrls: string[]): Promise<void> {
    if (endpointUrls.length === 0) {
      throw new Error('No RPC endpoints provided');
    }

    // Initialize providers
    for (const url of endpointUrls) {
      const provider = new ethers.JsonRpcProvider(url, env.CELO_CHAIN_ID);
      this.providers.set(url, provider);
      this.endpoints.push({ url, priority: endpointUrls.indexOf(url) });
    }

    logger.info('[RPC] Failover manager initialized', {
      endpoints: endpointUrls.length,
      urls: endpointUrls
    });

    // Initialize endpoints in database
    for (const url of endpointUrls) {
      await prisma.rpcEndpoint
        .upsert({
          where: { url },
          create: {
            url,
            priority: endpointUrls.indexOf(url),
            healthy: true,
            healthScore: 100
          },
          update: {}
        })
        .catch((e) => logger.error('[RPC] Failed to upsert endpoint', { url, error: e.message }));
    }

    // Start health checks
    this.startHealthChecks();
  }

  /**
   * Get the next healthy endpoint (round-robin with health awareness)
   */
  private getNextHealthyEndpoint(): string {
    const healthyEndpoints = this.endpoints.filter((e) => {
      const provider = this.providers.get(e.url);
      return provider !== undefined;
    });

    if (healthyEndpoints.length === 0) {
      logger.warn('[RPC] No healthy endpoints available, falling back to first');
      return this.endpoints[0]?.url || env.CELO_RPC_URL;
    }

    // Sort by priority and use round-robin
    healthyEndpoints.sort((a, b) => a.priority - b.priority);
    this.currentEndpointIndex = (this.currentEndpointIndex + 1) % healthyEndpoints.length;

    return healthyEndpoints[this.currentEndpointIndex].url;
  }

  /**
   * Execute RPC call with automatic failover
   */
  async callWithFailover<T>(
    fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
    operationName: string,
    maxRetries = 3
  ): Promise<T | null> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    const attemptedEndpoints: string[] = [];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const endpoint = this.getNextHealthyEndpoint();
      attemptedEndpoints.push(endpoint);

      if (attemptedEndpoints.filter((e) => e === endpoint).length > 1) {
        // We've cycled through all endpoints, give up
        break;
      }

      const provider = this.providers.get(endpoint);
      if (!provider) continue;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), env.RPC_TIMEOUT_MS);

        const result = await Promise.race([
          fn(provider),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener('abort', () => reject(new Error('RPC timeout')))
          )
        ]);

        clearTimeout(timeoutId);

        const latency = Date.now() - startTime;
        await this.recordSuccess(endpoint, latency);
        this.lastSuccessfulEndpoint = endpoint;

        logger.debug('[RPC] Call succeeded', {
          operation: operationName,
          endpoint: this.maskEndpoint(endpoint),
          latencyMs: latency
        });

        return result;
      } catch (error) {
        lastError = error as Error;
        const latency = Date.now() - startTime;
        await this.recordFailure(endpoint, latency);

        logger.warn('[RPC] Call failed, attempting failover', {
          operation: operationName,
          endpoint: this.maskEndpoint(endpoint),
          attempt: attempt + 1,
          error: (error as Error).message,
          latencyMs: latency
        });
      }
    }

    logger.error('[RPC] All failover attempts exhausted', {
      operation: operationName,
      attemptedEndpoints: attemptedEndpoints.map((e) => this.maskEndpoint(e)),
      error: lastError?.message
    });

    return null;
  }

  /**
   * Get logs with failover
   */
  async getLogs(filter: ethers.Filter, chunkSize = 5000): Promise<ethers.Log[]> {
    const result = await this.callWithFailover(
      (provider) => provider.getLogs(filter),
      `getLogs chunkSize=${chunkSize}`,
      5
    );
    return result || [];
  }

  /**
   * Get block number with failover
   */
  async getBlockNumber(): Promise<number | null> {
    return this.callWithFailover(
      (provider) => provider.getBlockNumber(),
      'getBlockNumber',
      3
    );
  }

  /**
   * Get block with failover
   */
  async getBlock(blockNumber: number): Promise<ethers.Block | null> {
    return this.callWithFailover(
      (provider) => provider.getBlock(blockNumber),
      `getBlock ${blockNumber}`,
      3
    );
  }

  /**
   * Record successful RPC call
   */
  private async recordSuccess(endpoint: string, latencyMs: number): Promise<void> {
    try {
      const current = await prisma.rpcEndpoint.findUnique({ where: { url: endpoint } });
      if (!current) return;

      const totalRequests = Number(current.totalRequests);
      const newAvgLatency = (current.avgLatencyMs * totalRequests + latencyMs) / (totalRequests + 1);
      const healthScore = Math.min(100, current.healthScore + 5);

      await prisma.rpcEndpoint.update({
        where: { url: endpoint },
        data: {
          healthy: true,
          healthScore,
          consecutiveErrors: 0,
          totalRequests: current.totalRequests + 1n,
          avgLatencyMs: newAvgLatency,
          lastCheckedAt: new Date()
        }
      });
    } catch (error) {
      logger.error('[RPC] Failed to record success', { endpoint, error: (error as Error).message });
    }
  }

  /**
   * Record failed RPC call
   */
  private async recordFailure(endpoint: string, latencyMs: number): Promise<void> {
    try {
      const current = await prisma.rpcEndpoint.findUnique({ where: { url: endpoint } });
      if (!current) return;

      const consecutiveErrors = (current.consecutiveErrors || 0) + 1;
      const healthScore = Math.max(0, current.healthScore - 15);
      const isHealthy = healthScore > 20 && consecutiveErrors < 5;

      await prisma.rpcEndpoint.update({
        where: { url: endpoint },
        data: {
          healthy: isHealthy,
          healthScore,
          consecutiveErrors,
          totalRequests: current.totalRequests + 1n,
          failedRequests: current.failedRequests + 1n,
          lastErrorAt: new Date(),
          lastCheckedAt: new Date()
        }
      });
    } catch (error) {
      logger.error('[RPC] Failed to record failure', {
        endpoint,
        latencyMs,
        error: (error as Error).message
      });
    }
  }

  /**
   * Health check loop
   */
  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.endpoints.forEach((endpoint) => {
        this.checkEndpointHealth(endpoint.url);
      });
    }, 30000); // Every 30 seconds
  }

  /**
   * Check single endpoint health
   */
  private async checkEndpointHealth(url: string): Promise<void> {
    const provider = this.providers.get(url);
    if (!provider) return;

    try {
      const startTime = Date.now();
      await provider.getBlockNumber();
      const latency = Date.now() - startTime;
      await this.recordSuccess(url, latency);
    } catch (error) {
      logger.warn('[RPC] Health check failed', {
        endpoint: this.maskEndpoint(url),
        error: (error as Error).message
      });
      await this.recordFailure(url, 0);
    }
  }

  /**
   * Get health status of all endpoints
   */
  async getHealthStatus(): Promise<RpcHealth[]> {
    const health: RpcHealth[] = [];

    for (const endpoint of this.endpoints) {
      const data = await prisma.rpcEndpoint.findUnique({ where: { url: endpoint.url } });
      if (!data) continue;

      health.push({
        endpoint: this.maskEndpoint(endpoint.url),
        healthy: data.healthy,
        healthScore: data.healthScore,
        lastCheckedAt: data.lastCheckedAt,
        consecutiveErrors: data.consecutiveErrors,
        avgLatencyMs: data.avgLatencyMs
      });
    }

    return health;
  }

  /**
   * Get last successful endpoint
   */
  getLastSuccessfulEndpoint(): string | null {
    return this.lastSuccessfulEndpoint ? this.maskEndpoint(this.lastSuccessfulEndpoint) : null;
  }

  /**
   * Mask sensitive endpoint URLs
   */
  private maskEndpoint(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      return url.substring(0, 20) + '...';
    }
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.providers.clear();
    this.endpoints = [];
    logger.info('[RPC] Failover manager cleaned up');
  }
}

export const rpcFailoverManager = new RpcFailoverManager();

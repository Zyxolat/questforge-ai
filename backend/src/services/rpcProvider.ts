import { ethers } from 'ethers';
import { env } from '../config/env';
import { logger } from './logger';

interface ProviderConfig {
  url: string;
  timeout: number;
  maxRetries: number;
  backoffMs: number;
}

type PollingJsonRpcProvider = ethers.JsonRpcProvider & {
  pollingInterval: number;
};

class RobustRpcProvider {
  private provider: ethers.JsonRpcProvider;
  private config: ProviderConfig;
  private healthStatus = true;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.provider = this.createProvider();
  }

  private createProvider(): ethers.JsonRpcProvider {
    const provider = new ethers.JsonRpcProvider(this.config.url, env.CELO_CHAIN_ID) as PollingJsonRpcProvider;
    // Set network-level timeout
    provider.pollingInterval = 1000;
    return provider;
  }

  /**
   * Execute RPC call with timeout and retry logic
   */
  async callWithRetry<T>(
    fn: () => Promise<T>,
    operationName: string,
    maxRetries = this.config.maxRetries
  ): Promise<T | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Add timeout wrapper
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const result = await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener('abort', () => reject(new Error('RPC call timeout')))
          )
        ]);

        clearTimeout(timeoutId);
        this.recordSuccess();
        return result;
      } catch (error) {
        lastError = error as Error;
        this.recordError();

        const backoffMs = this.config.backoffMs * Math.pow(2, attempt);
        logger.warn(`RPC operation ${operationName} failed (attempt ${attempt + 1}/${maxRetries})`, {
          error: (error as Error).message,
          backoffMs,
          consecutiveErrors: this.consecutiveErrors
        });

        if (attempt < maxRetries - 1) {
          await this.sleep(backoffMs);
        }
      }
    }

    this.setUnhealthy(`${operationName} failed after ${maxRetries} retries`);
    logger.error(`RPC operation ${operationName} exhausted all retries`, {
      error: lastError?.message
    });

    return null;
  }

  /**
   * Get latest block number with resilience
   */
  async getBlockNumber(): Promise<number | null> {
    return this.callWithRetry(
      () => this.provider.getBlockNumber(),
      'getBlockNumber'
    );
  }

  /**
   * Get logs with chunked request (to avoid RPC limits)
   */
  async getLogs(filter: ethers.Filter, maxChunkSize = 1000): Promise<ethers.Log[]> {
    const fromBlock = typeof filter.fromBlock === 'number' ? filter.fromBlock : 0;
    const toBlock = typeof filter.toBlock === 'number' ? filter.toBlock : 'latest';

    const toBlockNum = await this.getBlockNumber();
    if (!toBlockNum) return [];

    const finalToBlock = toBlock === 'latest' ? toBlockNum : toBlock;

    if (typeof fromBlock !== 'number') {
      logger.error('Invalid fromBlock', { fromBlock });
      return [];
    }

    const allLogs: ethers.Log[] = [];
    const blockRange = finalToBlock - fromBlock;

    if (blockRange <= 0) return [];

    // Chunk the requests
    const chunkSize = Math.min(maxChunkSize, env.EVENT_CHUNK_SIZE);
    const chunks = Math.ceil(blockRange / chunkSize);

    logger.debug(`Fetching logs in ${chunks} chunks`, {
      fromBlock,
      toBlock: finalToBlock,
      chunkSize,
      blockRange
    });

    for (let i = 0; i < chunks; i++) {
      const chunkFromBlock = fromBlock + i * chunkSize;
      const chunkToBlock = Math.min(fromBlock + (i + 1) * chunkSize - 1, finalToBlock);

      const chunkFilter = {
        ...filter,
        fromBlock: chunkFromBlock,
        toBlock: chunkToBlock
      };

      const logs = await this.callWithRetry(
        () => this.provider.getLogs(chunkFilter as ethers.Filter),
        `getLogs chunk ${i + 1}/${chunks}`,
        3 // Fewer retries for individual chunks
      );

      if (logs) {
        allLogs.push(...logs);
      } else {
        logger.warn(`Failed to fetch logs for chunk ${i + 1}`, {
          chunkFromBlock,
          chunkToBlock
        });
      }
    }

    return allLogs;
  }

  /**
   * Get block with retry
   */
  async getBlock(blockNumber: number): Promise<ethers.Block | null> {
    return this.callWithRetry(
      () => this.provider.getBlock(blockNumber),
      `getBlock ${blockNumber}`
    );
  }

  /**
   * Get transaction with retry
   */
  async getTransaction(txHash: string): Promise<ethers.TransactionResponse | null> {
    return this.callWithRetry(
      () => this.provider.getTransaction(txHash),
      `getTransaction ${txHash}`
    );
  }

  /**
   * Get transaction receipt with retry
   */
  async getTransactionReceipt(txHash: string): Promise<ethers.TransactionReceipt | null> {
    return this.callWithRetry(
      () => this.provider.getTransactionReceipt(txHash),
      `getTransactionReceipt ${txHash}`
    );
  }

  /**
   * Call contract function with retry
   */
  async call(tx: ethers.TransactionRequest): Promise<string | null> {
    return this.callWithRetry(
      () => this.provider.call(tx),
      `call`,
      5
    );
  }

  /**
   * Check if provider is healthy
   */
  isHealthy(): boolean {
    return this.healthStatus && this.consecutiveErrors < this.maxConsecutiveErrors;
  }

  /**
   * Get provider health status
   */
  getHealthStatus() {
    return {
      healthy: this.isHealthy(),
      consecutiveErrors: this.consecutiveErrors,
      maxConsecutiveErrors: this.maxConsecutiveErrors
    };
  }

  private recordSuccess(): void {
    if (!this.healthStatus) {
      logger.info('RPC provider recovered from errors');
      this.healthStatus = true;
    }
    this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
  }

  private recordError(): void {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.setUnhealthy(`Reached max consecutive errors: ${this.consecutiveErrors}`);
    }
  }

  private setUnhealthy(reason: string): void {
    if (this.healthStatus) {
      logger.error('RPC provider marked as unhealthy', { reason });
      this.healthStatus = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }
}

// Export singleton instance
export const rpcProvider = new RobustRpcProvider({
  url: env.CELO_RPC_URL,
  timeout: env.RPC_TIMEOUT_MS,
  maxRetries: env.INDEXER_RETRY_LIMIT,
  backoffMs: env.INDEXER_BACKOFF_MS
});

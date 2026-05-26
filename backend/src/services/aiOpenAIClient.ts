/**
 * OpenAI Client Wrapper with Production Safety
 *
 * Features:
 * - Exponential backoff retry with jitter
 * - Comprehensive structured logging
 * - Token usage and latency tracking
 * - Rate limit detection and handling
 * - Request telemetry
 */

import OpenAI from 'openai';
import { env } from '../config/env';
import { logger } from './logger';

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

interface RequestTelemetry {
  requestId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  attemptCount: number;
  success: boolean;
  fallbackReason?: string;
}

interface AICompletionResult {
  content: string;
  telemetry: RequestTelemetry;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitterFactor: 0.1
};

class AIOpenAIClient {
  private client: OpenAI | null;
  private readonly isConfigured: boolean;
  private requestIdCounter = 0;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      this.isConfigured = true;
      logger.info('[OPENAI-CLIENT] OpenAI client initialized successfully', {
        configured: true,
        keyPresent: true
      });
    } else {
      this.client = null;
      this.isConfigured = false;
      logger.warn('[OPENAI-CLIENT] OpenAI API key not configured - fallback mode enabled', {
        configured: false,
        keyPresent: false
      });
    }
  }

  isAvailable(): boolean {
    return this.isConfigured && this.client !== null;
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${++this.requestIdCounter}`;
  }

  private calculateBackoffDelay(
    attemptNumber: number,
    config: RetryConfig
  ): number {
    const exponentialDelay = Math.min(
      config.initialDelayMs * Math.pow(config.backoffMultiplier, attemptNumber - 1),
      config.maxDelayMs
    );

    // Add jitter to prevent thundering herd
    const jitter = exponentialDelay * config.jitterFactor * Math.random();
    return exponentialDelay + jitter;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof OpenAI.APIError) {
      // Retry on rate limit (429) and server errors (5xx)
      const status = error.status ?? 0;
      return status === 429 || status >= 500;
    }
    return false;
  }

  async createChatCompletion(
    input: {
      model: string;
      messages: OpenAI.Chat.ChatCompletionMessageParam[];
      temperature: number;
      maxTokens: number;
      responseFormat?: { type: 'json_object' };
    },
    retryConfig: Partial<RetryConfig> = {}
  ): Promise<AICompletionResult> {
    const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    const requestId = this.generateRequestId();

    if (!this.isAvailable()) {
      logger.warn('[OPENAI-CLIENT] OpenAI not available, cannot create completion', {
        requestId,
        configured: this.isConfigured
      });
      throw new Error('OpenAI client not available - API key not configured');
    }

    logger.info('[OPENAI-CLIENT] Starting AI completion request', {
      requestId,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      messageCount: input.messages.length
    });

    let lastError: Error | null = null;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        logger.info('[OPENAI-CLIENT] OpenAI request attempt', {
          requestId,
          attempt,
          maxAttempts: config.maxAttempts,
          model: input.model
        });

        const attemptStartTime = Date.now();
        const response = await this.client!.chat.completions.create({
          model: input.model,
          messages: input.messages,
          temperature: input.temperature,
          max_tokens: input.maxTokens,
          response_format: input.responseFormat
        });
        const attemptLatencyMs = Date.now() - attemptStartTime;

        const content = response.choices[0]?.message?.content || '';
        const telemetry: RequestTelemetry = {
          requestId,
          model: input.model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
          latencyMs: attemptLatencyMs,
          attemptCount: attempt,
          success: true
        };

        const totalLatencyMs = Date.now() - startTime;
        logger.info('[OPENAI-CLIENT] OpenAI completion succeeded', {
          requestId,
          model: input.model,
          attempt,
          promptTokens: telemetry.promptTokens,
          completionTokens: telemetry.completionTokens,
          totalTokens: telemetry.totalTokens,
          attemptLatencyMs,
          totalLatencyMs,
          contentLength: content.length
        });

        return {
          content,
          telemetry
        };
      } catch (error) {
        lastError = error as Error;
        const isRetryable = this.isRetryableError(error);
        const totalLatencyMs = Date.now() - startTime;

        logger.warn('[OPENAI-CLIENT] OpenAI request failed', {
          requestId,
          attempt,
          maxAttempts: config.maxAttempts,
          error: lastError.message,
          isRetryable,
          totalLatencyMs,
          errorType: lastError.constructor.name
        });

        if (isRetryable && attempt < config.maxAttempts) {
          const delayMs = this.calculateBackoffDelay(attempt, config);
          logger.info('[OPENAI-CLIENT] Retrying after exponential backoff', {
            requestId,
            attempt,
            delayMs,
            nextAttempt: attempt + 1
          });
          await this.sleep(delayMs);
        } else if (!isRetryable) {
          logger.error('[OPENAI-CLIENT] Non-retryable error encountered', {
            requestId,
            attempt,
            error: lastError.message,
            errorType: lastError.constructor.name
          });
          throw lastError;
        }
      }
    }

    // All retries exhausted
    logger.error('[OPENAI-CLIENT] All retry attempts exhausted', {
      requestId,
      attempts: config.maxAttempts,
      lastError: lastError?.message,
      totalLatencyMs: Date.now() - startTime
    });

    throw new Error(
      `OpenAI request failed after ${config.maxAttempts} attempts: ${lastError?.message ?? 'Unknown error'}`
    );
  }
}

export const aiOpenAIClient = new AIOpenAIClient();
export type { AICompletionResult, RequestTelemetry, RetryConfig };

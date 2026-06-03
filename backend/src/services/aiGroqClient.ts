/**
 * Groq Client Wrapper with Production Safety
 *
 * Features:
 * - Exponential backoff retry with jitter
 * - Structured error diagnostics
 * - Token usage and latency tracking
 * - Temporary model fallback for invalid Groq model configuration
 */

import Groq, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'groq-sdk';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam
} from 'groq-sdk/resources/chat/completions';
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
  provider: 'groq';
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  attemptCount: number;
  success: boolean;
  fallbackReason?: string;
}

interface AIProviderHealthStatus {
  configured: boolean;
  available: boolean;
  validated: boolean;
  model: string;
  lastCheckedAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string | null;
}

interface AICompletionResult {
  content: string;
  telemetry: RequestTelemetry;
}

interface GroqErrorDiagnostics {
  provider: 'groq';
  model: string;
  requestId: string;
  attempt: number;
  latencyMs: number;
  statusCode: number | null;
  responseBody: unknown;
  sdkError: Record<string, unknown>;
  message: string;
  name: string;
  code: string | null;
  type: string | null;
  param: string | null;
  requestIdFromSdk: string | null;
  responseHeaders: Record<string, unknown> | null;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitterFactor: 0.1
};

const TEMPORARY_FALLBACK_MODEL = 'llama3-70b-8192';

function toPlainLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (depth > 4) {
    return '[MaxDepth]';
  }

  if (value instanceof Error) {
    const errorObject: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null
    };

    for (const key of Object.getOwnPropertyNames(value)) {
      if (!(key in errorObject)) {
        errorObject[key] = toPlainLogValue(
          (value as unknown as Record<string, unknown>)[key],
          depth + 1,
          seen
        );
      }
    }

    return errorObject;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => toPlainLogValue(item, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) {
      return '[Circular]';
    }

    seen.add(value as object);

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toPlainLogValue(item, depth + 1, seen);
    }

    return output;
  }

  return String(value);
}

function extractStatusCode(error: unknown): number | null {
  const record = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number; statusCode?: number };
  };

  const status = record?.status ?? record?.statusCode ?? record?.response?.status ?? record?.response?.statusCode ?? null;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function extractResponseBody(error: unknown): unknown {
  const record = error as {
    response?: {
      data?: unknown;
      body?: unknown;
      text?: unknown;
    };
    body?: unknown;
    error?: unknown;
  };

  if (record?.response?.data !== undefined) {
    return toPlainLogValue(record.response.data);
  }

  if (record?.response?.body !== undefined) {
    return toPlainLogValue(record.response.body);
  }

  if (record?.body !== undefined) {
    return toPlainLogValue(record.body);
  }

  if (record?.error !== undefined) {
    return toPlainLogValue(record.error);
  }

  if (record?.response?.text !== undefined) {
    return toPlainLogValue(record.response.text);
  }

  return null;
}

function extractResponseHeaders(error: unknown): Record<string, unknown> | null {
  const record = error as {
    response?: { headers?: Headers | Record<string, string | string[]> };
    headers?: Headers | Record<string, string | string[]>;
  };

  const headers = record?.response?.headers ?? record?.headers;
  if (!headers) {
    return null;
  }

  if (headers instanceof Headers) {
    return toPlainLogValue(Object.fromEntries(headers.entries())) as Record<string, unknown>;
  }

  return toPlainLogValue(headers) as Record<string, unknown>;
}

function buildGroqErrorDiagnostics(input: {
  error: unknown;
  requestId: string;
  attempt: number;
  latencyMs: number;
  model: string;
}): GroqErrorDiagnostics {
  const error = input.error as {
    name?: string;
    message?: string;
    code?: string;
    type?: string;
    param?: string;
    request_id?: string;
    requestId?: string;
  };

  return {
    provider: 'groq',
    model: input.model,
    requestId: input.requestId,
    attempt: input.attempt,
    latencyMs: input.latencyMs,
    statusCode: extractStatusCode(input.error),
    responseBody: extractResponseBody(input.error),
    sdkError: toPlainLogValue(input.error) as Record<string, unknown>,
    message: error.message ?? (input.error instanceof Error ? input.error.message : String(input.error)),
    name: error.name ?? (input.error instanceof Error ? input.error.name : 'Error'),
    code: error.code ?? null,
    type: error.type ?? null,
    param: error.param ?? null,
    requestIdFromSdk: error.request_id ?? error.requestId ?? null,
    responseHeaders: extractResponseHeaders(input.error)
  };
}

export function describeGroqError(
  error: unknown,
  context: { model: string; requestId?: string; latencyMs?: number; attempt?: number }
): GroqErrorDiagnostics {
  return buildGroqErrorDiagnostics({
    error,
    requestId: context.requestId ?? 'unknown',
    attempt: context.attempt ?? 0,
    latencyMs: context.latencyMs ?? 0,
    model: context.model
  });
}

class AIGroqClient {
  private client: Groq | null;
  private readonly isConfigured: boolean;
  private requestIdCounter = 0;
  private healthStatus: AIProviderHealthStatus = {
    configured: false,
    available: false,
    validated: false,
    model: env.GROQ_MODEL,
    lastCheckedAt: null,
    lastSuccessfulAt: null,
    lastError: null
  };

  constructor() {
    if (env.GROQ_API_KEY) {
      this.client = new Groq({ apiKey: env.GROQ_API_KEY });
      this.isConfigured = true;
      this.healthStatus = {
        ...this.healthStatus,
        configured: true,
        available: true
      };
      logger.info('[GROQ-CLIENT] Groq client initialized successfully', {
        provider: 'groq',
        configured: true,
        keyPresent: true,
        model: env.GROQ_MODEL
      });
    } else {
      this.client = null;
      this.isConfigured = false;
      this.healthStatus = {
        ...this.healthStatus,
        configured: false,
        available: false,
        validated: false,
        lastError: 'GROQ_API_KEY not configured'
      };
      logger.warn('[GROQ-CLIENT] Groq API key not configured - deterministic fallback mode enabled', {
        provider: 'groq',
        configured: false,
        keyPresent: false
      });
    }
  }

  isAvailable(): boolean {
    return this.isConfigured && this.client !== null;
  }

  getHealthStatus(): AIProviderHealthStatus {
    return { ...this.healthStatus };
  }

  getActiveModel(): string {
    return this.healthStatus.model;
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${++this.requestIdCounter}`;
  }

  private calculateBackoffDelay(attemptNumber: number, config: RetryConfig): number {
    const exponentialDelay = Math.min(
      config.initialDelayMs * Math.pow(config.backoffMultiplier, attemptNumber - 1),
      config.maxDelayMs
    );

    const jitter = exponentialDelay * config.jitterFactor * Math.random();
    return exponentialDelay + jitter;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseRetryAfterMs(error: unknown): number | null {
    const apiError = error as { headers?: Headers | Record<string, string | string[]> };
    const retryAfterHeader =
      apiError.headers instanceof Headers ? apiError.headers.get('retry-after') : apiError.headers?.['retry-after'];

    if (!retryAfterHeader) {
      return null;
    }

    const retryAfter = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const retrySeconds = Number(retryAfter);
    if (Number.isFinite(retrySeconds) && retrySeconds >= 0) {
      return retrySeconds * 1000;
    }

    const retryDateMs = Date.parse(retryAfter);
    if (Number.isFinite(retryDateMs)) {
      return Math.max(0, retryDateMs - Date.now());
    }

    return null;
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) {
      return true;
    }

    if (error instanceof APIError) {
      const status = error.status ?? 0;
      return status === 408 || status === 409 || status === 429 || status >= 500;
    }

    return false;
  }

  private shouldTryTemporaryFallback(error: unknown): boolean {
    const status = extractStatusCode(error);
    if (status === 401 || status === 403) {
      return false;
    }

    if (status === 400 || status === 404 || status === 422) {
      return true;
    }

    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return /model|unsupported|not found|permission|invalid request/.test(message);
  }

  private getCandidateModels(model: string): string[] {
    const candidates = [model];
    if (model !== TEMPORARY_FALLBACK_MODEL) {
      candidates.push(TEMPORARY_FALLBACK_MODEL);
    }
    return candidates;
  }

  async createChatCompletion(
    input: {
      model: string;
      messages: ChatCompletionMessageParam[];
      temperature: number;
      maxTokens: number;
    },
    retryConfig: Partial<RetryConfig> = {}
  ): Promise<AICompletionResult> {
    const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    const requestId = this.generateRequestId();

    if (!this.isAvailable()) {
      logger.warn('[GROQ-CLIENT] Groq not available, cannot create completion', {
        requestId,
        provider: 'groq',
        configured: this.isConfigured
      });
      throw new Error('Groq client not available - API key not configured');
    }

    logger.info('[GROQ-CLIENT] Starting AI completion request', {
      requestId,
      provider: 'groq',
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      messageCount: input.messages.length
    });

    const startTime = Date.now();
    let lastError: unknown = null;

    for (const [candidateIndex, candidateModel] of this.getCandidateModels(input.model).entries()) {
      let candidateError: unknown = null;

      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        try {
          logger.info('[GROQ-CLIENT] Groq request attempt', {
            requestId,
            provider: 'groq',
            attempt,
            maxAttempts: config.maxAttempts,
            model: candidateModel,
            candidateIndex
          });

          const attemptStartTime = Date.now();
          const completionRequest: ChatCompletionCreateParamsNonStreaming = {
            model: candidateModel,
            messages: input.messages,
            temperature: input.temperature,
            max_completion_tokens: input.maxTokens
          };

          const response = await this.client!.chat.completions.create(completionRequest);
          const attemptLatencyMs = Date.now() - attemptStartTime;

          const content = response.choices[0]?.message?.content || '';
          const telemetry: RequestTelemetry = {
            requestId,
            provider: 'groq',
            model: candidateModel,
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
            totalTokens: response.usage?.total_tokens ?? 0,
            latencyMs: attemptLatencyMs,
            attemptCount: attempt,
            success: true
          };

          const totalLatencyMs = Date.now() - startTime;
          logger.info('[GROQ-CLIENT] Groq completion succeeded', {
            requestId,
            provider: 'groq',
            model: candidateModel,
            attempt,
            promptTokens: telemetry.promptTokens,
            completionTokens: telemetry.completionTokens,
            totalTokens: telemetry.totalTokens,
            attemptLatencyMs,
            totalLatencyMs,
            contentLength: content.length,
            candidateIndex
          });

          if (candidateIndex > 0) {
            logger.warn('[GROQ-CLIENT] Groq completion succeeded after temporary model fallback', {
              requestId,
              provider: 'groq',
              primaryModel: input.model,
              fallbackModel: candidateModel,
              candidateIndex
            });
          }

          return { content, telemetry };
        } catch (error) {
          candidateError = error;
          lastError = error;
          const isRetryable = this.isRetryableError(error);
          const totalLatencyMs = Date.now() - startTime;
          const diagnostics = buildGroqErrorDiagnostics({
            error,
            requestId,
            attempt,
            latencyMs: totalLatencyMs,
            model: candidateModel
          });

          logger.warn('[GROQ-CLIENT] Groq request failed', {
            requestId,
            provider: 'groq',
            attempt,
            maxAttempts: config.maxAttempts,
            model: candidateModel,
            statusCode: diagnostics.statusCode,
            responseBody: diagnostics.responseBody,
            sdkError: diagnostics.sdkError,
            latencyMs: totalLatencyMs,
            isRetryable,
            errorType: diagnostics.name,
            errorMessage: diagnostics.message,
            candidateIndex
          });

          if (isRetryable && attempt < config.maxAttempts) {
            const retryAfterMs = error instanceof APIError ? this.parseRetryAfterMs(error) : null;
            const delayMs = retryAfterMs ?? this.calculateBackoffDelay(attempt, config);
            logger.info('[GROQ-CLIENT] Retrying after exponential backoff', {
              requestId,
              provider: 'groq',
              attempt,
              model: candidateModel,
              delayMs,
              retryAfterMs,
              nextAttempt: attempt + 1
            });
            await this.sleep(delayMs);
            continue;
          }

          break;
        }
      }

      if (
        candidateError &&
        candidateIndex < this.getCandidateModels(input.model).length - 1 &&
        this.shouldTryTemporaryFallback(candidateError)
      ) {
        const diagnostics = buildGroqErrorDiagnostics({
          error: candidateError,
          requestId,
          attempt: config.maxAttempts,
          latencyMs: Date.now() - startTime,
          model: candidateModel
        });

        logger.warn('[GROQ-CLIENT] Groq primary model failed; switching to temporary fallback model', {
          requestId,
          provider: 'groq',
          primaryModel: candidateModel,
          fallbackModel: this.getCandidateModels(input.model)[candidateIndex + 1],
          statusCode: diagnostics.statusCode,
          responseBody: diagnostics.responseBody,
          sdkError: diagnostics.sdkError,
          latencyMs: diagnostics.latencyMs
        });

        continue;
      }

      if (candidateError) {
        const diagnostics = buildGroqErrorDiagnostics({
          error: candidateError,
          requestId,
          attempt: config.maxAttempts,
          latencyMs: Date.now() - startTime,
          model: candidateModel
        });

        logger.error('[GROQ-CLIENT] Groq request exhausted for model candidate', {
          requestId,
          provider: 'groq',
          model: candidateModel,
          statusCode: diagnostics.statusCode,
          responseBody: diagnostics.responseBody,
          sdkError: diagnostics.sdkError,
          latencyMs: diagnostics.latencyMs,
          attemptCount: config.maxAttempts,
          candidateIndex
        });

        if (candidateIndex === this.getCandidateModels(input.model).length - 1) {
          if (candidateError instanceof Error) {
            throw candidateError;
          }
          throw new Error(`Groq request failed for provider=groq model=${candidateModel}: ${String(candidateError)}`);
        }
      }
    }

    const diagnostics = lastError
      ? buildGroqErrorDiagnostics({
          error: lastError,
          requestId,
          attempt: config.maxAttempts,
          latencyMs: Date.now() - startTime,
          model: input.model
        })
      : null;

    logger.error('[GROQ-CLIENT] All model candidates exhausted', {
      requestId,
      provider: 'groq',
      primaryModel: input.model,
      fallbackModel: input.model !== TEMPORARY_FALLBACK_MODEL ? TEMPORARY_FALLBACK_MODEL : null,
      attempts: config.maxAttempts,
      totalLatencyMs: Date.now() - startTime,
      lastError: diagnostics
    });

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error(
      `Groq request failed for provider=groq model=${input.model} after ${config.maxAttempts} attempts: ${
        diagnostics?.message ?? 'Unknown error'
      }`
    );
  }

  async validateModelAccess(model = env.GROQ_MODEL): Promise<AIProviderHealthStatus> {
    const checkedAt = new Date().toISOString();
    const probeStartedAt = Date.now();

    if (!this.isAvailable()) {
      this.healthStatus = {
        ...this.healthStatus,
        configured: false,
        available: false,
        validated: false,
        model,
        lastCheckedAt: checkedAt,
        lastError: 'GROQ_API_KEY not configured'
      };
      return this.getHealthStatus();
    }

    try {
      const completion = await this.createChatCompletion(
        {
          model,
          messages: [
            {
              role: 'system',
              content: 'You are validating API connectivity. Reply with a single JSON object.'
            },
            {
              role: 'user',
              content: '{"status":"ok"}'
            }
          ],
          temperature: 0,
          maxTokens: 8
        },
        {
          maxAttempts: 2,
          initialDelayMs: 300,
          maxDelayMs: 2000,
          backoffMultiplier: 2,
          jitterFactor: 0.05
        }
      );

      this.healthStatus = {
        ...this.healthStatus,
        configured: true,
        available: true,
        validated: true,
        model: completion.telemetry.model,
        lastCheckedAt: checkedAt,
        lastSuccessfulAt: checkedAt,
        lastError: null
      };

      logger.info('[GROQ-CLIENT] Groq connectivity probe succeeded', {
        provider: 'groq',
        requestedModel: model,
        activeModel: completion.telemetry.model,
        requestId: completion.telemetry.requestId,
        latencyMs: Date.now() - probeStartedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostics = describeGroqError(error, {
        model,
        requestId: `probe_${checkedAt}`,
        attempt: 1,
        latencyMs: Date.now() - probeStartedAt
      });

      this.healthStatus = {
        ...this.healthStatus,
        configured: true,
        available: true,
        validated: false,
        model,
        lastCheckedAt: checkedAt,
        lastError: message
      };

      logger.warn('[GROQ-CLIENT] Groq connectivity probe failed - deterministic fallback remains enabled', {
        provider: 'groq',
        requestedModel: model,
        statusCode: diagnostics.statusCode,
        responseBody: diagnostics.responseBody,
        sdkError: diagnostics.sdkError,
        error: message,
        latencyMs: Date.now() - probeStartedAt
      });
    }

    return this.getHealthStatus();
  }
}

export const aiGroqClient = new AIGroqClient();
export type { AICompletionResult, AIProviderHealthStatus, RequestTelemetry, RetryConfig };

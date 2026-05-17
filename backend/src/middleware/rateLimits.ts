/**
 * Enhanced Rate Limiting Middleware
 * 
 * Implements per-endpoint, per-user, and per-wallet rate limiting to prevent:
 * - Spam attacks
 * - Quest generation spam
 * - Proof submission flooding
 * - Auth bypass attempts
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { createClient } from 'redis';
import { env } from '../config/env';
import { logger } from '../services/logger';

// Rate limit configuration per endpoint
export const RATE_LIMITS = {
  // Auth endpoints
  authNonce: { windowMs: 15 * 60 * 1000, max: 10 }, // 10 per 15 min
  authVerify: { windowMs: 15 * 60 * 1000, max: 5 }, // 5 per 15 min
  authRefresh: { windowMs: 15 * 60 * 1000, max: 20 }, // 20 per 15 min

  // Quest endpoints
  generateQuest: { windowMs: 60 * 60 * 1000, max: 50 }, // 50 per hour
  submitProof: { windowMs: 60 * 60 * 1000, max: 100 }, // 100 per hour
  getActiveQuests: { windowMs: 5 * 60 * 1000, max: 30 }, // 30 per 5 min
  getDailyMissions: { windowMs: 5 * 60 * 1000, max: 50 }, // 50 per 5 min

  // Player endpoints
  getPlayerStats: { windowMs: 5 * 60 * 1000, max: 30 },
  getProgression: { windowMs: 5 * 60 * 1000, max: 30 },

  // Global fallback
  global: { windowMs: 15 * 60 * 1000, max: 150 } // 150 per 15 min
};

/**
 * Create rate limiter with safe in-memory defaults.
 * We probe Redis for visibility, but we do not attach request handling to it at startup.
 * That keeps Railway health checks and API traffic available even when Redis is degraded.
 */
const redisClient = env.REDIS_URL ? createClient({ url: env.REDIS_URL }) : null;

if (redisClient) {
  redisClient.on('error', (error) => {
    logger.error('[RATE_LIMIT] Redis probe error', error, {
      service: 'rateLimitRedisProbe'
    });
  });
  void redisClient.connect().catch((error) => {
    logger.warn('[RATE_LIMIT] Redis store unavailable, using in-memory rate limits', {
      error: error instanceof Error ? error.message : 'unknown'
    });
  });
} else {
  logger.info('[RATE_LIMIT] Redis not configured, using in-memory rate limits');
}

function createRateLimiter(
  options: { windowMs: number; max: number },
  keyGenerator?: (req: Request) => string
) {
  const config: Partial<Options> = {
    windowMs: options.windowMs,
    max: options.max,
    keyGenerator: keyGenerator || ((req) => {
      if (req.auth?.wallet) {
        return `${req.auth.wallet}:${req.path}`;
      }
      return `${req.ip}:${req.path}`;
    }),
    message: 'Too many requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      return req.path === '/health';
    }
  };

  return rateLimit(config as Options);
}

/**
 * Per-wallet quest generation limiter
 * More strict limits for quest generation to prevent farming
 */
export const questGenerationLimiter = createRateLimiter(
  RATE_LIMITS.generateQuest,
  (req) => `quest-gen:${req.auth?.wallet || req.ip}`
);

/**
 * Per-wallet proof submission limiter
 */
export const proofSubmissionLimiter = createRateLimiter(
  RATE_LIMITS.submitProof,
  (req) => `proof-submit:${req.auth?.wallet || req.ip}`
);

export const getActiveQuestsLimiter = createRateLimiter(
  RATE_LIMITS.getActiveQuests,
  (req) => `active-quests:${req.auth?.wallet || req.ip}`
);

/**
 * Auth nonce rate limiter (per-wallet)
 */
export const authNonceLimiter = createRateLimiter(
  RATE_LIMITS.authNonce,
  (req) => `auth-nonce:${req.body?.wallet || req.ip}`
);

/**
 * Auth verify rate limiter (per-IP to prevent brute force)
 */
export const authVerifyLimiter = createRateLimiter(
  RATE_LIMITS.authVerify,
  (req) => `auth-verify:${req.ip}`
);

/**
 * Auth refresh rate limiter
 */
export const authRefreshLimiter = createRateLimiter(
  RATE_LIMITS.authRefresh,
  (req) => `auth-refresh:${req.auth?.wallet || req.ip}`
);

/**
 * Global rate limiter (fallback for all endpoints)
 */
export const globalLimiter = createRateLimiter(RATE_LIMITS.global);

/**
 * Composite rate limiter that applies multiple limits
 * Returns 429 if ANY limit is exceeded
 */
export function createCompositeRateLimiter(...limiters: Array<(req: Request, res: Response, next: NextFunction) => unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    let index = 0;

    const run = () => {
      const limiter = limiters[index];
      index += 1;

      if (!limiter) {
        next();
        return;
      }

      limiter(req, res, run);
    };

    run();
  };
}

/**
 * Custom rate limit error handler
 */
type RateLimitError = {
  status?: number;
  retryAfter?: number;
};

function isRateLimitError(err: unknown): err is RateLimitError {
  return typeof err === 'object' && err !== null;
}

export function handleRateLimitError(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (isRateLimitError(err) && err.status === 429) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: err.retryAfter || 60
    });
  }
  next(err);
}

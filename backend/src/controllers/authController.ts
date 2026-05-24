import { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../services/logger';
import {
  AuthError,
  isAuthError,
  issueWalletChallenge,
  normalizeValidatedWallet,
  readBearerToken,
  readRefreshToken,
  readSessionIdFromAccessToken,
  refreshAuthSession,
  revokeRefreshSession,
  revokeSessionById,
  toAuthErrorResponse,
  verifyWalletChallenge
} from '../services/auth';

function normalizeRequestedChainId(value: unknown) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }

    const parsed = /^0x[0-9a-f]+$/i.test(normalized) ? Number.parseInt(normalized, 16) : Number(normalized);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function setNoStore(res: Response) {
  res.set('Cache-Control', 'no-store');
}

function buildRefreshCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAME_SITE,
    domain: env.AUTH_COOKIE_DOMAIN,
    path: env.AUTH_COOKIE_PATH,
    expires: expiresAt
  };
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(env.AUTH_COOKIE_NAME, buildRefreshCookieOptions());
}

function setRefreshCookie(res: Response, refreshToken: string, expiresAt: Date) {
  res.cookie(env.AUTH_COOKIE_NAME, refreshToken, buildRefreshCookieOptions(expiresAt));
}

function sendAuthError(res: Response, error: unknown) {
  setNoStore(res);
  if (isAuthError(error)) {
    logger.debug('[AUTH] Sending auth error response', {
      code: error.code,
      status: error.status,
      message: error.message,
      action: error.action
    });
    return res.status(error.status).json(toAuthErrorResponse(error));
  }

  logger.error('Authentication controller unhandled error', error);
  return res.status(500).json({
    error: {
      code: 'AUTH_SESSION_INVALID',
      message: 'Authentication failed unexpectedly'
    },
    action: 'sign'
  });
}

function sendAuthSession(res: Response, payload: Awaited<ReturnType<typeof verifyWalletChallenge>> | Awaited<ReturnType<typeof refreshAuthSession>>) {
  setNoStore(res);

  logger.debug('[AUTH] Sending authenticated session response', {
    sessionId: payload.session.id,
    wallet: `${payload.session.wallet.slice(0, 6)}...${payload.session.wallet.slice(-4)}`,
    userId: payload.session.userId,
    accessTokenExpiresAt: payload.accessTokenExpiresAt.toISOString(),
    sessionExpiresAt: payload.session.expiresAt.toISOString()
  });

  logger.debug('[AUTH] Setting refresh cookie', {
    cookieName: env.AUTH_COOKIE_NAME,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAME_SITE,
    domain: env.AUTH_COOKIE_DOMAIN ?? null,
    path: env.AUTH_COOKIE_PATH,
    expiresAt: payload.session.expiresAt.toISOString()
  });

  setRefreshCookie(res, payload.refreshToken, payload.session.expiresAt);
  res.json({
    accessToken: payload.accessToken,
    accessTokenExpiresAt: payload.accessTokenExpiresAt.toISOString(),
    session: {
      id: payload.session.id,
      wallet: normalizeValidatedWallet(payload.session.wallet),
      expiresAt: payload.session.expiresAt.toISOString()
    },
    user: payload.session.user
  });
}

function deriveAuthContext() {
  return {
    domain: env.AUTH_DOMAIN,
    uri: env.AUTH_URI
  };
}

export async function createAuthNonce(req: Request, res: Response) {
  const wallet = req.body.wallet?.toString();
  const chainId = normalizeRequestedChainId(req.body.chainId);

  logger.debug('[AUTH] Nonce request received', {
    wallet: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : 'MISSING',
    chainId
  });

  if (!wallet) {
    logger.warn('[AUTH] Nonce request validation failed: wallet missing');
    return sendAuthError(res, new AuthError('AUTH_REQUEST_INVALID', 'Wallet is required', 400, 'sign'));
  }

  if (typeof chainId !== 'number') {
    logger.warn('[AUTH] Nonce request validation failed: invalid chainId', {
      providedChainId: req.body.chainId,
      normalizedChainId: chainId
    });
    return sendAuthError(res, new AuthError('AUTH_CHAIN_ID_INVALID', 'A valid chainId is required', 400, 'sign'));
  }

  if (chainId !== env.CELO_CHAIN_ID) {
    logger.warn('[AUTH] Nonce request validation failed: chain mismatch', {
      providedChainId: chainId,
      expectedChainId: env.CELO_CHAIN_ID
    });
    return sendAuthError(
      res,
      new AuthError('AUTH_CHAIN_MISMATCH', `QuestForge AI supports only Celo Mainnet (${env.CELO_CHAIN_ID})`, 401, 'sign')
    );
  }

  try {
    logger.debug('[AUTH] Issuing wallet challenge', {
      wallet: `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
      chainId
    });

    const { domain, uri } = deriveAuthContext();
    const challenge = await issueWalletChallenge({ wallet, chainId, domain, uri });

    logger.info('[AUTH] Wallet challenge issued', {
      wallet: `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
      nonce: `${challenge.nonce.slice(0, 8)}...`,
      expiresAt: challenge.expiresAt.toISOString()
    });

    setNoStore(res);
    res.json({
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString()
    });
  } catch (error) {
    logger.error('[AUTH] Wallet challenge issuance failed', error, {
      wallet: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : 'UNKNOWN',
      errorName: error instanceof Error ? error.name : 'Unknown'
    });
    return sendAuthError(res, error);
  }
}

export async function verifyAuthSignature(req: Request, res: Response) {
  const wallet = req.body.wallet?.toString();
  const nonce = req.body.nonce?.toString();
  const signature = req.body.signature?.toString();
  const chainId = normalizeRequestedChainId(req.body.chainId);

  logger.debug('[AUTH] Verify signature request received', {
    wallet: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : 'MISSING',
    nonce: nonce ? `${nonce.slice(0, 8)}...` : 'MISSING',
    signature: signature ? `${signature.slice(0, 8)}...` : 'MISSING',
    chainId,
    requestChainId: req.body.chainId
  });

  if (!wallet || !nonce || !signature) {
    logger.warn('[AUTH] Verify signature validation failed: missing required fields', {
      missingWallet: !wallet,
      missingNonce: !nonce,
      missingSignature: !signature
    });
    return sendAuthError(res, new AuthError('AUTH_REQUEST_INVALID', 'Wallet, nonce, and signature are required', 400, 'sign'));
  }

  if (typeof req.body.chainId !== 'undefined' && typeof chainId !== 'number') {
    logger.warn('[AUTH] Verify signature validation failed: invalid chainId', {
      providedChainId: req.body.chainId,
      normalizedChainId: chainId
    });
    return sendAuthError(res, new AuthError('AUTH_CHAIN_ID_INVALID', 'chainId must be a positive integer', 400, 'sign'));
  }

  if (typeof chainId === 'number' && chainId !== env.CELO_CHAIN_ID) {
    logger.warn('[AUTH] Verify signature validation failed: chain mismatch', {
      providedChainId: chainId,
      expectedChainId: env.CELO_CHAIN_ID
    });
    return sendAuthError(
      res,
      new AuthError('AUTH_CHAIN_MISMATCH', `QuestForge AI supports only Celo Mainnet (${env.CELO_CHAIN_ID})`, 401, 'sign')
    );
  }

  try {
    logger.debug('[AUTH] Starting wallet challenge verification', {
      wallet: `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
      chainId
    });

    const payload = await verifyWalletChallenge({
      wallet,
      nonce,
      signature,
      chainId
    });

    logger.info('[AUTH] Wallet challenge verification successful', {
      wallet: `${payload.session.wallet.slice(0, 6)}...${payload.session.wallet.slice(-4)}`,
      sessionId: payload.session.id,
      userId: payload.session.userId
    });

    sendAuthSession(res, payload);
  } catch (error) {
    logger.error('[AUTH] Wallet challenge verification failed', error, {
      wallet: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : 'UNKNOWN',
      errorName: error instanceof Error ? error.name : 'Unknown'
    });
    return sendAuthError(res, error);
  }
}

export async function refreshAuthenticatedSession(req: Request, res: Response) {
  const refreshToken = readRefreshToken(req.headers.cookie);

  logger.debug('[AUTH] Refresh session request received', {
    hasRefreshToken: !!refreshToken,
    cookieHeader: req.headers.cookie ? '[present]' : '[missing]'
  });

  if (!refreshToken) {
    logger.warn('[AUTH] Refresh session request failed: missing refresh token');
    clearRefreshCookie(res);
    return sendAuthError(res, new AuthError('AUTH_REFRESH_TOKEN_MISSING', 'Refresh session is missing', 401, 'sign'));
  }

  try {
    logger.debug('[AUTH] Validating refresh token and issuing new session');

    const payload = await refreshAuthSession(refreshToken);

    logger.info('[AUTH] Session refreshed successfully', {
      sessionId: payload.session.id,
      wallet: `${payload.session.wallet.slice(0, 6)}...${payload.session.wallet.slice(-4)}`,
      userId: payload.session.userId
    });

    sendAuthSession(res, payload);
  } catch (error) {
    logger.error('[AUTH] Session refresh failed', error, {
      errorName: error instanceof Error ? error.name : 'Unknown'
    });
    clearRefreshCookie(res);
    return sendAuthError(res, error);
  }
}

export async function getAuthenticatedSession(req: Request, res: Response) {
  if (!req.auth) {
    logger.warn('[AUTH] Get session request failed: no auth context');
    return sendAuthError(res, new AuthError('AUTH_ACCESS_TOKEN_MISSING', 'Authentication required', 401, 'sign'));
  }

  logger.debug('[AUTH] Get session request successful', {
    sessionId: req.auth.sessionId,
    wallet: `${req.auth.wallet.slice(0, 6)}...${req.auth.wallet.slice(-4)}`,
    userId: req.auth.userId
  });

  setNoStore(res);
  res.json({
    session: {
      id: req.auth.sessionId,
      wallet: normalizeValidatedWallet(req.auth.wallet),
      expiresAt: req.auth.expiresAt.toISOString(),
      accessTokenExpiresAt: req.auth.accessTokenExpiresAt.toISOString()
    },
    user: req.auth.user
  });
}

export async function logoutSession(req: Request, res: Response) {
  const refreshToken = readRefreshToken(req.headers.cookie);
  const accessToken = readBearerToken(req.get('authorization'));

  clearRefreshCookie(res);
  setNoStore(res);

  try {
    if (refreshToken) {
      await revokeRefreshSession(refreshToken);
    } else if (accessToken) {
      const sessionId = readSessionIdFromAccessToken(accessToken);
      await revokeSessionById(sessionId);
    }
  } catch (error) {
    logger.error('Logout session revocation failed', error);
  }

  res.json({
    success: true
  });
}

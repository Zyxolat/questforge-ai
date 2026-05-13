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
    return res.status(error.status).json(toAuthErrorResponse(error));
  }

  logger.error('Authentication controller error', error);
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

  if (!wallet) {
    return sendAuthError(res, new AuthError('AUTH_REQUEST_INVALID', 'Wallet is required', 400, 'sign'));
  }

  if (typeof chainId !== 'number') {
    return sendAuthError(res, new AuthError('AUTH_CHAIN_ID_INVALID', 'A valid chainId is required', 400, 'sign'));
  }

  if (chainId !== env.CELO_CHAIN_ID) {
    return sendAuthError(
      res,
      new AuthError('AUTH_CHAIN_MISMATCH', `QuestForge AI supports only Celo Mainnet (${env.CELO_CHAIN_ID})`, 401, 'sign')
    );
  }

  try {
    const { domain, uri } = deriveAuthContext();
    const challenge = await issueWalletChallenge({ wallet, chainId, domain, uri });
    setNoStore(res);
    res.json({
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString()
    });
  } catch (error) {
    return sendAuthError(res, error);
  }
}

export async function verifyAuthSignature(req: Request, res: Response) {
  const wallet = req.body.wallet?.toString();
  const nonce = req.body.nonce?.toString();
  const signature = req.body.signature?.toString();
  const chainId = normalizeRequestedChainId(req.body.chainId);

  if (!wallet || !nonce || !signature) {
    return sendAuthError(res, new AuthError('AUTH_REQUEST_INVALID', 'Wallet, nonce, and signature are required', 400, 'sign'));
  }

  if (typeof req.body.chainId !== 'undefined' && typeof chainId !== 'number') {
    return sendAuthError(res, new AuthError('AUTH_CHAIN_ID_INVALID', 'chainId must be a positive integer', 400, 'sign'));
  }

  if (typeof chainId === 'number' && chainId !== env.CELO_CHAIN_ID) {
    return sendAuthError(
      res,
      new AuthError('AUTH_CHAIN_MISMATCH', `QuestForge AI supports only Celo Mainnet (${env.CELO_CHAIN_ID})`, 401, 'sign')
    );
  }

  try {
    const payload = await verifyWalletChallenge({
      wallet,
      nonce,
      signature,
      chainId
    });

    sendAuthSession(res, payload);
  } catch (error) {
    return sendAuthError(res, error);
  }
}

export async function refreshAuthenticatedSession(req: Request, res: Response) {
  const refreshToken = readRefreshToken(req.headers.cookie);

  if (!refreshToken) {
    clearRefreshCookie(res);
    return sendAuthError(res, new AuthError('AUTH_REFRESH_TOKEN_MISSING', 'Refresh session is missing', 401, 'sign'));
  }

  try {
    const payload = await refreshAuthSession(refreshToken);
    sendAuthSession(res, payload);
  } catch (error) {
    clearRefreshCookie(res);
    return sendAuthError(res, error);
  }
}

export async function getAuthenticatedSession(req: Request, res: Response) {
  if (!req.auth) {
    return sendAuthError(res, new AuthError('AUTH_ACCESS_TOKEN_MISSING', 'Authentication required', 401, 'sign'));
  }

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

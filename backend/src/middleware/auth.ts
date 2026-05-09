import { NextFunction, Request, Response } from 'express';
import { authenticateAccessToken, AuthError, isAuthError, readBearerToken, toAuthErrorResponse } from '../services/auth';
import { logger } from '../services/logger';

function setNoStore(res: Response) {
  res.set('Cache-Control', 'no-store');
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readBearerToken(req.get('authorization'));

  if (!token) {
    setNoStore(res);
    return res
      .status(401)
      .json(toAuthErrorResponse(new AuthError('AUTH_ACCESS_TOKEN_MISSING', 'Authentication required', 401, 'refresh')));
  }

  try {
    const verified = await authenticateAccessToken(token);
    req.auth = {
      userId: verified.session.userId,
      wallet: verified.session.wallet,
      sessionId: verified.session.id,
      expiresAt: verified.session.expiresAt,
      accessTokenExpiresAt: verified.accessTokenExpiresAt,
      user: verified.session.user
    };

    return next();
  } catch (error) {
    setNoStore(res);
    if (isAuthError(error)) {
      return res.status(error.status).json(toAuthErrorResponse(error));
    }

    logger.error('Authentication middleware failed', error);
    return res
      .status(500)
      .json(toAuthErrorResponse(new AuthError('AUTH_SESSION_INVALID', 'Authentication failed unexpectedly', 500, 'sign')));
  }
}

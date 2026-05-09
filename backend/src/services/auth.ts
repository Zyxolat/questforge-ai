import { Prisma, User } from '@prisma/client';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { env } from '../config/env';
import { prisma, normalizeWallet } from './chain';

type DatabaseClient = typeof prisma | Prisma.TransactionClient;
type AuthAction = 'none' | 'refresh' | 'sign';

const NONCE_TTL_MINUTES = env.AUTH_NONCE_TTL_MINUTES;
const SESSION_TTL_HOURS = env.AUTH_SESSION_TTL_HOURS;
const AUTH_STATEMENT = env.AUTH_STATEMENT;

export type AuthErrorCode =
  | 'AUTH_REQUEST_INVALID'
  | 'AUTH_WALLET_INVALID'
  | 'AUTH_CHAIN_ID_INVALID'
  | 'AUTH_CHALLENGE_NOT_FOUND'
  | 'AUTH_CHALLENGE_EXPIRED'
  | 'AUTH_CHALLENGE_CONSUMED'
  | 'AUTH_CHAIN_MISMATCH'
  | 'AUTH_SIGNATURE_INVALID'
  | 'AUTH_ACCESS_TOKEN_MISSING'
  | 'AUTH_ACCESS_TOKEN_INVALID'
  | 'AUTH_ACCESS_TOKEN_EXPIRED'
  | 'AUTH_REFRESH_TOKEN_MISSING'
  | 'AUTH_REFRESH_TOKEN_INVALID'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_SESSION_INVALID';

export class AuthError extends Error {
  status: number;
  code: AuthErrorCode;
  action: AuthAction;

  constructor(code: AuthErrorCode, message: string, status = 401, action: AuthAction = 'none') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.action = action;
  }
}

export interface WalletChallengeContext {
  wallet: string;
  chainId: number;
  domain: string;
  uri: string;
}

interface AuthChallengeRow {
  id: string;
  wallet: string;
  nonce: string;
  message: string;
  chainId: number;
  domain: string;
  uri: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface AuthSessionRow {
  sessionId: string;
  wallet: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userId: string;
  username: string | null;
  userWallet: string;
  xp: number;
  level: number;
  questCount: number;
  streak: number;
  onchainActions: number;
}

interface JwtAccessTokenPayload {
  type: 'access';
  sub: string;
  sid: string;
  wallet: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedUser {
  id: string;
  username: string | null;
  wallet: string;
  xp: number;
  level: number;
  questCount: number;
  streak: number;
  onchainActions: number;
}

export interface AuthenticatedSession {
  id: string;
  wallet: string;
  expiresAt: Date;
  userId: string;
  user: AuthenticatedUser;
}

export interface VerifiedAccessToken {
  session: AuthenticatedSession;
  accessTokenExpiresAt: Date;
}

export interface IssuedAuthSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  session: AuthenticatedSession;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toUnixSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

function fromUnixSeconds(seconds: number) {
  return new Date(seconds * 1000);
}

function createNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function encodeBase64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signJwt(payload: JwtAccessTokenPayload) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  const unsignedToken = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', env.JWT_SECRET).update(unsignedToken).digest('base64url');
  return `${unsignedToken}.${signature}`;
}

function parseJwtPayload(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError('AUTH_ACCESS_TOKEN_INVALID', 'Malformed access token', 401, 'sign');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  let header: { alg?: string; typ?: string };
  let payload: JwtAccessTokenPayload;

  try {
    header = JSON.parse(decodeBase64Url(headerPart)) as { alg?: string; typ?: string };
    payload = JSON.parse(decodeBase64Url(payloadPart)) as JwtAccessTokenPayload;
  } catch {
    throw new AuthError('AUTH_ACCESS_TOKEN_INVALID', 'Invalid access token payload', 401, 'sign');
  }

  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new AuthError('AUTH_ACCESS_TOKEN_INVALID', 'Unsupported access token format', 401, 'sign');
  }

  const unsignedToken = `${headerPart}.${payloadPart}`;
  const expectedSignature = crypto.createHmac('sha256', env.JWT_SECRET).update(unsignedToken).digest('base64url');
  const signatureBuffer = Buffer.from(signaturePart);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw new AuthError('AUTH_ACCESS_TOKEN_INVALID', 'Access token signature mismatch', 401, 'sign');
  }

  if (
    payload.type !== 'access' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.wallet !== 'string' ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp)
  ) {
    throw new AuthError('AUTH_ACCESS_TOKEN_INVALID', 'Access token claims are invalid', 401, 'sign');
  }

  return payload;
}

function verifyAccessTokenClaims(token: string, options?: { allowExpired?: boolean }) {
  const payload = parseJwtPayload(token);
  const now = Math.floor(Date.now() / 1000);

  if (!options?.allowExpired && payload.exp <= now) {
    throw new AuthError('AUTH_ACCESS_TOKEN_EXPIRED', 'Access token expired', 401, 'refresh');
  }

  return payload;
}

function createAccessToken(session: AuthenticatedSession, issuedAt: Date) {
  const accessTokenExpiresAt = new Date(
    Math.min(session.expiresAt.getTime(), issuedAt.getTime() + env.JWT_EXPIRES_IN_SECONDS * 1000)
  );

  const payload: JwtAccessTokenPayload = {
    type: 'access',
    sub: session.userId,
    sid: session.id,
    wallet: session.wallet,
    iat: toUnixSeconds(issuedAt),
    exp: toUnixSeconds(accessTokenExpiresAt)
  };

  return {
    accessToken: signJwt(payload),
    accessTokenExpiresAt
  };
}

function mapSessionRow(row: AuthSessionRow): AuthenticatedSession {
  return {
    id: row.sessionId,
    wallet: row.wallet,
    expiresAt: row.expiresAt,
    userId: row.userId,
    user: {
      id: row.userId,
      username: row.username,
      wallet: row.userWallet,
      xp: row.xp,
      level: row.level,
      questCount: row.questCount,
      streak: row.streak,
      onchainActions: row.onchainActions
    }
  };
}

function ensureActiveSessionRow(row: AuthSessionRow | null) {
  if (!row) {
    throw new AuthError('AUTH_SESSION_INVALID', 'Session not found', 401, 'sign');
  }

  if (row.revokedAt) {
    throw new AuthError('AUTH_SESSION_REVOKED', 'Session has been revoked', 401, 'sign');
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    throw new AuthError('AUTH_SESSION_EXPIRED', 'Session has expired', 401, 'sign');
  }

  return row;
}

async function loadSessionRowById(sessionId: string, db: DatabaseClient = prisma) {
  const [session] = await db.$queryRaw<AuthSessionRow[]>`
    SELECT
      s.id AS "sessionId",
      s.wallet,
      s."expiresAt",
      s."revokedAt",
      s."userId",
      u.username,
      u.wallet AS "userWallet",
      u.xp,
      u.level,
      u."questCount",
      u.streak,
      u."onchainActions"
    FROM "AuthSession" s
    INNER JOIN "User" u ON u.id = s."userId"
    WHERE s.id = ${sessionId}
    LIMIT 1
  `;

  return session ?? null;
}

async function loadSessionRowByRefreshToken(refreshToken: string, db: DatabaseClient = prisma) {
  const [session] = await db.$queryRaw<AuthSessionRow[]>`
    SELECT
      s.id AS "sessionId",
      s.wallet,
      s."expiresAt",
      s."revokedAt",
      s."userId",
      u.username,
      u.wallet AS "userWallet",
      u.xp,
      u.level,
      u."questCount",
      u.streak,
      u."onchainActions"
    FROM "AuthSession" s
    INNER JOIN "User" u ON u.id = s."userId"
    WHERE s."tokenHash" = ${hashToken(refreshToken)}
    LIMIT 1
  `;

  return session ?? null;
}

async function touchSession(sessionId: string, db: DatabaseClient = prisma) {
  await db.$executeRaw`
    UPDATE "AuthSession"
    SET "lastSeenAt" = ${new Date()}
    WHERE id = ${sessionId}
  `;
}

async function createPersistentSession(user: User, wallet: string) {
  const issuedAt = new Date();
  const refreshToken = createSessionToken();
  const sessionExpiresAt = addHours(issuedAt, SESSION_TTL_HOURS);

  const session = await prisma.$transaction(async (tx) => {
    const sessionId = crypto.randomUUID();

    await tx.$executeRaw`
      INSERT INTO "AuthSession" (id, "tokenHash", wallet, "createdAt", "expiresAt", "lastSeenAt", "userId")
      VALUES (${sessionId}, ${hashToken(refreshToken)}, ${wallet}, ${issuedAt}, ${sessionExpiresAt}, ${issuedAt}, ${user.id})
    `;

    const created = await loadSessionRowById(sessionId, tx);
    return mapSessionRow(ensureActiveSessionRow(created));
  });

  const { accessToken, accessTokenExpiresAt } = createAccessToken(session, issuedAt);

  return {
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    session
  };
}

export function assertValidWallet(wallet: string) {
  try {
    return ethers.getAddress(wallet);
  } catch {
    throw new AuthError('AUTH_WALLET_INVALID', 'Wallet address is invalid', 400, 'sign');
  }
}

export function normalizeValidatedWallet(wallet: string) {
  return normalizeWallet(assertValidWallet(wallet));
}

export function buildWalletSignInMessage({
  wallet,
  chainId,
  domain,
  uri,
  nonce,
  issuedAt,
  expiresAt
}: WalletChallengeContext & { nonce: string; issuedAt: Date; expiresAt: Date }) {
  return `${domain} wants you to sign in with your Ethereum account:
${wallet}

${AUTH_STATEMENT}

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt.toISOString()}
Expiration Time: ${expiresAt.toISOString()}`;
}

export async function issueWalletChallenge(context: WalletChallengeContext) {
  const wallet = assertValidWallet(context.wallet);
  const normalizedWallet = normalizeWallet(wallet);
  const now = new Date();

  await prisma.$executeRaw`
    DELETE FROM "AuthChallenge"
    WHERE wallet = ${normalizedWallet}
      AND ("expiresAt" <= ${now} OR "consumedAt" IS NOT NULL)
  `;

  const [existingChallenge] = await prisma.$queryRaw<AuthChallengeRow[]>`
    SELECT id, wallet, nonce, message, "chainId", domain, uri, "expiresAt", "consumedAt", "createdAt"
    FROM "AuthChallenge"
    WHERE wallet = ${normalizedWallet}
      AND "consumedAt" IS NULL
      AND "expiresAt" > ${now}
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;

  if (
    existingChallenge &&
    existingChallenge.chainId === context.chainId &&
    existingChallenge.domain === context.domain &&
    existingChallenge.uri === context.uri
  ) {
    return {
      nonce: existingChallenge.nonce,
      message: existingChallenge.message,
      expiresAt: existingChallenge.expiresAt
    };
  }

  await prisma.$executeRaw`
    DELETE FROM "AuthChallenge"
    WHERE wallet = ${normalizedWallet}
      AND "consumedAt" IS NULL
  `;

  const issuedAt = now;
  const expiresAt = addMinutes(issuedAt, NONCE_TTL_MINUTES);
  const nonce = createNonce();
  const message = buildWalletSignInMessage({
    wallet,
    chainId: context.chainId,
    domain: context.domain,
    uri: context.uri,
    nonce,
    issuedAt,
    expiresAt
  });

  const [challenge] = await prisma.$queryRaw<AuthChallengeRow[]>`
    INSERT INTO "AuthChallenge" (id, wallet, nonce, message, "chainId", domain, uri, "expiresAt", "createdAt")
    VALUES (${crypto.randomUUID()}, ${normalizedWallet}, ${nonce}, ${message}, ${context.chainId}, ${context.domain}, ${context.uri}, ${expiresAt}, ${issuedAt})
    RETURNING id, wallet, nonce, message, "chainId", domain, uri, "expiresAt", "consumedAt", "createdAt"
  `;

  return {
    nonce: challenge.nonce,
    message: challenge.message,
    expiresAt: challenge.expiresAt
  };
}

export async function verifyWalletChallenge(params: {
  wallet: string;
  nonce: string;
  signature: string;
  chainId?: number;
}) {
  const wallet = assertValidWallet(params.wallet);
  const normalizedWallet = normalizeWallet(wallet);
  const [challenge] = await prisma.$queryRaw<AuthChallengeRow[]>`
    SELECT id, wallet, nonce, message, "chainId", domain, uri, "expiresAt", "consumedAt", "createdAt"
    FROM "AuthChallenge"
    WHERE wallet = ${normalizedWallet}
      AND nonce = ${params.nonce}
    LIMIT 1
  `;

  if (!challenge) {
    throw new AuthError('AUTH_CHALLENGE_NOT_FOUND', 'Sign-in challenge was not found', 401, 'sign');
  }

  if (challenge.consumedAt) {
    throw new AuthError('AUTH_CHALLENGE_CONSUMED', 'Sign-in challenge has already been used', 409, 'sign');
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new AuthError('AUTH_CHALLENGE_EXPIRED', 'Sign-in challenge expired', 401, 'sign');
  }

  if (typeof params.chainId === 'number' && params.chainId !== challenge.chainId) {
    throw new AuthError('AUTH_CHAIN_MISMATCH', 'Wallet challenge chain does not match the active network', 401, 'sign');
  }

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(challenge.message, params.signature);
  } catch {
    throw new AuthError('AUTH_SIGNATURE_INVALID', 'Wallet signature is invalid', 401, 'sign');
  }

  if (normalizeWallet(recoveredAddress) !== normalizedWallet) {
    throw new AuthError('AUTH_SIGNATURE_INVALID', 'Wallet signature does not match the requested account', 401, 'sign');
  }

  const result = await prisma.$transaction(async (tx) => {
    const consumedRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "AuthChallenge"
      SET "consumedAt" = ${new Date()}
      WHERE id = ${challenge.id}
        AND "consumedAt" IS NULL
      RETURNING id
    `;

    if (consumedRows.length !== 1) {
      throw new AuthError('AUTH_CHALLENGE_CONSUMED', 'Sign-in challenge has already been used', 409, 'sign');
    }

    const user = await tx.user.upsert({
      where: { wallet: normalizedWallet },
      update: {},
      create: { wallet: normalizedWallet }
    });

    return user;
  });

  return createPersistentSession(result, normalizedWallet);
}

export async function authenticateAccessToken(token: string): Promise<VerifiedAccessToken> {
  const claims = verifyAccessTokenClaims(token);
  const sessionRow = ensureActiveSessionRow(await loadSessionRowById(claims.sid));
  const session = mapSessionRow(sessionRow);

  if (session.userId !== claims.sub || session.wallet !== normalizeWallet(claims.wallet)) {
    throw new AuthError('AUTH_SESSION_INVALID', 'Session token does not match the active session', 401, 'sign');
  }

  await touchSession(session.id);

  return {
    session,
    accessTokenExpiresAt: fromUnixSeconds(claims.exp)
  };
}

export async function refreshAuthSession(refreshToken: string) {
  const foundSession = await loadSessionRowByRefreshToken(refreshToken);

  if (!foundSession) {
    throw new AuthError('AUTH_REFRESH_TOKEN_INVALID', 'Refresh token is invalid', 401, 'sign');
  }

  const sessionRow = ensureActiveSessionRow(foundSession);
  const rotatedRefreshToken = createSessionToken();
  const now = new Date();

  const rotatedSessionRow = await prisma.$transaction(async (tx) => {
    const [updatedRow] = await tx.$queryRaw<Array<{ sessionId: string }>>`
      UPDATE "AuthSession"
      SET
        "tokenHash" = ${hashToken(rotatedRefreshToken)},
        "lastSeenAt" = ${now}
      WHERE id = ${sessionRow.sessionId}
        AND "tokenHash" = ${hashToken(refreshToken)}
        AND "revokedAt" IS NULL
        AND "expiresAt" > ${now}
      RETURNING id AS "sessionId"
    `;

    if (!updatedRow) {
      throw new AuthError('AUTH_REFRESH_TOKEN_INVALID', 'Refresh token is no longer valid', 401, 'sign');
    }

    const updated = await loadSessionRowById(updatedRow.sessionId, tx);
    return ensureActiveSessionRow(updated);
  });

  const session = mapSessionRow(rotatedSessionRow);
  const { accessToken, accessTokenExpiresAt } = createAccessToken(session, now);

  return {
    accessToken,
    accessTokenExpiresAt,
    refreshToken: rotatedRefreshToken,
    session
  };
}

export async function revokeRefreshSession(refreshToken: string) {
  await prisma.$executeRaw`
    UPDATE "AuthSession"
    SET "revokedAt" = ${new Date()}
    WHERE "tokenHash" = ${hashToken(refreshToken)}
      AND "revokedAt" IS NULL
  `;
}

export async function revokeSessionById(sessionId: string) {
  await prisma.$executeRaw`
    UPDATE "AuthSession"
    SET "revokedAt" = ${new Date()}
    WHERE id = ${sessionId}
      AND "revokedAt" IS NULL
  `;
}

export function readBearerToken(headerValue: string | undefined) {
  const header = (headerValue || '').trim();
  if (!header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

export function readRefreshToken(cookieHeader: string | undefined) {
  if (!cookieHeader) {
    return null;
  }

  const cookieName = env.AUTH_COOKIE_NAME;
  const cookiePairs = cookieHeader.split(';');

  for (const pair of cookiePairs) {
    const [rawName, ...rawValue] = pair.split('=');
    if (rawName?.trim() !== cookieName) {
      continue;
    }

    const value = rawValue.join('=').trim();
    if (!value) {
      return null;
    }

    return decodeURIComponent(value);
  }

  return null;
}

export function readSessionIdFromAccessToken(token: string) {
  const claims = verifyAccessTokenClaims(token, { allowExpired: true });
  return claims.sid;
}

export function getAccessTokenExpiry(token: string) {
  const claims = verifyAccessTokenClaims(token, { allowExpired: true });
  return fromUnixSeconds(claims.exp);
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

export function toAuthErrorResponse(error: AuthError) {
  return {
    error: {
      code: error.code,
      message: error.message
    },
    action: error.action
  };
}

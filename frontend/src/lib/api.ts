import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { env } from './env';

const API_BASE = env.API_BASE_URL;
const AUTH_REFRESHABLE_CODES = new Set([
  'AUTH_ACCESS_TOKEN_MISSING',
  'AUTH_ACCESS_TOKEN_EXPIRED',
  'AUTH_SESSION_INVALID',
  'AUTH_SESSION_REVOKED',
  'AUTH_SESSION_EXPIRED'
]);
const AUTH_ROUTE_SUFFIXES = ['/auth/nonce', '/auth/verify', '/auth/refresh', '/auth/logout'];

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

export interface AuthSessionSummary {
  id: string;
  wallet: string;
  expiresAt: string;
  accessTokenExpiresAt?: string;
}

export interface AuthSessionPayload {
  accessToken: string;
  accessTokenExpiresAt: string;
  session: AuthSessionSummary;
  user: AuthenticatedUser;
}

export interface AuthSessionInfo {
  session: AuthSessionSummary;
  user: AuthenticatedUser;
}

export interface AuthFailure {
  status: number;
  code: string;
  message: string;
  action: 'none' | 'refresh' | 'sign';
}

export class AuthApiError extends Error {
  status: number;
  code: string;
  action: 'none' | 'refresh' | 'sign';

  constructor(failure: AuthFailure) {
    super(failure.message);
    this.name = 'AuthApiError';
    this.status = failure.status;
    this.code = failure.code;
    this.action = failure.action;
  }
}

interface AuthAwareRequestConfig extends InternalAxiosRequestConfig {
  _authRetried?: boolean;
}

type AuthEventHandlers = {
  onSessionChanged?: (session: AuthSessionPayload | null) => void;
  onAuthFailure?: (failure: AuthFailure) => void;
};

const apiDefaults = {
  baseURL: API_BASE,
  timeout: 12000,
  withCredentials: true
};

const refreshClient = axios.create(apiDefaults);
export const api = axios.create(apiDefaults);

let currentAccessToken: string | null = null;
let currentAccessTokenExpiresAt: string | null = null;
let refreshPromise: Promise<AuthSessionPayload> | null = null;
let authHandlers: AuthEventHandlers = {};

function isAuthRoute(url: string | undefined) {
  if (!url) return false;
  return AUTH_ROUTE_SUFFIXES.some((suffix) => url.endsWith(suffix));
}

function toAuthFailure(error: unknown, fallbackAction: AuthFailure['action'] = 'sign'): AuthFailure {
  if (error instanceof AuthApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      action: error.action
    };
  }

  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data as
      | {
          error?: { code?: string; message?: string };
          action?: AuthFailure['action'];
        }
      | undefined;

    return {
      status: error.response?.status ?? 500,
      code: responseData?.error?.code || 'AUTH_UNKNOWN',
      message: responseData?.error?.message || error.message || 'Authentication failed',
      action: responseData?.action || fallbackAction
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      code: 'AUTH_UNKNOWN',
      message: error.message,
      action: fallbackAction
    };
  }

  return {
    status: 500,
    code: 'AUTH_UNKNOWN',
    message: 'Authentication failed',
    action: fallbackAction
  };
}

function applyAuthSession(session: AuthSessionPayload | null, notify = true) {
  currentAccessToken = session?.accessToken ?? null;
  currentAccessTokenExpiresAt = session?.accessTokenExpiresAt ?? null;

  if (notify) {
    authHandlers.onSessionChanged?.(session);
  }
}

function shouldUseAccessToken() {
  if (!currentAccessToken || !currentAccessTokenExpiresAt) {
    return false;
  }

  return new Date(currentAccessTokenExpiresAt).getTime() > Date.now() + 5_000;
}

function shouldAttemptRefresh(error: AxiosError, config: AuthAwareRequestConfig) {
  if (config._authRetried || isAuthRoute(config.url)) {
    return false;
  }

  if (error.response?.status !== 401) {
    return false;
  }

  const failure = toAuthFailure(error, 'sign');
  return failure.action === 'refresh' || AUTH_REFRESHABLE_CODES.has(failure.code);
}

export function subscribeToAuthEvents(handlers: AuthEventHandlers) {
  authHandlers = handlers;
  return () => {
    if (authHandlers === handlers) {
      authHandlers = {};
    }
  };
}

export function getCurrentAccessToken() {
  return currentAccessToken;
}

export function clearAuthSession(notify = true) {
  applyAuthSession(null, notify);
}

export function applyVerifiedAuthSession(session: AuthSessionPayload) {
  applyAuthSession(session);
}

export async function restoreAuthSession(options?: { notifyFailure?: boolean }) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = refreshClient
    .post<AuthSessionPayload>('/auth/refresh')
    .then((response) => {
      applyAuthSession(response.data);
      return response.data;
    })
    .catch((error) => {
      const failure = toAuthFailure(error, 'sign');
      applyAuthSession(null, false);
      if (options?.notifyFailure !== false) {
        authHandlers.onAuthFailure?.(failure);
      }
      throw new AuthApiError(failure);
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

api.interceptors.request.use((config) => {
  if (shouldUseAccessToken()) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${currentAccessToken}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = (error.config || {}) as AuthAwareRequestConfig;

    if (!shouldAttemptRefresh(error, config)) {
      throw error;
    }

    config._authRetried = true;

    try {
      const refreshedSession = await restoreAuthSession({ notifyFailure: true });
      config.headers = config.headers ?? {};
      config.headers.Authorization = `Bearer ${refreshedSession.accessToken}`;
      return api.request(config);
    } catch (refreshError) {
      throw refreshError;
    }
  }
);

export function requestAuthNonce(wallet: string, chainId: number) {
  return refreshClient.post<{ nonce: string; message: string; expiresAt: string }>('/auth/nonce', { wallet, chainId });
}

export function verifyWalletSignature(wallet: string, nonce: string, signature: string, chainId: number) {
  return refreshClient.post<AuthSessionPayload>('/auth/verify', { wallet, nonce, signature, chainId });
}

export function fetchAuthSession() {
  return api.get<AuthSessionInfo>('/auth/me');
}

export async function logoutAuthSession() {
  try {
    await refreshClient.post('/auth/logout');
  } finally {
    applyAuthSession(null);
  }
}

export function getPlayerStats(wallet: string) {
  return api.get('/player/stats', { params: { wallet } });
}

export function fetchDailyMissions() {
  return api.get('/quests/daily');
}

export function fetchActiveQuests() {
  return api.get('/quests/active');
}

export function fetchNPCDialogue(type: string, player: string) {
  return api.get('/npc/dialogue', { params: { type, player } });
}

export function generateQuest() {
  return api.post('/quests/generate');
}

export function submitProofForVerification(questId: string, proofUri: string, submissionTxHash: string) {
  return api.post('/quests/submit-proof', { questId, proofUri, submissionTxHash });
}

export function extractAuthFailure(error: unknown) {
  return toAuthFailure(error);
}

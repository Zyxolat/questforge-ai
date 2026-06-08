import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
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
  details?: string[];
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
  withCredentials: true,
  headers: {
    Accept: 'application/json'
  }
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

function isHtmlLikeResponse(data: unknown) {
  return (
    typeof data === 'string' &&
    (/<html/i.test(data) || /<!doctype/i.test(data) || /page could not be found/i.test(data))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwInvalidApiResponse(message: string): never {
  throw new AuthApiError({
    status: 502,
    code: 'AUTH_API_INVALID_RESPONSE',
    message,
    action: 'sign'
  });
}

function getHeaderValue(headers: AxiosResponse['headers'], name: string) {
  if (!headers) {
    return '';
  }

  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value.join(', ');
  }

  return typeof value === 'string' ? value : '';
}

function assertJsonApiResponse<T>(response: AxiosResponse<T>) {
  const contentType = getHeaderValue(response.headers, 'content-type').toLowerCase();
  if (contentType.includes('text/html') || isHtmlLikeResponse(response.data)) {
    throwInvalidApiResponse('Backend API not reachable or wrong base URL');
  }

  return response;
}

function assertAuthNoncePayload(data: unknown) {
  if (!isRecord(data)) {
    throwInvalidApiResponse('Backend API not reachable or wrong base URL.');
  }

  if (typeof data.nonce !== 'string' || typeof data.message !== 'string' || typeof data.expiresAt !== 'string') {
    throwInvalidApiResponse('Authentication nonce response was invalid. Check backend routing and VITE_API_BASE_URL.');
  }

  return data as { nonce: string; message: string; expiresAt: string };
}

function assertAuthSessionPayload(data: unknown): AuthSessionPayload {
  if (!isRecord(data)) {
    throwInvalidApiResponse('Backend API not reachable or wrong base URL.');
  }

  const session = data.session;
  const user = data.user;
  if (
    typeof data.accessToken !== 'string' ||
    typeof data.accessTokenExpiresAt !== 'string' ||
    !isRecord(session) ||
    typeof session.id !== 'string' ||
    typeof session.wallet !== 'string' ||
    typeof session.expiresAt !== 'string' ||
    !isRecord(user) ||
    typeof user.id !== 'string' ||
    typeof user.wallet !== 'string'
  ) {
    throwInvalidApiResponse('Authentication session response was invalid. Check backend routing and VITE_API_BASE_URL.');
  }

  return data as unknown as AuthSessionPayload;
}

function assertAuthSessionInfo(data: unknown): AuthSessionInfo {
  if (!isRecord(data) || !isRecord(data.session) || !isRecord(data.user)) {
    throwInvalidApiResponse('Authenticated session payload was invalid. Check backend routing and VITE_API_BASE_URL.');
  }

  if (
    typeof data.session.id !== 'string' ||
    typeof data.session.wallet !== 'string' ||
    typeof data.session.expiresAt !== 'string' ||
    typeof data.user.id !== 'string' ||
    typeof data.user.wallet !== 'string'
  ) {
    throwInvalidApiResponse('Authenticated session payload was invalid. Check backend routing and VITE_API_BASE_URL.');
  }

  return data as unknown as AuthSessionInfo;
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
    if (!error.response) {
      return {
        status: 502,
        code: 'AUTH_API_UNREACHABLE',
        message: 'Backend API not reachable or wrong base URL',
        action: fallbackAction
      };
    }

    const responseData = error.response?.data as
      | {
          error?: { code?: string; message?: string } | string;
          action?: AuthFailure['action'];
          details?: unknown;
        }
      | undefined;
    const htmlLikeResponse = isHtmlLikeResponse(error.response?.data);

    if (htmlLikeResponse) {
      return {
        status: error.response?.status ?? 500,
        code: 'AUTH_API_INVALID_RESPONSE',
        message:
          error.response?.status === 403
            ? 'Authentication request was blocked before JSON reached the browser. Check backend CORS origins for this frontend domain.'
            : 'Authentication backend returned HTML instead of JSON. Check Railway logs and auth middleware.',
        action: fallbackAction
      };
    }

    if (
      error.response?.status === 404 &&
      (!responseData?.error || isHtmlLikeResponse(error.response?.data))
    ) {
      const misconfiguredRelativeApi = API_BASE.startsWith('/');
      return {
        status: 404,
        code: 'AUTH_API_NOT_FOUND',
        message: misconfiguredRelativeApi
          ? 'Authentication API was not found on this site. Set VITE_API_BASE_URL to your backend /api URL or configure a same-origin /api proxy.'
          : 'Authentication API endpoint was not found. Check the backend deployment and VITE_API_BASE_URL.',
        action: 'sign'
      };
    }

    return {
      status: error.response?.status ?? 500,
      code:
        typeof responseData?.error === 'object' && responseData.error
          ? responseData.error.code || 'AUTH_UNKNOWN'
          : 'AUTH_UNKNOWN',
      message:
        typeof responseData?.error === 'string'
          ? responseData.error
          : responseData?.error?.message || error.message || 'Authentication failed',
      action: responseData?.action || fallbackAction,
      details: Array.isArray(responseData?.details)
        ? responseData.details.filter((detail): detail is string => typeof detail === 'string')
        : undefined
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
    console.debug('[API] Refresh already in progress, returning existing promise');
    return refreshPromise;
  }

  console.debug('[API] Starting session refresh');

  refreshPromise = refreshClient
    .post<AuthSessionPayload>('/auth/refresh')
    .then((response) => {
      console.debug('[API] Refresh response received', {
        status: response.status,
        headers: { contentType: response.headers['content-type'] },
        hasData: !!response.data,
        dataKeys: response.data ? Object.keys(response.data) : []
      });

      const payload = assertAuthSessionPayload(response.data);
      applyAuthSession(payload);

      console.info('[API] Session refreshed successfully', {
        sessionId: payload.session.id,
        wallet: `${payload.session.wallet.slice(0, 6)}...${payload.session.wallet.slice(-4)}`,
        userId: payload.user.id
      });

      return payload;
    })
    .catch((error) => {
      console.error('[API] Session refresh failed', {
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        status: axios.isAxiosError(error) ? error.response?.status : undefined
      });

      const failure = toAuthFailure(error, 'sign');
      applyAuthSession(null, false);

      console.debug('[API] Calling onAuthFailure callback', {
        code: failure.code,
        status: failure.status,
        notifyFailure: options?.notifyFailure ?? true
      });

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

refreshClient.interceptors.response.use((response) => assertJsonApiResponse(response));

api.interceptors.request.use((config) => {
  if (shouldUseAccessToken()) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${currentAccessToken}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => assertJsonApiResponse(response),
  async (error: AxiosError) => {
    const config = (error.config || {}) as AuthAwareRequestConfig;

    if (!shouldAttemptRefresh(error, config)) {
      throw error;
    }

    config._authRetried = true;

    const refreshedSession = await restoreAuthSession({ notifyFailure: true });
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${refreshedSession.accessToken}`;
    return api.request(config);
  }
);

export function requestAuthNonce(wallet: string, chainId: number) {
  console.debug('[API] Requesting auth nonce', {
    wallet: `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
    chainId,
    origin: typeof window !== 'undefined' ? window.location.origin : 'server'
  });

  return refreshClient
    .post<{ nonce: string; message: string; expiresAt: string }>('/auth/nonce', { wallet, chainId })
    .then((response) => {
      console.debug('[API] Nonce response received', {
        status: response.status,
        headers: { contentType: response.headers['content-type'] },
        hasData: !!response.data,
        dataKeys: response.data ? Object.keys(response.data) : []
      });

      return {
        ...response,
        data: assertAuthNoncePayload(response.data)
      };
    })
    .catch((error) => {
      console.error('[API] Nonce request failed', {
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
        responseDataType: axios.isAxiosError(error) ? typeof error.response?.data : undefined
      });
      throw error;
    });
}

export function verifyWalletSignature(wallet: string, nonce: string, signature: string, chainId: number) {
  console.debug('[API] Verifying wallet signature', {
    wallet: `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
    nonce: `${nonce.slice(0, 8)}...`,
    signatureLength: signature.length,
    chainId,
    origin: typeof window !== 'undefined' ? window.location.origin : 'server'
  });

  return refreshClient
    .post<AuthSessionPayload>('/auth/verify', { wallet, nonce, signature, chainId })
    .then((response) => {
      console.debug('[API] Verify response received', {
        status: response.status,
        headers: { contentType: response.headers['content-type'] },
        hasData: !!response.data,
        dataKeys: response.data ? Object.keys(response.data) : [],
        hasSession: response.data?.session ? true : false,
        hasUser: response.data?.user ? true : false,
        hasAccessToken: !!response.data?.accessToken
      });

      return {
        ...response,
        data: assertAuthSessionPayload(response.data)
      };
    })
    .catch((error) => {
      console.error('[API] Verify request failed', {
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
        responseDataType: axios.isAxiosError(error) ? typeof error.response?.data : undefined,
        responseData: axios.isAxiosError(error) ? JSON.stringify(error.response?.data).slice(0, 200) : undefined
      });
      throw error;
    });
}

export function fetchAuthSession() {
  return api.get<AuthSessionInfo>('/auth/me').then((response) => ({
    ...response,
    data: assertAuthSessionInfo(response.data)
  }));
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

export function fetchNPCDialogue(type: string, player: string, wallet?: string | null) {
  return api.get('/npc/dialogue', { params: { type, player, wallet: wallet || undefined } });
}

export function fetchRealtimeBootstrap() {
  return api.get('/realtime/bootstrap');
}

export function fetchRealtimeSync(afterId: number) {
  return api.get('/realtime/sync', { params: { afterId } });
}

export function generateQuest(chain = 'Celo') {
  console.debug('[API] Generating quest', {
    chain,
    hasAccessToken: Boolean(currentAccessToken)
  });

  return api
    .post('/quests/generate', { chain })
    .then((response) => {
      console.debug('[API] Generate quest response received', {
        status: response.status,
        hasData: !!response.data,
        dataKeys: response.data ? Object.keys(response.data) : [],
        questId: response.data?.quest?.id,
        orchestrationId: response.data?.quest?.orchestrationId
      });
      return response;
    })
    .catch((error) => {
      console.error('[API] Generate quest request failed', {
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
        responseData: axios.isAxiosError(error) ? JSON.stringify(error.response?.data).slice(0, 500) : undefined
      });
      throw error;
    });
}

export function registerOnchainQuest(questId: string, chainQuestId: string, creationTxHash: string) {
  return api.post('/quests/register-onchain', { questId, chainQuestId, creationTxHash });
}

export function submitProofForVerification(questId: string, proofUri: string, submissionTxHash: string) {
  console.debug('[API] Submitting proof for verification', {
    questId,
    proofUriPreview: proofUri.slice(0, 16),
    submissionTxHash,
    endpoint: '/quests/submit-proof'
  });

  return api
    .post('/quests/submit-proof', { questId, proofUri, submissionTxHash })
    .then((response) => {
      console.debug('[API] Proof verification submission accepted', {
        status: response.status,
        questId: response.data?.questId ?? questId,
        proofSubmissionId: response.data?.proofSubmissionId,
        verificationStatus: response.data?.verificationStatus
      });
      return response;
    })
    .catch((error) => {
      console.error('[API] Proof verification submission failed', {
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
        responseData: axios.isAxiosError(error) ? JSON.stringify(error.response?.data).slice(0, 500) : undefined,
        questId,
        submissionTxHash
      });
      throw error;
    });
}

export function claimDailyLoginBonus() {
  return api.post('/player/daily-bonus');
}

export function extractAuthFailure(error: unknown) {
  return toAuthFailure(error);
}

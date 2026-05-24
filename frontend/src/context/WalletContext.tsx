import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, ethers } from 'ethers';
import {
  applyVerifiedAuthSession,
  AuthFailure,
  extractAuthFailure,
  logoutAuthSession,
  requestAuthNonce,
  restoreAuthSession,
  subscribeToAuthEvents,
  verifyWalletSignature
} from '../lib/api';
import { formatDetectedChain, formatSupportedNetworkMessage, isSupportedCeloChain, normalizeChainId } from '../lib/celo';
import { env } from '../lib/env';
import {
  getInjectedWalletSelection,
  requestWalletProvider,
  requestWalletSignature,
  type WalletProviderKind,
  type WalletProviderShape
} from '../lib/walletProvider';

type WalletStatus = 'disconnected' | 'connected' | 'unsupported';
type AuthStatus = 'idle' | 'restoring' | 'unauthenticated' | 'authenticating' | 'authenticated' | 'expired' | 'error';
type RestoreOutcome =
  | { restored: true }
  | { restored: false; failure: AuthFailure };

interface WalletContextValue {
  address: string | null;
  balance: string;
  network: string | null;
  chainId: number | null;
  isCorrectNetwork: boolean;
  isMiniPay: boolean;
  status: WalletStatus;
  authStatus: AuthStatus;
  authMessage: string | null;
  isAuthReady: boolean;
  signer: ethers.JsonRpcSigner | null;
  provider: BrowserProvider | null;
  walletProvider: WalletProviderShape | null;
  walletKind: WalletProviderKind | null;
  connectWallet: () => Promise<void>;
  authenticateWallet: () => Promise<boolean>;
  disconnectWallet: () => Promise<void>;
  switchCeloNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

const targetChainId = env.CELO_CHAIN_ID;
const targetChainHex = env.CELO_CHAIN_HEX;

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function withRpcRetry<T>(label: string, operation: () => Promise<T>, attempts = 3) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(attempt * 200);
      }
    }
  }

  throw lastError;
}

function getChainDiagnostics(rawChainId: unknown, fallbackChainId?: unknown, fallbackName?: string | null) {
  const normalizedChainId = normalizeChainId(rawChainId) ?? normalizeChainId(fallbackChainId);
  return {
    rawChainId,
    normalizedChainId,
    expectedChainId: targetChainId,
    detectedNetwork: formatDetectedChain(normalizedChainId, fallbackName)
  };
}

function isAddChainRequired(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? Number((error as { code?: unknown }).code) : NaN;
  const message = 'message' in error ? String((error as { message?: unknown }).message).toLowerCase() : '';
  return code === 4902 || message.includes('unrecognized chain') || message.includes('unknown chain');
}

function normalizeAddress(address: string | null | undefined) {
  return address?.trim().toLowerCase() || null;
}

function formatBalance(value: bigint | number | string) {
  try {
    const amount = ethers.formatEther(value as bigint);
    return Number(amount).toFixed(4);
  } catch {
    return '0.0000';
  }
}

function isSignatureRejection(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeCode = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const maybeMessage = 'message' in error ? String((error as { message?: unknown }).message).toLowerCase() : '';

  return maybeCode === '4001' || maybeCode === 'ACTION_REJECTED' || maybeMessage.includes('user rejected');
}

function sessionExpiredMessage(code: string) {
  if (code === 'AUTH_WALLET_MISMATCH') {
    return 'Connected wallet changed. Sign in again to continue.';
  }

  return 'Your session expired. Sign in again to continue.';
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [balance, setBalance] = useState('0.0000');
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [walletProvider, setWalletProvider] = useState<WalletProviderShape | null>(null);
  const [walletKind, setWalletKind] = useState<WalletProviderKind | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [authStatus, setAuthStatus] = useState<AuthStatus>('idle');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [walletReady, setWalletReady] = useState(false);
  const [isMiniPay, setIsMiniPay] = useState(false);

  const restorePromiseRef = useRef<Promise<RestoreOutcome> | null>(null);
  const authenticatePromiseRef = useRef<Promise<boolean> | null>(null);
  const activeAddressRef = useRef<string | null>(null);
  const activeWalletProviderRef = useRef<WalletProviderShape | null>(null);
  const autoConnectAttemptedRef = useRef(false);
  const authStateRef = useRef<{ status: AuthStatus; message: string | null }>({
    status: 'idle',
    message: null
  });
  const walletSelection = typeof window !== 'undefined' ? getInjectedWalletSelection('auto') : null;
  const hasProvider = Boolean(walletSelection?.provider);

  function clearWalletState(nextStatus: WalletStatus = 'disconnected', reason = 'unspecified') {
    console.debug('[WalletContext] Wallet state transition', {
      fromStatus: status,
      toStatus: nextStatus,
      reason
    });

    setAddress(null);
    setSigner(null);
    setProvider(null);
    setWalletProvider(null);
    setWalletKind(null);
    setChainId(null);
    setNetwork(null);
    setBalance('0.0000');
    setStatus(nextStatus);
    if (nextStatus !== 'connected') {
      setIsMiniPay(false);
    }
    activeWalletProviderRef.current = null;
  }

  function clearAuthState(nextStatus: AuthStatus = 'unauthenticated', message: string | null = null, reason = 'unspecified') {
    console.debug('[AUTH] Auth state transition', {
      fromStatus: authStateRef.current.status,
      toStatus: nextStatus,
      fromMessage: authStateRef.current.message,
      toMessage: message,
      reason
    });

    authStateRef.current = {
      status: nextStatus,
      message
    };
    setAuthStatus(nextStatus);
    setAuthMessage(message);
  }

  function resolveWalletSelection(preferredKind: WalletProviderKind | 'auto' = 'auto') {
    const selection = getInjectedWalletSelection(preferredKind);

    if (selection) {
      console.debug('[WalletContext] Selected injected provider', {
        preferredKind,
        selectedKind: selection.kind,
        candidateKinds: selection.candidates.map((candidate) => `${candidate.kind}:${candidate.source}`),
        isMiniPayUserAgent:
          typeof navigator !== 'undefined' &&
          /minipay|opera mini/i.test(navigator.userAgent)
      });
    } else {
      console.warn('[WalletContext] No injected wallet providers detected', {
        preferredKind
      });
    }

    return selection;
  }

  async function restoreSessionForWallet(nextAddress: string): Promise<RestoreOutcome> {
    if (restorePromiseRef.current) {
      return restorePromiseRef.current;
    }

    setAuthStatus('restoring');
    setAuthMessage(null);

    console.debug('[AUTH] Restoring session for wallet', {
      address: `${nextAddress.slice(0, 6)}...${nextAddress.slice(-4)}`
    });

    const restoreTask = (async () => {
      try {
        console.debug('[AUTH] Calling restoreAuthSession');

        const payload = await restoreAuthSession({ notifyFailure: false });

        console.debug('[AUTH] Session restored successfully', {
          sessionId: payload.session.id,
          wallet: `${payload.session.wallet.slice(0, 6)}...${payload.session.wallet.slice(-4)}`,
          userId: payload.user.id
        });

        const payloadWalletNorm = normalizeAddress(payload.session.wallet);
        const nextAddressNorm = normalizeAddress(nextAddress);

        console.debug('[AUTH] Comparing addresses', {
          payloadWallet: payloadWalletNorm,
          nextAddress: nextAddressNorm,
          match: payloadWalletNorm === nextAddressNorm
        });

        if (payloadWalletNorm !== nextAddressNorm) {
          console.warn('[AUTH] Session wallet mismatch', {
            sessionWallet: payloadWalletNorm,
            connectedWallet: nextAddressNorm
          });

          await logoutAuthSession().catch(() => undefined);
          const failure: AuthFailure = {
            status: 409,
            code: 'AUTH_WALLET_MISMATCH',
            message: sessionExpiredMessage('AUTH_WALLET_MISMATCH'),
            action: 'sign'
          };
          clearAuthState('expired', failure.message, 'restore-wallet-mismatch');
          return { restored: false as const, failure };
        }

        clearAuthState('authenticated', null, 'restore-success');
        return { restored: true as const };
      } catch (error) {
        console.error('[AUTH] Session restore failed', {
          errorName: error instanceof Error ? error.name : 'Unknown',
          errorMessage: error instanceof Error ? error.message : String(error)
        });

        const failure = extractAuthFailure(error);
        console.debug('[AUTH] Failure extracted from restore error', {
          code: failure.code,
          status: failure.status,
          message: failure.message
        });

        if (failure.code === 'AUTH_REFRESH_TOKEN_MISSING') {
          console.debug('[AUTH] No refresh token available, setting unauthenticated');
          clearAuthState('unauthenticated', null, 'restore-missing-refresh-token');
        } else if (
          failure.code === 'AUTH_SESSION_EXPIRED' ||
          failure.code === 'AUTH_SESSION_REVOKED' ||
          failure.code === 'AUTH_REFRESH_TOKEN_INVALID'
        ) {
          console.debug('[AUTH] Session expired/revoked, setting expired state');
          clearAuthState('expired', sessionExpiredMessage(failure.code), 'restore-expired-session');
        } else {
          console.debug('[AUTH] Other auth error, setting error state');
          clearAuthState('error', failure.message, 'restore-error');
        }
        return { restored: false as const, failure };
      } finally {
        restorePromiseRef.current = null;
      }
    })();

    restorePromiseRef.current = restoreTask;
    return restoreTask;
  }

  async function syncWalletState(
    browserProvider: BrowserProvider,
    reason: 'init' | 'connect' | 'change' | 'switch' = 'init',
    rawProviderOverride?: WalletProviderShape | null,
    walletKindOverride?: WalletProviderKind | null
  ) {
    try {
      const selection =
        rawProviderOverride && walletKindOverride
          ? {
              provider: rawProviderOverride,
              kind: walletKindOverride
            }
          : resolveWalletSelection(rawProviderOverride?.isMiniPay ? 'minipay' : 'auto');
      const activeWalletProvider = rawProviderOverride ?? selection?.provider ?? null;
      const activeWalletKind = walletKindOverride ?? selection?.kind ?? null;

      if (!activeWalletProvider || !activeWalletKind) {
        clearWalletState('unsupported', 'wallet-provider-missing-during-sync');
        clearAuthState('error', 'Unable to detect a compatible wallet provider.', 'wallet-provider-missing-during-sync');
        return;
      }

      const accounts = (await withRpcRetry('eth_accounts', () => browserProvider.send('eth_accounts', []))) as string[];

      if (!accounts.length) {
        if (activeAddressRef.current) {
          void logoutAuthSession().catch(() => undefined);
        }
        activeAddressRef.current = null;
        clearWalletState('disconnected', 'wallet-no-accounts');
        clearAuthState('unauthenticated', null, 'wallet-no-accounts');
        return;
      }

      const signerInstance = await withRpcRetry('getSigner', () => browserProvider.getSigner());
      const nextAddress = await signerInstance.getAddress();
      const rawChainId =
        activeWalletProvider.chainId ?? (await withRpcRetry('eth_chainId', () => browserProvider.send('eth_chainId', [])));
      const networkData = await withRpcRetry('getNetwork', () => browserProvider.getNetwork());
      const diagnostics = getChainDiagnostics(rawChainId, networkData.chainId, networkData.name);
      const nextBalance = await withRpcRetry('getBalance', () => browserProvider.getBalance(nextAddress));
      const previousAddress = activeAddressRef.current;
      const changedWallet = Boolean(previousAddress && normalizeAddress(previousAddress) !== normalizeAddress(nextAddress));

      console.info('[WalletContext] chain diagnostics', {
        reason,
        walletKind: activeWalletKind,
        isMiniPay: Boolean(activeWalletProvider.isMiniPay),
        rawChainId: diagnostics.rawChainId,
        normalizedChainId: diagnostics.normalizedChainId,
        expectedChainId: diagnostics.expectedChainId
      });

      activeWalletProviderRef.current = activeWalletProvider;
      activeAddressRef.current = nextAddress;
      setProvider(browserProvider);
      setWalletProvider(activeWalletProvider);
      setWalletKind(activeWalletKind);
      setSigner(signerInstance);
      setAddress(nextAddress);
      setChainId(diagnostics.normalizedChainId);
      setNetwork(diagnostics.detectedNetwork);
      setBalance(formatBalance(nextBalance));
      setStatus('connected');
      setIsMiniPay(Boolean(activeWalletProvider.isMiniPay));

      if (changedWallet) {
        await logoutAuthSession().catch(() => undefined);
        clearAuthState('expired', sessionExpiredMessage('AUTH_WALLET_MISMATCH'), 'wallet-changed');
        return;
      }

      const restoreOutcome = await restoreSessionForWallet(nextAddress);
      if (
        (reason === 'connect' || reason === 'switch') &&
        !restoreOutcome.restored &&
        restoreOutcome.failure.code === 'AUTH_REFRESH_TOKEN_MISSING' &&
        isSupportedCeloChain(diagnostics.normalizedChainId)
      ) {
        await authenticateWallet(signerInstance, nextAddress, diagnostics.normalizedChainId);
      }

      if (!isSupportedCeloChain(diagnostics.normalizedChainId)) {
        setAuthMessage(formatSupportedNetworkMessage(diagnostics.normalizedChainId, networkData.name));
      }
    } catch (error) {
      console.error(error);
      clearWalletState('unsupported', 'wallet-sync-error');
      clearAuthState('error', 'Unable to read wallet connection state.', 'wallet-sync-error');
    } finally {
      setWalletReady(true);
    }
  }

  async function authenticateWallet(
    signerOverride?: ethers.JsonRpcSigner | null,
    addressOverride?: string | null,
    chainIdOverride?: number | null
  ) {
    if (authenticatePromiseRef.current) {
      return authenticatePromiseRef.current;
    }

    const activeSigner = signerOverride ?? signer;
    const activeAddress = addressOverride ?? address;
    const activeChainId = chainIdOverride ?? chainId;
    const activeWalletProvider = activeWalletProviderRef.current ?? walletProvider;

    console.debug('[AUTH] authenticateWallet called', {
      hasSigner: !!activeSigner,
      hasWalletProvider: !!activeWalletProvider,
      hasAddress: !!activeAddress,
      hasChainId: !!activeChainId,
      address: activeAddress ? `${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}` : null,
      chainId: activeChainId
    });

    if ((!activeSigner && !activeWalletProvider) || !activeAddress || !activeChainId) {
      console.warn('[AUTH] authenticateWallet failed: missing credentials', {
        hasSigner: !!activeSigner,
        hasWalletProvider: !!activeWalletProvider,
        hasAddress: !!activeAddress,
        hasChainId: !!activeChainId
      });
      clearAuthState('unauthenticated', 'Connect your wallet before signing in.', 'authenticate-missing-credentials');
      return false;
    }

    if (!isSupportedCeloChain(activeChainId)) {
      console.warn('[AUTH] authenticateWallet failed: unsupported chain', {
        chainId: activeChainId
      });
      clearAuthState('unauthenticated', formatSupportedNetworkMessage(activeChainId, network), 'authenticate-unsupported-chain');
      return false;
    }

    clearAuthState('authenticating', null, 'authenticate-start');

    const authTask = (async () => {
      try {
        console.debug('[AUTH] Requesting nonce', {
          address: `${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}`,
          chainId: activeChainId
        });

        const nonceResponse = await requestAuthNonce(activeAddress, activeChainId);

        console.debug('[AUTH] Nonce received', {
          nonce: `${nonceResponse.data.nonce.slice(0, 8)}...`,
          messageLength: nonceResponse.data.message.length,
          expiresAt: nonceResponse.data.expiresAt
        });

        console.debug('[AUTH] Requesting wallet signature', {
          messageLength: nonceResponse.data.message.length,
          prefersProviderSignature: Boolean(activeWalletProvider?.isMiniPay)
        });

        let signature: string;
        try {
          if (activeWalletProvider?.isMiniPay) {
            signature = await requestWalletSignature(activeWalletProvider, activeAddress, nonceResponse.data.message);
          } else {
            if (!activeSigner) {
              throw new Error('Wallet signer is unavailable for signature request.');
            }
            signature = await activeSigner.signMessage(nonceResponse.data.message);
          }
        } catch (signError) {
          if (!activeWalletProvider) {
            throw signError;
          }

          console.warn('[AUTH] Signer signMessage failed, retrying through provider request', {
            walletKind,
            error: signError instanceof Error ? signError.message : String(signError)
          });
          signature = await requestWalletSignature(activeWalletProvider, activeAddress, nonceResponse.data.message);
        }

        console.debug('[AUTH] Signature received', {
          signatureLength: signature.length,
          signatureStart: signature.slice(0, 10)
        });

        console.debug('[AUTH] Verifying signature on backend', {
          address: `${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}`,
          nonce: `${nonceResponse.data.nonce.slice(0, 8)}...`,
          chainId: activeChainId
        });

        const verifyResponse = await verifyWalletSignature(
          activeAddress,
          nonceResponse.data.nonce,
          signature,
          activeChainId
        );

        console.debug('[AUTH] Verify response received', {
          hasAccessToken: !!verifyResponse.data.accessToken,
          sessionId: verifyResponse.data.session?.id,
          wallet: verifyResponse.data.session?.wallet
            ? `${verifyResponse.data.session.wallet.slice(0, 6)}...${verifyResponse.data.session.wallet.slice(-4)}`
            : 'MISSING',
          userId: verifyResponse.data.user?.id
        });

        if (normalizeAddress(verifyResponse.data.session.wallet) !== normalizeAddress(activeAddress)) {
          console.error('[AUTH] Verify response wallet mismatch', {
            responseWallet: `${verifyResponse.data.session.wallet.slice(0, 6)}...${verifyResponse.data.session.wallet.slice(-4)}`,
            expectedWallet: `${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}`
          });
          throw new Error('Authenticated session does not match the connected wallet');
        }

        console.info('[AUTH] Wallet authentication successful', {
          wallet: `${activeAddress.slice(0, 6)}...${activeAddress.slice(-4)}`,
          sessionId: verifyResponse.data.session.id
        });

        applyVerifiedAuthSession(verifyResponse.data);
        clearAuthState('authenticated');
        return true;
      } catch (error) {
        console.error('[AUTH] Wallet authentication failed', {
          errorName: error instanceof Error ? error.name : 'Unknown',
          errorMessage: error instanceof Error ? error.message : String(error),
          errorCode: 'code' in (error as Record<string, unknown>) ? (error as { code: unknown }).code : undefined
        });

        if (isSignatureRejection(error)) {
          console.info('[AUTH] User rejected signature request');
          clearAuthState('unauthenticated', 'Signature request was cancelled.', 'authenticate-signature-rejected');
          return false;
        }

        const failure = extractAuthFailure(error);
        console.debug('[AUTH] Auth failure extracted', {
          code: failure.code,
          status: failure.status,
          message: failure.message,
          action: failure.action
        });

        if (
          failure.code === 'AUTH_CHALLENGE_EXPIRED' ||
          failure.code === 'AUTH_CHALLENGE_CONSUMED' ||
          failure.code === 'AUTH_SIGNATURE_INVALID' ||
          failure.code === 'AUTH_CHAIN_MISMATCH'
        ) {
          clearAuthState('expired', failure.message, 'authenticate-expired');
        } else {
          clearAuthState('error', failure.message, 'authenticate-error');
        }
        return false;
      } finally {
        authenticatePromiseRef.current = null;
      }
    })();

    authenticatePromiseRef.current = authTask;
    return authTask;
  }

  useEffect(() => {
    return subscribeToAuthEvents({
      onSessionChanged: (session) => {
        const currentAddress = activeAddressRef.current;

        if (!currentAddress) {
          return;
        }

        if (!session) {
          setAuthStatus((current) => (current === 'restoring' || current === 'authenticating' ? current : 'unauthenticated'));
          return;
        }

        if (normalizeAddress(session.session.wallet) === normalizeAddress(currentAddress)) {
          clearAuthState('authenticated', null, 'auth-event-session-changed');
        }
      },
      onAuthFailure: (failure) => {
        if (!activeAddressRef.current) {
          return;
        }

        if (failure.code === 'AUTH_REFRESH_TOKEN_MISSING') {
          clearAuthState('unauthenticated', null, 'auth-event-missing-refresh-token');
          return;
        }

        if (
          failure.code === 'AUTH_SESSION_EXPIRED' ||
          failure.code === 'AUTH_SESSION_REVOKED' ||
          failure.code === 'AUTH_REFRESH_TOKEN_INVALID'
        ) {
          clearAuthState('expired', sessionExpiredMessage(failure.code), 'auth-event-expired-session');
          return;
        }

        clearAuthState('error', failure.message, 'auth-event-error');
      }
    });
  }, []);

  useEffect(() => {
    if (!hasProvider) {
      setWalletReady(true);
      setStatus('unsupported');
      clearAuthState('unauthenticated', 'Install a compatible wallet to continue.', 'wallet-provider-missing');
      return;
    }

    const selection = resolveWalletSelection('auto');
    const selectedProvider = selection?.provider;
    const selectedKind = selection?.kind;

    if (!selectedProvider || !selectedKind) {
      setWalletReady(true);
      setStatus('unsupported');
      clearAuthState('unauthenticated', 'Install a compatible wallet to continue.', 'wallet-provider-selection-missing');
      return;
    }

    const browserProvider = new BrowserProvider(selectedProvider);
    setProvider(browserProvider);

    const handleAccountsChanged = () => {
      void syncWalletState(browserProvider, 'change', selectedProvider, selectedKind);
    };
    const handleChainChanged = (nextChainId?: unknown) => {
      const diagnostics = getChainDiagnostics(nextChainId);
      console.info('[WalletContext] chainChanged event', {
        rawChainId: nextChainId,
        normalizedChainId: diagnostics.normalizedChainId,
        expectedChainId: diagnostics.expectedChainId
      });
      void syncWalletState(browserProvider, 'change', selectedProvider, selectedKind);
    };

    void syncWalletState(browserProvider, 'init', selectedProvider, selectedKind);

    selectedProvider.on?.('accountsChanged', handleAccountsChanged);
    selectedProvider.on?.('chainChanged', handleChainChanged);

    return () => {
      selectedProvider.removeListener?.('accountsChanged', handleAccountsChanged);
      selectedProvider.removeListener?.('chainChanged', handleChainChanged);
    };
  }, [hasProvider]);

  useEffect(() => {
    if (!hasProvider || autoConnectAttemptedRef.current || address || status === 'connected') {
      return;
    }

    const selection = resolveWalletSelection('auto');
    if (selection?.kind !== 'minipay') {
      return;
    }

    autoConnectAttemptedRef.current = true;
    console.info('[WalletContext] Auto-connecting MiniPay provider');
    void connectWallet();
  }, [address, hasProvider, status]);

  async function connectWallet() {
    if (!hasProvider) {
      clearAuthState('error', 'No compatible wallet provider was found.');
      return;
    }

    try {
      const selection = resolveWalletSelection('auto');
      if (!selection?.provider) {
        clearAuthState('error', 'No compatible wallet provider was found.');
        return;
      }

      const browserProvider = new BrowserProvider(selection.provider);
      await requestWalletProvider(selection.provider, 'eth_requestAccounts', []);
      await syncWalletState(browserProvider, 'connect', selection.provider, selection.kind);
      const rawChainId = selection.provider.chainId ?? (await browserProvider.send('eth_chainId', []));
      const normalizedChainId = normalizeChainId(rawChainId);

      if (!isSupportedCeloChain(normalizedChainId)) {
        await switchCeloNetwork(browserProvider, selection.provider);
      }
    } catch (error) {
      console.error(error);
      if (isSignatureRejection(error)) {
        clearAuthState('unauthenticated', 'Wallet connection was cancelled.');
      } else {
        clearAuthState('error', 'Wallet connection failed.', 'wallet-connect-error');
      }
    }
  }

  async function disconnectWallet() {
    await logoutAuthSession().catch(() => undefined);
    activeAddressRef.current = null;
    autoConnectAttemptedRef.current = false;
    clearWalletState('disconnected', 'wallet-disconnect');
    clearAuthState('unauthenticated', null, 'wallet-disconnect');
    setWalletReady(true);
    setIsMiniPay(false);
  }

  async function switchCeloNetwork(browserProviderOverride?: BrowserProvider | null, ethereumOverride?: WalletProviderShape | null) {
    if (!hasProvider) return;
    try {
      const selection = resolveWalletSelection(ethereumOverride?.isMiniPay ? 'minipay' : 'auto');
      const ethereum = ethereumOverride ?? selection?.provider ?? null;
      const browserProvider =
        browserProviderOverride ?? (ethereum ? new BrowserProvider(ethereum as WalletProviderShape) : null);

      if (!ethereum) {
        throw new Error('No wallet provider available for network switching.');
      }

      await ethereum?.request?.({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChainHex }]
      });
      if (browserProvider) {
        await syncWalletState(browserProvider, 'switch', ethereum, selection?.kind ?? null);
      }
    } catch (error) {
      if (isAddChainRequired(error)) {
        try {
          const selection = resolveWalletSelection(ethereumOverride?.isMiniPay ? 'minipay' : 'auto');
          const ethereum = ethereumOverride ?? selection?.provider ?? null;
          const browserProvider =
            browserProviderOverride ?? (ethereum ? new BrowserProvider(ethereum as WalletProviderShape) : null);

          if (!ethereum) {
            throw new Error('No wallet provider available for add-chain request.', { cause: error });
          }

          await ethereum?.request?.({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: targetChainHex,
                chainName: env.CELO_CHAIN_NAME,
                nativeCurrency: {
                  name: 'Celo',
                  symbol: 'CELO',
                  decimals: 18
                },
                rpcUrls: [env.CELO_RPC_URL],
                blockExplorerUrls: [env.CELO_EXPLORER_BASE_URL]
              }
            ]
          });

          if (browserProvider) {
            await syncWalletState(browserProvider, 'switch', ethereum, selection?.kind ?? null);
          }
          return;
        } catch (addError) {
          console.error('Add network failed', addError);
        }
      }

      console.error('Switch network failed', error);
      setAuthMessage(`Switch to ${env.CELO_CHAIN_NAME} (${targetChainId}) to continue.`);
    }
  }

  const isCorrectNetwork = isSupportedCeloChain(chainId);

  const value = useMemo(
    () => ({
      address,
      balance,
      chainId,
      network,
      isCorrectNetwork,
      isMiniPay,
      status,
      authStatus,
      authMessage,
      isAuthReady: walletReady && authStatus !== 'restoring',
      signer,
      provider,
      walletProvider,
      walletKind,
      connectWallet,
      authenticateWallet: () => authenticateWallet(),
      disconnectWallet,
      switchCeloNetwork
    }),
    [
      address,
      balance,
      chainId,
      network,
      isCorrectNetwork,
      isMiniPay,
      status,
      authStatus,
      authMessage,
      walletReady,
      signer,
      provider,
      walletProvider,
      walletKind
    ]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within WalletProvider');
  }
  return context;
}

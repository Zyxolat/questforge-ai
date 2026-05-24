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
  connectWallet: () => Promise<void>;
  authenticateWallet: () => Promise<boolean>;
  disconnectWallet: () => Promise<void>;
  switchCeloNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

const targetChainId = env.CELO_CHAIN_ID;
const targetChainHex = env.CELO_CHAIN_HEX;

type WalletProviderShape = ethers.Eip1193Provider & {
  chainId?: string | number;
  isMiniPay?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

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
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [authStatus, setAuthStatus] = useState<AuthStatus>('idle');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [walletReady, setWalletReady] = useState(false);
  const [isMiniPay, setIsMiniPay] = useState(false);

  const restorePromiseRef = useRef<Promise<RestoreOutcome> | null>(null);
  const authenticatePromiseRef = useRef<Promise<boolean> | null>(null);
  const activeAddressRef = useRef<string | null>(null);
  const hasProvider = typeof window !== 'undefined' && Boolean((window as Window & { ethereum?: unknown }).ethereum);

  function clearWalletState(nextStatus: WalletStatus = 'disconnected') {
    setAddress(null);
    setSigner(null);
    setProvider(null);
    setChainId(null);
    setNetwork(null);
    setBalance('0.0000');
    setStatus(nextStatus);
  }

  function clearAuthState(nextStatus: AuthStatus = 'unauthenticated', message: string | null = null) {
    setAuthStatus(nextStatus);
    setAuthMessage(message);
  }

  async function restoreSessionForWallet(nextAddress: string): Promise<RestoreOutcome> {
    if (restorePromiseRef.current) {
      return restorePromiseRef.current;
    }

    setAuthStatus('restoring');
    setAuthMessage(null);

    const restoreTask = (async () => {
      try {
        const payload = await restoreAuthSession({ notifyFailure: false });

        if (normalizeAddress(payload.session.wallet) !== normalizeAddress(nextAddress)) {
          await logoutAuthSession().catch(() => undefined);
          const failure: AuthFailure = {
            status: 409,
            code: 'AUTH_WALLET_MISMATCH',
            message: sessionExpiredMessage('AUTH_WALLET_MISMATCH'),
            action: 'sign'
          };
          clearAuthState('expired', failure.message);
          return { restored: false as const, failure };
        }

        clearAuthState('authenticated');
        return { restored: true as const };
      } catch (error) {
        const failure = extractAuthFailure(error);
        if (failure.code === 'AUTH_REFRESH_TOKEN_MISSING') {
          clearAuthState('unauthenticated');
        } else if (
          failure.code === 'AUTH_SESSION_EXPIRED' ||
          failure.code === 'AUTH_SESSION_REVOKED' ||
          failure.code === 'AUTH_REFRESH_TOKEN_INVALID'
        ) {
          clearAuthState('expired', sessionExpiredMessage(failure.code));
        } else {
          clearAuthState('error', failure.message);
        }
        return { restored: false as const, failure };
      } finally {
        restorePromiseRef.current = null;
      }
    })();

    restorePromiseRef.current = restoreTask;
    return restoreTask;
  }

  async function syncWalletState(browserProvider: BrowserProvider, reason: 'init' | 'connect' | 'change' | 'switch' = 'init') {
    try {
      const ethereum = (window as Window & { ethereum?: WalletProviderShape }).ethereum;
      const accounts = (await withRpcRetry('eth_accounts', () => browserProvider.send('eth_accounts', []))) as string[];

      if (!accounts.length) {
        if (activeAddressRef.current) {
          void logoutAuthSession().catch(() => undefined);
        }
        activeAddressRef.current = null;
        clearWalletState('disconnected');
        clearAuthState('unauthenticated');
        return;
      }

      const signerInstance = await withRpcRetry('getSigner', () => browserProvider.getSigner());
      const nextAddress = await signerInstance.getAddress();
      const rawChainId = ethereum?.chainId ?? (await withRpcRetry('eth_chainId', () => browserProvider.send('eth_chainId', [])));
      const networkData = await withRpcRetry('getNetwork', () => browserProvider.getNetwork());
      const diagnostics = getChainDiagnostics(rawChainId, networkData.chainId, networkData.name);
      const nextBalance = await withRpcRetry('getBalance', () => browserProvider.getBalance(nextAddress));
      const previousAddress = activeAddressRef.current;
      const changedWallet = Boolean(previousAddress && normalizeAddress(previousAddress) !== normalizeAddress(nextAddress));

      console.info('[WalletContext] chain diagnostics', {
        reason,
        rawChainId: diagnostics.rawChainId,
        normalizedChainId: diagnostics.normalizedChainId,
        expectedChainId: diagnostics.expectedChainId
      });

      activeAddressRef.current = nextAddress;
      setProvider(browserProvider);
      setSigner(signerInstance);
      setAddress(nextAddress);
      setChainId(diagnostics.normalizedChainId);
      setNetwork(diagnostics.detectedNetwork);
      setBalance(formatBalance(nextBalance));
      setStatus('connected');
      setIsMiniPay(Boolean(ethereum?.isMiniPay));

      if (changedWallet) {
        await logoutAuthSession().catch(() => undefined);
        clearAuthState('expired', sessionExpiredMessage('AUTH_WALLET_MISMATCH'));
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
      clearWalletState('unsupported');
      clearAuthState('error', 'Unable to read wallet connection state.');
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

    if (!activeSigner || !activeAddress || !activeChainId) {
      clearAuthState('unauthenticated', 'Connect your wallet before signing in.');
      return false;
    }

    if (!isSupportedCeloChain(activeChainId)) {
      clearAuthState('unauthenticated', formatSupportedNetworkMessage(activeChainId, network));
      return false;
    }

    setAuthStatus('authenticating');
    setAuthMessage(null);

    const authTask = (async () => {
      try {
        const nonceResponse = await requestAuthNonce(activeAddress, activeChainId);
        const signature = await activeSigner.signMessage(nonceResponse.data.message);
        const verifyResponse = await verifyWalletSignature(activeAddress, nonceResponse.data.nonce, signature, activeChainId);

        if (normalizeAddress(verifyResponse.data.session.wallet) !== normalizeAddress(activeAddress)) {
          throw new Error('Authenticated session does not match the connected wallet');
        }

        applyVerifiedAuthSession(verifyResponse.data);
        clearAuthState('authenticated');
        return true;
      } catch (error) {
        if (isSignatureRejection(error)) {
          clearAuthState('unauthenticated', 'Signature request was cancelled.');
          return false;
        }

        const failure = extractAuthFailure(error);
        if (
          failure.code === 'AUTH_CHALLENGE_EXPIRED' ||
          failure.code === 'AUTH_CHALLENGE_CONSUMED' ||
          failure.code === 'AUTH_SIGNATURE_INVALID' ||
          failure.code === 'AUTH_CHAIN_MISMATCH'
        ) {
          clearAuthState('expired', failure.message);
        } else {
          clearAuthState('error', failure.message);
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
          clearAuthState('authenticated');
        }
      },
      onAuthFailure: (failure) => {
        if (!activeAddressRef.current) {
          return;
        }

        if (failure.code === 'AUTH_REFRESH_TOKEN_MISSING') {
          clearAuthState('unauthenticated');
          return;
        }

        if (
          failure.code === 'AUTH_SESSION_EXPIRED' ||
          failure.code === 'AUTH_SESSION_REVOKED' ||
          failure.code === 'AUTH_REFRESH_TOKEN_INVALID'
        ) {
          clearAuthState('expired', sessionExpiredMessage(failure.code));
          return;
        }

        clearAuthState('error', failure.message);
      }
    });
  }, []);

  useEffect(() => {
    if (!hasProvider) {
      setWalletReady(true);
      setStatus('unsupported');
      clearAuthState('unauthenticated', 'Install a compatible wallet to continue.');
      return;
    }

    const ethereum = (window as Window & { ethereum?: unknown }).ethereum;
    if (!ethereum) {
      return;
    }

    const browserProvider = new BrowserProvider(ethereum as WalletProviderShape);
    setProvider(browserProvider);

    const handleAccountsChanged = () => {
      void syncWalletState(browserProvider, 'change');
    };
    const handleChainChanged = (nextChainId?: unknown) => {
      const diagnostics = getChainDiagnostics(nextChainId);
      console.info('[WalletContext] chainChanged event', {
        rawChainId: nextChainId,
        normalizedChainId: diagnostics.normalizedChainId,
        expectedChainId: diagnostics.expectedChainId
      });
      void syncWalletState(browserProvider, 'change');
    };

    void syncWalletState(browserProvider, 'init');

    (ethereum as WalletProviderShape).on?.('accountsChanged', handleAccountsChanged);
    (ethereum as WalletProviderShape).on?.('chainChanged', handleChainChanged);

    return () => {
      (ethereum as WalletProviderShape).removeListener?.('accountsChanged', handleAccountsChanged);
      (ethereum as WalletProviderShape).removeListener?.('chainChanged', handleChainChanged);
    };
  }, [hasProvider]);

  async function connectWallet() {
    if (!hasProvider) {
      clearAuthState('error', 'No compatible wallet provider was found.');
      return;
    }

    try {
      const ethereum = (window as Window & { ethereum?: WalletProviderShape }).ethereum;
      if (!ethereum) {
        clearAuthState('error', 'No compatible wallet provider was found.');
        return;
      }

      const browserProvider = new BrowserProvider(ethereum);
      await browserProvider.send('eth_requestAccounts', []);
      await syncWalletState(browserProvider, 'connect');
      const rawChainId = ethereum.chainId ?? (await browserProvider.send('eth_chainId', []));
      const normalizedChainId = normalizeChainId(rawChainId);

      if (!isSupportedCeloChain(normalizedChainId)) {
        await switchCeloNetwork(browserProvider, ethereum);
      }
    } catch (error) {
      console.error(error);
      if (isSignatureRejection(error)) {
        clearAuthState('unauthenticated', 'Wallet connection was cancelled.');
      } else {
        clearAuthState('error', 'Wallet connection failed.');
      }
    }
  }

  async function disconnectWallet() {
    await logoutAuthSession().catch(() => undefined);
    activeAddressRef.current = null;
    clearWalletState('disconnected');
    clearAuthState('unauthenticated');
    setWalletReady(true);
    setIsMiniPay(false);
  }

  async function switchCeloNetwork(browserProviderOverride?: BrowserProvider | null, ethereumOverride?: WalletProviderShape | null) {
    if (!hasProvider) return;
    try {
      const ethereum = ethereumOverride ?? (window as Window & { ethereum?: WalletProviderShape }).ethereum;
      const browserProvider =
        browserProviderOverride ?? (ethereum ? new BrowserProvider(ethereum as WalletProviderShape) : null);

      await ethereum?.request?.({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChainHex }]
      });
      if (browserProvider) {
        await syncWalletState(browserProvider, 'switch');
      }
    } catch (error) {
      if (isAddChainRequired(error)) {
        try {
          const ethereum = ethereumOverride ?? (window as Window & { ethereum?: WalletProviderShape }).ethereum;
          const browserProvider =
            browserProviderOverride ?? (ethereum ? new BrowserProvider(ethereum as WalletProviderShape) : null);

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
            await syncWalletState(browserProvider, 'switch');
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
      connectWallet,
      authenticateWallet: () => authenticateWallet(),
      disconnectWallet,
      switchCeloNetwork
    }),
    [address, balance, chainId, network, isCorrectNetwork, isMiniPay, status, authStatus, authMessage, walletReady, signer, provider]
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

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
  status: WalletStatus;
  authStatus: AuthStatus;
  authMessage: string | null;
  isAuthReady: boolean;
  signer: ethers.JsonRpcSigner | null;
  provider: BrowserProvider | null;
  connectWallet: () => Promise<void>;
  authenticateWallet: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  switchCeloNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

const targetChainId = env.CELO_CHAIN_ID;
const targetChainHex = `0x${targetChainId.toString(16)}`;

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

  const restorePromiseRef = useRef<Promise<RestoreOutcome> | null>(null);
  const authenticatePromiseRef = useRef<Promise<void> | null>(null);
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

  async function syncWalletState(browserProvider: BrowserProvider, reason: 'init' | 'connect' | 'change' = 'init') {
    try {
      const accounts = (await browserProvider.send('eth_accounts', [])) as string[];

      if (!accounts.length) {
        if (activeAddressRef.current) {
          void logoutAuthSession().catch(() => undefined);
        }
        activeAddressRef.current = null;
        clearWalletState('disconnected');
        clearAuthState('unauthenticated');
        return;
      }

      const signerInstance = await browserProvider.getSigner();
      const nextAddress = await signerInstance.getAddress();
      const networkData = await browserProvider.getNetwork();
      const nextChainId = Number(networkData.chainId);
      const nextBalance = await browserProvider.getBalance(nextAddress);
      const previousAddress = activeAddressRef.current;
      const changedWallet = Boolean(previousAddress && normalizeAddress(previousAddress) !== normalizeAddress(nextAddress));

      activeAddressRef.current = nextAddress;
      setProvider(browserProvider);
      setSigner(signerInstance);
      setAddress(nextAddress);
      setChainId(nextChainId);
      setNetwork(networkData.name);
      setBalance(formatBalance(nextBalance));
      setStatus('connected');

      if (changedWallet) {
        await logoutAuthSession().catch(() => undefined);
        clearAuthState('expired', sessionExpiredMessage('AUTH_WALLET_MISMATCH'));
        return;
      }

      const restoreOutcome = await restoreSessionForWallet(nextAddress);
      if (reason === 'connect' && !restoreOutcome.restored && restoreOutcome.failure.code === 'AUTH_REFRESH_TOKEN_MISSING') {
        await authenticateWallet(signerInstance, nextAddress, nextChainId);
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
      return;
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
      } catch (error) {
        if (isSignatureRejection(error)) {
          clearAuthState('unauthenticated', 'Signature request was cancelled.');
          return;
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
        throw error;
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

    const browserProvider = new BrowserProvider(ethereum as ethers.Eip1193Provider);
    setProvider(browserProvider);

    const handleWalletUpdate = () => {
      void syncWalletState(browserProvider, 'change');
    };

    void syncWalletState(browserProvider, 'init');

    (ethereum as { on: (event: string, listener: () => void) => void }).on('accountsChanged', handleWalletUpdate);
    (ethereum as { on: (event: string, listener: () => void) => void }).on('chainChanged', handleWalletUpdate);

    return () => {
      (ethereum as { removeListener: (event: string, listener: () => void) => void }).removeListener('accountsChanged', handleWalletUpdate);
      (ethereum as { removeListener: (event: string, listener: () => void) => void }).removeListener('chainChanged', handleWalletUpdate);
    };
  }, [hasProvider]);

  async function connectWallet() {
    if (!hasProvider) {
      clearAuthState('error', 'No compatible wallet provider was found.');
      return;
    }

    try {
      const ethereum = (window as Window & { ethereum?: ethers.Eip1193Provider }).ethereum;
      if (!ethereum) {
        clearAuthState('error', 'No compatible wallet provider was found.');
        return;
      }

      const browserProvider = new BrowserProvider(ethereum);
      await browserProvider.send('eth_requestAccounts', []);
      await syncWalletState(browserProvider, 'connect');
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
  }

  async function switchCeloNetwork() {
    if (!hasProvider) return;
    try {
      const ethereum = (window as Window & { ethereum?: ethers.Eip1193Provider }).ethereum;
      await ethereum?.request?.({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChainHex }]
      });
    } catch (error) {
      console.error('Switch network failed', error);
      setAuthMessage(`Switch to chain ${targetChainId} to continue on Celo.`);
    }
  }

  const value = useMemo(
    () => ({
      address,
      balance,
      chainId,
      network,
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
    [address, balance, chainId, network, status, authStatus, authMessage, walletReady, signer, provider]
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

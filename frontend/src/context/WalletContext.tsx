import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { BrowserProvider, ethers } from 'ethers';

interface WalletContextValue {
  address: string | null;
  balance: string;
  network: string | null;
  chainId: number | null;
  status: 'disconnected' | 'connected' | 'unsupported';
  signer: ethers.JsonRpcSigner | null;
  provider: BrowserProvider | null;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  switchCeloNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

const targetChainId = Number(import.meta.env.VITE_CELO_CHAIN_ID || '44787');
const targetChainHex = `0x${targetChainId.toString(16)}`;

function formatBalance(value: bigint | number | string) {
  try {
    const amount = ethers.formatEther(value as bigint);
    return Number(amount).toFixed(4);
  } catch {
    return '0.0000';
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [balance, setBalance] = useState('0.0000');
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [status, setStatus] = useState<'disconnected' | 'connected' | 'unsupported'>('disconnected');

  const hasProvider = typeof window !== 'undefined' && (window as any).ethereum;

  useEffect(() => {
    if (!hasProvider) return;
    const ethereum = (window as any).ethereum;
    const browserProvider = new BrowserProvider(ethereum);
    setProvider(browserProvider);

    async function updateWallet() {
      try {
        const accounts = await browserProvider.send('eth_accounts', []);
        if (accounts.length) {
          const signerInstance = await browserProvider.getSigner();
          const address = await signerInstance.getAddress();
          const network = await browserProvider.getNetwork();
          setAddress(address);
          setSigner(signerInstance);
          setChainId(Number(network.chainId));
          setNetwork(network.name);
          setStatus('connected');
          const balance = await browserProvider.getBalance(address);
          setBalance(formatBalance(balance));
        }
      } catch {
        setStatus('unsupported');
      }
    }
    updateWallet();

    ethereum.on('accountsChanged', updateWallet);
    ethereum.on('chainChanged', () => updateWallet());
    return () => {
      ethereum.removeListener('accountsChanged', updateWallet);
      ethereum.removeListener('chainChanged', updateWallet);
    };
  }, [hasProvider]);

  async function connectWallet() {
    if (!hasProvider) return;
    try {
      const ethereum = (window as any).ethereum;
      const browserProvider = new BrowserProvider(ethereum);
      await browserProvider.send('eth_requestAccounts', []);
      const signerInstance = await browserProvider.getSigner();
      const address = await signerInstance.getAddress();
      const network = await browserProvider.getNetwork();
      const balance = await browserProvider.getBalance(address);
      setProvider(browserProvider);
      setSigner(signerInstance);
      setAddress(address);
      setChainId(Number(network.chainId));
      setNetwork(network.name);
      setBalance(formatBalance(balance));
      setStatus('connected');
    } catch (error) {
      console.error(error);
      setStatus('disconnected');
    }
  }

  function disconnectWallet() {
    setAddress(null);
    setSigner(null);
    setProvider(null);
    setChainId(null);
    setNetwork(null);
    setBalance('0.0000');
    setStatus('disconnected');
  }

  async function switchCeloNetwork() {
    if (!hasProvider) return;
    try {
      const ethereum = (window as any).ethereum;
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChainHex }]
      });
    } catch (error) {
      console.error('Switch network failed', error);
    }
  }

  const value = useMemo(
    () => ({ address, balance, chainId, network, status, signer, provider, connectWallet, disconnectWallet, switchCeloNetwork }),
    [address, balance, chainId, network, status, signer, provider]
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

import { BrowserProvider, ethers } from 'ethers';

export type WalletProviderShape = ethers.Eip1193Provider & {
  chainId?: string | number;
  isMetaMask?: boolean;
  isMiniPay?: boolean;
  providers?: WalletProviderShape[];
  request?: (request: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type WalletProviderKind = 'minipay' | 'metamask' | 'injected';

export type WalletProviderSelection = {
  provider: WalletProviderShape;
  kind: WalletProviderKind;
  candidates: Array<{
    kind: WalletProviderKind;
    provider: WalletProviderShape;
    source: string;
  }>;
};

function getWindowObject() {
  return typeof window === 'undefined'
    ? null
    : (window as Window & {
        ethereum?: WalletProviderShape;
        provider?: WalletProviderShape;
      });
}

function inferProviderKind(provider: WalletProviderShape): WalletProviderKind {
  if (provider.isMiniPay) {
    return 'minipay';
  }

  if (provider.isMetaMask) {
    return 'metamask';
  }

  return 'injected';
}

function addProviderCandidate(
  candidates: Array<{ provider: WalletProviderShape; kind: WalletProviderKind; source: string }>,
  seen: Set<WalletProviderShape>,
  provider: WalletProviderShape | null | undefined,
  source: string
) {
  if (!provider || seen.has(provider)) {
    return;
  }

  seen.add(provider);
  candidates.push({
    provider,
    kind: inferProviderKind(provider),
    source
  });
}

export function discoverInjectedWalletProviders() {
  const browserWindow = getWindowObject();
  if (!browserWindow) {
    return [];
  }

  const seen = new Set<WalletProviderShape>();
  const candidates: Array<{ provider: WalletProviderShape; kind: WalletProviderKind; source: string }> = [];
  const rootEthereum = browserWindow.ethereum;
  const rootProvider = browserWindow.provider;

  addProviderCandidate(candidates, seen, rootEthereum, 'window.ethereum');
  addProviderCandidate(candidates, seen, rootProvider, 'window.provider');

  rootEthereum?.providers?.forEach((provider, index) => {
    addProviderCandidate(candidates, seen, provider, `window.ethereum.providers[${index}]`);
  });

  rootProvider?.providers?.forEach((provider, index) => {
    addProviderCandidate(candidates, seen, provider, `window.provider.providers[${index}]`);
  });

  return candidates;
}

function prefersMiniPaySelection() {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent.toLowerCase();
  return userAgent.includes('minipay') || userAgent.includes('opera mini');
}

export function getInjectedWalletSelection(preferredKind: WalletProviderKind | 'auto' = 'auto'): WalletProviderSelection | null {
  const candidates = discoverInjectedWalletProviders();
  if (!candidates.length) {
    return null;
  }

  const wantMiniPay = preferredKind === 'minipay' || (preferredKind === 'auto' && prefersMiniPaySelection());
  const wantMetaMask = preferredKind === 'metamask';

  const selected =
    (wantMiniPay ? candidates.find((candidate) => candidate.kind === 'minipay') : null) ??
    (wantMetaMask ? candidates.find((candidate) => candidate.kind === 'metamask') : null) ??
    candidates.find((candidate) => candidate.kind === 'metamask') ??
    candidates.find((candidate) => candidate.kind === 'minipay') ??
    candidates[0];

  return {
    provider: selected.provider,
    kind: selected.kind,
    candidates
  };
}

function ensureRequestMethod(provider: WalletProviderShape) {
  if (!provider.request) {
    throw new Error('Wallet provider does not expose request(method, params).');
  }

  return provider.request.bind(provider);
}

export async function requestWalletProvider<T = unknown>(
  provider: WalletProviderShape,
  method: string,
  params?: unknown[] | Record<string, unknown>
) {
  const request = ensureRequestMethod(provider);
  return (await request({
    method,
    ...(typeof params === 'undefined' ? {} : { params })
  })) as T;
}

export async function requestWalletSignature(provider: WalletProviderShape, address: string, message: string) {
  try {
    return await requestWalletProvider<string>(provider, 'personal_sign', [message, address]);
  } catch (personalSignError) {
    const hexMessage = ethers.hexlify(ethers.toUtf8Bytes(message));
    try {
      return await requestWalletProvider<string>(provider, 'personal_sign', [hexMessage, address]);
    } catch {
      throw personalSignError;
    }
  }
}

function toRpcHex(value: bigint | number) {
  return ethers.toBeHex(typeof value === 'number' ? BigInt(Math.trunc(value)) : value);
}

type ContractTransactionInput = {
  provider: WalletProviderShape;
  contractAddress: string;
  contractInterface: ethers.Interface;
  functionName: string;
  args: unknown[];
  from: string;
  value?: bigint;
  gasLimit?: bigint;
};

export function buildContractWriteRequest(input: ContractTransactionInput) {
  return {
    from: input.from,
    to: input.contractAddress,
    data: input.contractInterface.encodeFunctionData(input.functionName, input.args),
    ...(typeof input.value === 'bigint' ? { value: toRpcHex(input.value) } : {}),
    ...(typeof input.gasLimit === 'bigint' ? { gas: toRpcHex(input.gasLimit) } : {})
  };
}

export async function estimateContractWriteGas(input: Omit<ContractTransactionInput, 'gasLimit'>) {
  const request = buildContractWriteRequest(input);
  const gasEstimate = await requestWalletProvider<string>(input.provider, 'eth_estimateGas', [request]);
  return BigInt(gasEstimate);
}

export async function sendContractWrite(input: ContractTransactionInput) {
  const request = buildContractWriteRequest(input);
  const txHash = await requestWalletProvider<string>(input.provider, 'eth_sendTransaction', [request]);

  return {
    txHash,
    request
  };
}

export async function waitForTransactionReceipt(provider: BrowserProvider, txHash: string, timeoutMs = 120000) {
  const receipt = await provider.waitForTransaction(txHash, 1, timeoutMs);
  if (!receipt) {
    throw new Error(`Transaction ${txHash} was not confirmed before the timeout expired.`);
  }

  return receipt;
}

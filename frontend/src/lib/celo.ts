export const CELO_MAINNET_CHAIN_ID = 42220;
export const CELO_MAINNET_CHAIN_NAME = 'Celo Mainnet';
export const CELO_NATIVE_CURRENCY = {
  name: 'Celo',
  symbol: 'CELO',
  decimals: 18
} as const;

function normalizeChainName(name: string | null | undefined) {
  const normalized = name?.trim();
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    return null;
  }
  return normalized;
}

export function normalizeChainId(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value <= 0 || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return Number(value);
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsed = /^0x[0-9a-f]+$/i.test(normalized) ? Number.parseInt(normalized, 16) : Number(normalized);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  if (typeof value === 'object' && value && 'chainId' in value) {
    return normalizeChainId((value as { chainId?: unknown }).chainId);
  }

  return null;
}

export function isSupportedCeloChain(chainId: number | null) {
  return chainId === CELO_MAINNET_CHAIN_ID;
}

export function chainIdToHex(chainId: number) {
  return `0x${chainId.toString(16)}`;
}

export function formatDetectedChain(chainId: number | null, fallbackName?: string | null) {
  const normalizedName = normalizeChainName(fallbackName);

  if (chainId === CELO_MAINNET_CHAIN_ID) {
    return `${CELO_MAINNET_CHAIN_NAME} (${CELO_MAINNET_CHAIN_ID})`;
  }

  if (chainId === null) {
    return normalizedName || 'No network detected';
  }

  if (normalizedName) {
    return `${normalizedName} (${chainId})`;
  }

  return `Chain ${chainId}`;
}

export function formatSupportedNetworkMessage(chainId: number | null, fallbackName?: string | null) {
  if (isSupportedCeloChain(chainId)) {
    return formatDetectedChain(chainId, fallbackName);
  }

  if (chainId === null) {
    return `Unsupported network. Expected ${CELO_MAINNET_CHAIN_NAME} (${CELO_MAINNET_CHAIN_ID}).`;
  }

  return `Unsupported network: ${formatDetectedChain(chainId, fallbackName)}. Expected ${CELO_MAINNET_CHAIN_NAME} (${CELO_MAINNET_CHAIN_ID}).`;
}

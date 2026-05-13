import { ethers } from 'ethers';
import { CELO_MAINNET_CHAIN_ID, CELO_MAINNET_CHAIN_NAME, chainIdToHex, normalizeChainId } from './celo';

function requireEnv(name: string, value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return normalized;
}

function optionalEnv(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseAbsoluteUrl(name: string, value: string) {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function parseAddress(name: string, value: string) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${name} must be a valid Ethereum address`);
  }
}

function parseApiBaseUrl(value: string | undefined) {
  const raw = optionalEnv(value);
  const fallback = import.meta.env.DEV ? 'http://localhost:4000/api' : '/api';
  const resolved = raw || fallback;

  if (resolved.startsWith('/')) {
    return resolved;
  }

  try {
    return new URL(resolved).toString().replace(/\/$/, '');
  } catch {
    throw new Error('VITE_API_BASE_URL must be an absolute URL or a relative path starting with "/"');
  }
}

function parseSupportedChainId(name: string, value: string) {
  const numeric = normalizeChainId(value);
  if (numeric === null) {
    throw new Error(`${name} must be a valid positive chain id`);
  }
  if (numeric !== CELO_MAINNET_CHAIN_ID) {
    throw new Error(`${name} must be ${CELO_MAINNET_CHAIN_ID} for ${CELO_MAINNET_CHAIN_NAME}`);
  }
  return numeric;
}

const celoChainId = parseSupportedChainId('VITE_CELO_CHAIN_ID', requireEnv('VITE_CELO_CHAIN_ID', import.meta.env.VITE_CELO_CHAIN_ID));
const celoRpcUrl = parseAbsoluteUrl('VITE_CELO_RPC_URL', optionalEnv(import.meta.env.VITE_CELO_RPC_URL) || 'https://forno.celo.org');

export const env = {
  API_BASE_URL: parseApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  CELO_CHAIN_ID: celoChainId,
  CELO_CHAIN_HEX: chainIdToHex(celoChainId),
  CELO_CHAIN_NAME: CELO_MAINNET_CHAIN_NAME,
  CELO_RPC_URL: celoRpcUrl,
  CELO_EXPLORER_BASE_URL: parseAbsoluteUrl(
    'VITE_CELO_EXPLORER_BASE_URL',
    optionalEnv(import.meta.env.VITE_CELO_EXPLORER_BASE_URL) || 'https://celoscan.io'
  ),
  FORGE_QUEST_MANAGER_ADDRESS: parseAddress(
    'VITE_FORGE_QUEST_MANAGER_ADDRESS',
    requireEnv('VITE_FORGE_QUEST_MANAGER_ADDRESS', import.meta.env.VITE_FORGE_QUEST_MANAGER_ADDRESS)
  ),
  REWARD_NFT_ADDRESS: parseAddress(
    'VITE_REWARD_NFT_ADDRESS',
    requireEnv('VITE_REWARD_NFT_ADDRESS', import.meta.env.VITE_REWARD_NFT_ADDRESS)
  ),
  REPUTATION_ADDRESS: parseAddress(
    'VITE_REPUTATION_ADDRESS',
    requireEnv('VITE_REPUTATION_ADDRESS', import.meta.env.VITE_REPUTATION_ADDRESS)
  ),
  TREASURY_ADDRESS: parseAddress('VITE_TREASURY_ADDRESS', requireEnv('VITE_TREASURY_ADDRESS', import.meta.env.VITE_TREASURY_ADDRESS))
} as const;

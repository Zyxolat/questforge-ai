import { ethers } from 'ethers';

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

function parsePositiveInt(name: string, value: string) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return numeric;
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

export const env = {
  API_BASE_URL: parseApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  CELO_CHAIN_ID: parsePositiveInt('VITE_CELO_CHAIN_ID', requireEnv('VITE_CELO_CHAIN_ID', import.meta.env.VITE_CELO_CHAIN_ID)),
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


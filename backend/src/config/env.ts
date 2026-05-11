import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

type SameSite = 'lax' | 'strict' | 'none';

function readEnv(name: string) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function requireEnv(name: string) {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function requireEnvAlias(preferredName: string, aliases: string[]) {
  const preferredValue = readEnv(preferredName);
  if (preferredValue) {
    return preferredValue;
  }

  for (const alias of aliases) {
    const aliasValue = readEnv(alias);
    if (aliasValue) {
      return aliasValue;
    }
  }

  const names = [preferredName, ...aliases].join(' or ');
  throw new Error(`Missing required environment variable ${names}`);
}

function optionalEnv(name: string) {
  const value = readEnv(name);
  return value || undefined;
}

function parsePort(name: string, fallback: number) {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function parsePositiveInt(name: string, raw: string, minimum = 1) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function parseSupportedChainId(name: string, raw: string) {
  const value = parsePositiveInt(name, raw);
  if (value !== 42220) {
    throw new Error(`${name} must be 42220 for Celo Mainnet`);
  }
  return value;
}

function parseUrl(name: string, raw: string) {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function parseOrigins(name: string, raw: string) {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!values.length) {
    throw new Error(`${name} must include at least one origin`);
  }

  return values.map((value) => parseUrl(name, value).origin);
}

function parseEthereumAddress(name: string, raw: string) {
  try {
    return ethers.getAddress(raw);
  } catch {
    throw new Error(`${name} must be a valid Ethereum address`);
  }
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean) {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be either "true" or "false"`);
}

function parseSameSite(name: string, raw: string | undefined, fallback: SameSite): SameSite {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'lax' || normalized === 'strict' || normalized === 'none') {
    return normalized;
  }
  throw new Error(`${name} must be one of "lax", "strict", or "none"`);
}

function parseJwtExpirySeconds(raw: string) {
  const match = raw.match(/^(\d+)([smhd])?$/i);
  if (!match) {
    throw new Error('JWT_EXPIRES_IN must be a positive integer optionally suffixed with s, m, h, or d');
  }

  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('JWT_EXPIRES_IN must be greater than zero');
  }

  const unit = (match[2] || 's').toLowerCase();
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 60 * 60 : 60 * 60 * 24;
  return amount * multiplier;
}

const nodeEnv = optionalEnv('NODE_ENV') || 'development';
const frontendUrl = parseUrl('FRONTEND_URL', requireEnv('FRONTEND_URL'));
const authUri = parseUrl('AUTH_URI', optionalEnv('AUTH_URI') || frontendUrl.toString());
const corsOrigins = parseOrigins('CORS_ORIGIN', requireEnv('CORS_ORIGIN'));
const jwtSecret = requireEnv('JWT_SECRET');

if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}

const jwtExpiresIn = requireEnv('JWT_EXPIRES_IN');
const authNonceTtlRaw = optionalEnv('AUTH_NONCE_TTL_MINUTES') || '5';
const authSessionTtlRaw = optionalEnv('AUTH_SESSION_TTL_HOURS') || '168';
const cookieSecureDefault = nodeEnv === 'production';

export const env = {
  NODE_ENV: nodeEnv,
  PORT: parsePort('PORT', 4000),
  DATABASE_URL: requireEnv('DATABASE_URL'),
  OPENAI_API_KEY: optionalEnv('OPENAI_API_KEY') || '',
  FRONTEND_URL: frontendUrl.toString(),
  FRONTEND_ORIGIN: frontendUrl.origin,
  CORS_ORIGINS: corsOrigins,
  CELO_RPC_URL: requireEnvAlias('CELO_RPC_URL', ['CELO_NODE_URL']),
  CELO_CHAIN_ID: parseSupportedChainId('CELO_CHAIN_ID', requireEnv('CELO_CHAIN_ID')),
  FORGE_QUEST_MANAGER_ADDRESS: parseEthereumAddress('FORGE_QUEST_MANAGER_ADDRESS', requireEnv('FORGE_QUEST_MANAGER_ADDRESS')),
  REWARD_NFT_ADDRESS: parseEthereumAddress('REWARD_NFT_ADDRESS', requireEnv('REWARD_NFT_ADDRESS')),
  REPUTATION_ADDRESS: parseEthereumAddress('REPUTATION_ADDRESS', requireEnv('REPUTATION_ADDRESS')),
  TREASURY_ADDRESS: parseEthereumAddress('TREASURY_ADDRESS', requireEnv('TREASURY_ADDRESS')),
  INDEXER_FROM_BLOCK: parsePositiveInt('INDEXER_FROM_BLOCK', optionalEnv('INDEXER_FROM_BLOCK') || '0', 0),
  INDEXER_POLL_INTERVAL_MS: parsePositiveInt('INDEXER_POLL_INTERVAL_MS', optionalEnv('INDEXER_POLL_INTERVAL_MS') || '10000'),
  REDIS_URL: optionalEnv('REDIS_URL'),
  VERIFIER_PRIVATE_KEY: optionalEnv('VERIFIER_PRIVATE_KEY') || optionalEnv('PRIVATE_KEY'),
  VERIFICATION_WORKER_INTERVAL_MS: parsePositiveInt(
    'VERIFICATION_WORKER_INTERVAL_MS',
    optionalEnv('VERIFICATION_WORKER_INTERVAL_MS') || '5000'
  ),
  VERIFICATION_BATCH_SIZE: parsePositiveInt(
    'VERIFICATION_BATCH_SIZE',
    optionalEnv('VERIFICATION_BATCH_SIZE') || '10'
  ),
  AUTH_DOMAIN: optionalEnv('AUTH_DOMAIN') || authUri.host,
  AUTH_URI: authUri.toString(),
  AUTH_NONCE_TTL_MINUTES: parsePositiveInt('AUTH_NONCE_TTL_MINUTES', authNonceTtlRaw),
  AUTH_SESSION_TTL_HOURS: parsePositiveInt('AUTH_SESSION_TTL_HOURS', authSessionTtlRaw),
  AUTH_STATEMENT: optionalEnv('AUTH_STATEMENT') || 'Sign in to QuestForge AI.',
  AUTH_COOKIE_NAME: optionalEnv('AUTH_COOKIE_NAME') || 'questforge_session',
  AUTH_COOKIE_DOMAIN: optionalEnv('AUTH_COOKIE_DOMAIN'),
  AUTH_COOKIE_PATH: optionalEnv('AUTH_COOKIE_PATH') || '/',
  AUTH_COOKIE_SECURE: parseBoolean('AUTH_COOKIE_SECURE', optionalEnv('AUTH_COOKIE_SECURE'), cookieSecureDefault),
  AUTH_COOKIE_SAME_SITE: parseSameSite('AUTH_COOKIE_SAME_SITE', optionalEnv('AUTH_COOKIE_SAME_SITE'), 'lax'),
  JWT_SECRET: jwtSecret,
  JWT_EXPIRES_IN: jwtExpiresIn,
  JWT_EXPIRES_IN_SECONDS: parseJwtExpirySeconds(jwtExpiresIn)
} as const;

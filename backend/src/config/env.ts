import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

type SameSite = 'lax' | 'strict' | 'none';

type EnvIssue = {
  group: string;
  name: string;
  message: string;
};

type EnvValidationResult = {
  ok: boolean;
  env?: AppEnv;
  errors: EnvIssue[];
  warnings: EnvIssue[];
};

export type AppEnv = {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  FRONTEND_URL: string;
  FRONTEND_ORIGIN: string;
  CORS_ORIGINS: string[];
  CELO_RPC_URL: string;
  CELO_RPC_FALLBACK_URLS: string[];
  CELO_CHAIN_ID: number;
  FORGE_QUEST_MANAGER_ADDRESS: string;
  REWARD_NFT_ADDRESS: string;
  REPUTATION_ADDRESS: string;
  TREASURY_ADDRESS: string;
  INDEXER_FROM_BLOCK: number;
  INDEXER_POLL_INTERVAL_MS: number;
  VERIFIER_PRIVATE_KEY?: string;
  DAILY_REWARD_TREASURY_PRIVATE_KEY?: string;
  VERIFICATION_WORKER_INTERVAL_MS: number;
  VERIFICATION_BATCH_SIZE: number;
  AUTH_DOMAIN: string;
  AUTH_URI: string;
  AUTH_NONCE_TTL_MINUTES: number;
  AUTH_SESSION_TTL_HOURS: number;
  AUTH_STATEMENT: string;
  AUTH_COOKIE_NAME: string;
  AUTH_COOKIE_DOMAIN?: string;
  AUTH_COOKIE_PATH: string;
  AUTH_COOKIE_SECURE: boolean;
  AUTH_COOKIE_SAME_SITE: SameSite;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  JWT_EXPIRES_IN_SECONDS: number;
  INDEXER_RETRY_LIMIT: number;
  INDEXER_BACKOFF_MS: number;
  RPC_TIMEOUT_MS: number;
  EVENT_CHUNK_SIZE: number;
};

export class EnvValidationError extends Error {
  readonly result: EnvValidationResult;

  constructor(result: EnvValidationResult) {
    super('Environment validation failed');
    this.name = 'EnvValidationError';
    this.result = result;
  }
}

export let env!: AppEnv;

function readEnv(name: string) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function addIssue(target: EnvIssue[], group: string, name: string, message: string) {
  target.push({ group, name, message });
}

function readRequired(name: string, group: string, errors: EnvIssue[]) {
  const value = readEnv(name);
  if (!value) {
    addIssue(errors, group, name, 'is required');
    return undefined;
  }

  return value;
}

function readRequiredAlias(preferredName: string, aliases: string[], group: string, errors: EnvIssue[]) {
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

  addIssue(errors, group, preferredName, `is required${aliases.length ? ` (alias: ${aliases.join(', ')})` : ''}`);
  return undefined;
}

function optionalEnv(name: string) {
  const value = readEnv(name);
  if (/^\$\{\{.+\}\}$/.test(value) || /^\{\{.+\}\}$/.test(value)) {
    return undefined;
  }
  return value || undefined;
}

function parsePort(name: string, raw: string | undefined, fallback: number) {
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
  const value = new URL(raw);
  if (!value.protocol || !value.host) {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  return value;
}

function parseDatabaseUrl(name: string, raw: string) {
  const value = parseUrl(name, raw);
  if (value.protocol !== 'postgresql:' && value.protocol !== 'postgres:') {
    throw new Error(`${name} must use the postgresql:// or postgres:// protocol`);
  }
  return value.toString();
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

function dedupeOrigins(origins: string[]) {
  return [...new Set(origins)];
}

function parseUrlList(name: string, raw: string) {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseUrl(name, value).toString());
}

function parseEthereumAddress(name: string, raw: string) {
  const address = ethers.getAddress(raw);
  if (address === ethers.ZeroAddress) {
    throw new Error(`${name} must not be the zero address`);
  }
  return address;
}

function parseOptionalPrivateKey(name: string, raw: string | undefined) {
  if (!raw) {
    return undefined;
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }

  if (/^0x0{64}$/i.test(raw)) {
    throw new Error(`${name} must not be the all-zero private key`);
  }

  return new ethers.Wallet(raw).privateKey;
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

function captureRequired<T>(
  name: string,
  group: string,
  errors: EnvIssue[],
  parser: (raw: string) => T
) {
  const raw = readRequired(name, group, errors);
  if (!raw) {
    return undefined;
  }

  try {
    return parser(raw);
  } catch (error) {
    addIssue(errors, group, name, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function captureRequiredAlias<T>(
  preferredName: string,
  aliases: string[],
  group: string,
  errors: EnvIssue[],
  parser: (raw: string) => T
) {
  const raw = readRequiredAlias(preferredName, aliases, group, errors);
  if (!raw) {
    return undefined;
  }

  try {
    return parser(raw);
  } catch (error) {
    addIssue(errors, group, preferredName, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function captureOptional<T>(
  name: string,
  group: string,
  warnings: EnvIssue[],
  parser: (raw: string) => T
) {
  const raw = optionalEnv(name);
  if (!raw) {
    return undefined;
  }

  try {
    return parser(raw);
  } catch (error) {
    addIssue(warnings, group, name, `${error instanceof Error ? error.message : String(error)}. Ignoring value.`);
    return undefined;
  }
}

function captureVerifierPrivateKey(nodeEnv: string, errors: EnvIssue[], warnings: EnvIssue[]) {
  const name = optionalEnv('VERIFIER_PRIVATE_KEY') ? 'VERIFIER_PRIVATE_KEY' : 'PRIVATE_KEY';
  const raw = optionalEnv(name);

  if (!raw) {
    if (nodeEnv === 'production') {
      addIssue(
        errors,
        'Proof Verification',
        'VERIFIER_PRIVATE_KEY',
        'is required in production because submitted quests cannot be verified, paid, or minted without a verifier signer'
      );
    }
    return undefined;
  }

  try {
    return parseOptionalPrivateKey(name, raw);
  } catch (error) {
    addIssue(
      nodeEnv === 'production' ? errors : warnings,
      'Proof Verification',
      name,
      nodeEnv === 'production'
        ? error instanceof Error
          ? error.message
          : String(error)
        : `${error instanceof Error ? error.message : String(error)}. Ignoring value.`
    );
    return undefined;
  }
}

export function validateEnvironment(): EnvValidationResult {
  const errors: EnvIssue[] = [];
  const warnings: EnvIssue[] = [];

  const nodeEnv = optionalEnv('NODE_ENV') || 'development';
  const frontendUrl = captureRequired('FRONTEND_URL', 'Application URLs', errors, (raw) =>
    parseUrl('FRONTEND_URL', raw)
  );
  const corsOriginRaw = optionalEnv('CORS_ORIGIN') || optionalEnv('CORS_ORIGINS');
  let corsOrigins: string[] | undefined;
  if (corsOriginRaw) {
    try {
      corsOrigins = parseOrigins('CORS_ORIGIN', corsOriginRaw);
    } catch (error) {
      addIssue(errors, 'Application URLs', 'CORS_ORIGIN', error instanceof Error ? error.message : String(error));
    }
  } else if (frontendUrl) {
    corsOrigins = [frontendUrl.origin];
    addIssue(
      warnings,
      'Application URLs',
      'CORS_ORIGIN',
      'not set; defaulting to the FRONTEND_URL origin for credentialed requests'
    );
  } else {
    addIssue(errors, 'Application URLs', 'CORS_ORIGIN', 'is required when FRONTEND_URL is unavailable');
  }
  const databaseUrl = captureRequired('DATABASE_URL', 'Database', errors, (raw) =>
    parseDatabaseUrl('DATABASE_URL', raw)
  );
  const jwtSecret = captureRequired('JWT_SECRET', 'Authentication', errors, (raw) => {
    if (raw.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long');
    }
    return raw;
  });
  const jwtExpiresIn = captureRequired('JWT_EXPIRES_IN', 'Authentication', errors, (raw) => raw);
  const celoRpcUrl = captureRequiredAlias('CELO_RPC_URL', ['CELO_NODE_URL'], 'Blockchain', errors, (raw) =>
    parseUrl('CELO_RPC_URL', raw).toString()
  );
  const celoRpcFallbackUrls = captureOptional(
    'CELO_RPC_FALLBACK_URLS',
    'Blockchain',
    warnings,
    (raw) => parseUrlList('CELO_RPC_FALLBACK_URLS', raw)
  );
  const celoChainId = captureRequired('CELO_CHAIN_ID', 'Blockchain', errors, (raw) =>
    parseSupportedChainId('CELO_CHAIN_ID', raw)
  );
  const forgeQuestManagerAddress = captureRequired(
    'FORGE_QUEST_MANAGER_ADDRESS',
    'Contracts',
    errors,
    (raw) => parseEthereumAddress('FORGE_QUEST_MANAGER_ADDRESS', raw)
  );
  const rewardNftAddress = captureRequired('REWARD_NFT_ADDRESS', 'Contracts', errors, (raw) =>
    parseEthereumAddress('REWARD_NFT_ADDRESS', raw)
  );
  const reputationAddress = captureRequired('REPUTATION_ADDRESS', 'Contracts', errors, (raw) =>
    parseEthereumAddress('REPUTATION_ADDRESS', raw)
  );
  const treasuryAddress = captureRequired('TREASURY_ADDRESS', 'Contracts', errors, (raw) =>
    parseEthereumAddress('TREASURY_ADDRESS', raw)
  );

  const verifierPrivateKey = captureVerifierPrivateKey(nodeEnv, errors, warnings);
  const dailyRewardTreasuryPrivateKey = captureOptional(
    'DAILY_REWARD_TREASURY_PRIVATE_KEY',
    'Daily Rewards',
    warnings,
    (raw) => parseOptionalPrivateKey('DAILY_REWARD_TREASURY_PRIVATE_KEY', raw)
  );

  const authUriRaw = optionalEnv('AUTH_URI') || frontendUrl?.toString();
  let authUri: URL | undefined;
  if (authUriRaw) {
    try {
      authUri = parseUrl('AUTH_URI', authUriRaw);
    } catch (error) {
      addIssue(errors, 'Authentication', 'AUTH_URI', error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const authNonceTtlRaw = optionalEnv('AUTH_NONCE_TTL_MINUTES') || '5';
  const authSessionTtlRaw = optionalEnv('AUTH_SESSION_TTL_HOURS') || '168';
  const cookieSecureDefault = nodeEnv === 'production';
  const cookieSameSiteDefault: SameSite = nodeEnv === 'production' ? 'none' : 'lax';

  const resolvedCookieSecure = parseBoolean('AUTH_COOKIE_SECURE', optionalEnv('AUTH_COOKIE_SECURE'), cookieSecureDefault);
  const resolvedCookieSameSite = parseSameSite(
    'AUTH_COOKIE_SAME_SITE',
    optionalEnv('AUTH_COOKIE_SAME_SITE'),
    cookieSameSiteDefault
  );

  if (nodeEnv === 'production' && !resolvedCookieSecure) {
    addIssue(errors, 'Authentication', 'AUTH_COOKIE_SECURE', 'must be true in production for HTTPS cookie delivery');
  }

  if (nodeEnv === 'production' && resolvedCookieSameSite !== 'none') {
    addIssue(
      errors,
      'Authentication',
      'AUTH_COOKIE_SAME_SITE',
      'must be "none" in production when the frontend and backend are served from different origins'
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  try {
    const resolvedJwtExpiresIn = jwtExpiresIn!;
    const resolvedAuthUri = authUri!;
    const resolvedCorsOrigins = dedupeOrigins([frontendUrl!.origin, ...(corsOrigins || [])]);

    if (corsOrigins && !corsOrigins.includes(frontendUrl!.origin)) {
      addIssue(
        warnings,
        'Application URLs',
        'CORS_ORIGIN',
        `did not include FRONTEND_URL origin ${frontendUrl!.origin}; adding it automatically`
      );
    }

    return {
      ok: true,
      env: {
        NODE_ENV: nodeEnv,
        PORT: parsePort('PORT', optionalEnv('PORT'), 4000),
        DATABASE_URL: databaseUrl!,
        FRONTEND_URL: frontendUrl!.toString(),
        FRONTEND_ORIGIN: frontendUrl!.origin,
        CORS_ORIGINS: resolvedCorsOrigins,
        CELO_RPC_URL: celoRpcUrl!,
        CELO_RPC_FALLBACK_URLS: celoRpcFallbackUrls || [],
        CELO_CHAIN_ID: celoChainId!,
        FORGE_QUEST_MANAGER_ADDRESS: forgeQuestManagerAddress!,
        REWARD_NFT_ADDRESS: rewardNftAddress!,
        REPUTATION_ADDRESS: reputationAddress!,
        TREASURY_ADDRESS: treasuryAddress!,
        INDEXER_FROM_BLOCK: parsePositiveInt('INDEXER_FROM_BLOCK', optionalEnv('INDEXER_FROM_BLOCK') || '0', 0),
        INDEXER_POLL_INTERVAL_MS: parsePositiveInt(
          'INDEXER_POLL_INTERVAL_MS',
          optionalEnv('INDEXER_POLL_INTERVAL_MS') || '10000'
        ),
        VERIFIER_PRIVATE_KEY: verifierPrivateKey,
        DAILY_REWARD_TREASURY_PRIVATE_KEY: dailyRewardTreasuryPrivateKey,
        VERIFICATION_WORKER_INTERVAL_MS: parsePositiveInt(
          'VERIFICATION_WORKER_INTERVAL_MS',
          optionalEnv('VERIFICATION_WORKER_INTERVAL_MS') || '2000'
        ),
        VERIFICATION_BATCH_SIZE: parsePositiveInt(
          'VERIFICATION_BATCH_SIZE',
          optionalEnv('VERIFICATION_BATCH_SIZE') || '10'
        ),
        AUTH_DOMAIN: optionalEnv('AUTH_DOMAIN') || resolvedAuthUri.host,
        AUTH_URI: resolvedAuthUri.toString(),
        AUTH_NONCE_TTL_MINUTES: parsePositiveInt('AUTH_NONCE_TTL_MINUTES', authNonceTtlRaw),
        AUTH_SESSION_TTL_HOURS: parsePositiveInt('AUTH_SESSION_TTL_HOURS', authSessionTtlRaw),
        AUTH_STATEMENT: optionalEnv('AUTH_STATEMENT') || 'Sign in to Online ForgeQuest Game.',
        AUTH_COOKIE_NAME: optionalEnv('AUTH_COOKIE_NAME') || 'forgequest_session',
        AUTH_COOKIE_DOMAIN: optionalEnv('AUTH_COOKIE_DOMAIN'),
        AUTH_COOKIE_PATH: optionalEnv('AUTH_COOKIE_PATH') || '/',
        AUTH_COOKIE_SECURE: resolvedCookieSecure,
        AUTH_COOKIE_SAME_SITE: resolvedCookieSameSite,
        JWT_SECRET: jwtSecret!,
        JWT_EXPIRES_IN: resolvedJwtExpiresIn,
        JWT_EXPIRES_IN_SECONDS: parseJwtExpirySeconds(resolvedJwtExpiresIn),
        INDEXER_RETRY_LIMIT: parsePositiveInt('INDEXER_RETRY_LIMIT', optionalEnv('INDEXER_RETRY_LIMIT') || '10'),
        INDEXER_BACKOFF_MS: parsePositiveInt('INDEXER_BACKOFF_MS', optionalEnv('INDEXER_BACKOFF_MS') || '2000'),
        RPC_TIMEOUT_MS: parsePositiveInt('RPC_TIMEOUT_MS', optionalEnv('RPC_TIMEOUT_MS') || '30000'),
        EVENT_CHUNK_SIZE: parsePositiveInt('EVENT_CHUNK_SIZE', optionalEnv('EVENT_CHUNK_SIZE') || '5000')
      },
      errors,
      warnings
    };
  } catch (error) {
    addIssue(errors, 'Configuration', 'runtime', error instanceof Error ? error.message : String(error));
    return { ok: false, errors, warnings };
  }
}

function formatIssueGroups(issues: EnvIssue[]) {
  const groups = new Map<string, EnvIssue[]>();

  for (const issue of issues) {
    const existing = groups.get(issue.group) || [];
    existing.push(issue);
    groups.set(issue.group, existing);
  }

  return [...groups.entries()]
    .map(([group, groupIssues]) => {
      const lines = groupIssues.map((issue) => `  - ${issue.name}: ${issue.message}`).join('\n');
      return `${group}:\n${lines}`;
    })
    .join('\n');
}

export function formatEnvironmentValidation(result: EnvValidationResult) {
  const lines = ['[ENV] Startup environment validation failed.'];

  if (result.errors.length > 0) {
    lines.push('[ENV] Missing or invalid required variables:');
    lines.push(formatIssueGroups(result.errors));
  }

  if (result.warnings.length > 0) {
    lines.push('[ENV] Optional variables ignored:');
    lines.push(formatIssueGroups(result.warnings));
  }

  return lines.join('\n');
}

export function initializeEnvironment() {
  const result = validateEnvironment();
  if (!result.ok || !result.env) {
    throw new EnvValidationError(result);
  }

  env = result.env;
  return result;
}

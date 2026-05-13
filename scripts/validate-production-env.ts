/**
 * QuestForge AI - Production Environment Validation
 * 
 * Validates all required environment variables, RPC connectivity,
 * and deployment prerequisites before live deployment.
 * 
 * Usage: npx ts-node scripts/validate-production-env.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load env from .env.production
const envPath = path.join(__dirname, '../.env.production');
if (!fs.existsSync(envPath)) {
  console.error('❌ ERROR: .env.production not found at', envPath);
  console.error('   Please copy .env.production.template to .env.production and fill in values');
  process.exit(1);
}

dotenv.config({ path: envPath });

type ValidationResult = {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
  value?: string;
};

const results: ValidationResult[] = [];

function recordResult(name: string, status: 'pass' | 'fail' | 'warning', message: string, value?: string) {
  results.push({ name, status, message, value });
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '❌' : '⚠️';
  console.log(`${icon} ${name}: ${message}`);
}

function requireEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    recordResult(name, 'fail', 'Missing required environment variable');
    return null;
  }
  recordResult(name, 'pass', 'Set', value.substring(0, 20) + (value.length > 20 ? '...' : ''));
  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (value) {
    recordResult(name, 'pass', 'Set', value.substring(0, 20) + (value.length > 20 ? '...' : ''));
  } else {
    recordResult(name, 'warning', 'Not set (optional)');
  }
  return value || null;
}

async function validateEthereumAddress(name: string, value: string | null): Promise<boolean> {
  if (!value) {
    recordResult(name, 'fail', 'Invalid Ethereum address (missing)');
    return false;
  }
  try {
    ethers.getAddress(value);
    recordResult(name, 'pass', `Valid address: ${value}`);
    return true;
  } catch (e) {
    recordResult(name, 'fail', `Invalid Ethereum address: ${value}`);
    return false;
  }
}

async function validateRpcConnectivity(rpcUrl: string | null): Promise<boolean> {
  if (!rpcUrl) {
    recordResult('RPC_CONNECTIVITY', 'fail', 'No RPC URL provided');
    return false;
  }
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    
    if (network.chainId !== 42220n) {
      recordResult('RPC_CONNECTIVITY', 'fail', `Expected chain ID 42220, got ${network.chainId}`);
      return false;
    }
    
    const blockNumber = await provider.getBlockNumber();
    recordResult('RPC_CONNECTIVITY', 'pass', `Connected to Celo Mainnet, block ${blockNumber}`);
    return true;
  } catch (e) {
    recordResult('RPC_CONNECTIVITY', 'fail', `Failed to connect to RPC: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function validatePrivateKey(name: string, value: string | null): Promise<boolean> {
  if (!value) {
    recordResult(name, 'fail', 'Missing private key');
    return false;
  }
  try {
    const wallet = new ethers.Wallet(value);
    recordResult(name, 'pass', `Valid private key, address: ${wallet.address}`);
    return true;
  } catch (e) {
    recordResult(name, 'fail', `Invalid private key: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function validateJwtSecret(name: string, value: string | null): boolean {
  if (!value) {
    recordResult(name, 'fail', 'Missing JWT secret');
    return false;
  }
  if (value.length < 32) {
    recordResult(name, 'fail', `JWT secret must be at least 32 characters, got ${value.length}`);
    return false;
  }
  recordResult(name, 'pass', `Valid JWT secret (${value.length} chars)`);
  return true;
}

function validatePositiveInteger(name: string, value: string | null, min = 1): boolean {
  if (!value) {
    recordResult(name, 'fail', 'Missing value');
    return false;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < min) {
    recordResult(name, 'fail', `Must be integer >= ${min}, got ${value}`);
    return false;
  }
  recordResult(name, 'pass', `Valid: ${value}`);
  return true;
}

function validateUrl(name: string, value: string | null): boolean {
  if (!value) {
    recordResult(name, 'fail', 'Missing URL');
    return false;
  }
  try {
    new URL(value);
    recordResult(name, 'pass', `Valid URL: ${value}`);
    return true;
  } catch (e) {
    recordResult(name, 'fail', `Invalid URL: ${value}`);
    return false;
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   QuestForge AI - Production Environment Validation');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('📋 CHECKING ENVIRONMENT VARIABLES...\n');

  // Node Environment
  const nodeEnv = requireEnv('NODE_ENV');
  if (nodeEnv !== 'production') {
    recordResult('NODE_ENV', 'warning', `Expected "production", got "${nodeEnv}"`);
  }

  // API Configuration
  console.log('\n📡 API CONFIGURATION...\n');
  const port = requireEnv('PORT');
  validatePositiveInteger('PORT', port);
  validateUrl('FRONTEND_URL', requireEnv('FRONTEND_URL'));
  validateUrl('API_URL', optionalEnv('API_URL'));

  // Database
  console.log('\n🗄️  DATABASE CONFIGURATION...\n');
  const databaseUrl = requireEnv('DATABASE_URL');
  if (databaseUrl && databaseUrl.startsWith('postgresql://')) {
    recordResult('DATABASE_URL', 'pass', 'Valid PostgreSQL connection string');
  } else {
    recordResult('DATABASE_URL', 'fail', 'Invalid database URL format');
  }

  // Blockchain Configuration
  console.log('\n⛓️  BLOCKCHAIN CONFIGURATION...\n');
  const rpcUrl = requireEnv('CELO_RPC_URL');
  const chainId = optionalEnv('CELO_CHAIN_ID');
  validatePositiveInteger('CELO_CHAIN_ID', chainId || '42220');

  // Private Keys
  console.log('\n🔐 PRIVATE KEYS...\n');
  const privateKey = requireEnv('PRIVATE_KEY');
  await validatePrivateKey('PRIVATE_KEY', privateKey);
  const verifierPrivateKey = optionalEnv('VERIFIER_PRIVATE_KEY');
  if (verifierPrivateKey) {
    await validatePrivateKey('VERIFIER_PRIVATE_KEY', verifierPrivateKey);
  }

  // Smart Contract Addresses
  console.log('\n📜 SMART CONTRACT ADDRESSES...\n');
  await validateEthereumAddress('FORGE_QUEST_MANAGER_ADDRESS', requireEnv('FORGE_QUEST_MANAGER_ADDRESS'));
  await validateEthereumAddress('REPUTATION_ADDRESS', requireEnv('REPUTATION_ADDRESS'));
  await validateEthereumAddress('REWARD_NFT_ADDRESS', requireEnv('REWARD_NFT_ADDRESS'));
  await validateEthereumAddress('TREASURY_ADDRESS', requireEnv('TREASURY_ADDRESS'));
  optionalEnv('REWARD_TOKEN_ADDRESS');

  // API Keys
  console.log('\n🔑 API KEYS...\n');
  const openaiKey = optionalEnv('OPENAI_API_KEY');
  if (openaiKey && openaiKey.startsWith('sk-')) {
    recordResult('OPENAI_API_KEY', 'pass', 'Valid OpenAI key format');
  } else if (!openaiKey) {
    recordResult('OPENAI_API_KEY', 'warning', 'Not set (quest generation may fail)');
  } else {
    recordResult('OPENAI_API_KEY', 'fail', 'Invalid OpenAI key format');
  }

  // JWT Configuration
  console.log('\n🎟️  JWT CONFIGURATION...\n');
  validateJwtSecret('JWT_SECRET', requireEnv('JWT_SECRET'));
  optionalEnv('JWT_EXPIRES_IN');

  // Authentication Configuration
  console.log('\n🔑 AUTHENTICATION CONFIGURATION...\n');
  optionalEnv('AUTH_STATEMENT');
  validatePositiveInteger('AUTH_NONCE_TTL_MINUTES', optionalEnv('AUTH_NONCE_TTL_MINUTES') || '5');
  validatePositiveInteger('AUTH_SESSION_TTL_HOURS', optionalEnv('AUTH_SESSION_TTL_HOURS') || '168');

  // Rate Limiting
  console.log('\n⏱️  RATE LIMITING...\n');
  validatePositiveInteger('RATE_LIMIT_WINDOW_MS', optionalEnv('RATE_LIMIT_WINDOW_MS') || '900000');
  validatePositiveInteger('RATE_LIMIT_MAX_REQUESTS', optionalEnv('RATE_LIMIT_MAX_REQUESTS') || '150');
  validatePositiveInteger('QUEST_GENERATION_RATE_LIMIT', optionalEnv('QUEST_GENERATION_RATE_LIMIT') || '50');
  validatePositiveInteger('PROOF_SUBMISSION_RATE_LIMIT', optionalEnv('PROOF_SUBMISSION_RATE_LIMIT') || '100');

  // Logging
  console.log('\n📊 LOGGING...\n');
  optionalEnv('LOG_LEVEL');
  optionalEnv('SENTRY_DSN');

  // Indexer Configuration
  console.log('\n🔄 INDEXER CONFIGURATION...\n');
  validatePositiveInteger('INDEXER_POLL_INTERVAL_MS', optionalEnv('INDEXER_POLL_INTERVAL_MS') || '10000');
  validatePositiveInteger('VERIFICATION_WORKER_INTERVAL_MS', optionalEnv('VERIFICATION_WORKER_INTERVAL_MS') || '5000');
  validatePositiveInteger('VERIFICATION_BATCH_SIZE', optionalEnv('VERIFICATION_BATCH_SIZE') || '10');

  // Circuit Breaker
  console.log('\n🚫 CIRCUIT BREAKER...\n');
  optionalEnv('MAX_DAILY_REWARDS_CELO');
  optionalEnv('MAX_REWARD_POOL_SIZE_CELO');

  // Redis (optional)
  console.log('\n📮 REDIS (OPTIONAL)...\n');
  optionalEnv('REDIS_URL');

  // RPC Connectivity Check (LAST - expensive operation)
  console.log('\n🌐 RPC CONNECTIVITY CHECK...\n');
  const rpcOk = await validateRpcConnectivity(rpcUrl);

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    VALIDATION SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');

  const fails = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warning');
  const passes = results.filter(r => r.status === 'pass');

  console.log(`✓ Passed:  ${passes.length}`);
  console.log(`⚠️  Warnings: ${warnings.length}`);
  console.log(`❌ Failed:  ${fails.length}\n`);

  if (fails.length > 0) {
    console.log('🚫 CRITICAL FAILURES:\n');
    fails.forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.message}`);
    });
    console.log('\n⛔ Fix all failures before proceeding with deployment.\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log('⚠️  WARNINGS:\n');
    warnings.forEach(r => {
      console.log(`  ⚠️  ${r.name}: ${r.message}`);
    });
    console.log('\n⚡ Warnings may impact functionality. Review before deployment.\n');
  }

  console.log('✅ Environment validation PASSED! Ready for deployment.\n');
  process.exit(0);
}

main().catch(error => {
  console.error('❌ Validation error:', error);
  process.exit(1);
});

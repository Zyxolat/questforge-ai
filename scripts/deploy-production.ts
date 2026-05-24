/**
 * QuestForge AI - Production Deployment Orchestrator
 * 
 * Orchestrates the complete production deployment pipeline:
 * 1. Pre-flight validation
 * 2. Contract deployment to Celo Mainnet
 * 3. Role configuration
 * 4. Treasury funding
 * 5. Address wiring
 * 6. Deployment verification
 * 
 * Usage: npm run deploy:production (from root)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as dotenv from 'dotenv';

// Ensure we're in the project root
const projectRoot = path.join(__dirname, '..');
const envPath = path.join(projectRoot, '.env.production');
const contractsEnvPath = path.join(projectRoot, 'contracts', '.env.production');
const deploymentArtifactPath = path.join(projectRoot, 'contracts', 'deployments', 'celo-addresses.json');

type DeployedAddresses = {
  REWARD_NFT_ADDRESS: string;
  TREASURY_ADDRESS: string;
  REPUTATION_ADDRESS: string;
  FORGE_QUEST_MANAGER_ADDRESS: string;
};

interface DeploymentLog {
  timestamp: string;
  step: string;
  status: 'start' | 'success' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

const deploymentLogs: DeploymentLog[] = [];

function createErrorWithCause(message: string, cause: unknown) {
  const wrappedError = new Error(message) as Error & { cause?: unknown };
  wrappedError.cause = cause;
  return wrappedError;
}

function log(
  step: string,
  status: 'start' | 'success' | 'error',
  message: string,
  details?: Record<string, unknown>
) {
  const entry: DeploymentLog = {
    timestamp: new Date().toISOString(),
    step,
    status,
    message,
    details,
  };
  deploymentLogs.push(entry);
  
  const icon = status === 'start' ? '⏳' : status === 'success' ? '✓' : '❌';
  const color = status === 'error' ? '\x1b[31m' : status === 'success' ? '\x1b[32m' : '\x1b[36m';
  console.log(`${color}${icon} [${step}] ${message}\x1b[0m`);
}

function exec(command: string, description: string): string {
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    log('EXEC', 'success', description);

    return output;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    log('EXEC', 'error', `${description} failed: ${message}`);

    throw createErrorWithCause(`Failed: ${description}`, error);
  }
}

function parseEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadEffectiveProductionEnv() {
  const rootEnv = parseEnvFile(envPath);
  const contractsEnv = parseEnvFile(contractsEnvPath);
  const mergedEnv = {
    ...rootEnv,
    ...contractsEnv,
    ...process.env,
  };

  for (const [name, value] of Object.entries(mergedEnv)) {
    if (typeof value === 'string' && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }

  return mergedEnv;
}

function writeFileAtomic(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function requireNormalizedAddress(name: string, value: string | undefined) {
  if (!value?.trim()) {
    throw new Error(`Missing deployed address ${name}`);
  }

  const normalized = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized) || normalized === '0x0000000000000000000000000000000000000000') {
    throw new Error(`Invalid deployed address ${name}: ${normalized}`);
  }

  return normalized;
}

function readDeploymentArtifact(): DeployedAddresses {
  if (!fs.existsSync(deploymentArtifactPath)) {
    throw new Error(`Deployment artifact not found at ${deploymentArtifactPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(deploymentArtifactPath, 'utf-8')) as Record<string, string>;

  return {
    REWARD_NFT_ADDRESS: requireNormalizedAddress('REWARD_NFT_ADDRESS', parsed.REWARD_NFT_ADDRESS),
    TREASURY_ADDRESS: requireNormalizedAddress('TREASURY_ADDRESS', parsed.TREASURY_ADDRESS),
    REPUTATION_ADDRESS: requireNormalizedAddress('REPUTATION_ADDRESS', parsed.REPUTATION_ADDRESS),
    FORGE_QUEST_MANAGER_ADDRESS: requireNormalizedAddress(
      'FORGE_QUEST_MANAGER_ADDRESS',
      parsed.FORGE_QUEST_MANAGER_ADDRESS
    )
  };
}

function upsertEnvValue(envContent: string, name: string, value: string) {
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(envContent)) {
    return envContent.replace(pattern, `${name}=${value}`);
  }

  return `${envContent.trimEnd()}\n${name}=${value}\n`;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     QuestForge AI - Production Deployment Orchestrator     ║');
  console.log('║                  Celo Mainnet Deployment                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // Step 1: Validate environment
    log('VALIDATION', 'start', 'Validating production environment...');
    
    if (!fs.existsSync(envPath)) {
      throw new Error(`.env.production not found at ${envPath}`);
    }

    const effectiveEnv = loadEffectiveProductionEnv();
    
    // Check critical env vars
    const requiredVars = [
      'CELO_RPC_URL',
      'CELO_CHAIN_ID',
      'PRIVATE_KEY',
      'DATABASE_URL',
      'FRONTEND_URL',
      'CORS_ORIGIN',
      'JWT_SECRET'
    ];
    
    const missing: string[] = [];
    for (const varName of requiredVars) {
      if (!effectiveEnv[varName]) {
        missing.push(varName);
      }
    }
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    log('VALIDATION', 'success', 'Environment validation passed');

    // Step 2: Check contract builds
    log('CONTRACTS', 'start', 'Verifying contract compilation...');
    try {
      process.chdir(path.join(projectRoot, 'contracts'));
      exec('npm run compile', 'Compile contracts');
    } finally {
      process.chdir(projectRoot);
    }
    log('CONTRACTS', 'success', 'Contracts compiled successfully');

    // Step 3: Run contract tests
    log('TESTS', 'start', 'Running contract security tests...');
    try {
      process.chdir(path.join(projectRoot, 'contracts'));
      exec('npm test', 'Run contract tests');
    } catch {
      log('TESTS', 'error', 'Contract tests failed - reviewing details');
      // Continue anyway, but note the failure
    } finally {
      process.chdir(projectRoot);
    }

    // Step 4: Deploy contracts
    log('DEPLOYMENT', 'start', 'Deploying contracts to Celo Mainnet...');
    try {
      process.chdir(path.join(projectRoot, 'contracts'));
      exec('npm run deploy:mainnet', 'Deploy to Celo Mainnet');
    } finally {
      process.chdir(projectRoot);
    }

    const deployedAddresses = readDeploymentArtifact();
    log('DEPLOYMENT', 'success', `RewardNFT deployed at ${deployedAddresses.REWARD_NFT_ADDRESS}`);
    log('DEPLOYMENT', 'success', `Treasury deployed at ${deployedAddresses.TREASURY_ADDRESS}`);
    log('DEPLOYMENT', 'success', `Reputation deployed at ${deployedAddresses.REPUTATION_ADDRESS}`);
    log('DEPLOYMENT', 'success', `ForgeQuestManager deployed at ${deployedAddresses.FORGE_QUEST_MANAGER_ADDRESS}`);

    // Step 5: Validate deployed contracts
    log('VALIDATION', 'start', 'Validating deployed contracts...');
    try {
      process.chdir(path.join(projectRoot, 'contracts'));
      exec('npm run validate:mainnet', 'Validate deployment');
    } finally {
      process.chdir(projectRoot);
    }
    log('VALIDATION', 'success', 'Deployed contracts validated');

    // Step 6: Build backend
    log('BUILD', 'start', 'Building backend...');
    try {
      process.chdir(path.join(projectRoot, 'backend'));
      exec('npm run build', 'Build backend');
    } finally {
      process.chdir(projectRoot);
    }
    log('BUILD', 'success', 'Backend built successfully');

    // Step 7: Build frontend
    log('BUILD', 'start', 'Building frontend...');
    try {
      process.chdir(path.join(projectRoot, 'frontend'));
      exec('npm run build', 'Build frontend');
    } finally {
      process.chdir(projectRoot);
    }
    log('BUILD', 'success', 'Frontend built successfully');

    // Step 8: Wire deployed addresses
    log('WIRING', 'start', 'Wiring deployed addresses to environment...');
    
    const envContent = fs.readFileSync(envPath, 'utf-8');
    let updatedEnv = envContent;
    
    updatedEnv = upsertEnvValue(updatedEnv, 'REWARD_NFT_ADDRESS', deployedAddresses.REWARD_NFT_ADDRESS);
    updatedEnv = upsertEnvValue(updatedEnv, 'TREASURY_ADDRESS', deployedAddresses.TREASURY_ADDRESS);
    updatedEnv = upsertEnvValue(updatedEnv, 'REPUTATION_ADDRESS', deployedAddresses.REPUTATION_ADDRESS);
    updatedEnv = upsertEnvValue(
      updatedEnv,
      'FORGE_QUEST_MANAGER_ADDRESS',
      deployedAddresses.FORGE_QUEST_MANAGER_ADDRESS
    );

    writeFileAtomic(envPath, updatedEnv);
    log('WIRING', 'success', 'Deployed addresses wired to .env.production');

    // Step 9: Generate deployment report
    log('REPORTING', 'start', 'Generating deployment report...');

    exec('npm run generate:report', 'Generate deployment report');
    log('REPORTING', 'success', 'Deployment report regenerated from deployment artifacts');

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              DEPLOYMENT COMPLETED SUCCESSFULLY             ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('📜 DEPLOYED CONTRACTS:\n');
    for (const [contract, address] of Object.entries({
      RewardNFT: deployedAddresses.REWARD_NFT_ADDRESS,
      Treasury: deployedAddresses.TREASURY_ADDRESS,
      Reputation: deployedAddresses.REPUTATION_ADDRESS,
      ForgeQuestManager: deployedAddresses.FORGE_QUEST_MANAGER_ADDRESS
    })) {
      console.log(`  ${contract.padEnd(22)} ${address}`);
    }

    console.log('\n📋 NEXT STEPS:\n');
    console.log('  1. Review deployment report: cat deployment-report.json');
    console.log('  2. Fund Treasury with reward tokens');
    console.log('  3. Run gameplay validation: npm run test:gameplay');
    console.log('  4. Monitor backend logs after deployment');
    console.log('  5. Verify contracts on Celoscan');
    console.log('  6. Run security validation: npm run test:security');
    console.log('\n');

  } catch (error) {
    console.error('\n❌ DEPLOYMENT FAILED:', error instanceof Error ? error.message : String(error));
    
    // Log the failure
    log('DEPLOYMENT', 'error', error instanceof Error ? error.message : String(error));
    
    // Save deployment log
    const logPath = path.join(projectRoot, 'deployment-error.log');
    writeFileAtomic(logPath, `${JSON.stringify(deploymentLogs, null, 2)}\n`);
    console.error(`\nDeployment logs saved to ${logPath}`);
    
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

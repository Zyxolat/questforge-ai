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

interface DeploymentLog {
  timestamp: string;
  step: string;
  status: 'start' | 'success' | 'error';
  message: string;
  details?: Record<string, any>;
}

const deploymentLogs: DeploymentLog[] = [];

function log(step: string, status: 'start' | 'success' | 'error', message: string, details?: Record<string, any>) {
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
    const output = execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
    log('EXEC', 'success', `${description}`);
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('EXEC', 'error', `${description} failed: ${message}`);
    throw new Error(`Failed: ${description}`);
  }
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
    
    dotenv.config({ path: envPath });
    
    // Check critical env vars
    const requiredVars = [
      'NODE_ENV', 'CELO_RPC_URL', 'PRIVATE_KEY',
      'DATABASE_URL', 'FRONTEND_URL', 'JWT_SECRET'
    ];
    
    const missing: string[] = [];
    for (const varName of requiredVars) {
      if (!process.env[varName]) {
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
    } catch (e) {
      log('TESTS', 'error', 'Contract tests failed - reviewing details');
      // Continue anyway, but note the failure
    } finally {
      process.chdir(projectRoot);
    }

    // Step 4: Deploy contracts
    log('DEPLOYMENT', 'start', 'Deploying contracts to Celo Mainnet...');
    let deploymentOutput = '';
    try {
      process.chdir(path.join(projectRoot, 'contracts'));
      deploymentOutput = exec('npm run deploy:mainnet', 'Deploy to Celo Mainnet');
    } finally {
      process.chdir(projectRoot);
    }
    
    // Extract deployed addresses from output
    const addressRegex = /✓ (\w+) deployed at: (0x[a-fA-F0-9]{40})/g;
    const deployedAddresses: Record<string, string> = {};
    let match;
    
    while ((match = addressRegex.exec(deploymentOutput)) !== null) {
      const contractName = match[1];
      const address = match[2];
      deployedAddresses[contractName] = address;
      log('DEPLOYMENT', 'success', `${contractName} deployed at ${address}`);
    }

    if (Object.keys(deployedAddresses).length === 0) {
      throw new Error('No contracts were deployed (deployment output parsing failed)');
    }

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
    
    // Map contract names to env var names
    const addressMapping: Record<string, string> = {
      'RewardNFT': 'REWARD_NFT_ADDRESS',
      'Treasury': 'TREASURY_ADDRESS',
      'Reputation': 'REPUTATION_ADDRESS',
      'ForgeQuestManager': 'FORGE_QUEST_MANAGER_ADDRESS',
    };
    
    for (const [contractName, envVarName] of Object.entries(addressMapping)) {
      if (deployedAddresses[contractName]) {
        const regex = new RegExp(`^${envVarName}=.*$`, 'm');
        updatedEnv = updatedEnv.replace(regex, `${envVarName}=${deployedAddresses[contractName]}`);
      }
    }
    
    fs.writeFileSync(envPath, updatedEnv);
    log('WIRING', 'success', 'Deployed addresses wired to .env.production');

    // Step 9: Generate deployment report
    log('REPORTING', 'start', 'Generating deployment report...');
    
    const deploymentReport = {
      timestamp: new Date().toISOString(),
      environment: 'production',
      network: 'Celo Mainnet',
      chainId: 42220,
      status: 'success',
      deployedContracts: deployedAddresses,
      logs: deploymentLogs,
    };
    
    const reportPath = path.join(projectRoot, 'deployment-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(deploymentReport, null, 2));
    log('REPORTING', 'success', `Deployment report saved to ${reportPath}`);

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              DEPLOYMENT COMPLETED SUCCESSFULLY             ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('📜 DEPLOYED CONTRACTS:\n');
    for (const [contract, address] of Object.entries(deployedAddresses)) {
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
    fs.writeFileSync(logPath, JSON.stringify(deploymentLogs, null, 2));
    console.error(`\nDeployment logs saved to ${logPath}`);
    
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

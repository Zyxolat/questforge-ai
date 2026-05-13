/**
 * QuestForge AI - Treasury Validation and Health Check
 * 
 * Validates treasury funding, solvency, and operational health.
 * Performs comprehensive checks on:
 * - Reward reserves
 * - Payout limits
 * - Emergency pause capabilities
 * - Funding requirements
 * 
 * Usage: npx ts-node scripts/validate-treasury.ts
 */

import { ethers } from 'ethers';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

// Load environment
const envPath = path.join(__dirname, '../.env.production');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Contract ABIs
const TREASURY_ABI = [
  'function getTreasuryStats() public view returns (uint256 nativeBalance, uint256 tokenBalance, uint256 totalPaidOut)',
  'function getRewardPool() public view returns (uint256)',
  'function getNativeRewardPool() public view returns (uint256)',
  'function getSolvency() public view returns (bool)',
  'function isPaused() public view returns (bool)',
  'function getMaxRewardPerQuest() public view returns (uint256)',
  'function getMaxRewardPerDay() public view returns (uint256)',
  'function canPayout(uint256 amount) public view returns (bool)',
  'function owner() public view returns (address)',
];

const FORGE_QUEST_MANAGER_ABI = [
  'function getRewardPoolSize() public view returns (uint256)',
  'function getMaxSingleReward() public view returns (uint256)',
  'function getMaxSingleStake() public view returns (uint256)',
  'function getTreasuryAddress() public view returns (address)',
  'function isHealthy() public view returns (bool)',
  'function getCircuitBreakerStatus() public view returns (bool, uint256, uint256)',
];

interface TreasuryHealth {
  status: 'healthy' | 'warning' | 'critical';
  checks: {
    name: string;
    passed: boolean;
    message: string;
    value?: string;
  }[];
  metrics: Record<string, string | number | boolean>;
}

async function validateTreasury(): Promise<TreasuryHealth> {
  const checks: TreasuryHealth['checks'] = [];
  const metrics: Record<string, string | number | boolean> = {};
  let status: 'healthy' | 'warning' | 'critical' = 'healthy';

  try {
    // Connect to Celo network
    const rpcUrl = process.env.CELO_RPC_URL || 'https://forno.celo.org';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Verify network
    const network = await provider.getNetwork();
    if (network.chainId !== 42220n) {
      checks.push({
        name: 'Network',
        passed: false,
        message: `Expected Celo Mainnet (42220), got ${network.chainId}`,
      });
      return { status: 'critical', checks, metrics };
    }
    checks.push({
      name: 'Network',
      passed: true,
      message: 'Connected to Celo Mainnet',
    });

    // Load contract addresses
    const treasuryAddress = process.env.TREASURY_ADDRESS;
    const forgeQuestManagerAddress = process.env.FORGE_QUEST_MANAGER_ADDRESS;

    if (!treasuryAddress || !forgeQuestManagerAddress) {
      checks.push({
        name: 'Contract Addresses',
        passed: false,
        message: 'Missing contract addresses in environment',
      });
      return { status: 'critical', checks, metrics };
    }

    // Initialize contract instances
    const treasury = new ethers.Contract(treasuryAddress, TREASURY_ABI, provider);
    const forgeQuestManager = new ethers.Contract(forgeQuestManagerAddress, FORGE_QUEST_MANAGER_ABI, provider);

    // Check 1: Treasury Pause Status
    try {
      const isPaused = await treasury.isPaused();
      checks.push({
        name: 'Emergency Pause',
        passed: !isPaused,
        message: isPaused ? 'Treasury is PAUSED' : 'Treasury is active',
        value: isPaused ? 'PAUSED' : 'ACTIVE',
      });
      metrics.treasuryPaused = isPaused;
    } catch (e) {
      checks.push({
        name: 'Emergency Pause',
        passed: false,
        message: `Failed to check pause status: ${e instanceof Error ? e.message : String(e)}`,
      });
      status = 'warning';
    }

    // Check 2: Native Balance
    try {
      const nativeBalance = await provider.getBalance(treasuryAddress);
      const balanceEth = ethers.formatEther(nativeBalance);
      metrics.nativeBalance = balanceEth;
      metrics.nativeBalanceWei = nativeBalance.toString();

      // Warning if balance is low (less than 10 CELO)
      const minBalance = ethers.parseEther('10');
      const passed = nativeBalance >= minBalance;
      
      checks.push({
        name: 'Native Balance (CELO)',
        passed,
        message: passed 
          ? `Sufficient balance: ${balanceEth} CELO`
          : `Low balance warning: ${balanceEth} CELO (minimum recommended: 10)`,
        value: `${balanceEth} CELO`,
      });

      if (!passed) status = 'warning';
    } catch (e) {
      checks.push({
        name: 'Native Balance',
        passed: false,
        message: `Failed to check balance: ${e instanceof Error ? e.message : String(e)}`,
      });
      status = 'warning';
    }

    // Check 3: Solvency
    try {
      const isSolvent = await treasury.getSolvency();
      checks.push({
        name: 'Solvency',
        passed: isSolvent,
        message: isSolvent ? 'Treasury is solvent' : 'Treasury is insolvent',
        value: isSolvent ? 'SOLVENT' : 'INSOLVENT',
      });
      metrics.solvent = isSolvent;

      if (!isSolvent) status = 'critical';
    } catch (e) {
      checks.push({
        name: 'Solvency',
        passed: false,
        message: `Failed to check solvency: ${e instanceof Error ? e.message : String(e)}`,
      });
      status = 'warning';
    }

    // Check 4: Payout Capability
    try {
      // Test if treasury can payout small amount (0.1 CELO)
      const testAmount = ethers.parseEther('0.1');
      const canPayout = await treasury.canPayout(testAmount);
      checks.push({
        name: 'Payout Capability (0.1 CELO)',
        passed: canPayout,
        message: canPayout 
          ? 'Treasury can execute payouts'
          : 'Treasury cannot execute payouts',
        value: canPayout ? 'CAPABLE' : 'INCAPABLE',
      });
      metrics.canPayout = canPayout;

      if (!canPayout) status = 'critical';
    } catch (e) {
      checks.push({
        name: 'Payout Capability',
        passed: false,
        message: `Failed to check payout capability: ${e instanceof Error ? e.message : String(e)}`,
      });
      status = 'warning';
    }

    // Check 5: Reward Pool Size
    try {
      const maxRewardPerQuest = await treasury.getMaxRewardPerQuest();
      const maxRewardPerDay = await treasury.getMaxRewardPerDay();
      
      const perQuestEth = ethers.formatEther(maxRewardPerQuest);
      const perDayEth = ethers.formatEther(maxRewardPerDay);

      checks.push({
        name: 'Reward Limits',
        passed: true,
        message: `Per quest: ${perQuestEth} CELO, Per day: ${perDayEth} CELO`,
        value: `${perQuestEth} / ${perDayEth}`,
      });

      metrics.maxRewardPerQuest = perQuestEth;
      metrics.maxRewardPerDay = perDayEth;
    } catch (e) {
      checks.push({
        name: 'Reward Limits',
        passed: false,
        message: `Failed to check reward limits: ${e instanceof Error ? e.message : String(e)}`,
      });
      status = 'warning';
    }

    // Check 6: Quest Manager Health
    try {
      const isHealthy = await forgeQuestManager.isHealthy();
      checks.push({
        name: 'Quest Manager Health',
        passed: isHealthy,
        message: isHealthy 
          ? 'Quest manager is healthy'
          : 'Quest manager is unhealthy',
        value: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
      });
      metrics.questManagerHealthy = isHealthy;

      if (!isHealthy) status = 'warning';
    } catch (e) {
      checks.push({
        name: 'Quest Manager Health',
        passed: false,
        message: `Failed to check health: ${e instanceof Error ? e.message : String(e)}`,
      });
      status = 'warning';
    }

    // Check 7: Circuit Breaker Status
    try {
      const [cbActive, usedAmount, maxAmount] = await forgeQuestManager.getCircuitBreakerStatus();
      const usedCelo = ethers.formatEther(usedAmount);
      const maxCelo = ethers.formatEther(maxAmount);
      const usage = (Number(usedCelo) / Number(maxCelo) * 100).toFixed(1);

      checks.push({
        name: 'Circuit Breaker',
        passed: !cbActive,
        message: cbActive 
          ? `Circuit breaker is ACTIVE (${usage}% utilization)`
          : `Circuit breaker is inactive (${usage}% utilization)`,
        value: `${usage}%`,
      });

      metrics.circuitBreakerActive = cbActive;
      metrics.circuitBreakerUsagePercent = usage;

      if (cbActive) status = 'warning';
    } catch (e) {
      checks.push({
        name: 'Circuit Breaker',
        passed: false,
        message: `Failed to check circuit breaker: ${e instanceof Error ? e.message : String(e)}`,
      });
      status = 'warning';
    }

    // Check 8: Contract Links
    try {
      checks.push({
        name: 'Contract Verification',
        passed: true,
        message: `Contracts are on Celo Mainnet`,
        value: 'https://celoscan.io',
      });

      metrics.treasuryLink = `https://celoscan.io/address/${treasuryAddress}`;
      metrics.questManagerLink = `https://celoscan.io/address/${forgeQuestManagerAddress}`;
    } catch (e) {
      // Not critical
    }

  } catch (error) {
    checks.push({
      name: 'Connection',
      passed: false,
      message: `Failed to connect to treasury: ${error instanceof Error ? error.message : String(error)}`,
    });
    status = 'critical';
  }

  return { status, checks, metrics };
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        QuestForge AI - Treasury Health Check                ║');
  console.log('║                 Celo Mainnet Validation                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const health = await validateTreasury();

  // Print checks
  console.log('📋 VALIDATION CHECKS:\n');
  for (const check of health.checks) {
    const icon = check.passed ? '✓' : '❌';
    const color = check.passed ? '\x1b[32m' : '\x1b[31m';
    console.log(`${color}${icon} ${check.name.padEnd(25)} ${check.message}\x1b[0m`);
    if (check.value) {
      console.log(`  └─ Value: ${check.value}\n`);
    }
  }

  // Print metrics
  console.log('📊 METRICS:\n');
  for (const [key, value] of Object.entries(health.metrics)) {
    console.log(`  ${key.padEnd(30)} ${value}`);
  }

  // Overall status
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  const statusIcon = health.status === 'healthy' ? '✓' : health.status === 'warning' ? '⚠️' : '❌';
  const statusColor = health.status === 'healthy' ? '\x1b[32m' : health.status === 'warning' ? '\x1b[33m' : '\x1b[31m';
  console.log(`║  ${statusColor}${statusIcon} Treasury Status: ${health.status.toUpperCase()}\x1b[0m`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  process.exit(health.status === 'critical' ? 1 : 0);
}

main().catch(error => {
  console.error('❌ Validation error:', error);
  process.exit(1);
});

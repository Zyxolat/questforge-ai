import * as fs from 'fs';
import * as path from 'path';
import hre from 'hardhat';

const CELO_MAINNET_CHAIN_ID = 42220;
const DEFAULT_VERIFY_RETRIES = 10;
const DEFAULT_VERIFY_RETRY_DELAY_MS = 15_000;

type DeploymentAddresses = {
  REWARD_NFT_ADDRESS: string;
  TREASURY_ADDRESS: string;
  REPUTATION_ADDRESS: string;
  FORGE_QUEST_MANAGER_ADDRESS: string;
  VERIFIER_ADDRESS: string;
  DEPLOYER_ADDRESS: string;
  NETWORK: string;
  CHAIN_ID: string;
};

type VerificationTarget = {
  name: string;
  address: string;
  constructorArguments: unknown[];
  contract: string;
};

function readOptionalEnv(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  if (/^\$\{\{.+\}\}$/.test(raw) || /^\$\{.+\}$/.test(raw)) {
    return undefined;
  }

  return raw;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number) {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createErrorWithCause(message: string, cause: unknown) {
  const wrappedError = new Error(message) as Error & { cause?: unknown };
  wrappedError.cause = cause;
  return wrappedError;
}

function loadDeploymentAddresses(networkName: string): DeploymentAddresses {
  const artifactPath = path.join(__dirname, '..', 'deployments', `${networkName}-addresses.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Deployment artifact not found for network "${networkName}" at ${artifactPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Partial<DeploymentAddresses>;
  const requiredKeys: Array<keyof DeploymentAddresses> = [
    'REWARD_NFT_ADDRESS',
    'TREASURY_ADDRESS',
    'REPUTATION_ADDRESS',
    'FORGE_QUEST_MANAGER_ADDRESS',
    'VERIFIER_ADDRESS',
    'DEPLOYER_ADDRESS',
    'NETWORK',
    'CHAIN_ID'
  ];

  for (const key of requiredKeys) {
    if (!parsed[key] || typeof parsed[key] !== 'string') {
      throw new Error(`Deployment artifact is missing ${key}`);
    }
  }

  return parsed as DeploymentAddresses;
}

function buildVerificationTargets(addresses: DeploymentAddresses): VerificationTarget[] {
  return [
    {
      name: 'RewardNFT',
      address: addresses.REWARD_NFT_ADDRESS,
      constructorArguments: [addresses.DEPLOYER_ADDRESS],
      contract: 'contracts/RewardNFT.sol:RewardNFT'
    },
    {
      name: 'Treasury',
      address: addresses.TREASURY_ADDRESS,
      constructorArguments: [],
      contract: 'contracts/Treasury.sol:Treasury'
    },
    {
      name: 'Reputation',
      address: addresses.REPUTATION_ADDRESS,
      constructorArguments: [],
      contract: 'contracts/Reputation.sol:Reputation'
    },
    {
      name: 'ForgeQuestManager',
      address: addresses.FORGE_QUEST_MANAGER_ADDRESS,
      constructorArguments: [
        addresses.REWARD_NFT_ADDRESS,
        addresses.REPUTATION_ADDRESS,
        addresses.TREASURY_ADDRESS
      ],
      contract: 'contracts/ForgeQuestManager.sol:ForgeQuestManager'
    }
  ];
}

async function verifyTarget(target: VerificationTarget, retries: number, retryDelayMs: number) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await hre.run('verify:verify', {
        address: target.address,
        constructorArguments: target.constructorArguments,
        contract: target.contract
      });

      console.log(`✅ Verified ${target.name}: ${target.address}`);
      return;
    } catch (error) {
      const message = getErrorMessage(error);

      if (/already verified/i.test(message)) {
        console.log(`✅ ${target.name} already verified: ${target.address}`);
        return;
      }

      if (attempt === retries) {
        throw createErrorWithCause(
          `Verification failed for ${target.name} after ${retries} attempts: ${message}`,
          error
        );
      }

      console.warn(
        `⏳ Verification attempt ${attempt}/${retries} failed for ${target.name}: ${message}. Retrying in ${retryDelayMs}ms...`
      );
      await sleep(retryDelayMs);
    }
  }
}

async function main() {
  const networkName = hre.network.name;
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (networkName !== 'celo' || chainId !== CELO_MAINNET_CHAIN_ID) {
    throw new Error(
      `Contract verification is configured for Celo Mainnet only. Received network=${networkName} chainId=${chainId}.`
    );
  }

  const explorerApiKey = readOptionalEnv('CELOSCAN_API_KEY') || readOptionalEnv('ETHERSCAN_API_KEY');
  if (!explorerApiKey) {
    throw new Error(
      'Missing CELOSCAN_API_KEY (or ETHERSCAN_API_KEY fallback). Set it before running contract verification.'
    );
  }

  const retries = parsePositiveInt(
    'CONTRACT_VERIFICATION_RETRIES',
    readOptionalEnv('CONTRACT_VERIFICATION_RETRIES'),
    DEFAULT_VERIFY_RETRIES
  );
  const retryDelayMs = parsePositiveInt(
    'CONTRACT_VERIFICATION_RETRY_DELAY_MS',
    readOptionalEnv('CONTRACT_VERIFICATION_RETRY_DELAY_MS'),
    DEFAULT_VERIFY_RETRY_DELAY_MS
  );

  const addresses = loadDeploymentAddresses(networkName);
  const targets = buildVerificationTargets(addresses);

  console.log(`\nVerifying ${targets.length} deployed contracts on Celoscan...`);
  console.log(`Network: ${networkName}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Retries: ${retries}`);
  console.log(`Retry delay: ${retryDelayMs}ms\n`);

  for (const target of targets) {
    await verifyTarget(target, retries, retryDelayMs);
  }

  console.log('\n✅ Contract verification completed successfully.');
}

main().catch((error) => {
  console.error('\n❌ Contract verification failed');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

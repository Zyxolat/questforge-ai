import hre from 'hardhat';
import '@nomicfoundation/hardhat-ethers';
import { writeDeploymentArtifacts, type DeploymentAddresses } from './deploymentArtifacts';

const { ethers } = hre;

const CELO_MAINNET_CHAIN_ID = 42220;
const CELO_DEPLOY_CONFIRMATIONS = 2;
const DEFAULT_DEPLOY_CONFIRMATIONS = 1;
const BYTECODE_CHECK_RETRIES = 8;
const BYTECODE_CHECK_DELAY_MS = 1500;

type DeployReceipt = {
  contractAddress?: string | null;
  status?: number | null;
};

type DeployTransaction = {
  hash?: string;
  wait(confirmations?: number): Promise<DeployReceipt | null>;
};

type DeployableContract = {
  deploymentTransaction?: () => DeployTransaction | undefined;
  waitForDeployment?: () => Promise<unknown>;
  getAddress?: () => Promise<string>;
  target?: unknown;
  address?: unknown;
};

type WaitableTransaction = {
  wait?: (confirmations?: number) => Promise<unknown>;
};

/* -------------------------
   HELPERS
-------------------------- */

function readOptionalEnv(name: string) {
  return process.env[name]?.trim() || undefined;
}

function requireNormalizedAddress(name: string) {
  const raw = readOptionalEnv(name);
  if (!raw) throw new Error(`Missing env: ${name}`);

  return ethers.getAddress(raw);
}

function parseOptionalEther(name: string) {
  const raw = readOptionalEnv(name);
  return raw ? ethers.parseEther(raw) : null;
}

function isTruthyEnv(value: string | undefined) {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function requireValidPrivateKey(name: string) {
  const value = readOptionalEnv(name);
  if (!value) {
    throw new Error(
      `${name} is missing or empty. Set it in your shell or repo-root .env.production before deploying to Celo.`
    );
  }

  try {
    return new ethers.Wallet(value).privateKey;
  } catch (error) {
    throw new Error(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

function shouldUseExistingRewardToken(networkName: string) {
  return networkName === 'celo' || isTruthyEnv(readOptionalEnv('USE_EXISTING_REWARD_TOKEN'));
}

function validateCeloPrerequisites() {
  requireValidPrivateKey('PRIVATE_KEY');

  const rewardTokenAddress = readOptionalEnv('REWARD_TOKEN_ADDRESS');
  if (!rewardTokenAddress) {
    throw new Error('REWARD_TOKEN_ADDRESS is required for Celo deployments.');
  }

  try {
    ethers.getAddress(rewardTokenAddress);
  } catch (error) {
    throw new Error(`REWARD_TOKEN_ADDRESS is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

function getRequiredConfirmations() {
  return hre.network.name === 'celo' ? CELO_DEPLOY_CONFIRMATIONS : DEFAULT_DEPLOY_CONFIRMATIONS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAddressSafe(contract: DeployableContract, deploymentReceipt?: DeployReceipt): Promise<string> {
  if (!contract) throw new Error('Contract instance is undefined');

  const receiptAddress = deploymentReceipt?.contractAddress;
  if (typeof receiptAddress === 'string' && receiptAddress !== ethers.ZeroAddress) {
    return ethers.getAddress(receiptAddress);
  }

  if (typeof contract.getAddress === 'function') {
    const address = await contract.getAddress();
    if (typeof address === 'string') return ethers.getAddress(address);
  }

  if (typeof contract.target === 'string') return ethers.getAddress(contract.target);
  if (typeof contract.address === 'string') return ethers.getAddress(contract.address);

  throw new Error('Unable to resolve contract address');
}

async function getCodeWithRetry(address: string) {
  for (let attempt = 1; attempt <= BYTECODE_CHECK_RETRIES; attempt += 1) {
    const code = await ethers.provider.getCode(address);
    if (code && code !== '0x') {
      return code;
    }

    if (attempt < BYTECODE_CHECK_RETRIES) {
      await sleep(BYTECODE_CHECK_DELAY_MS);
    }
  }

  return '0x';
}

/* -------------------------
   DEPLOY CORE (FIXED)
-------------------------- */

async function deployContract(
  label: string,
  factoryFn: () => Promise<DeployableContract>
) {
  console.log(`\n🚀 Deploying ${label}...`);

  try {
    const contract = await factoryFn();

    if (!contract) {
      throw new Error(`${label}: factory returned undefined`);
    }

    const deploymentTx =
      typeof contract.deploymentTransaction === 'function'
        ? contract.deploymentTransaction()
        : undefined;

    if (!deploymentTx) {
      throw new Error(`${label}: missing deployment transaction`);
    }

    const receipt = await deploymentTx.wait(getRequiredConfirmations());
    if (!receipt) {
      throw new Error(`${label}: deployment receipt not available`);
    }

    if (receipt.status !== 1) {
      throw new Error(`${label}: deployment reverted (tx: ${deploymentTx.hash})`);
    }

    if (typeof contract.waitForDeployment === 'function') {
      await contract.waitForDeployment();
    }

    const address = await getAddressSafe(contract, receipt);

    const code = await getCodeWithRetry(address);
    if (!code || code === '0x') {
      throw new Error(
        `${label}: no bytecode at ${address} after ${BYTECODE_CHECK_RETRIES} checks (tx: ${deploymentTx.hash})`
      );
    }

    console.log(`✅ ${label}: ${address}`);

    return { contract, address };
  } catch (error) {
    throw new Error(`❌ Deployment failed (${label}): ${String(error)}`, {
      cause: error
    });
  }
}

/* -------------------------
   TX HELPER (FIXED)
-------------------------- */

async function waitForTx(label: string, fn: () => Promise<WaitableTransaction | null | undefined>) {
  console.log(`⏳ ${label}`);

  try {
    const tx = await fn();
    if (tx?.wait) await tx.wait(getRequiredConfirmations());
    console.log(`✅ ${label}`);
  } catch (error) {
    throw new Error(`❌ Tx failed (${label}): ${String(error)}`, {
      cause: error
    });
  }
}

/* -------------------------
   MAIN
-------------------------- */

async function main() {
  const networkName = hre.network.name;

  if (!['hardhat', 'localhost', 'celo'].includes(networkName)) {
    throw new Error(`Unsupported network: ${networkName}`);
  }

  if (networkName === 'celo') {
    validateCeloPrerequisites();
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];

  if (!deployer) {
    throw new Error(
      [
        'No deployer account is available for this network.',
        `Network: ${hre.network.name}.`,
        'Check the configured account list for this Hardhat network.',
        'For Celo, set a funded PRIVATE_KEY in your shell or repo-root .env.production.'
      ].join(' ')
    );
  }

  const deployerAddress = await deployer.getAddress();

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log('\n====================');
  console.log(' QUESTFORGE DEPLOY ');
  console.log('====================');

  if (networkName === 'celo' && chainId !== CELO_MAINNET_CHAIN_ID) {
    throw new Error(`Wrong chainId: ${chainId}`);
  }

  /* -------------------------
     TOKEN
  -------------------------- */

  let rewardTokenAddress = shouldUseExistingRewardToken(networkName)
    ? readOptionalEnv('REWARD_TOKEN_ADDRESS')
    : undefined;

  if (!rewardTokenAddress) {
    if (networkName === 'celo') {
      throw new Error('REWARD_TOKEN_ADDRESS required on mainnet');
    }

    const mock = await deployContract('MockERC20', async () => {
      const f = await ethers.getContractFactory('MockERC20');
      return f.deploy();
    });

    rewardTokenAddress = mock.address;
  } else {
    rewardTokenAddress = requireNormalizedAddress('REWARD_TOKEN_ADDRESS');
  }

  const verifierAddress =
    readOptionalEnv('VERIFIER_ADDRESS')
      ? requireNormalizedAddress('VERIFIER_ADDRESS')
      : deployerAddress;

  const initialNativeRewardPool = parseOptionalEther('INITIAL_NATIVE_REWARD_POOL_CELO');

  /* -------------------------
     DEPLOY CONTRACTS
  -------------------------- */

  const rewardNFT = await deployContract('RewardNFT', async () => {
    const f = await ethers.getContractFactory('RewardNFT');
    return f.deploy(deployerAddress);
  });

  const treasury = await deployContract('Treasury', async () => {
    const f = await ethers.getContractFactory('Treasury');
    return f.deploy(rewardTokenAddress);
  });

  const reputation = await deployContract('Reputation', async () => {
    const f = await ethers.getContractFactory('Reputation');
    return f.deploy();
  });

  const forgeQuestManager = await deployContract('ForgeQuestManager', async () => {
    const f = await ethers.getContractFactory('ForgeQuestManager');
    return f.deploy(
      rewardNFT.address,
      reputation.address,
      treasury.address
    );
  });

  /* -------------------------
     ROLES (FIXED ACCESS)
  -------------------------- */

  const rewardNFTContract = rewardNFT.contract;
  const treasuryContract = treasury.contract;
  const reputationContract = reputation.contract;
  const fqmContract = forgeQuestManager.contract;

  const minterRole = await rewardNFTContract.MINTER_ROLE();
  await waitForTx('MINTER_ROLE', () =>
    rewardNFTContract.grantRole(minterRole, forgeQuestManager.address)
  );

  const rewardRole = await reputationContract.REWARD_ROLE();
  await waitForTx('REWARD_ROLE', () =>
    reputationContract.grantRole(rewardRole, forgeQuestManager.address)
  );

  const questRole = await treasuryContract.QUEST_MANAGER_ROLE();
  await waitForTx('QUEST_MANAGER_ROLE', () =>
    treasuryContract.grantRole(questRole, forgeQuestManager.address)
  );

  if (verifierAddress !== deployerAddress) {
    await waitForTx('VERIFIER_ROLE', () =>
      fqmContract.grantVerifier(verifierAddress)
    );
  }

  if (initialNativeRewardPool && initialNativeRewardPool > 0n) {
    await waitForTx('FUND_TREASURY', () =>
      treasuryContract.fundNativeRewardPool({
        value: initialNativeRewardPool
      })
    );
  }

  /* -------------------------
     OUTPUT
  -------------------------- */

  const deploymentAddresses: DeploymentAddresses = {
    REWARD_NFT_ADDRESS: rewardNFT.address,
    TREASURY_ADDRESS: treasury.address,
    REPUTATION_ADDRESS: reputation.address,
    FORGE_QUEST_MANAGER_ADDRESS: forgeQuestManager.address,
    REWARD_TOKEN_ADDRESS: rewardTokenAddress,
    VERIFIER_ADDRESS: verifierAddress,
    DEPLOYER_ADDRESS: deployerAddress,
    NETWORK: networkName,
    CHAIN_ID: chainId.toString(),
    DEPLOYMENT_BLOCK: (await ethers.provider.getBlockNumber()).toString(),
    DEPLOYMENT_TIME: new Date().toISOString(),
    TREASURY_NATIVE_BALANCE: ethers.formatEther(
      await ethers.provider.getBalance(treasury.address)
    )
  };

  const artifacts = writeDeploymentArtifacts(deploymentAddresses, {
    chainId,
    networkName,
    initialNativeRewardPool
  });

  console.log('\n====================');
  console.log(' DEPLOY SUCCESS ');
  console.log('====================');
  console.log(JSON.stringify(deploymentAddresses, null, 2));
  console.log('\nArtifacts:', artifacts);
}

main().catch((err) => {
  console.error('\n❌ FAILED');
  console.error(err);
  process.exit(1);
});

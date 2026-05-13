import hre, { ethers } from 'hardhat';

const CELO_MAINNET_CHAIN_ID = 42220;
const CELO_EXPLORER_BASE_URL = 'https://celoscan.io';

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (hre.network.name === 'celo' && chainId !== CELO_MAINNET_CHAIN_ID) {
    throw new Error(`Connected chainId ${chainId} does not match Celo Mainnet (${CELO_MAINNET_CHAIN_ID}).`);
  }

  const forgeQuestManagerAddress = requireEnv('FORGE_QUEST_MANAGER_ADDRESS');
  const rewardNftAddress = requireEnv('REWARD_NFT_ADDRESS');
  const reputationAddress = requireEnv('REPUTATION_ADDRESS');
  const treasuryAddress = requireEnv('TREASURY_ADDRESS');
  const verifierPrivateKey = optionalEnv('VERIFIER_PRIVATE_KEY') || optionalEnv('PRIVATE_KEY');
  const verifierAddress = optionalEnv('VERIFIER_ADDRESS') || (verifierPrivateKey ? new ethers.Wallet(verifierPrivateKey).address : undefined);

  const forgeQuestManager = await ethers.getContractAt('ForgeQuestManager', forgeQuestManagerAddress);
  const rewardNFT = await ethers.getContractAt('RewardNFT', rewardNftAddress);
  const reputation = await ethers.getContractAt('Reputation', reputationAddress);
  const treasury = await ethers.getContractAt('Treasury', treasuryAddress);

  const [
    forgeQuestManagerCode,
    rewardNftCode,
    reputationCode,
    treasuryCode,
    minterRole,
    rewardRole,
    verifierRole,
    questManagerRole,
    managerTreasuryAddress,
    managerRewardNftAddress,
    managerReputationAddress,
    treasuryBalance,
    treasuryObligations,
    treasuryLiquidity,
    treasurySolvent
  ] = await Promise.all([
    ethers.provider.getCode(forgeQuestManagerAddress),
    ethers.provider.getCode(rewardNftAddress),
    ethers.provider.getCode(reputationAddress),
    ethers.provider.getCode(treasuryAddress),
    rewardNFT.MINTER_ROLE(),
    reputation.REWARD_ROLE(),
    forgeQuestManager.VERIFIER_ROLE(),
    treasury.QUEST_MANAGER_ROLE(),
    forgeQuestManager.treasury(),
    forgeQuestManager.rewardNFT(),
    forgeQuestManager.reputation(),
    ethers.provider.getBalance(treasuryAddress),
    treasury.obligations(),
    treasury.availableRewardLiquidity(),
    treasury.isSolvent()
  ]);

  const checks = [
    { label: 'ForgeQuestManager deployed', ok: forgeQuestManagerCode !== '0x' },
    { label: 'RewardNFT deployed', ok: rewardNftCode !== '0x' },
    { label: 'Reputation deployed', ok: reputationCode !== '0x' },
    { label: 'Treasury deployed', ok: treasuryCode !== '0x' },
    { label: 'ForgeQuestManager wired to Treasury', ok: managerTreasuryAddress.toLowerCase() === treasuryAddress.toLowerCase() },
    { label: 'ForgeQuestManager wired to RewardNFT', ok: managerRewardNftAddress.toLowerCase() === rewardNftAddress.toLowerCase() },
    { label: 'ForgeQuestManager wired to Reputation', ok: managerReputationAddress.toLowerCase() === reputationAddress.toLowerCase() },
    {
      label: 'RewardNFT minter permission granted',
      ok: await rewardNFT.hasRole(minterRole, forgeQuestManagerAddress)
    },
    {
      label: 'Reputation reward permission granted',
      ok: await reputation.hasRole(rewardRole, forgeQuestManagerAddress)
    },
    {
      label: 'Treasury quest manager permission granted',
      ok: await treasury.hasRole(questManagerRole, forgeQuestManagerAddress)
    },
    { label: 'Treasury solvent', ok: treasurySolvent }
  ];

  if (verifierAddress) {
    checks.push({
      label: `Verifier role granted to ${verifierAddress}`,
      ok: await forgeQuestManager.hasRole(verifierRole, verifierAddress)
    });
  }

  console.log('\nQuestForge AI deployment validation');
  console.log('Network:', hre.network.name);
  console.log('Chain ID:', chainId);
  console.log('Treasury balance:', ethers.formatEther(treasuryBalance), 'CELO');
  console.log('Treasury obligations:', ethers.formatEther(treasuryObligations), 'CELO');
  console.log('Treasury available liquidity:', ethers.formatEther(treasuryLiquidity), 'CELO');

  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label}`);
  }

  console.log('\nExplorer links');
  console.log('ForgeQuestManager:', `${CELO_EXPLORER_BASE_URL}/address/${forgeQuestManagerAddress}`);
  console.log('RewardNFT:', `${CELO_EXPLORER_BASE_URL}/address/${rewardNftAddress}`);
  console.log('Reputation:', `${CELO_EXPLORER_BASE_URL}/address/${reputationAddress}`);
  console.log('Treasury:', `${CELO_EXPLORER_BASE_URL}/address/${treasuryAddress}`);

  const failedChecks = checks.filter((check) => !check.ok);
  if (failedChecks.length > 0) {
    throw new Error(`Deployment validation failed with ${failedChecks.length} failing checks.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

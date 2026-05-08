import hre, { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  console.log('Deploying contracts with account:', deployer.address);

  let rewardTokenAddress = process.env.REWARD_TOKEN_ADDRESS;

  if (!rewardTokenAddress) {
    if (networkName === 'hardhat' || networkName === 'localhost') {
      console.log('\n--- Deploying MockERC20 for local network ---');
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const mockToken = await MockERC20.deploy();
      await mockToken.waitForDeployment();
      rewardTokenAddress = await mockToken.getAddress();
      console.log('✓ MockERC20 deployed at:', rewardTokenAddress);
    } else {
      throw new Error('REWARD_TOKEN_ADDRESS is required for non-local deployments');
    }
  }

  // 1. Deploy RewardNFT
  console.log('\n--- Deploying RewardNFT ---');
  const RewardNFT = await ethers.getContractFactory('RewardNFT');
  const rewardNFT = await RewardNFT.deploy(deployer.address);
  await rewardNFT.waitForDeployment();
  const rewardNFTAddress = await rewardNFT.getAddress();
  console.log('✓ RewardNFT deployed at:', rewardNFTAddress);

  // 2. Deploy Treasury
  console.log('\n--- Deploying Treasury ---');
  const Treasury = await ethers.getContractFactory('Treasury');
  const treasury = await Treasury.deploy(rewardTokenAddress);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log('✓ Treasury deployed at:', treasuryAddress);

  // 3. Deploy Reputation
  console.log('\n--- Deploying Reputation ---');
  const Reputation = await ethers.getContractFactory('Reputation');
  const reputation = await Reputation.deploy();
  await reputation.waitForDeployment();
  const reputationAddress = await reputation.getAddress();
  console.log('✓ Reputation deployed at:', reputationAddress);

  // 4. Deploy ForgeQuestManager
  console.log('\n--- Deploying ForgeQuestManager ---');
  const ForgeQuestManager = await ethers.getContractFactory('ForgeQuestManager');
  const forgeQuestManager = await ForgeQuestManager.deploy(
    rewardNFTAddress,
    reputationAddress,
    treasuryAddress
  );
  await forgeQuestManager.waitForDeployment();
  const forgeQuestManagerAddress = await forgeQuestManager.getAddress();
  console.log('✓ ForgeQuestManager deployed at:', forgeQuestManagerAddress);

  // 5. Grant MINTER_ROLE to ForgeQuestManager on RewardNFT
  console.log('\n--- Setting up access control ---');
  const minterRole = await rewardNFT.MINTER_ROLE();
  const grantMinterRoleTx = await rewardNFT.grantRole(minterRole, forgeQuestManagerAddress);
  await grantMinterRoleTx.wait();
  console.log('✓ Granted RewardNFT MINTER_ROLE to ForgeQuestManager');

  // 6. Grant REWARD_ROLE to ForgeQuestManager on Reputation
  const rewardRole = await reputation.REWARD_ROLE();
  const grantRewardRoleTx = await reputation.grantRole(rewardRole, forgeQuestManagerAddress);
  await grantRewardRoleTx.wait();
  console.log('✓ Granted Reputation REWARD_ROLE to ForgeQuestManager');

  // 7. Export deployment addresses
  const deploymentAddresses = {
    REWARD_NFT_ADDRESS: rewardNFTAddress,
    TREASURY_ADDRESS: treasuryAddress,
    REPUTATION_ADDRESS: reputationAddress,
    FORGE_QUEST_MANAGER_ADDRESS: forgeQuestManagerAddress,
    REWARD_TOKEN_ADDRESS: rewardTokenAddress,
    DEPLOYER_ADDRESS: deployer.address,
    NETWORK: networkName,
    DEPLOYMENT_BLOCK: (await ethers.provider.getBlockNumber()).toString(),
    DEPLOYMENT_TIME: new Date().toISOString(),
  };

  console.log('\n--- Deployment Addresses ---');
  console.log(JSON.stringify(deploymentAddresses, null, 2));

  // 8. Save deployment addresses to file
  const deploymentDir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const addressFile = path.join(deploymentDir, `${networkName}-addresses.json`);
  fs.writeFileSync(addressFile, JSON.stringify(deploymentAddresses, null, 2));
  console.log(`\n✓ Deployment addresses saved to: ${addressFile}`);

  // 9. Also save to .env format for backend
  const envContent = Object.entries(deploymentAddresses)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const envFile = path.join(deploymentDir, `${networkName}.env`);
  fs.writeFileSync(envFile, envContent);
  console.log(`✓ Deployment env file saved to: ${envFile}`);

  console.log('\n✅ All contracts deployed successfully!');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

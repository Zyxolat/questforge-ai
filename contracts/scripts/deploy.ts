import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying contracts with account:', deployer.address);

  const RewardNFT = await ethers.getContractFactory('RewardNFT');
  const rewardNFT = await RewardNFT.deploy();
  await rewardNFT.deployed();
  console.log('RewardNFT deployed at', rewardNFT.address);

  const Treasury = await ethers.getContractFactory('Treasury');
  const treasury = await Treasury.deploy('0x0000000000000000000000000000000000000000');
  await treasury.deployed();
  console.log('Treasury deployed at', treasury.address);

  const ForgeQuestManager = await ethers.getContractFactory('ForgeQuestManager');
  const forgeQuestManager = await ForgeQuestManager.deploy(rewardNFT.address, treasury.address);
  await forgeQuestManager.deployed();
  console.log('ForgeQuestManager deployed at', forgeQuestManager.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

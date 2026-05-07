import { ethers } from 'ethers';

const forgeQuestManagerAddress = import.meta.env.VITE_FORGE_QUEST_MANAGER_ADDRESS || '';
const rewardNFTAddress = import.meta.env.VITE_REWARD_NFT_ADDRESS || '';
const reputationAddress = import.meta.env.VITE_REPUTATION_ADDRESS || '';
const treasuryAddress = import.meta.env.VITE_TREASURY_ADDRESS || '';

const forgeQuestManagerAbi = [
  'function createQuest(string title,string metadataUri,uint256 stakeAmount,uint256 rewardAmount,uint256 durationSeconds) external',
  'function startQuest(uint256 questId) external payable',
  'function submitQuest(uint256 questId,string calldata proofUri) external',
  'function verifyQuest(uint256 questId,bool success) external',
  'function cancelQuest(uint256 questId) external'
];

const rewardNftAbi = [
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function mintQuestReward(address player,uint256 questId,string memory metadataUri) external'
];

const reputationAbi = [
  'function rewardXP(address player,uint256 xpGain,uint256 actionCount) external'
];

const treasuryAbi = [
  'function stake(address player,uint256 amount) external payable',
  'function payout(address player,uint256 amount) external',
  'function fundPool(uint256 amount) external'
];

export const getContract = (address: string, abi: any, signerOrProvider: ethers.Signer | ethers.Provider) => {
  return new ethers.Contract(address, abi, signerOrProvider);
};

export const contractAddresses = {
  forgeQuestManagerAddress,
  rewardNFTAddress,
  reputationAddress,
  treasuryAddress
};

export const contractABIs = {
  forgeQuestManagerAbi,
  rewardNftAbi,
  reputationAbi,
  treasuryAbi
};

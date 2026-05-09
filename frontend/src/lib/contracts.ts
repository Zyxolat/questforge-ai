import { ethers } from 'ethers';
import { env } from './env';

const forgeQuestManagerAddress = env.FORGE_QUEST_MANAGER_ADDRESS;
const rewardNFTAddress = env.REWARD_NFT_ADDRESS;
const reputationAddress = env.REPUTATION_ADDRESS;
const treasuryAddress = env.TREASURY_ADDRESS;

const forgeQuestManagerAbi = [
  'function createQuest(string title,string metadataUri,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external',
  'function startQuest(uint256 questId) external payable',
  'function submitQuest(uint256 questId,string calldata proofUri) external',
  'function cancelQuest(uint256 questId) external',
  'function quests(uint256) view returns (uint256 questId,address creator,string title,string metadataUri,string proofUri,bytes32 proofHash,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 createdAt,uint256 startedAt,uint256 expiresAt,uint8 status,address player,uint256 playerNonce,bytes32 proofVerificationHash)'
];

const rewardNftAbi = [
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function mintQuestReward(address player,uint256 questId,string memory metadataUri) external',
  'event RewardMinted(address indexed player,uint256 indexed tokenId,uint256 questId)'
];

const reputationAbi = [
  'function profileFor(address player) view returns (uint256 xp,uint256 level,uint256 questCount,uint256 streak,uint256 onchainActions,uint256 lastQuestAt)'
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

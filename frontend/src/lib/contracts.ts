import { ethers } from 'ethers';
import { env } from './env';

const forgeQuestManagerAddress = env.FORGE_QUEST_MANAGER_ADDRESS;
const rewardNFTAddress = env.REWARD_NFT_ADDRESS;
const reputationAddress = env.REPUTATION_ADDRESS;
const treasuryAddress = env.TREASURY_ADDRESS;

const forgeQuestManagerAbi: ethers.InterfaceAbi = [
  'function createQuest(string title,string metadataUri,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external',
  'function startQuest(uint256 questId) external payable',
  'function submitQuest(uint256 questId,string calldata proofUri) external',
  'function cancelQuest(uint256 questId) external',
  'function quests(uint256) view returns (uint256 questId,address creator,string title,string metadataUri,string proofUri,bytes32 proofHash,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 createdAt,uint256 startedAt,uint256 expiresAt,uint8 status,address player,uint256 playerNonce,bytes32 proofVerificationHash)',
  'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount,uint256 xpReward)',
  'event QuestStarted(uint256 indexed questId,address indexed creator,address indexed player,uint256 stakeAmount)',
  'event QuestSubmitted(uint256 indexed questId,address indexed player,bytes32 proofHash)',
  'event QuestVerified(uint256 indexed questId,address indexed player,bool success,uint256 rewardAmount,uint256 xpReward,bytes32 proofHash)'
];

const rewardNftAbi: ethers.InterfaceAbi = [
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function mintQuestReward(address player,uint256 questId,string memory metadataUri) external',
  'event RewardMinted(address indexed player,uint256 indexed tokenId,uint256 questId)'
];

const reputationAbi: ethers.InterfaceAbi = [
  'function profileFor(address player) view returns (uint256 xp,uint256 level,uint256 questCount,uint256 streak,uint256 onchainActions,uint256 lastQuestAt)'
];

const treasuryAbi: ethers.InterfaceAbi = [
  'function questFunds(uint256) view returns (uint256 reservedReward,uint256 lockedStake,address player,uint8 state)',
  'function availableRewardLiquidity() view returns (uint256)',
  'function isSolvent() view returns (bool)',
  'function fundNativeRewardPool() external payable',
  'event RewardReserved(uint256 indexed questId,address indexed creator,uint256 amount,uint256 totalReservedRewards)',
  'event RewardPaid(uint256 indexed questId,address indexed player,uint256 rewardAmount,uint256 stakeAmount,uint256 totalPayout)',
  'event RewardRefunded(uint256 indexed questId,address indexed recipient,uint256 rewardAmount,uint256 stakeAmount,bytes32 reason)'
];

export const getContract = (address: string, abi: ethers.InterfaceAbi, signerOrProvider: ethers.Signer | ethers.Provider) => {
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

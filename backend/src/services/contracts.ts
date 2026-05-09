import { ethers } from 'ethers';
import { env } from '../config/env';

const provider = new ethers.JsonRpcProvider(env.CELO_RPC_URL, env.CELO_CHAIN_ID);
const verifierSigner = env.VERIFIER_PRIVATE_KEY ? new ethers.Wallet(env.VERIFIER_PRIVATE_KEY, provider) : null;

const forgeQuestManagerAddress = env.FORGE_QUEST_MANAGER_ADDRESS;
const rewardNFTAddress = env.REWARD_NFT_ADDRESS;
const reputationAddress = env.REPUTATION_ADDRESS;
const treasuryAddress = env.TREASURY_ADDRESS;

const ForgeQuestManagerABI = [
  'function createQuest(string title,string metadataUri,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external',
  'function startQuest(uint256 questId) external payable',
  'function submitQuest(uint256 questId,string calldata proofUri) external',
  'function verifyQuest(uint256 questId,bool success,bytes32 proofVerificationHash) external',
  'function cancelQuest(uint256 questId) external',
  'function playerNonces(address player) view returns (uint256)',
  'function quests(uint256) view returns (uint256 questId,address creator,string title,string metadataUri,string proofUri,bytes32 proofHash,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 createdAt,uint256 startedAt,uint256 expiresAt,uint8 status,address player,uint256 playerNonce,bytes32 proofVerificationHash)',
  'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount,uint256 xpReward)',
  'event QuestStarted(uint256 indexed questId,address indexed creator,address indexed player,uint256 stakeAmount)',
  'event QuestSubmitted(uint256 indexed questId,address indexed player,bytes32 proofHash)',
  'event QuestVerified(uint256 indexed questId,address indexed player,bool success,uint256 rewardAmount,uint256 xpReward,bytes32 proofHash)'
];

const RewardNFTABI = [
  'function tokenURI(uint256 tokenId) public view returns (string memory)',
  'event RewardMinted(address indexed player,uint256 indexed tokenId,uint256 questId)'
];

const ReputationABI = [
  'function profileFor(address player) view returns (uint256 xp,uint256 level,uint256 questCount,uint256 streak,uint256 onchainActions,uint256 lastQuestAt)'
];

const TreasuryABI = [
  'function pause() external',
  'function unpause() external'
];

const forgeQuestManager = new ethers.Contract(forgeQuestManagerAddress, ForgeQuestManagerABI, provider) as ethers.Contract;

export const contracts = {
  provider,
  verifierSigner,
  forgeQuestManager,
  forgeQuestManagerWrite: verifierSigner ? (forgeQuestManager.connect(verifierSigner) as ethers.Contract) : null,
  rewardNFT: new ethers.Contract(rewardNFTAddress, RewardNFTABI, provider),
  reputation: new ethers.Contract(reputationAddress, ReputationABI, provider),
  treasury: new ethers.Contract(treasuryAddress, TreasuryABI, provider)
};

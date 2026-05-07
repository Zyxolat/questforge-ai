import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const rpcUrl = process.env.CELO_NODE_URL || 'https://alfajores-forno.celo-testnet.org';
const privateKey = process.env.PRIVATE_KEY || '';
const provider = new ethers.JsonRpcProvider(rpcUrl);
const signer = privateKey ? new ethers.Wallet(privateKey, provider) : provider;

const forgeQuestManagerAddress = process.env.FORGE_QUEST_MANAGER_ADDRESS || '';
const rewardNFTAddress = process.env.REWARD_NFT_ADDRESS || '';
const reputationAddress = process.env.REPUTATION_ADDRESS || '';
const treasuryAddress = process.env.TREASURY_ADDRESS || '';

const ForgeQuestManagerABI = [
  'function createQuest(string title,string metadataUri,uint256 stakeAmount,uint256 rewardAmount,uint256 durationSeconds) external',
  'function startQuest(uint256 questId) external payable',
  'function submitQuest(uint256 questId,string calldata proofUri) external',
  'function verifyQuest(uint256 questId,bool success) external',
  'function cancelQuest(uint256 questId) external',
  'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount)'
];

const RewardNFTABI = [
  'function tokenURI(uint256 tokenId) public view returns (string memory)',
  'function mintQuestReward(address player,uint256 questId,string memory metadataUri) external'
];

const ReputationABI = [
  'function rewardXP(address player,uint256 xpGain,uint256 actionCount) external'
];

const TreasuryABI = [
  'function stake(address player,uint256 amount) external payable',
  'function payout(address player,uint256 amount) external',
  'function fundPool(uint256 amount) external'
];

export const contracts = {
  provider,
  signer,
  forgeQuestManager: new ethers.Contract(forgeQuestManagerAddress, ForgeQuestManagerABI, signer),
  rewardNFT: new ethers.Contract(rewardNFTAddress, RewardNFTABI, signer),
  reputation: new ethers.Contract(reputationAddress, ReputationABI, signer),
  treasury: new ethers.Contract(treasuryAddress, TreasuryABI, signer)
};

export function parseJSON(text: string) {
  try {
    const start = text.indexOf('{');
    const raw = start >= 0 ? text.slice(start) : text;
    return JSON.parse(raw.replace(/\n/g, ' '));
  } catch (error) {
    return null;
  }
}

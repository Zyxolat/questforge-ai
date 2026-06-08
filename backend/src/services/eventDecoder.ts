import { ethers } from 'ethers';
import { env } from '../config/env';
import { logger } from './logger';

export interface DecodedEvent {
  eventType: string;
  eventName: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  blockTimestamp: Date;
  contractAddress: string;
  fromAddress: string;
  toAddress?: string;
  data: Record<string, unknown>;
  chainQuestId?: bigint;
  playerWallet?: string;
  creatorWallet?: string;
}

const QUEST_MANAGER_ABI = [
  'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount,uint256 xpReward)',
  'event QuestSubmitted(uint256 indexed questId,address indexed player,bytes32 proofHash)',
  'event QuestVerified(uint256 indexed questId,address indexed player,bool success,uint256 rewardAmount,uint256 xpReward,bytes32 proofHash)',
  'event QuestRewarded(uint256 indexed questId,address indexed player,uint256 rewardAmount,uint256 xpReward,bytes32 proofHash)'
];

const REWARD_NFT_ABI = [
  'event RewardMinted(address indexed player,uint256 indexed tokenId,uint256 questId)'
];

const TREASURY_ABI = [
  'event RewardReserved(uint256 indexed questId,address indexed creator,uint256 amount,uint256 totalReservedRewards)',
  'event RewardReleased(uint256 indexed questId,address indexed player,uint256 rewardAmount,uint256 totalPayout)',
  'event RewardPaid(uint256 indexed questId,address indexed player,uint256 rewardAmount,uint256 totalPayout)',
  'event RewardRefunded(uint256 indexed questId,address indexed recipient,uint256 rewardAmount,bytes32 reason)'
];

// Create interfaces
const questManagerInterface = new ethers.Interface(QUEST_MANAGER_ABI);
const rewardNFTInterface = new ethers.Interface(REWARD_NFT_ABI);
const treasuryInterface = new ethers.Interface(TREASURY_ABI);

type EventDecoderFunc = (log: ethers.Log, blockTimestamp: Date) => DecodedEvent | null;

const decoders: Record<string, EventDecoderFunc> = {
  // Quest Events
  [env.FORGE_QUEST_MANAGER_ADDRESS.toLowerCase()]: (log, blockTimestamp) => {
    try {
      const parsed = questManagerInterface.parseLog(log);
      if (!parsed) {
        return null;
      }

      const event = parsed.args;
      let chainQuestId: bigint | undefined;
      let playerWallet: string | undefined;
      let creatorWallet: string | undefined;

      if (parsed.name === 'QuestCreated') {
        chainQuestId = event[0];
        creatorWallet = String(event[1]);
        return {
          eventType: 'quest_created',
          eventName: 'QuestCreated',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: creatorWallet,
          data: {
            questId: chainQuestId,
            creator: creatorWallet,
            title: event[2],
            rewardAmount: event[3],
            xpReward: event[4]
          },
          chainQuestId,
          creatorWallet
        };
      }

      if (parsed.name === 'QuestSubmitted') {
        chainQuestId = event[0];
        playerWallet = String(event[1]);
        return {
          eventType: 'proof_submitted',
          eventName: 'QuestSubmitted',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: playerWallet,
          data: {
            questId: chainQuestId,
            player: playerWallet,
            proofHash: event[2]
          },
          chainQuestId,
          playerWallet
        };
      }

      if (parsed.name === 'QuestVerified') {
        chainQuestId = event[0];
        playerWallet = String(event[1]);
        return {
          eventType: 'quest_verified',
          eventName: 'QuestVerified',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: playerWallet,
          data: {
            questId: chainQuestId,
            player: playerWallet,
            success: event[2],
            rewardAmount: event[3],
            xpReward: event[4],
            proofHash: event[5]
          },
          chainQuestId,
          playerWallet
        };
      }

      if (parsed.name === 'QuestRewarded') {
        chainQuestId = event[0];
        playerWallet = String(event[1]);
        return {
          eventType: 'quest_rewarded',
          eventName: 'QuestRewarded',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: playerWallet,
          data: {
            questId: chainQuestId,
            player: playerWallet,
            rewardAmount: event[2],
            xpReward: event[3],
            proofHash: event[4]
          },
          chainQuestId,
          playerWallet
        };
      }
    } catch (error) {
      logger.error('Error decoding quest manager event', {
        error: (error as Error).message,
        logIndex: Number(log.index ?? 0)
      });
    }
    return null;
  },

  // Reward NFT Events
  [env.REWARD_NFT_ADDRESS.toLowerCase()]: (log, blockTimestamp) => {
    try {
      const parsed = rewardNFTInterface.parseLog(log);
      if (!parsed || parsed.name !== 'RewardMinted') return null;

      const event = parsed.args;
      const playerWallet = String(event[0]);
      const tokenId = event[1];
      const chainQuestId = event[2];

      return {
        eventType: 'nft_minted',
        eventName: 'RewardMinted',
        blockNumber: BigInt(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: Number(log.index ?? 0),
        blockTimestamp,
        contractAddress: log.address,
        fromAddress: playerWallet,
        toAddress: playerWallet,
        data: {
          player: playerWallet,
          tokenId,
          questId: chainQuestId
        },
        chainQuestId,
        playerWallet
      };
    } catch (error) {
      logger.error('Error decoding reward NFT event', {
        error: (error as Error).message,
        logIndex: Number(log.index ?? 0)
      });
    }
    return null;
  },

  // Treasury Events
  [env.TREASURY_ADDRESS.toLowerCase()]: (log, blockTimestamp) => {
    try {
      const parsed = treasuryInterface.parseLog(log);
      if (!parsed) {
        return null;
      }

      const event = parsed.args;
      let chainQuestId: bigint | undefined;
      let creatorWallet: string | undefined;
      let playerWallet: string | undefined;

      if (parsed.name === 'RewardReserved') {
        chainQuestId = event[0];
        creatorWallet = String(event[1]);
        return {
          eventType: 'reward_reserved',
          eventName: 'RewardReserved',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: creatorWallet,
          data: {
            questId: chainQuestId,
            creator: creatorWallet,
            amount: event[2],
            totalReservedRewards: event[3]
          },
          chainQuestId,
          creatorWallet
        };
      }

      if (parsed.name === 'RewardReleased') {
        chainQuestId = event[0];
        playerWallet = String(event[1]);
        return {
          eventType: 'reward_released',
          eventName: 'RewardReleased',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: playerWallet,
          data: {
            questId: chainQuestId,
            player: playerWallet,
            rewardAmount: event[2],
            totalPayout: event[3]
          },
          chainQuestId,
          playerWallet
        };
      }

      if (parsed.name === 'RewardPaid') {
        chainQuestId = event[0];
        playerWallet = String(event[1]);
        return {
          eventType: 'reward_paid',
          eventName: 'RewardPaid',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: playerWallet,
          data: {
            questId: chainQuestId,
            player: playerWallet,
            rewardAmount: event[2],
            totalPayout: event[3]
          },
          chainQuestId,
          playerWallet
        };
      }

      if (parsed.name === 'RewardRefunded') {
        chainQuestId = event[0];
        const recipient = String(event[1]);
        return {
          eventType: 'reward_refunded',
          eventName: 'RewardRefunded',
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: Number(log.index ?? 0),
          blockTimestamp,
          contractAddress: log.address,
          fromAddress: recipient,
          data: {
            questId: chainQuestId,
            recipient,
            rewardAmount: event[2],
            reason: event[3]
          },
          chainQuestId
        };
      }
    } catch (error) {
      logger.error('Error decoding treasury event', {
        error: (error as Error).message,
        logIndex: Number(log.index ?? 0)
      });
    }
    return null;
  }
};

class EventDecoderImpl {
  /**
   * Decode a single log entry
   */
  decodeLog(log: ethers.Log, blockTimestamp: Date): DecodedEvent | null {
    const contractAddress = log.address.toLowerCase();
    const decoder = decoders[contractAddress];

    if (!decoder) {
      return null;
    }

    try {
      return decoder(log, blockTimestamp);
    } catch (error) {
      logger.error('Unexpected error decoding log', {
        error: (error as Error).message,
        contractAddress,
        logIndex: Number(log.index ?? 0)
      });
      return null;
    }
  }

  /**
   * Batch decode logs
   */
  decodeLogs(logs: ethers.Log[], blockTimestamp: Date): DecodedEvent[] {
    return logs
      .map(log => this.decodeLog(log, blockTimestamp))
      .filter((event): event is DecodedEvent => event !== null);
  }
}

export const eventDecoder = new EventDecoderImpl();

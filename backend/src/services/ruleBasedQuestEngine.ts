import crypto from 'crypto';
import type { QuestStatus } from '@prisma/client';
import { QUEST_CONFIG, calculateStreakMultiplier } from './antiAbuse';
import { questValidationEngine } from './questValidationEngine';
import type { ObjectiveType } from './questTemplates';
import type {
  PlayerQuestProfile,
  QuestChainInteractionPattern,
  QuestGenerationDiagnostics,
  QuestNarrativeDraft,
  QuestTxRequirement,
  QuestValidationInput,
  ValidatedQuestOutput,
  WorldStateSnapshotData
} from './questOrchestrationTypes';

type QuestCategory =
  | 'Daily'
  | 'Community'
  | 'Learning'
  | 'Social'
  | 'Wallet'
  | 'Explorer'
  | 'Achievement';

type RuleQuestTemplate = {
  id: string;
  title: string;
  description: string;
  category: QuestCategory;
  difficulty: 1 | 2 | 3 | 4 | 5;
  xpReward: number;
  celoReward: number;
  nftEligible: boolean;
  objectiveType: ObjectiveType;
  proofHint: string;
  lore: string;
};

type RuleQuestGenerationContext = {
  wallet: string;
  chain: string;
  userId?: string;
  username?: string | null;
  xp?: number;
  level?: number;
  streak?: number;
  onchainActions?: number;
  worldState?: WorldStateSnapshotData;
  playerProfile?: Partial<PlayerQuestProfile>;
};

type RuleQuestGenerationResult = {
  quest: ValidatedQuestOutput & {
    id: string;
    expiresAt: Date;
    status: QuestStatus;
  };
  difficultyProfile: RuleDifficultyProfile;
  rewardProfile: RuleRewardProfile;
  streakMultiplier: number;
  template: RuleQuestTemplate;
  orchestrationDiagnostics: RuleBasedDiagnostics;
};

type RuleDifficultyProfile = {
  difficulty: 1 | 2 | 3 | 4 | 5;
  reasoning: string;
  stakeBounds: { min: number; max: number };
  rewardBounds: { min: number; max: number };
  recommendedStake: number;
  estimatedDuration: number;
};

type RuleRewardProfile = {
  rewardAmount: number;
  rewardBounds: { min: number; max: number };
  minimumAllowedReward: number;
  maximumAllowedReward: number;
  xpReward: number;
  reasoning: string;
  worldMultiplier: number;
  treasuryCap: number;
  availableRewardLiquidity: number;
  treasuryHealthy: boolean;
  activeWorldModifiers: Array<{
    id: string;
    name: string;
    type: string;
    multiplier: number;
    reward: number;
  }>;
};

type RuleBasedDiagnostics = {
  generatedCount: number;
  lastGeneratedAt: string | null;
  lastTemplateId: string | null;
  lastCategory: QuestCategory | null;
  lastDifficulty: number | null;
  lastQuestId: string | null;
  templateCount: number;
  categoryCount: number;
};

const QUEST_TEMPLATES: RuleQuestTemplate[] = [
  {
    id: 'daily-check-in',
    title: 'Daily Check-In',
    description: 'Touch base with the Forge, confirm your wallet is ready, and keep your streak alive.',
    category: 'Daily',
    difficulty: 1,
    xpReward: 120,
    celoReward: 0.01,
    nftEligible: false,
    objectiveType: 'native_transfer',
    proofHint: 'A small CELO transfer proves the wallet is active.',
    lore: 'The Forge remembers those who return each day.'
  },
  {
    id: 'daily-coinflow',
    title: 'Coinflow Tuning',
    description: 'Send a tiny CELO transfer to re-balance your daily flow and wake the treasury lamps.',
    category: 'Daily',
    difficulty: 1,
    xpReward: 130,
    celoReward: 0.012,
    nftEligible: false,
    objectiveType: 'native_transfer',
    proofHint: 'A valid transfer hash confirms the balance ritual.',
    lore: 'Treasury lights glow when the flow stays healthy.'
  },
  {
    id: 'daily-profile-polish',
    title: 'Profile Polish',
    description: 'Complete your profile, then submit proof that your account is ready for the realm.',
    category: 'Daily',
    difficulty: 1,
    xpReward: 140,
    celoReward: 0.01,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract interaction can confirm profile completion.',
    lore: 'A polished presence opens more doors in the market square.'
  },
  {
    id: 'daily-claim-window',
    title: 'Claim Window',
    description: 'Open the daily reward window, confirm the claim, and keep the CELO cycle moving.',
    category: 'Daily',
    difficulty: 2,
    xpReward: 160,
    celoReward: 0.015,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract call proves the claim was acknowledged.',
    lore: 'Daily rituals feed the settlement engine.'
  },
  {
    id: 'daily-streak-keeper',
    title: 'Streak Keeper',
    description: 'Protect your streak with a deliberate onchain action and keep the ember burning.',
    category: 'Daily',
    difficulty: 2,
    xpReward: 170,
    celoReward: 0.016,
    nftEligible: false,
    objectiveType: 'native_transfer',
    proofHint: 'A wallet-to-wallet transfer proves consistency.',
    lore: 'The ember of habit powers the whole forge.'
  },
  {
    id: 'community-join-celo',
    title: 'Join Celo Community',
    description: 'Show your allegiance by taking one community-facing action and proving it onchain.',
    category: 'Community',
    difficulty: 2,
    xpReward: 180,
    celoReward: 0.018,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract action can stand in for community membership.',
    lore: 'Communities grow stronger when every voice is recorded.'
  },
  {
    id: 'community-follow-minipay',
    title: 'Follow MiniPay',
    description: 'Signal support for the mobile frontier and document the action with a transaction hash.',
    category: 'Community',
    difficulty: 2,
    xpReward: 175,
    celoReward: 0.017,
    nftEligible: false,
    objectiveType: 'contract_call',
    proofHint: 'A contract interaction is used as the proof anchor.',
    lore: 'The mobile guild watches for travelers who move fast and light.'
  },
  {
    id: 'community-invite-friend',
    title: 'Invite a Friend',
    description: 'Bring another wallet into the world and prove the invitation with a transfer or contract action.',
    category: 'Community',
    difficulty: 3,
    xpReward: 220,
    celoReward: 0.024,
    nftEligible: true,
    objectiveType: 'native_transfer',
    proofHint: 'The invite is settled by a real wallet transaction.',
    lore: 'Every ally widens the reach of the forge.'
  },
  {
    id: 'community-raid-call',
    title: 'Raid Call',
    description: 'Organize a squad response and record the onchain step that proves the party formed.',
    category: 'Community',
    difficulty: 3,
    xpReward: 230,
    celoReward: 0.026,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract call shows the squad answered the call.',
    lore: 'Signals spread faster than banners in the square.'
  },
  {
    id: 'community-guild-spark',
    title: 'Guild Spark',
    description: 'Ignite guild momentum with a wallet action that the archive can verify instantly.',
    category: 'Community',
    difficulty: 3,
    xpReward: 225,
    celoReward: 0.025,
    nftEligible: false,
    objectiveType: 'token_approval',
    proofHint: 'A token approval can mark guild readiness.',
    lore: 'Guilds thrive when their members set the pace.'
  },
  {
    id: 'learning-stablecoin-primer',
    title: 'Stablecoin Primer',
    description: 'Learn how stablecoins keep value steady, then prove your lesson with a chain interaction.',
    category: 'Learning',
    difficulty: 2,
    xpReward: 190,
    celoReward: 0.018,
    nftEligible: false,
    objectiveType: 'contract_call',
    proofHint: 'The proof comes from a recorded contract call.',
    lore: 'Knowledge is the safest currency in the archive.'
  },
  {
    id: 'learning-celo-basics',
    title: 'Celo Basics',
    description: 'Study the Celo stack, confirm the lesson, and submit a proof transaction when ready.',
    category: 'Learning',
    difficulty: 2,
    xpReward: 195,
    celoReward: 0.019,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract invocation verifies the lesson path.',
    lore: 'The first lesson is always the chain itself.'
  },
  {
    id: 'learning-wallet-safety',
    title: 'Wallet Safety Drill',
    description: 'Practice safe wallet habits and show the archive that you can complete a clean onchain step.',
    category: 'Learning',
    difficulty: 3,
    xpReward: 240,
    celoReward: 0.03,
    nftEligible: true,
    objectiveType: 'token_approval',
    proofHint: 'Approval transactions are a strong safety signal.',
    lore: 'The best explorers learn before they sprint.'
  },
  {
    id: 'learning-dapp-discovery',
    title: 'dApp Discovery',
    description: 'Explore a live dApp, then pin the moment with a valid proof hash.',
    category: 'Learning',
    difficulty: 3,
    xpReward: 245,
    celoReward: 0.032,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract call proves the discovery happened.',
    lore: 'Every app is a doorway if you know the key.'
  },
  {
    id: 'learning-earn-by-doing',
    title: 'Earn By Doing',
    description: 'Turn reading into action by completing a practical onchain lesson.',
    category: 'Learning',
    difficulty: 4,
    xpReward: 280,
    celoReward: 0.04,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'The lesson is complete when the transaction lands.',
    lore: 'The forge respects hands that can apply what they learn.'
  },
  {
    id: 'social-share-win',
    title: 'Share the Win',
    description: 'Tell another player about the realm, then prove the social step with an onchain action.',
    category: 'Social',
    difficulty: 2,
    xpReward: 180,
    celoReward: 0.018,
    nftEligible: false,
    objectiveType: 'native_transfer',
    proofHint: 'A transfer is the social proof anchor.',
    lore: 'News travels farther when it is backed by a signed action.'
  },
  {
    id: 'social-thread-starter',
    title: 'Thread Starter',
    description: 'Open a conversation that invites other wallets to the table and record the proof.',
    category: 'Social',
    difficulty: 3,
    xpReward: 225,
    celoReward: 0.024,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract action proves the thread is live.',
    lore: 'Good conversation is an onchain asset.'
  },
  {
    id: 'social-coop-bridge',
    title: 'Co-op Bridge',
    description: 'Connect two players through a shared action and bridge the gap with a clean proof.',
    category: 'Social',
    difficulty: 3,
    xpReward: 235,
    celoReward: 0.027,
    nftEligible: true,
    objectiveType: 'token_approval',
    proofHint: 'Token approval can represent a shared commitment.',
    lore: 'Bridges are stronger when both sides sign in.'
  },
  {
    id: 'social-community-captain',
    title: 'Community Captain',
    description: 'Step up as a guide and complete the captaincy action onchain.',
    category: 'Social',
    difficulty: 4,
    xpReward: 290,
    celoReward: 0.041,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract call confirms the captaincy step.',
    lore: 'Leaders are measured by the actions they can prove.'
  },
  {
    id: 'wallet-link',
    title: 'Wallet Link',
    description: 'Link your wallet to the Forge and confirm your identity with a crisp transaction.',
    category: 'Wallet',
    difficulty: 1,
    xpReward: 125,
    celoReward: 0.01,
    nftEligible: false,
    objectiveType: 'contract_call',
    proofHint: 'A simple contract interaction proves the link.',
    lore: 'A linked wallet is the key to the whole kingdom.'
  },
  {
    id: 'wallet-balance-check',
    title: 'Balance Check',
    description: 'Confirm your CELO balance and prove the check with a wallet action.',
    category: 'Wallet',
    difficulty: 1,
    xpReward: 130,
    celoReward: 0.011,
    nftEligible: false,
    objectiveType: 'native_transfer',
    proofHint: 'A small transfer proves the wallet is alive.',
    lore: 'Healthy balances keep the pipeline moving.'
  },
  {
    id: 'wallet-token-approval',
    title: 'Token Approval',
    description: 'Approve a token route for future execution and submit the approval hash.',
    category: 'Wallet',
    difficulty: 3,
    xpReward: 235,
    celoReward: 0.028,
    nftEligible: true,
    objectiveType: 'token_approval',
    proofHint: 'An ERC20 approval is the canonical proof.',
    lore: 'Approvals are the locksmiths of the chain.'
  },
  {
    id: 'wallet-send-celo',
    title: 'Send CELO',
    description: 'Move CELO to another wallet and let the chain confirm the transfer.',
    category: 'Wallet',
    difficulty: 3,
    xpReward: 240,
    celoReward: 0.03,
    nftEligible: true,
    objectiveType: 'native_transfer',
    proofHint: 'The transfer hash is the proof of action.',
    lore: 'Value that moves proves the system is alive.'
  },
  {
    id: 'wallet-multisig-ready',
    title: 'Multisig Ready',
    description: 'Prepare for a multi-signature flow and verify readiness with a contract interaction.',
    category: 'Wallet',
    difficulty: 4,
    xpReward: 300,
    celoReward: 0.045,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract call proves readiness for shared custody.',
    lore: 'Shared control demands disciplined proof.'
  },
  {
    id: 'explorer-dapp-tour',
    title: 'dApp Tour',
    description: 'Visit a live dApp, inspect its mechanics, and record the journey with a proof transaction.',
    category: 'Explorer',
    difficulty: 2,
    xpReward: 200,
    celoReward: 0.02,
    nftEligible: false,
    objectiveType: 'contract_call',
    proofHint: 'The tour ends when the contract call lands.',
    lore: 'Explorers map the world by stepping into it.'
  },
  {
    id: 'explorer-payments-path',
    title: 'Payments Path',
    description: 'Trace a payment flow across Celo and submit proof that the route is valid.',
    category: 'Explorer',
    difficulty: 3,
    xpReward: 235,
    celoReward: 0.028,
    nftEligible: true,
    objectiveType: 'native_transfer',
    proofHint: 'A transfer hash shows the path is sound.',
    lore: 'The best map is the one written by real traffic.'
  },
  {
    id: 'explorer-liquidity-lens',
    title: 'Liquidity Lens',
    description: 'Inspect a liquidity route and lock the insight with a contract proof.',
    category: 'Explorer',
    difficulty: 4,
    xpReward: 295,
    celoReward: 0.045,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'Contract activity marks the lens as complete.',
    lore: 'Liquidity reveals itself to patient eyes.'
  },
  {
    id: 'explorer-market-spotlight',
    title: 'Market Spotlight',
    description: 'Identify a live market opportunity and prove the discovery with a token approval.',
    category: 'Explorer',
    difficulty: 4,
    xpReward: 305,
    celoReward: 0.05,
    nftEligible: true,
    objectiveType: 'token_approval',
    proofHint: 'An approval transaction shows the market was reached.',
    lore: 'Spotlights find the best opportunities in the dark.'
  },
  {
    id: 'explorer-bridge-run',
    title: 'Bridge Run',
    description: 'Observe a bridge route and submit proof that the route can be executed safely.',
    category: 'Explorer',
    difficulty: 5,
    xpReward: 340,
    celoReward: 0.06,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'The contract call confirms the route.',
    lore: 'Every bridge is a test of confidence.'
  },
  {
    id: 'achievement-first-win',
    title: 'First Win',
    description: 'Claim your first achievement by completing a clean proof and bringing it home.',
    category: 'Achievement',
    difficulty: 1,
    xpReward: 150,
    celoReward: 0.012,
    nftEligible: true,
    objectiveType: 'native_transfer',
    proofHint: 'A first-win transfer keeps the ritual simple.',
    lore: 'The first trophy always matters.'
  },
  {
    id: 'achievement-five-quests',
    title: 'Five Quests',
    description: 'Prove consistency by completing a milestone action after five successful quests.',
    category: 'Achievement',
    difficulty: 3,
    xpReward: 260,
    celoReward: 0.032,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'The proof lands when the milestone is recorded.',
    lore: 'Momentum becomes a permanent badge when it is proven.'
  },
  {
    id: 'achievement-weekly-chain',
    title: 'Weekly Chain',
    description: 'Keep the weekly chain intact with a proof transaction that seals the streak.',
    category: 'Achievement',
    difficulty: 4,
    xpReward: 310,
    celoReward: 0.048,
    nftEligible: true,
    objectiveType: 'native_transfer',
    proofHint: 'A transfer hash seals the weekly milestone.',
    lore: 'The weekly chain rewards discipline over flash.'
  },
  {
    id: 'achievement-guardian',
    title: 'Guardian',
    description: 'Guard the realm by completing a high-trust proof and securing the achievement seal.',
    category: 'Achievement',
    difficulty: 4,
    xpReward: 320,
    celoReward: 0.05,
    nftEligible: true,
    objectiveType: 'contract_call',
    proofHint: 'A contract interaction confirms guardian status.',
    lore: 'Guardians are the first to act when the realm needs them.'
  },
  {
    id: 'achievement-legend',
    title: 'Legend',
    description: 'Stand among the legends with a final proof that marks your place in the archive.',
    category: 'Achievement',
    difficulty: 5,
    xpReward: 360,
    celoReward: 0.065,
    nftEligible: true,
    objectiveType: 'token_approval',
    proofHint: 'A token approval can mark the final seal.',
    lore: 'Legends are simply records that never stop growing.'
  }
];

const CATEGORY_COUNT = new Set(QUEST_TEMPLATES.map((template) => template.category)).size;

function clampDifficulty(value: number): 1 | 2 | 3 | 4 | 5 {
  return Math.max(1, Math.min(5, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

function formatCelo(value: number) {
  return Number(value.toFixed(4));
}

function formatDifficultyLabel(difficulty: number) {
  if (difficulty >= 5) return 'Legendary';
  if (difficulty >= 4) return 'Epic';
  if (difficulty >= 3) return 'Rare';
  if (difficulty >= 2) return 'Uncommon';
  return 'Common';
}

function difficultyFromLevel(level: number) {
  if (level >= 12) return 5;
  if (level >= 9) return 4;
  if (level >= 6) return 3;
  if (level >= 3) return 2;
  return 1;
}

function buildWorldState(worldState?: WorldStateSnapshotData): WorldStateSnapshotData {
  return (
    worldState ?? {
      version: 1,
      generatedAt: new Date().toISOString(),
      season: {
        key: 'forge-season',
        label: 'Forge Season',
        theme: 'Community-driven quests and CELO rewards'
      },
      activeEvents: [],
      factions: [],
      activeConflicts: [],
      questThemes: ['daily growth', 'community effort', 'learning by doing'],
      seasonalContent: ['rule-based quest rotation'],
      npcTones: ['measured', 'supportive', 'clear'],
      rarityWeights: {
        common: 0.4,
        uncommon: 0.25,
        rare: 0.18,
        epic: 0.12,
        legendary: 0.05
      },
      worldMultiplier: 1,
      diagnostics: {
        trigger: 'rule-based-default',
        stateHash: 'rule-based-default',
        sourceEventCount: 0
      }
    }
  );
}

function buildPlayerProfile(level: number, context: RuleQuestGenerationContext): PlayerQuestProfile {
  const wallet = context.wallet;

  return {
    userId: context.userId ?? `player-${wallet.slice(-8)}`,
    wallet,
    username: context.username ?? null,
    level,
    xp: context.xp ?? 0,
    streak: context.streak ?? 0,
    onchainActions: context.onchainActions ?? 0,
    clanId: null,
    agentId: null,
    walletHistoryScore: 0.5,
    questHistory: {
      recentQuestTitles: [],
      recentObjectives: [],
      recentNpcNames: [],
      recentFactionIds: [],
      recentDifficultyAverage: level,
      verifiedCount: 0,
      failedCount: 0,
      questStreak: context.streak ?? 0
    },
    relationshipSummary: ['fresh slate', 'rule-based progression']
  };
}

function buildStakeBounds() {
  return { min: 0, max: 0 };
}

function buildRewardBounds(template: RuleQuestTemplate) {
  const min = formatCelo(Math.max(0.01, template.celoReward * 0.85));
  const max = formatCelo(Math.max(min, template.celoReward * 1.4));
  return { min, max };
}

function buildTxRequirements(template: RuleQuestTemplate): QuestTxRequirement[] {
  const primaryType = template.objectiveType;
  const primaryLabel =
    primaryType === 'native_transfer'
      ? 'Complete a CELO transfer that proves the objective'
      : primaryType === 'contract_call'
        ? 'Execute the required contract interaction'
        : 'Approve the token flow used by the quest';

  return [
    {
      stage: 'createQuest',
      label: 'Open quest',
      description: 'The quest is created and recorded in the realm ledger.',
      type: 'proof_submission',
      minimumCount: 1,
      verifierCompatible: true
    },
    {
      stage: 'completeQuest',
      label: 'Complete quest',
      description: 'The player completes the mission and prepares the final proof step.',
      type: primaryType,
      minimumCount: 1,
      verifierCompatible: true
    },
    {
      stage: 'gameplay',
      label: 'Complete objective',
      description: primaryLabel,
      type: primaryType,
      minimumCount: 1,
      verifierCompatible: true
    },
    {
      stage: 'submitProof',
      label: 'Submit proof',
      description: 'The player submits the transaction hash or proof artifact.',
      type: 'proof_submission',
      minimumCount: 1,
      verifierCompatible: true
    },
    {
      stage: 'verifierSettlement',
      label: 'Verify proof',
      description: 'The backend verifies the proof against chain history.',
      type: 'verifier_call',
      minimumCount: 1,
      verifierCompatible: true
    },
    {
      stage: 'rewardPayout',
      label: 'Claim reward',
      description: 'Rewards are released after successful verification.',
      type: 'reward_claim',
      minimumCount: 1,
      verifierCompatible: true
    },
    {
      stage: 'nftMint',
      label: 'Mint badge',
      description: 'Eligible players receive an achievement NFT.',
      type: 'nft_mint',
      minimumCount: 1,
      verifierCompatible: true
    }
  ];
}

function buildChainInteraction(template: RuleQuestTemplate): QuestChainInteractionPattern {
  if (template.objectiveType === 'native_transfer') {
    return {
      primary: 'native_transfer',
      secondary: null,
      allowedTargets: ['wallet'],
      minValueCelo: formatCelo(Math.max(0.01, template.celoReward / 2)),
      requireContractCall: false,
      requireTokenApproval: false
    };
  }

  if (template.objectiveType === 'token_approval') {
    return {
      primary: 'token_approval',
      secondary: 'contract_call',
      allowedTargets: ['token', 'contract'],
      minValueCelo: 0,
      requireContractCall: true,
      requireTokenApproval: true
    };
  }

  return {
    primary: 'contract_call',
    secondary: null,
    allowedTargets: ['contract'],
    minValueCelo: 0,
    requireContractCall: true,
    requireTokenApproval: false
  };
}

function buildNarrative(
  template: RuleQuestTemplate,
  difficulty: number,
  playerLevel: number,
  rewardAmount: number,
  context: RuleQuestGenerationContext,
  worldState: WorldStateSnapshotData,
  generation: QuestGenerationDiagnostics
): QuestNarrativeDraft {
  const rarity = formatDifficultyLabel(difficulty).toLowerCase() as QuestNarrativeDraft['worldInfluence']['rarity'];
  const primaryFactionName = worldState.factions[0]?.name ?? 'The Celo Commons';
  const primaryFactionId = worldState.factions[0]?.id ?? 'faction-celo-commons';
  const npcName = worldState.npcTones[0] ? `${worldState.npcTones[0][0].toUpperCase()}${worldState.npcTones[0].slice(1)} Steward` : 'Forge Steward';
  const rewardRationale = `This quest rewards steady progress for a level ${playerLevel} player with ${template.xpReward} XP and ${rewardAmount.toFixed(3)} CELO.`;

  return {
    title: template.title,
    description: template.description,
    lore: `${template.lore} This category belongs to ${template.category.toLowerCase()} quests and favors ${template.objectiveType.replace('_', ' ')} verification.`,
    missionStructure: '1. Browse the quest. 2. Complete the objective. 3. Submit proof and claim the reward.',
    missionObjectives: [
      {
        id: 'objective-1',
        summary: `Review the ${template.category.toLowerCase()} quest and prepare your wallet.`,
        mandatory: true,
        stage: 'createQuest',
        verifierHint: 'The quest record exists before proof submission.'
      },
      {
        id: 'objective-2',
        summary: template.description,
        mandatory: true,
        stage: 'gameplay',
        verifierHint: template.proofHint
      },
      {
        id: 'objective-3',
        summary: 'Submit the proof transaction and finish the reward flow.',
        mandatory: true,
        stage: 'submitProof',
        verifierHint: 'Proof submission must reference a successful Celo transaction hash.'
      }
    ],
    missionChapters: [
      {
        id: 'chapter-1',
        title: 'Browse and Prepare',
        summary: `Learn what the ${template.category.toLowerCase()} quest requires and line up your wallet.`,
        objectiveIds: ['objective-1']
      },
      {
        id: 'chapter-2',
        title: 'Execute and Submit',
        summary: 'Complete the objective, submit proof, and wait for settlement.',
        objectiveIds: ['objective-2', 'objective-3']
      }
    ],
    txRequirements: buildTxRequirements(template),
    storyline: [
      `${template.category} energy surges through the realm as the quest is selected.`,
      `The player completes ${template.title.toLowerCase()} and secures the proof.`,
      'The reward settles after deterministic verification confirms success.'
    ],
    rewardRationale,
    riskLevel: difficulty >= 5 ? 'extreme' : difficulty >= 4 ? 'high' : difficulty >= 3 ? 'moderate' : 'low',
    npc: {
      npcId: `npc-${template.category.toLowerCase()}-${template.id}`,
      name: npcName,
      type: `${template.category.toLowerCase()}_steward`,
      role: template.category.toLowerCase(),
      relationshipScore: Number(Math.min(1, 0.35 + playerLevel * 0.03).toFixed(3)),
      personalitySummary: `${worldState.npcTones.slice(0, 3).join(', ')} and focused on rule-based quests`,
      openingDialogue: `${npcName} greets ${context.username ?? 'traveler'} and presents ${template.title}.`,
      memoryReferences: [`category=${template.category}`, `difficulty=${difficulty}`]
    },
    faction: {
      primaryFactionId,
      primaryFactionName,
      opposingFactionId: worldState.factions[1]?.id ?? null,
      opposingFactionName: worldState.factions[1]?.name ?? null,
      playerAlignment: 'neutral',
      conflictSummary: `${primaryFactionName} keeps the realm moving with practical, rule-based challenges.`,
      coOpEligible: template.category === 'Community' || template.category === 'Social',
      clanRaidCompatible: template.category === 'Achievement'
    },
    worldInfluence: {
      rarity,
      theme: `${template.category} questing in Online ForgeQuest Game`,
      modifiers: [template.category.toLowerCase(), template.objectiveType, `level-${playerLevel}`],
      seasonalHook: `${worldState.season.label} rewards consistent quest completion.`
    },
    branchingHooks: [
      {
        id: 'branch-1',
        trigger: 'player completes objective early',
        branch: 'offer a bonus achievement path',
        riskDelta: 0.2
      },
      {
        id: 'branch-2',
        trigger: 'player chooses a team-friendly path',
        branch: 'unlock a co-op follow-up quest',
        riskDelta: 0.1
      }
    ],
    chainInteraction: buildChainInteraction(template),
    coOpHooks: [
      'Invite another wallet to mirror the same quest path.',
      'Share the proof flow with a teammate for faster adoption.'
    ],
    loreContinuity: [
      `${template.category} quests remain the default path for level ${playerLevel} players.`,
      'The rule-based engine keeps the quest pool predictable, auditable, and immediate.'
    ],
    generation
  };
}

function buildDifficultyProfile(level: number, template: RuleQuestTemplate) {
  const templateDifficulty = template.difficulty;
  const difficulty = clampDifficulty(Math.max(templateDifficulty, difficultyFromLevel(level)));
  const stakeBounds = buildStakeBounds();
  return {
    difficulty,
    reasoning: `Difficulty ${difficulty} was selected from player level ${level} and the ${template.category.toLowerCase()} template ${template.id}.`,
    stakeBounds,
    rewardBounds: buildRewardBounds(template),
    recommendedStake: 0,
    estimatedDuration: 1800 + difficulty * 900
  };
}

function buildRewardProfile(
  template: RuleQuestTemplate,
  difficultyProfile: RuleDifficultyProfile,
  context: RuleQuestGenerationContext,
  worldState: WorldStateSnapshotData
): RuleRewardProfile {
  const streakMultiplier = calculateStreakMultiplier(context.streak ?? 0);
  const worldMultiplier = formatCelo(Math.max(0.5, worldState.worldMultiplier || 1));
  const rewardBounds = difficultyProfile.rewardBounds;
  const treasuryCap = QUEST_CONFIG.MAX_SINGLE_REWARD_CELO;
  const availableRewardLiquidity = QUEST_CONFIG.MAX_SINGLE_REWARD_CELO;
  const minimumAllowedReward = rewardBounds.min;
  const maximumAllowedReward = formatCelo(Math.min(rewardBounds.max, treasuryCap));
  const baseReward = formatCelo(Math.max(rewardBounds.min, template.celoReward));
  let rewardAmount = formatCelo(baseReward * streakMultiplier * worldMultiplier);
  rewardAmount = formatCelo(Math.max(minimumAllowedReward, Math.min(rewardAmount, maximumAllowedReward)));

  const xpReward = Math.max(
    template.xpReward,
    Math.round(template.xpReward * Math.min(1.5, 1 + (worldMultiplier - 1) * 0.5))
  );

  return {
    rewardAmount,
    rewardBounds: {
      min: minimumAllowedReward,
      max: maximumAllowedReward
    },
    minimumAllowedReward,
    maximumAllowedReward,
    xpReward,
    reasoning: `Reward output follows the ${template.category.toLowerCase()} template, with streak multiplier ${streakMultiplier.toFixed(2)} and world multiplier ${worldMultiplier.toFixed(2)}.`,
    worldMultiplier,
    treasuryCap,
    availableRewardLiquidity,
    treasuryHealthy: true,
    activeWorldModifiers: worldState.activeEvents.slice(0, 3).map((event) => ({
      id: event.id,
      name: event.name,
      type: event.type,
      multiplier: event.multiplier,
      reward: event.reward
    }))
  };
}

class RuleBasedQuestEngine {
  private diagnostics: RuleBasedDiagnostics = {
    generatedCount: 0,
    lastGeneratedAt: null,
    lastTemplateId: null,
    lastCategory: null,
    lastDifficulty: null,
    lastQuestId: null,
    templateCount: QUEST_TEMPLATES.length,
    categoryCount: CATEGORY_COUNT
  };

  generateQuest(playerLevel: number, context: RuleQuestGenerationContext): RuleQuestGenerationResult {
    const normalizedLevel = Math.max(1, Math.round(playerLevel || 1));
    const selectedDifficulty = difficultyFromLevel(normalizedLevel);
    const pool = QUEST_TEMPLATES.filter((template) => template.difficulty === selectedDifficulty);
    const selectedTemplate = pool[(normalizedLevel - 1) % pool.length] ?? QUEST_TEMPLATES[(normalizedLevel - 1) % QUEST_TEMPLATES.length];
    const worldState = buildWorldState(context.worldState);
    const difficultyProfile = buildDifficultyProfile(normalizedLevel, selectedTemplate);
    const playerProfile: PlayerQuestProfile = context.playerProfile
      ? ({ ...buildPlayerProfile(normalizedLevel, context), ...context.playerProfile } as PlayerQuestProfile)
      : buildPlayerProfile(normalizedLevel, context);
    const rewardProfile = buildRewardProfile(selectedTemplate, difficultyProfile, context, worldState);
    const streakMultiplier = Number(calculateStreakMultiplier(context.streak ?? 0).toFixed(2));
    const generationSeed = `${selectedTemplate.id}:${normalizedLevel}:${context.wallet}:${context.chain}`;
    const generation: QuestGenerationDiagnostics = {
      source: 'rule_based',
      provider: 'rule_based',
      model: null,
      promptHash: crypto.createHash('sha256').update(generationSeed).digest('hex'),
      promptPreview: `${selectedTemplate.category} | ${selectedTemplate.title} | level ${normalizedLevel}`,
      fallbackReason: null,
      generatedAt: new Date().toISOString(),
      requestId: selectedTemplate.id,
      latencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      attemptCount: 1
    };

    const narrative = buildNarrative(
      selectedTemplate,
      difficultyProfile.difficulty,
      normalizedLevel,
      rewardProfile.rewardAmount,
      context,
      worldState,
      generation
    );

    const validationInput: QuestValidationInput = {
      wallet: context.wallet,
      chain: context.chain,
      difficulty: difficultyProfile.difficulty,
      stakeBounds: difficultyProfile.stakeBounds,
      rewardBounds: rewardProfile.rewardBounds,
      recommendedStake: difficultyProfile.recommendedStake,
      rewardAmount: rewardProfile.rewardAmount,
      xpReward: rewardProfile.xpReward,
      estimatedDurationSeconds: difficultyProfile.estimatedDuration,
      worldState,
      playerProfile,
      narrative,
      difficultyReasoning: `Difficulty ${difficultyProfile.difficulty} selected from player level ${normalizedLevel} and template ${selectedTemplate.id}.`,
      rewardReasoning: rewardProfile.reasoning,
      worldMultiplier: rewardProfile.worldMultiplier,
      treasuryCap: rewardProfile.treasuryCap,
      minimumAllowedReward: rewardProfile.minimumAllowedReward,
      maximumAllowedReward: rewardProfile.maximumAllowedReward,
      activeWorldModifiers: rewardProfile.activeWorldModifiers,
      agentId: null
    };

    const validated = questValidationEngine.validateGeneratedQuest(validationInput);

    this.diagnostics.generatedCount += 1;
    this.diagnostics.lastGeneratedAt = generation.generatedAt;
    this.diagnostics.lastTemplateId = selectedTemplate.id;
    this.diagnostics.lastCategory = selectedTemplate.category;
    this.diagnostics.lastDifficulty = difficultyProfile.difficulty;
    this.diagnostics.lastQuestId = validated.orchestrationId;

    return {
      quest: {
        ...validated,
        id: validated.orchestrationId,
        expiresAt: new Date(Date.now() + validated.durationSeconds * 1000),
        status: 'AVAILABLE'
      },
      difficultyProfile,
      rewardProfile,
      streakMultiplier,
      template: selectedTemplate,
      orchestrationDiagnostics: this.getDiagnostics()
    };
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }
}

export const ruleBasedQuestEngine = new RuleBasedQuestEngine();
export type { RuleQuestTemplate, RuleQuestGenerationContext, RuleQuestGenerationResult };

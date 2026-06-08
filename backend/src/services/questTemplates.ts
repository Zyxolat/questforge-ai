import { ethers } from 'ethers';

export type ObjectiveType = 'native_transfer' | 'contract_call' | 'token_approval';

export interface QuestVerificationTemplate {
  type: ObjectiveType;
  questType: string;
  objective: string;
  validationRules: string[];
  minValueCelo: number;
  allowContractTarget: boolean;
  requireContractCall: boolean;
  requireTokenApproval: boolean;
}

type QuestVerificationBaseTemplate = Omit<QuestVerificationTemplate, 'type' | 'objective'>;

const TEMPLATE_ALLOWLIST: Record<ObjectiveType, QuestVerificationBaseTemplate> = {
  native_transfer: {
    questType: 'Celo Transfer',
    validationRules: [
      'Proof must be a successful Celo transaction hash.',
      'The proof transaction must be signed by the quest player after the quest is issued.',
      'The transaction must transfer CELO to another non-zero wallet.',
      'The transfer value must meet the quest minimum amount.'
    ],
    minValueCelo: 0.01,
    allowContractTarget: false,
    requireContractCall: false,
    requireTokenApproval: false
  },
  contract_call: {
    questType: 'Contract Invocation',
    validationRules: [
      'Proof must be a successful Celo transaction hash.',
      'The proof transaction must be signed by the quest player after the quest is issued.',
      'The transaction must call a smart contract with calldata.',
      'The transaction must spend at least the quest minimum gas value in CELO.'
    ],
    minValueCelo: 0,
    allowContractTarget: true,
    requireContractCall: true,
    requireTokenApproval: false
  },
  token_approval: {
    questType: 'Token Approval',
    validationRules: [
      'Proof must be a successful Celo transaction hash.',
      'The proof transaction must be signed by the quest player after the quest is issued.',
      'The receipt must emit at least one ERC20 Approval event.',
      'The transaction must target a live contract address.'
    ],
    minValueCelo: 0,
    allowContractTarget: true,
    requireContractCall: true,
    requireTokenApproval: true
  }
};

function formatCeloAmount(value: number) {
  return Number(value.toFixed(3)).toString();
}

export function objectiveTypes(): ObjectiveType[] {
  return Object.keys(TEMPLATE_ALLOWLIST) as ObjectiveType[];
}

export function buildQuestTemplateForType(
  type: ObjectiveType,
  wallet: string,
  difficulty: number
): QuestVerificationTemplate {
  const normalizedDifficulty = Math.max(1, Math.min(5, Math.round(difficulty)));
  const base = TEMPLATE_ALLOWLIST[type];
  const shortWallet = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  const minValueCelo =
    type === 'native_transfer'
      ? Math.min(0.05, Number((0.01 + (normalizedDifficulty - 1) * 0.005).toFixed(3)))
      : base.minValueCelo;

  const objectiveByType: Record<ObjectiveType, string> = {
    native_transfer: `Send at least ${formatCeloAmount(minValueCelo)} CELO from ${shortWallet} to another wallet on Celo and use that transaction hash as proof.`,
    contract_call: `Execute a successful contract interaction from ${shortWallet} on Celo after accepting this quest, then use that transaction hash as proof.`,
    token_approval: `Submit a successful ERC20 approval transaction from ${shortWallet} on Celo after accepting this quest, then use that transaction hash as proof.`
  };

  return {
    ...base,
    type,
    minValueCelo,
    objective: objectiveByType[type]
  };
}

export function buildQuestTemplate(difficulty: number, wallet: string): QuestVerificationTemplate {
  const normalizedDifficulty = Math.max(1, Math.min(5, Math.round(difficulty)));
  const types = objectiveTypes();
  const index = (normalizedDifficulty - 1) % types.length;
  const type = types[index];
  return buildQuestTemplateForType(type, wallet, normalizedDifficulty);
}

export function isApprovalEvent(topics: readonly string[]) {
  return topics[0]?.toLowerCase() === ethers.id('Approval(address,address,uint256)').toLowerCase();
}

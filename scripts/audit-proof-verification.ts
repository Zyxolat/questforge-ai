import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

type AuditStatus = 'pass' | 'fail';

type AuthSessionPayload = {
  accessToken: string;
  session: {
    id: string;
    wallet: string;
  };
  user: {
    id: string;
    wallet: string;
  };
};

type GeneratedQuestPayload = {
  quest: {
    id: string;
    title: string;
    metadataUri: string;
    metadata?: {
      verification?: {
        minValueCelo?: number;
        requireContractCall?: boolean;
        requireTokenApproval?: boolean;
      };
    };
    stakeAmount: string | number;
    rewardAmount: string | number;
    xpReward: string | number;
    durationSeconds: string | number;
  };
};

type ActiveQuestSnapshot = {
  id?: string;
  chainQuestId?: string | number | null;
  status?: string | null;
  verificationTx?: string | null;
  treasuryPayout?: {
    status?: string | null;
  } | null;
  [key: string]: unknown;
};

type DeploymentAddresses = {
  FORGE_QUEST_MANAGER_ADDRESS: string;
  TREASURY_ADDRESS: string;
  VALIDATION_TOKEN_ADDRESS?: string;
};

const AUTH_CHAIN_ID = Number(process.env.AUTH_CHAIN_ID || '42220');
const RPC_CHAIN_ID = Number(process.env.RPC_CHAIN_ID || '42220');
const API_ROOT = (process.env.API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const API_BASE = API_ROOT.endsWith('/api') ? API_ROOT : `${API_ROOT}/api`;
const RPC_URL = process.env.VALIDATION_RPC_URL || 'http://127.0.0.1:8545';
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_ADDRESSES_FILE?.trim()
  ? path.resolve(process.cwd(), process.env.DEPLOYMENT_ADDRESSES_FILE.trim())
  : path.join(process.cwd(), 'contracts/deployments/localhost-addresses.json');

const PRIVATE_KEYS = {
  alpha: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  beta: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  gamma: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  delta: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'
} as const;

const FORGE_QUEST_MANAGER_ABI = [
  'function createQuest(string title,string metadataUri,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external',
  'function startQuest(uint256 questId) external payable',
  'function submitQuest(uint256 questId,string proofUri) external',
  'function quests(uint256) view returns (uint256 questId,address creator,string title,string metadataUri,string proofUri,bytes32 proofHash,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 createdAt,uint256 startedAt,uint256 expiresAt,uint8 status,address player,uint256 playerNonce,bytes32 proofVerificationHash)',
  'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount,uint256 xpReward)'
];

function record(name: string, status: AuditStatus, message: string, details?: unknown) {
  const icon = status === 'pass' ? '✓' : '✗';
  console.log(`${icon} ${name}: ${message}`);
  if (details && status === 'fail') {
    console.log(JSON.stringify(details, null, 2));
  }
}

function createClient(accessToken?: string) {
  return axios.create({
    baseURL: API_BASE,
    timeout: 15000,
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
    }
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDeploymentAddresses(): DeploymentAddresses {
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8')) as DeploymentAddresses;
}

async function authenticateWallet(wallet: ethers.Wallet) {
  const client = createClient();
  const nonceResponse = await client.post('/auth/nonce', {
    wallet: wallet.address,
    chainId: AUTH_CHAIN_ID
  });
  const signature = await wallet.signMessage(String(nonceResponse.data.message));
  const verifyResponse = await client.post<AuthSessionPayload>('/auth/verify', {
    wallet: wallet.address,
    nonce: nonceResponse.data.nonce,
    signature,
    chainId: AUTH_CHAIN_ID
  });

  return {
    session: verifyResponse.data,
    client: createClient(verifyResponse.data.accessToken)
  };
}

async function waitForQuestState(
  client: AxiosInstance,
  questId: string,
  predicate: (quest: ActiveQuestSnapshot | undefined) => boolean,
  timeoutMs = 20000,
  intervalMs = 1500
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await client.get('/quests/active');
    const quests = Array.isArray(response.data?.quests) ? (response.data.quests as ActiveQuestSnapshot[]) : [];
    const match = quests.find((quest) => quest.id === questId);
    if (predicate(match)) {
      return match;
    }
    await sleep(intervalMs);
  }

  const response = await client.get('/quests/active');
  const quests = Array.isArray(response.data?.quests) ? (response.data.quests as ActiveQuestSnapshot[]) : [];
  return quests.find((quest) => quest.id === questId);
}

async function createStartedQuest(
  client: AxiosInstance,
  signer: ethers.Signer,
  contract: ethers.Contract
) {
  const generated = await client.post<GeneratedQuestPayload>('/quests/generate', { chain: 'Celo' });
  const quest = generated.data.quest;

  const createTx = await contract.createQuest(
    quest.title,
    quest.metadataUri,
    ethers.parseEther(String(quest.stakeAmount)),
    ethers.parseEther(String(quest.rewardAmount)),
    BigInt(quest.xpReward),
    BigInt(quest.durationSeconds)
  );
  const createReceipt = await createTx.wait();
  const parsedCreatedLog = createReceipt?.logs
    ?.map((log: ethers.Log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((log: ethers.LogDescription | null) => log?.name === 'QuestCreated');

  const chainQuestId = parsedCreatedLog?.args?.questId?.toString();
  if (!chainQuestId) {
    throw new Error('Quest creation receipt missing QuestCreated');
  }

  await client.post('/quests/register-onchain', {
    questId: quest.id,
    chainQuestId,
    creationTxHash: createTx.hash
  });

  const onchainQuest = await contract.quests(BigInt(chainQuestId));
  const stakeValue = BigInt(onchainQuest.stakeAmount.toString());
  const startTx = await contract.startQuest(BigInt(chainQuestId), { value: stakeValue });
  await startTx.wait();

  await client.post('/quests/register-start', {
    questId: quest.id,
    chainQuestId,
    startTxHash: startTx.hash
  });

  return {
    quest,
    chainQuestId,
    startTxHash: startTx.hash
  };
}

async function submitProofAndQueue(input: {
  client: AxiosInstance;
  contract: ethers.Contract;
  chainQuestId: string;
  questId: string;
  proofTxHash: string;
}) {
  const submitTx = await input.contract.submitQuest(BigInt(input.chainQuestId), input.proofTxHash);
  await submitTx.wait();

  await input.client.post('/quests/submit-proof', {
    questId: input.questId,
    proofUri: input.proofTxHash,
    submissionTxHash: submitTx.hash
  });

  return submitTx.hash;
}

async function createValidProofTransaction(input: {
  signer: ethers.Signer;
  signerAddress: string;
  deployment: DeploymentAddresses;
  verification?: {
    minValueCelo?: number;
    requireContractCall?: boolean;
    requireTokenApproval?: boolean;
  };
}) {
  const minValueCelo = Number(input.verification?.minValueCelo ?? 0);
  const minimumValue = ethers.parseEther(Math.max(0, minValueCelo).toFixed(18));

  if (input.verification?.requireContractCall || input.verification?.requireTokenApproval) {
    const validationTokenAddress =
      process.env.VALIDATION_TOKEN_ADDRESS?.trim() || input.deployment.VALIDATION_TOKEN_ADDRESS;
    if (!validationTokenAddress) {
      throw new Error(
        'Quest proof requires a contract/token approval transaction. Set VALIDATION_TOKEN_ADDRESS to an ERC20 on the target network; REWARD_TOKEN_ADDRESS is not used for CELO rewards.'
      );
    }

    const rewardToken = new ethers.Contract(
      validationTokenAddress,
      ['function approve(address spender,uint256 value) external returns (bool)'],
      input.signer
    );
    const approvalAmount = minimumValue > 0n ? minimumValue : 1n;
    const tx = await rewardToken.approve(input.deployment.TREASURY_ADDRESS, approvalAmount);
    await tx.wait();
    return tx.hash as string;
  }

  const tx = await input.signer.sendTransaction({
    to:
      input.signerAddress.toLowerCase() === '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
        ? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
        : '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    value: minimumValue > 0n ? minimumValue : ethers.parseEther('0.01')
  });
  await tx.wait();
  return tx.hash as string;
}

async function expectHttpFailure(
  name: string,
  fn: () => Promise<unknown>,
  expectedStatus: number,
  expectedMessage: string
) {
  try {
    await fn();
    record(name, 'fail', `Expected HTTP ${expectedStatus} but request succeeded`);
    return false;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === expectedStatus) {
      record(name, 'pass', expectedMessage);
      return true;
    }

    record(name, 'fail', 'Received unexpected HTTP failure', {
      message: error instanceof Error ? error.message : String(error),
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
      data: axios.isAxiosError(error) ? error.response?.data : undefined
    });
    return false;
  }
}

async function main() {
  const deployment = loadDeploymentAddresses();
  const provider = new ethers.JsonRpcProvider(RPC_URL, RPC_CHAIN_ID);

  const wallets = {
    alpha: new ethers.Wallet(PRIVATE_KEYS.alpha, provider),
    beta: new ethers.Wallet(PRIVATE_KEYS.beta, provider),
    gamma: new ethers.Wallet(PRIVATE_KEYS.gamma, provider),
    delta: new ethers.Wallet(PRIVATE_KEYS.delta, provider)
  };
  const signers = {
    alpha: new ethers.NonceManager(wallets.alpha),
    beta: new ethers.NonceManager(wallets.beta),
    gamma: new ethers.NonceManager(wallets.gamma),
    delta: new ethers.NonceManager(wallets.delta)
  };

  const auth = {
    beta: await authenticateWallet(wallets.beta),
    gamma: await authenticateWallet(wallets.gamma),
    delta: await authenticateWallet(wallets.delta)
  };

  const contracts = {
    beta: new ethers.Contract(deployment.FORGE_QUEST_MANAGER_ADDRESS, FORGE_QUEST_MANAGER_ABI, signers.beta),
    gamma: new ethers.Contract(deployment.FORGE_QUEST_MANAGER_ADDRESS, FORGE_QUEST_MANAGER_ABI, signers.gamma),
    delta: new ethers.Contract(deployment.FORGE_QUEST_MANAGER_ADDRESS, FORGE_QUEST_MANAGER_ABI, signers.delta)
  };

  const successfulQuest = await createStartedQuest(auth.beta.client, signers.beta, contracts.beta);
  const validProofTxHash = await createValidProofTransaction({
    signer: signers.beta,
    signerAddress: wallets.beta.address,
    deployment,
    verification: successfulQuest.quest.metadata?.verification
  });
  const successSubmitHash = await submitProofAndQueue({
    client: auth.beta.client,
    contract: contracts.beta,
    chainQuestId: successfulQuest.chainQuestId,
    questId: successfulQuest.quest.id,
    proofTxHash: validProofTxHash
  });
  const verifiedQuest = await waitForQuestState(
    auth.beta.client,
    successfulQuest.quest.id,
    (quest) => quest?.status === 'VERIFIED'
  );

  if (verifiedQuest?.status === 'VERIFIED' && verifiedQuest.treasuryPayout?.status === 'PAID') {
    record('Positive flow', 'pass', 'Quest verified, reward paid, and proof lifecycle completed');
  } else {
    record('Positive flow', 'fail', 'Expected VERIFIED + PAID after successful proof', verifiedQuest);
  }

  const progression = await auth.beta.client.get('/player/progression', {
    params: { wallet: wallets.beta.address }
  });
  if (Number(progression.data?.progression?.xp ?? 0) > 0 && Number(progression.data?.progression?.achievements ?? 0) > 0) {
    record('Reward artifacts', 'pass', 'XP progression and NFT achievement count increased after verification');
  } else {
    record('Reward artifacts', 'fail', 'Progression payload did not reflect XP/NFT updates', progression.data);
  }

  await expectHttpFailure(
    'Double claim prevention',
    () =>
      auth.beta.client.post('/quests/submit-proof', {
        questId: successfulQuest.quest.id,
        proofUri: validProofTxHash,
        submissionTxHash: successSubmitHash
      }),
    400,
    'Verified quests cannot be queued for proof submission again'
  );

  const replayQuest = await createStartedQuest(auth.beta.client, signers.beta, contracts.beta);
  try {
    await contracts.beta.submitQuest(BigInt(replayQuest.chainQuestId), validProofTxHash);
    record('Replay protection', 'fail', 'Expected replayed proof hash to revert onchain');
  } catch {
    record('Replay protection', 'pass', 'Onchain proof reuse across quests is rejected');
  }

  const unauthorizedQuest = await createStartedQuest(auth.gamma.client, signers.gamma, contracts.gamma);
  await expectHttpFailure(
    'Unauthorized proof API',
    () =>
      auth.delta.client.post('/quests/submit-proof', {
        questId: unauthorizedQuest.quest.id,
        proofUri: '0x' + '11'.repeat(32),
        submissionTxHash: '0x' + '22'.repeat(32)
      }),
    403,
    'A different authenticated wallet cannot queue proof verification for another player'
  );

  const wrongWalletQuest = await createStartedQuest(auth.gamma.client, signers.gamma, contracts.gamma);
  const wrongWalletProofTx = await signers.delta.sendTransaction({
    to: wallets.beta.address,
    value: ethers.parseEther('0.05')
  });
  await wrongWalletProofTx.wait();
  await submitProofAndQueue({
    client: auth.gamma.client,
    contract: contracts.gamma,
    chainQuestId: wrongWalletQuest.chainQuestId,
    questId: wrongWalletQuest.quest.id,
    proofTxHash: wrongWalletProofTx.hash
  });
  const failedWrongWalletQuest = await waitForQuestState(
    auth.gamma.client,
    wrongWalletQuest.quest.id,
    (quest) => quest?.status === 'FAILED'
  );
  if (
    failedWrongWalletQuest?.status === 'FAILED' &&
    failedWrongWalletQuest.treasuryPayout?.status === 'REFUNDED'
  ) {
    record('Wrong wallet proof rejection', 'pass', 'Deterministic verification rejected a proof transaction from the wrong wallet');
  } else {
    record('Wrong wallet proof rejection', 'fail', 'Wrong-wallet proof was not rejected with refund settlement', failedWrongWalletQuest);
  }

  const fakeProofQuest = await createStartedQuest(auth.gamma.client, signers.gamma, contracts.gamma);
  const fakeProofHash = `0x${'12'.repeat(32)}`;
  await submitProofAndQueue({
    client: auth.gamma.client,
    contract: contracts.gamma,
    chainQuestId: fakeProofQuest.chainQuestId,
    questId: fakeProofQuest.quest.id,
    proofTxHash: fakeProofHash
  });
  const failedFakeQuest = await waitForQuestState(
    auth.gamma.client,
    fakeProofQuest.quest.id,
    (quest) => quest?.status === 'FAILED'
  );
  if (failedFakeQuest?.status === 'FAILED' && failedFakeQuest.treasuryPayout?.status === 'REFUNDED') {
    record('Fake tx rejection', 'pass', 'Missing/nonexistent proof transactions are rejected and refunded');
  } else {
    record('Fake tx rejection', 'fail', 'Fake proof hash did not fail as expected', failedFakeQuest);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

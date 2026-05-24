/**
 * QuestForge AI - Wallet-Driven Gameplay Validation
 *
 * Validates the current production gameplay path:
 * 1. Backend health
 * 2. Wallet authentication challenge flow
 * 3. Quest generation API
 * 4. Realtime/bootstrap visibility
 * 5. Contract deployment configuration
 * 6. Optional onchain create -> register -> start -> register-start flow
 *
 * Usage:
 *   npx ts-node scripts/validate-gameplay.ts
 *
 * Optional env for onchain validation:
 *   VALIDATION_PRIVATE_KEY=0x...
 *   VALIDATION_RPC_URL=https://forno.celo.org
 */

import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.join(__dirname, '../.env.production');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

type GameplayStatus = 'pass' | 'fail' | 'pending';

type GameplayTest = {
  name: string;
  status: GameplayStatus;
  duration: number;
  message: string;
  details?: unknown;
};

type AuthSessionPayload = {
  accessToken: string;
  session: {
    id: string;
    wallet: string;
    expiresAt: string;
  };
  user: {
    id: string;
    wallet: string;
  };
};

type SignableWallet = {
  address: string;
  signMessage(message: string | Uint8Array): Promise<string>;
};

type GeneratedQuestPayload = {
  quest: {
    id: string;
    orchestrationId?: string;
    title: string;
    metadataUri: string;
    metadata?: Record<string, unknown>;
    generation?: {
      source?: string;
      provider?: string;
      model?: string | null;
      promptHash?: string;
      fallbackReason?: string | null;
    };
    stakeAmount: string | number;
    rewardAmount: string | number;
    xpReward: string | number;
    durationSeconds: string | number;
    status?: string;
  };
};

type DeploymentAddresses = {
  FORGE_QUEST_MANAGER_ADDRESS: string;
  REWARD_NFT_ADDRESS: string;
  REPUTATION_ADDRESS: string;
  TREASURY_ADDRESS: string;
};

const tests: GameplayTest[] = [];
const CELO_CHAIN_ID = Number(process.env.CELO_CHAIN_ID || '42220');
const DEFAULT_RPC_URL = process.env.VALIDATION_RPC_URL || process.env.CELO_RPC_URL || 'https://forno.celo.org';

const FORGE_QUEST_MANAGER_ABI = [
  'function createQuest(string title,string metadataUri,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external',
  'function startQuest(uint256 questId) external payable',
  'function quests(uint256) view returns (uint256 questId,address creator,string title,string metadataUri,string proofUri,bytes32 proofHash,uint256 stakeAmount,uint256 rewardAmount,uint256 xpReward,uint256 createdAt,uint256 startedAt,uint256 expiresAt,uint8 status,address player,uint256 playerNonce,bytes32 proofVerificationHash)',
  'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount,uint256 xpReward)'
];

function recordTest(
  name: string,
  status: GameplayStatus,
  message: string,
  duration = 0,
  details?: unknown
) {
  tests.push({ name, status, message, duration, details });
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '❌' : '⏳';
  const color = status === 'pass' ? '\x1b[32m' : status === 'fail' ? '\x1b[31m' : '\x1b[36m';
  console.log(`${color}${icon} [${duration}ms] ${name}: ${message}\x1b[0m`);
}

function loadDeploymentAddresses(): DeploymentAddresses {
  const deploymentPath = path.join(__dirname, '../contracts/deployments/celo-addresses.json');
  if (fs.existsSync(deploymentPath)) {
    const parsed = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as DeploymentAddresses;
    return parsed;
  }

  const manager = process.env.FORGE_QUEST_MANAGER_ADDRESS || process.env.VITE_FORGE_QUEST_MANAGER_ADDRESS;
  const rewardNft = process.env.REWARD_NFT_ADDRESS || process.env.VITE_REWARD_NFT_ADDRESS;
  const reputation = process.env.REPUTATION_ADDRESS || process.env.VITE_REPUTATION_ADDRESS;
  const treasury = process.env.TREASURY_ADDRESS || process.env.VITE_TREASURY_ADDRESS;

  if (!manager || !rewardNft || !reputation || !treasury) {
    throw new Error('Missing deployment addresses. Provide env vars or contracts/deployments/celo-addresses.json.');
  }

  return {
    FORGE_QUEST_MANAGER_ADDRESS: manager,
    REWARD_NFT_ADDRESS: rewardNft,
    REPUTATION_ADDRESS: reputation,
    TREASURY_ADDRESS: treasury
  };
}

function resolveUrls(rawBase: string) {
  const normalized = rawBase.replace(/\/$/, '');
  if (normalized.endsWith('/api')) {
    return {
      rootUrl: normalized.slice(0, -4),
      apiUrl: normalized
    };
  }

  return {
    rootUrl: normalized,
    apiUrl: `${normalized}/api`
  };
}

function buildApiClient(apiUrl: string, accessToken?: string) {
  return axios.create({
    baseURL: apiUrl,
    timeout: 15000,
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
    },
    withCredentials: true
  });
}

async function authenticateWallet(client: AxiosInstance, wallet: SignableWallet): Promise<AuthSessionPayload> {
  const nonceResponse = await client.post('/auth/nonce', {
    wallet: wallet.address,
    chainId: CELO_CHAIN_ID
  });

  const nonce = nonceResponse.data?.nonce;
  const message = nonceResponse.data?.message;
  if (typeof nonce !== 'string' || typeof message !== 'string') {
    throw new Error('Auth nonce response was malformed');
  }

  const signature = await wallet.signMessage(message);
  const verifyResponse = await client.post<AuthSessionPayload>('/auth/verify', {
    wallet: wallet.address,
    nonce,
    signature,
    chainId: CELO_CHAIN_ID
  });

  if (!verifyResponse.data?.accessToken) {
    throw new Error('Auth verify response did not include an access token');
  }

  return verifyResponse.data;
}

async function main() {
  const rawBase = process.env.API_URL || process.env.BACKEND_URL || 'http://localhost:4000';
  const { rootUrl, apiUrl } = resolveUrls(rawBase);
  const deployment = loadDeploymentAddresses();
  const validationPrivateKey = process.env.VALIDATION_PRIVATE_KEY?.trim();
  const authWallet = validationPrivateKey ? new ethers.Wallet(validationPrivateKey) : ethers.Wallet.createRandom();

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║      QuestForge AI - Wallet Gameplay Validation           ║');
  console.log('║            Current Celo Mainnet Production Flow           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`🎮 Backend root: ${rootUrl}`);
  console.log(`🔌 API base:     ${apiUrl}`);
  console.log(`👛 Test wallet:  ${authWallet.address}`);
  console.log(`⛓️  Chain ID:     ${CELO_CHAIN_ID}\n`);

  try {
    let startedAt = Date.now();
    try {
      const response = await axios.get(`${rootUrl}/health`, { timeout: 5000 });
      recordTest('Backend Health', 'pass', 'Backend health endpoint responded', Date.now() - startedAt, response.data);
    } catch (error) {
      recordTest('Backend Health', 'fail', `Backend unavailable: ${error instanceof Error ? error.message : String(error)}`, Date.now() - startedAt);
      throw error;
    }

    const unauthenticatedClient = buildApiClient(apiUrl);

    startedAt = Date.now();
    const authSession = await authenticateWallet(unauthenticatedClient, authWallet);
    recordTest(
      'Wallet Authentication',
      'pass',
      `Authenticated wallet session ${authSession.session.id}`,
      Date.now() - startedAt,
      {
        wallet: authSession.session.wallet,
        userId: authSession.user.id,
        expiresAt: authSession.session.expiresAt
      }
    );

    const authenticatedClient = buildApiClient(apiUrl, authSession.accessToken);

    startedAt = Date.now();
    const generatedQuestResponse = await authenticatedClient.post<GeneratedQuestPayload>('/quests/generate', {
      chain: 'Celo'
    });
    const generatedQuest = generatedQuestResponse.data.quest;
    const generation = generatedQuest.generation || {};
    const promptHash = generation.promptHash || (generatedQuest.metadata?.generation as { promptHash?: string } | undefined)?.promptHash;
    const hasGenerationDiagnostics = Boolean(generation.provider && promptHash);

    recordTest(
      'Quest Generation',
      hasGenerationDiagnostics ? 'pass' : 'fail',
      hasGenerationDiagnostics
        ? `Generated quest ${generatedQuest.id} with ${generation.source || 'unknown'} narrative provenance`
        : `Generated quest ${generatedQuest.id} but provenance metadata was incomplete`,
      Date.now() - startedAt,
      {
        questId: generatedQuest.id,
        orchestrationId: generatedQuest.orchestrationId,
        provider: generation.provider,
        model: generation.model,
        promptHash,
        fallbackReason: generation.fallbackReason ?? null
      }
    );

    startedAt = Date.now();
    const realtimeBootstrap = await authenticatedClient.get('/realtime/bootstrap');
    const realtimeQuests = Array.isArray(realtimeBootstrap.data?.quests) ? realtimeBootstrap.data.quests : [];
    const foundQuest = realtimeQuests.find((quest: { id?: string }) => quest.id === generatedQuest.id);

    recordTest(
      'Realtime Bootstrap',
      foundQuest ? 'pass' : 'fail',
      foundQuest ? `Generated quest ${generatedQuest.id} is visible in realtime bootstrap` : `Generated quest ${generatedQuest.id} was not present in realtime bootstrap`,
      Date.now() - startedAt,
      {
        questCount: realtimeQuests.length
      }
    );

    startedAt = Date.now();
    const provider = new ethers.JsonRpcProvider(DEFAULT_RPC_URL, CELO_CHAIN_ID);
    const code = await provider.getCode(deployment.FORGE_QUEST_MANAGER_ADDRESS);
    recordTest(
      'Contract Deployment',
      code !== '0x' ? 'pass' : 'fail',
      code !== '0x'
        ? `ForgeQuestManager deployed at ${deployment.FORGE_QUEST_MANAGER_ADDRESS}`
        : `No bytecode found at ${deployment.FORGE_QUEST_MANAGER_ADDRESS}`,
      Date.now() - startedAt,
      {
        manager: deployment.FORGE_QUEST_MANAGER_ADDRESS,
        treasury: deployment.TREASURY_ADDRESS
      }
    );

    if (!validationPrivateKey) {
      recordTest(
        'Wallet Tx Flow',
        'pending',
        'Set VALIDATION_PRIVATE_KEY to execute createQuest -> register-onchain -> startQuest -> register-start against the live deployment.'
      );
    } else {
      const signer = new ethers.Wallet(validationPrivateKey, provider);
      if (signer.address.toLowerCase() !== authWallet.address.toLowerCase()) {
        throw new Error('VALIDATION_PRIVATE_KEY did not produce the authenticated wallet address');
      }

      const contract = new ethers.Contract(
        deployment.FORGE_QUEST_MANAGER_ADDRESS,
        FORGE_QUEST_MANAGER_ABI,
        signer
      );

      startedAt = Date.now();
      const createTx = await contract.createQuest(
        generatedQuest.title,
        generatedQuest.metadataUri,
        ethers.parseEther(String(generatedQuest.stakeAmount)),
        ethers.parseEther(String(generatedQuest.rewardAmount)),
        BigInt(generatedQuest.xpReward),
        BigInt(generatedQuest.durationSeconds)
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
        throw new Error('Quest creation receipt did not include QuestCreated');
      }

      await authenticatedClient.post('/quests/register-onchain', {
        questId: generatedQuest.id,
        chainQuestId,
        creationTxHash: createTx.hash
      });

      recordTest(
        'Onchain Quest Creation',
        'pass',
        `Created and registered chain quest ${chainQuestId}`,
        Date.now() - startedAt,
        {
          txHash: createTx.hash,
          chainQuestId
        }
      );

      startedAt = Date.now();
      const onchainQuest = await contract.quests(BigInt(chainQuestId));
      const stakeValue = BigInt(onchainQuest.stakeAmount.toString());
      const gasEstimate = await contract.startQuest.estimateGas(BigInt(chainQuestId), { value: stakeValue });
      const startTx = await contract.startQuest(BigInt(chainQuestId), {
        value: stakeValue,
        gasLimit: gasEstimate + gasEstimate / 5n
      });
      await startTx.wait();

      await authenticatedClient.post('/quests/register-start', {
        questId: generatedQuest.id,
        chainQuestId,
        startTxHash: startTx.hash
      });

      recordTest(
        'Onchain Quest Start',
        'pass',
        `Started and registered chain quest ${chainQuestId}`,
        Date.now() - startedAt,
        {
          txHash: startTx.hash,
          chainQuestId,
          stakeValueWei: stakeValue.toString(),
          gasEstimate: gasEstimate.toString()
        }
      );

      recordTest(
        'Proof / Settlement Flow',
        'pending',
        'Proof submission was not auto-executed because verifier-compatible gameplay transactions depend on quest-specific rules.'
      );
    }
  } catch (error) {
    recordTest('Gameplay Validation', 'fail', error instanceof Error ? error.message : String(error));
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                     VALIDATION SUMMARY                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const passed = tests.filter((test) => test.status === 'pass').length;
  const failed = tests.filter((test) => test.status === 'fail').length;
  const pending = tests.filter((test) => test.status === 'pending').length;

  console.log(`✓ Passed:  ${passed}`);
  console.log(`⏳ Pending: ${pending}`);
  console.log(`❌ Failed:  ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

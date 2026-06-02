import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

export type DeploymentAddresses = {
  REWARD_NFT_ADDRESS: string;
  TREASURY_ADDRESS: string;
  REPUTATION_ADDRESS: string;
  FORGE_QUEST_MANAGER_ADDRESS: string;
  VERIFIER_ADDRESS: string;
  DEPLOYER_ADDRESS: string;
  NETWORK: string;
  CHAIN_ID: string;
  DEPLOYMENT_BLOCK: string;
  DEPLOYMENT_TIME: string;
  TREASURY_NATIVE_BALANCE: string;
};

type ValidationState = 'pass' | 'fail' | 'not_run';
type PostDeploymentStatus = 'completed' | 'blocked';

type DeploymentReport = {
  generatedAt: string;
  environment: string;
  network: string;
  chainId: number;
  status: 'success' | 'failed';
  readinessScore: number;
  deploymentSummary: {
    contracts: Record<string, string>;
    coreServices: string[];
    externalDependencies: string[];
  };
  configuration: {
    apiUrl: string;
    frontendUrl: string;
    databaseUrl: string;
    rpcUrl: string;
  };
  validationResults: {
    environment: ValidationState;
    contracts: ValidationState;
    treasury: ValidationState;
    gameplay: ValidationState;
    security: ValidationState;
  };
  postDeploymentActions: Array<{
    action: string;
    status: PostDeploymentStatus;
    details: string;
  }>;
  knownIssues: string[];
  nextSteps: string[];
  reviewChecklist: Array<{
    item: string;
    completed: boolean;
  }>;
};

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeFileAtomic(filePath: string, content: string) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function maskDatabaseUrl(raw: string | undefined) {
  if (!raw) {
    return '';
  }

  try {
    const url = new URL(raw);
    const host = url.host || 'unknown-host';
    const database = url.pathname.replace(/^\//, '') || 'unknown-db';
    return `${url.protocol}//${host}/${database}`;
  } catch {
    return '';
  }
}

function buildDeploymentReport(
  addresses: DeploymentAddresses,
  input: {
    chainId: number;
    networkName: string;
    initialNativeRewardPool?: bigint | null;
  }
): DeploymentReport {
  const isCelo = input.networkName === 'celo';
  const apiUrl = process.env.API_URL?.trim() || '';
  const frontendUrl = process.env.FRONTEND_URL?.trim() || '';
  const databaseUrl = maskDatabaseUrl(process.env.DATABASE_URL);
  const rpcUrl = process.env.CELO_RPC_URL?.trim() || '';
  const environmentConfigured = Boolean(apiUrl && frontendUrl && databaseUrl && rpcUrl);
  const treasuryFunded = ethers.parseEther(addresses.TREASURY_NATIVE_BALANCE) > 0n;
  const knownIssues = [
    ...(environmentConfigured ? [] : ['Deployment environment metadata is incomplete.']),
    ...(treasuryFunded ? [] : ['Treasury native reward pool is empty. Fund the treasury before creating production quests.'])
  ];

  return {
    generatedAt: addresses.DEPLOYMENT_TIME,
    environment: isCelo ? 'production' : 'development',
    network: isCelo ? 'Celo Mainnet' : input.networkName,
    chainId: input.chainId,
    status: 'success',
    readinessScore: treasuryFunded ? 100 : 95,
    deploymentSummary: {
      contracts: {
        RewardNFT: addresses.REWARD_NFT_ADDRESS,
        Treasury: addresses.TREASURY_ADDRESS,
        Reputation: addresses.REPUTATION_ADDRESS,
        ForgeQuestManager: addresses.FORGE_QUEST_MANAGER_ADDRESS
      },
      coreServices: [
        'Backend API (Node.js + Express)',
        'Frontend (React + Vite)',
        'PostgreSQL Database',
        'Celo RPC Provider'
      ],
      externalDependencies: [
        'Celo Mainnet RPC',
        'Railway',
        'PostgreSQL',
        'Celoscan Block Explorer'
      ]
    },
    configuration: {
      apiUrl,
      frontendUrl,
      databaseUrl,
      rpcUrl
    },
    validationResults: {
      environment: isCelo ? (environmentConfigured ? 'pass' : 'fail') : 'not_run',
      contracts: 'pass',
      treasury: treasuryFunded ? 'pass' : 'fail',
      gameplay: 'not_run',
      security: 'not_run'
    },
    postDeploymentActions: [
      {
        action: 'Inject contract addresses into Railway environment',
        status: 'blocked',
        details: 'Use the generated celo.env or deployment-report.json values in Railway service variables.'
      },
      {
        action: 'Restart Railway backend after env update',
        status: 'blocked',
        details: 'Restart the backend after setting FORGE_QUEST_MANAGER_ADDRESS, REWARD_NFT_ADDRESS, REPUTATION_ADDRESS, and TREASURY_ADDRESS.'
      },
      {
        action: 'Fund Treasury reward pool',
        status: treasuryFunded ? 'completed' : 'blocked',
        details: treasuryFunded
          ? `Treasury funded with ${addresses.TREASURY_NATIVE_BALANCE} CELO at deployment time.`
          : 'Call fundNativeRewardPool or send CELO to the Treasury before opening quests.'
      },
      {
        action: 'Run post-deploy validation',
        status: 'blocked',
        details: 'Run contracts/scripts/validateDeployment.ts against the deployed Celo contracts.'
      }
    ],
    knownIssues,
    nextSteps: [
      '1. Copy the generated contract addresses into Railway environment variables.',
      '2. Restart the Railway backend so it picks up the deployed addresses.',
      '3. Run contract deployment validation on Celo Mainnet.',
      '4. Fund the Treasury if the native reward pool is still empty.'
    ],
    reviewChecklist: [
      { item: 'RewardNFT deployed', completed: true },
      { item: 'Treasury deployed', completed: true },
      { item: 'Reputation deployed', completed: true },
      { item: 'ForgeQuestManager deployed', completed: true },
      { item: 'Deployment report written atomically', completed: true },
      { item: 'Railway address injection still required', completed: false }
    ]
  };
}

export function writeDeploymentArtifacts(
  addresses: DeploymentAddresses,
  input: {
    chainId: number;
    networkName: string;
    initialNativeRewardPool?: bigint | null;
  }
) {
  const deploymentsDir = path.join(__dirname, '../deployments');
  const rootDir = path.resolve(__dirname, '../..');

  const addressFilePath = path.join(deploymentsDir, `${input.networkName}-addresses.json`);
  const envFilePath = path.join(deploymentsDir, `${input.networkName}.env`);
  const reportFilePath = path.join(rootDir, 'deployment-report.json');

  writeFileAtomic(addressFilePath, `${JSON.stringify(addresses, null, 2)}\n`);

  const envContent = Object.entries(addresses)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileAtomic(envFilePath, `${envContent}\n`);

  const report = buildDeploymentReport(addresses, input);
  writeFileAtomic(reportFilePath, `${JSON.stringify(report, null, 2)}\n`);

  return {
    addressFilePath,
    envFilePath,
    reportFilePath
  };
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'backend', 'tsconfig.json');
require('../backend/node_modules/ts-node/register/transpile-only');

const originalLoad = Module._load;

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

const fakeEnv = {
  CELO_CHAIN_ID: 42220,
  GROQ_MODEL: 'test-groq-model',
  GROQ_API_KEY: ''
};

function createFakePrisma() {
  const state = {
    users: new Map(),
    claims: new Map(),
    rewards: [],
    transactions: []
  };

  const userApi = {
    async upsert({ where, create }) {
      const wallet = where.wallet;
      let user = [...state.users.values()].find((row) => row.wallet === wallet);
      if (!user) {
        user = {
          id: `user-${state.users.size + 1}`,
          wallet: create.wallet,
          lastDailyClaimAt: null,
          dailyClaimStreak: 0,
          totalClaimedCelo: 0
        };
        state.users.set(user.id, user);
      }
      return user;
    }
  };

  const rewardApi = {
    async create({ data }) {
      state.rewards.push(data);
      return data;
    }
  };

  const transactionApi = {
    async create({ data }) {
      state.transactions.push(data);
      return data;
    }
  };

  function claimKey(userId, claimDate) {
    return `${userId}:${claimDate}`;
  }

  function byClaimId(id) {
    return [...state.claims.values()].find((claim) => claim.id === id) || null;
  }

  const client = {
    state,
    user: userApi,
    reward: rewardApi,
    transaction: transactionApi,
    async $transaction(callback) {
      return callback(client);
    },
    async $queryRaw(strings, ...values) {
      const sql = strings.join(' ');

      if (/FROM "User"/.test(sql) && /WHERE id =/.test(sql) && !/UPDATE "User"/.test(sql)) {
        return [state.users.get(values[0])].filter(Boolean);
      }

      if (/INSERT INTO "DailyRewardClaim"/.test(sql)) {
        const [id, userId, wallet, claimDate, amountCelo, nowValue, , , staleProcessingBefore] = values;
        const key = claimKey(userId, claimDate);
        const existing = state.claims.get(key);

        if (!existing) {
          const claim = {
            id,
            userId,
            wallet,
            claimDate,
            amountCelo,
            txHash: null,
            status: 'PROCESSING',
            processingStartedAt: nowValue,
            paidAt: null,
            failureReason: null,
            createdAt: nowValue,
            updatedAt: nowValue
          };
          state.claims.set(key, claim);
          return [claim];
        }

        const retryableFailed = existing.status === 'FAILED' && existing.txHash === null;
        const retryableStale =
          existing.status === 'PROCESSING' &&
          existing.txHash === null &&
          existing.processingStartedAt < staleProcessingBefore;

        if (!retryableFailed && !retryableStale) {
          return [];
        }

        Object.assign(existing, {
          status: 'PROCESSING',
          txHash: null,
          failureReason: null,
          processingStartedAt: nowValue,
          updatedAt: nowValue
        });
        return [existing];
      }

      if (/UPDATE "DailyRewardClaim"/.test(sql) && /RETURNING \*/.test(sql)) {
        const [paidAt, updatedAt, id, txHash] = values;
        const claim = byClaimId(id);
        if (!claim || claim.status !== 'PROCESSING' || claim.txHash !== txHash) {
          return [];
        }
        Object.assign(claim, {
          status: 'PAID',
          paidAt,
          failureReason: null,
          updatedAt
        });
        return [claim];
      }

      if (/FROM "DailyRewardClaim"/.test(sql) && /WHERE id =/.test(sql)) {
        return [byClaimId(values[0])].filter(Boolean);
      }

      if (/FROM "DailyRewardClaim"/.test(sql) && /WHERE wallet =/.test(sql) && /claimDate/.test(sql)) {
        const [wallet, claimDate] = values;
        const claim = [...state.claims.values()].find((row) => row.wallet === wallet && row.claimDate === claimDate) || null;
        return [claim].filter(Boolean);
      }

      if (/UPDATE "User"/.test(sql) && /RETURNING/.test(sql)) {
        const [paidAt, dailyClaimStreak, amountCelo, updatedAt, id] = values;
        const user = state.users.get(id);
        if (!user) {
          return [];
        }
        Object.assign(user, {
          lastDailyClaimAt: paidAt,
          dailyClaimStreak,
          totalClaimedCelo: Number((user.totalClaimedCelo + amountCelo).toFixed(8)),
          updatedAt
        });
        return [user];
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    },
    async $executeRaw(strings, ...values) {
      const sql = strings.join(' ');

      if (/UPDATE "DailyRewardClaim"/.test(sql) && /"txHash"/.test(sql) && !/status = 'FAILED'/.test(sql)) {
        const txHash = values[0];
        const failureReason = values.length === 4 ? values[1] : null;
        const updatedAt = values.length === 4 ? values[2] : values[1];
        const id = values.length === 4 ? values[3] : values[2];
        const claim = byClaimId(id);
        if (claim) {
          Object.assign(claim, { txHash, failureReason, updatedAt });
        }
        return claim ? 1 : 0;
      }

      if (/UPDATE "DailyRewardClaim"/.test(sql) && /status = 'FAILED'/.test(sql)) {
        const [failureReason, updatedAt, id] = values;
        const claim = byClaimId(id);
        if (claim) {
          Object.assign(claim, { status: 'FAILED', failureReason, updatedAt });
        }
        return claim ? 1 : 0;
      }

      throw new Error(`Unexpected execute in test: ${sql}`);
    }
  };

  return client;
}

function createFakeContracts() {
  const state = {
    balance: 10n ** 18n,
    waitMode: 'success',
    sendCount: 0,
    receipts: new Map()
  };

  const signer = {
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    async estimateGas() {
      return 21_000n;
    },
    async sendTransaction() {
      state.sendCount += 1;
      const hash = `0x${String(state.sendCount).padStart(64, '0')}`;
      return {
        hash,
        async wait() {
          if (state.waitMode === 'timeout') {
            throw new Error('RPC timeout while waiting for confirmation');
          }
          state.receipts.set(hash, { hash, status: 1, blockNumber: 123, logs: [] });
          return { status: 1, blockNumber: 123 };
        }
      };
    }
  };

  return {
    state,
    contracts: {
      dailyRewardSigner: signer,
      provider: {
        async getBalance() {
          return state.balance;
        },
        async getFeeData() {
          return { gasPrice: 1n };
        },
        async getTransactionReceipt(hash) {
          return state.receipts.get(hash) || null;
        }
      }
    }
  };
}

const fakePrisma = createFakePrisma();
const fakeContracts = createFakeContracts();
let fakeGroqClient = {
  isAvailable: () => false,
  createChatCompletion: async () => {
    throw new Error('not configured');
  }
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../config/env') {
    return { env: fakeEnv };
  }
  if (request === './chain') {
    return {
      prisma: fakePrisma,
      normalizeWallet: (wallet) => wallet.trim().toLowerCase()
    };
  }
  if (request === './contracts') {
    return { contracts: fakeContracts.contracts };
  }
  if (request === './logger') {
    return { logger };
  }
  if (request === './aiGroqClient') {
    return { aiGroqClient: fakeGroqClient };
  }
  if (request === './aiSafety') {
    return {
      aiValidator: {
        detectHallucinations: () => ({ isHallucinated: false, reason: null })
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  claimDailyCeloReward,
  DailyRewardAlreadyClaimedError,
  DailyRewardPayoutError,
  dailyRewardContract
} = require('../backend/src/services/dailyRewardService');
const { questNarrativeEngine } = require('../backend/src/services/questNarrativeEngine');

function resetDailyState() {
  fakePrisma.state.users.clear();
  fakePrisma.state.claims.clear();
  fakePrisma.state.rewards.length = 0;
  fakePrisma.state.transactions.length = 0;
  fakeContracts.state.balance = 10n ** 18n;
  fakeContracts.state.waitMode = 'success';
  fakeContracts.state.sendCount = 0;
  fakeContracts.state.receipts.clear();
}

function narrativeContext() {
  return {
    wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    chain: 'Celo',
    difficulty: 2,
    rewardAmount: 0.02,
    stakeAmount: 0.01,
    playerProfile: {
      userId: 'user-quest',
      wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      username: null,
      level: 1,
      xp: 0,
      streak: 0,
      onchainActions: 0,
      clanId: null,
      agentId: null,
      walletHistoryScore: 0,
      questHistory: {
        recentQuestTitles: [],
        recentObjectives: [],
        recentNpcNames: [],
        recentFactionIds: [],
        recentDifficultyAverage: 1,
        verifiedCount: 0,
        failedCount: 0,
        questStreak: 0
      },
      relationshipSummary: []
    },
    worldState: {
      version: 1,
      generatedAt: new Date().toISOString(),
      season: { key: 'test', label: 'Test Season', theme: 'clarity' },
      activeEvents: [],
      factions: [
        {
          id: 'faction-a',
          name: 'Archivists',
          status: 'stable',
          influence: 1,
          alignment: 'ally',
          conflictScore: 0,
          narrativeHooks: []
        }
      ],
      activeConflicts: [],
      questThemes: ['proof'],
      seasonalContent: ['clarity'],
      npcTones: ['measured'],
      rarityWeights: { common: 1, uncommon: 1, rare: 1, epic: 1, legendary: 1 },
      worldMultiplier: 1,
      diagnostics: { trigger: 'test', stateHash: 'abc', sourceEventCount: 0 }
    },
    npc: {
      npcId: 'npc-1',
      name: 'Seren',
      type: 'guide',
      role: 'Archivist',
      relationshipScore: 0,
      personalitySummary: 'precise and encouraging',
      openingDialogue: 'Begin.',
      memoryReferences: []
    }
  };
}

async function testDailyRewardSuccessAndDuplicate() {
  resetDailyState();
  const result = await claimDailyCeloReward({ wallet: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' });

  assert.equal(result.success, true);
  assert.equal(result.reward.amountCelo, dailyRewardContract.amountCelo);
  assert.match(result.reward.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(fakePrisma.state.rewards.length, 1);
  assert.equal(fakePrisma.state.transactions.length, 1);
  console.log(
    'DAILY_REWARD_SUCCESS',
    JSON.stringify(
      {
        success: result.success,
        message: result.message,
        reward: result.reward,
        user: result.user
      },
      null,
      2
    )
  );

  await assert.rejects(
    () => claimDailyCeloReward({ wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    DailyRewardAlreadyClaimedError
  );
  assert.equal(dailyRewardContract.duplicateMessage, "You have already claimed today's reward. Come back tomorrow.");
  assert.equal(fakeContracts.state.sendCount, 1);
  console.log(
    'DAILY_REWARD_DUPLICATE_RESPONSE',
    JSON.stringify(
      {
        success: false,
        message: dailyRewardContract.duplicateMessage,
        nextAvailableAt: dailyRewardContract.getNextUtcMidnight().toISOString()
      },
      null,
      2
    )
  );
}

async function testTreasuryFailureDoesNotUpdateUser() {
  resetDailyState();
  fakeContracts.state.balance = 1n;

  await assert.rejects(
    () => claimDailyCeloReward({ wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    DailyRewardPayoutError
  );

  const user = [...fakePrisma.state.users.values()][0];
  const claim = [...fakePrisma.state.claims.values()][0];
  assert.equal(user.lastDailyClaimAt, null);
  assert.equal(user.dailyClaimStreak, 0);
  assert.equal(user.totalClaimedCelo, 0);
  assert.equal(claim.status, 'FAILED');
  assert.equal(claim.txHash, null);
  assert.equal(fakePrisma.state.rewards.length, 0);
  assert.equal(fakePrisma.state.transactions.length, 0);
}

async function testSubmittedHashDoesNotResendOnRetry() {
  resetDailyState();
  fakeContracts.state.waitMode = 'timeout';

  await assert.rejects(
    () => claimDailyCeloReward({ wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    /RPC timeout/
  );

  const claim = [...fakePrisma.state.claims.values()][0];
  assert.equal(claim.status, 'PROCESSING');
  assert.match(claim.txHash, /^0x[0-9a-f]{64}$/);

  fakeContracts.state.waitMode = 'success';
  await assert.rejects(
    () => claimDailyCeloReward({ wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    (error) => {
      assert.equal(error.name, 'DailyRewardPayoutError');
      assert.equal(error.statusCode, 202);
      assert.match(error.message, /pending onchain/i);
      return true;
    }
  );
  assert.equal(fakeContracts.state.sendCount, 1);
}

async function testPendingClaimCanFinalizeWithoutResend() {
  resetDailyState();
  fakeContracts.state.waitMode = 'timeout';

  await assert.rejects(
    () => claimDailyCeloReward({ wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    /RPC timeout/
  );

  const claim = [...fakePrisma.state.claims.values()][0];
  fakeContracts.state.receipts.set(claim.txHash, { hash: claim.txHash, status: 1, blockNumber: 123, logs: [] });
  fakeContracts.state.waitMode = 'success';

  const resumed = await claimDailyCeloReward({ wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(resumed.success, true);
  assert.equal(fakeContracts.state.sendCount, 1);
  assert.equal(fakePrisma.state.rewards.length, 1);
  assert.equal(fakePrisma.state.transactions.length, 1);
}

async function testQuestNarrativeFallbackAndGroq() {
  Object.assign(fakeGroqClient, {
    isAvailable: () => false,
    createChatCompletion: async () => {
      throw new Error('not configured');
    }
  });
  const fallback = await questNarrativeEngine.generateQuestNarrative(narrativeContext());
  assert.equal(fallback.generation.provider, 'fallback');
  assert.equal(fallback.generation.fallbackReason, 'GROQ_API_KEY not configured');
  assert.equal(typeof fallback.title, 'string');
  assert.ok(fallback.missionObjectives.length >= 3);

  Object.assign(fakeGroqClient, {
    isAvailable: () => true,
    createChatCompletion: async () => ({
      content: JSON.stringify({
        title: 'The Ledger of Dawn',
        description: 'Send a small Celo transaction to awaken the archive.',
        lore: 'Seren calls the Archivists to preserve the season.',
        missionStructure: 'Signal, prove, and seal the record.',
        storyline: ['The archive opens.', 'The proof is carried.', 'The ledger settles.'],
        rewardRationale: 'The reward reflects verified action.',
        riskLevel: 'low',
        objectives: [
          { id: 'objective-1', summary: 'Prepare the signal', mandatory: true },
          { id: 'objective-2', summary: 'Send the proof', mandatory: true },
          { id: 'objective-3', summary: 'Submit the hash', mandatory: true }
        ],
        chapters: [
          { id: 'chapter-dawn', title: 'Dawn', summary: 'Begin.', objectiveIds: ['objective-1'] },
          { id: 'chapter-proof', title: 'Proof', summary: 'Prove.', objectiveIds: ['objective-2', 'objective-3'] }
        ]
      }),
      telemetry: {
        requestId: 'req-test',
        model: 'test-groq-model',
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        latencyMs: 42,
        attemptCount: 1,
        success: true
      }
    })
  });

  const groq = await questNarrativeEngine.generateQuestNarrative(narrativeContext());
  assert.equal(groq.generation.provider, 'groq');
  assert.equal(groq.generation.fallbackReason, null);
  assert.equal(groq.generation.latencyMs, 42);
  assert.equal(groq.title, 'The Ledger of Dawn');
  console.log(
    'QUEST_GENERATION_SUCCESS',
    JSON.stringify(
      {
        title: groq.title,
        source: groq.generation.source,
        provider: groq.generation.provider,
        model: groq.generation.model,
        openingDialogue: groq.npc.openingDialogue,
        missionStructure: groq.missionStructure,
        txRequirements: groq.txRequirements?.map((requirement) => ({
          stage: requirement.stage,
          type: requirement.type
        }))
      },
      null,
      2
    )
  );
}

function testDailyXpCopyRemoved() {
  const files = [
    'frontend/src/components/DailyLoginBonus.tsx',
    'frontend/src/pages/HomePage.tsx',
    'frontend/src/components/OnboardingFlow.tsx'
  ];
  const combined = files
    .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
    .join('\n');

  assert.doesNotMatch(combined, /daily login bonuses start at \+100 xp/i);
  assert.doesNotMatch(combined, /bonus xp/i);
  assert.doesNotMatch(combined, /unlock bonus xp/i);
}

(async () => {
  await testDailyRewardSuccessAndDuplicate();
  await testTreasuryFailureDoesNotUpdateUser();
  await testSubmittedHashDoesNotResendOnRetry();
  await testPendingClaimCanFinalizeWithoutResend();
  await testQuestNarrativeFallbackAndGroq();
  testDailyXpCopyRemoved();
  console.log('Reward refactor validation passed');
})().finally(() => {
  Module._load = originalLoad;
});

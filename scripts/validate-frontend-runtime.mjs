import assert from 'node:assert/strict';
import { ethers } from 'ethers';

const walletProviderModule = await import('../frontend/src/lib/walletProvider.ts');
const questTransactionsModule = await import('../frontend/src/lib/questTransactions.ts');

function record(name, passed, details) {
  const icon = passed ? '✓' : '✗';
  console.log(`${icon} ${name}${details ? `: ${details}` : ''}`);
}

function mockBrowserEnvironment() {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;

  const metamaskProvider = {
    isMetaMask: true,
    request: async () => []
  };
  const miniPayProvider = {
    isMiniPay: true,
    request: async () => []
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      ethereum: {
        providers: [metamaskProvider, miniPayProvider]
      }
    }
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'MiniPay Android'
    }
  });

  return {
    restore() {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator
      });
    }
  };
}

function buildSyntheticQuestCreatedReceipt() {
  const contractInterface = new ethers.Interface([
    'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount,uint256 xpReward)'
  ]);
  const encoded = contractInterface.encodeEventLog(
    contractInterface.getEvent('QuestCreated'),
    [12n, '0x1111111111111111111111111111111111111111', 'Forge the Test', 100000000000000000n, 150n]
  );

  return {
    hash: '0x' + 'ab'.repeat(32),
    status: 1,
    blockNumber: 123,
    gasUsed: 21000n,
    logs: [
      {
        address: '0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2',
        index: 0,
        data: encoded.data,
        topics: encoded.topics
      }
    ]
  };
}

const {
  discoverInjectedWalletProviders,
  getInjectedWalletSelection,
  buildContractWriteRequest
} = walletProviderModule;
const { parseReceiptEvent, summarizeReceiptLogs } = questTransactionsModule;

const browserMock = mockBrowserEnvironment();
try {
  const discovered = discoverInjectedWalletProviders();
  assert.ok(discovered.length >= 2);
  record('Provider discovery', true, `found ${discovered.length} injected providers`);

  const selection = getInjectedWalletSelection('auto');
  assert.ok(selection);
  assert.equal(selection.kind, 'minipay');
  record('MiniPay provider preference', true, `selected ${selection.kind}`);
} finally {
  browserMock.restore();
}

const contractInterface = new ethers.Interface([
  'function startQuest(uint256 questId) payable',
  'event QuestCreated(uint256 indexed questId,address indexed creator,string title,uint256 rewardAmount,uint256 xpReward)'
]);
const txRequest = buildContractWriteRequest({
  provider: {
    request: async () => null
  },
  contractAddress: '0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2',
  contractInterface,
  functionName: 'startQuest',
  args: [12n],
  from: '0x1111111111111111111111111111111111111111',
  value: 10000000000000000n,
  gasLimit: 75000n
});
assert.equal(txRequest.to, '0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2');
assert.ok(typeof txRequest.data === 'string' && txRequest.data.startsWith('0x'));
assert.equal(txRequest.value, '0x2386f26fc10000');
record('Contract write request encoding', true, txRequest.data.slice(0, 10));

const syntheticReceipt = buildSyntheticQuestCreatedReceipt();
const parsedEvent = parseReceiptEvent(
  syntheticReceipt,
  {
    contractAddress: '0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2',
    contractInterface
  },
  'QuestCreated'
);
assert.ok(parsedEvent);
assert.equal(parsedEvent.args.questId.toString(), '12');
record('QuestCreated receipt parsing', true, `questId=${parsedEvent.args.questId.toString()}`);

const summary = summarizeReceiptLogs(syntheticReceipt, {
  contractAddress: '0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2',
  contractInterface
});
assert.equal(summary[0]?.parsedEventName, 'QuestCreated');
record('Receipt log diagnostics', true, summary[0]?.parsedEventName ?? 'missing');

console.log('\nFrontend runtime validation passed.');

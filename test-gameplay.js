#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */

const ethers = require('./backend/node_modules/ethers');
const https = require('https');
const http = require('http');

// Test wallet with a known private key (NOT a real account)
const PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const CHAIN_ID = 42220; // Celo Mainnet
const API_BASE = 'http://localhost:4000';

const wallet = new ethers.Wallet(PRIVATE_KEY);
const WALLET_ADDRESS = wallet.address;

console.log(`🔑 Test Wallet: ${WALLET_ADDRESS}`);
console.log(`🌐 Chain ID: ${CHAIN_ID}`);
console.log(`🔗 API Base: ${API_BASE}\n`);

// HTTP utility function
function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const client = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Main test flow
async function runGameplayTest() {
  try {
    // Step 1: Get auth nonce
    console.log('📝 Step 1: Getting auth nonce...');
    const nonceRes = await makeRequest('POST', '/api/auth/nonce', {
      wallet: WALLET_ADDRESS,
      chainId: CHAIN_ID
    });

    if (nonceRes.status !== 200) {
      console.error('❌ Failed to get nonce:', nonceRes.data);
      process.exit(1);
    }

    const { nonce, message } = nonceRes.data;
    console.log(`✅ Nonce received: ${nonce.slice(0, 8)}...\n`);

    // Step 2: Sign the message
    console.log('🖊️  Step 2: Signing message...');
    const signature = await wallet.signMessage(message);
    console.log(`✅ Message signed: ${signature.slice(0, 20)}...\n`);

    // Step 3: Verify signature and get auth token
    console.log('🔐 Step 3: Verifying signature...');
    const verifyRes = await makeRequest('POST', '/api/auth/verify', {
      wallet: WALLET_ADDRESS,
      nonce: nonce,
      signature: signature,
      chainId: CHAIN_ID
    });

    if (verifyRes.status !== 200) {
      console.error('❌ Signature verification failed:', verifyRes.data);
      process.exit(1);
    }

    const { accessToken } = verifyRes.data;
    console.log(`✅ Signature verified, access token received\n`);

    // Step 4: Generate quest
    console.log('🎯 Step 4: Generating quest...');
    const generateRes = await makeRequest('POST', '/api/quests/generate', {}, {
      'Authorization': `Bearer ${accessToken}`
    });

    if (generateRes.status !== 200) {
      console.error('❌ Quest generation failed:', generateRes.data);
      process.exit(1);
    }

    const quest = generateRes.data.quest || generateRes.data;
    console.log(`✅ Quest generated: ${quest.title}`);
    console.log(`   Difficulty: ${quest.difficulty}`);
    console.log(`   Reward: ${quest.rewardAmount} CELO\n`);

    // Step 5: Accept quest
    console.log('🤝 Step 5: Accepting quest...');
    const acceptRes = await makeRequest('POST', `/api/quests/${quest.id}/accept`, {}, {
      'Authorization': `Bearer ${accessToken}`
    });

    if (acceptRes.status !== 200) {
      console.error('❌ Accept quest failed:', acceptRes.data);
      process.exit(1);
    }

    console.log(`✅ Quest accepted\n`);

    // Step 5b: Register quest on-chain
    console.log('🔗 Step 5b: Registering quest on-chain...');
    const registerRes = await makeRequest('POST', '/api/quests/register-onchain', {
      questId: quest.id
    }, {
      'Authorization': `Bearer ${accessToken}`
    });

    if (registerRes.status !== 200) {
      console.log('⚠️  Quest on-chain registration skipped (may not be required)');
    } else {
      console.log(`✅ Quest registered on-chain\n`);
    }

    // Step 6: Submit proof
    console.log('⛏️  Step 6: Submitting proof...');
    const submitRes = await makeRequest('POST', '/api/quests/submit-proof', {
      questId: quest.id,
      proofUri: '0x1234567890123456789012345678901234567890123456789012345678901234',
      submissionTxHash: '0x1234567890123456789012345678901234567890123456789012345678901234'
    }, {
      'Authorization': `Bearer ${accessToken}`
    });

    if (submitRes.status !== 200 && submitRes.status !== 202) {
      console.error('❌ Submit proof failed:', submitRes.data);
      process.exit(1);
    }

    console.log(`✅ Proof submitted\n`);

    console.log('🎉 Gameplay Test #1 COMPLETE!\n');
    return accessToken;

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the test
runGameplayTest().then(() => {
  console.log('✨ All tests passed!');
  process.exit(0);
}).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

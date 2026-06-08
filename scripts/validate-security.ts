/**
 * ForgeQuest Online - Security Validation
 *
 * Validates the current authentication and protected-route security model:
 * 1. Auth nonce rate limiting
 * 2. Invalid signature rejection
 * 3. Replay attack prevention
 * 4. Invalid token rejection
 * 5. Unauthenticated protected-route rejection
 * 6. Auth input validation
 * 7. Wrong-chain rejection
 *
 * Usage: npx ts-node scripts/validate-security.ts
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

type SecurityStatus = 'pass' | 'fail' | 'blocked';

type SecurityTest = {
  name: string;
  status: SecurityStatus;
  message: string;
  details?: unknown;
};

type AuthSessionPayload = {
  accessToken: string;
  session: {
    id: string;
    wallet: string;
  };
};

type SignableWallet = {
  address: string;
  signMessage(message: string | Uint8Array): Promise<string>;
};

const results: SecurityTest[] = [];
const CELO_CHAIN_ID = Number(process.env.CELO_CHAIN_ID || '42220');

function recordResult(
  name: string,
  status: SecurityStatus,
  message: string,
  details?: unknown
) {
  results.push({ name, status, message, details });
  const icon = status === 'pass' ? '✓' : status === 'blocked' ? '🚫' : '❌';
  const color = status === 'pass' ? '\x1b[32m' : status === 'blocked' ? '\x1b[33m' : '\x1b[31m';
  console.log(`${color}${icon} ${name}: ${message}\x1b[0m`);
}

function resolveUrls(rawBase: string) {
  const normalized = rawBase.replace(/\/$/, '');
  if (normalized.endsWith('/api')) {
    return {
      apiUrl: normalized
    };
  }

  return {
    apiUrl: `${normalized}/api`
  };
}

function buildApiClient(apiUrl: string, accessToken?: string): AxiosInstance {
  return axios.create({
    baseURL: apiUrl,
    timeout: 8000,
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
    throw new Error('Nonce response was malformed');
  }

  const signature = await wallet.signMessage(message);
  const verifyResponse = await client.post<AuthSessionPayload>('/auth/verify', {
    wallet: wallet.address,
    nonce,
    signature,
    chainId: CELO_CHAIN_ID
  });

  if (!verifyResponse.data?.accessToken) {
    throw new Error('Verify response did not include an access token');
  }

  return verifyResponse.data;
}

async function main() {
  const rawBase = process.env.API_URL || process.env.BACKEND_URL || 'http://localhost:4000';
  const { apiUrl } = resolveUrls(rawBase);

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       ForgeQuest Online - Production Security Validation      ║');
  console.log('║             Current Auth And API Security Checks          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`🔒 API base: ${apiUrl}\n`);

  const wallet1 = ethers.Wallet.createRandom();
  const wallet2 = ethers.Wallet.createRandom();
  const maliciousWallet = ethers.Wallet.createRandom();
  const client = buildApiClient(apiUrl);

  try {
    console.log('⏱️  TEST 1: Rate Limiting Protection\n');
    let requests = 0;
    let blocked = false;

    for (let i = 0; i < 100; i += 1) {
      try {
        await client.post('/auth/nonce', {
          wallet: maliciousWallet.address,
          chainId: CELO_CHAIN_ID
        });
        requests += 1;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          blocked = true;
          recordResult('Rate Limiting', 'pass', `Blocked nonce spam after ${requests} successful requests`, { statusCode: 429 });
          break;
        }
      }
    }

    if (!blocked) {
      recordResult('Rate Limiting', 'fail', 'No nonce rate limiting detected after 100 requests');
    }

    console.log('\n🔐 TEST 2: Signature Verification\n');
    const nonceRes = await client.post('/auth/nonce', {
      wallet: wallet1.address,
      chainId: CELO_CHAIN_ID
    });
    const nonce = nonceRes.data.nonce as string;

    try {
      await client.post('/auth/verify', {
        wallet: wallet1.address,
        nonce,
        signature: `0x${'0'.repeat(128)}`,
        chainId: CELO_CHAIN_ID
      });
      recordResult('Invalid Signature Rejection', 'fail', 'Invalid signature was accepted');
    } catch (error) {
      if (axios.isAxiosError(error) && [400, 401].includes(error.response?.status ?? 0)) {
        recordResult('Invalid Signature Rejection', 'pass', 'Invalid signature rejected', { statusCode: error.response?.status });
      } else {
        recordResult('Invalid Signature Rejection', 'fail', `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const wrongSignature = await wallet1.signMessage('wrong message');
      await client.post('/auth/verify', {
        wallet: wallet1.address,
        nonce,
        signature: wrongSignature,
        chainId: CELO_CHAIN_ID
      });
      recordResult('Wrong Message Rejection', 'fail', 'Signature for the wrong message was accepted');
    } catch (error) {
      if (axios.isAxiosError(error) && [400, 401].includes(error.response?.status ?? 0)) {
        recordResult('Wrong Message Rejection', 'pass', 'Signature for the wrong message was rejected', { statusCode: error.response?.status });
      } else {
        recordResult('Wrong Message Rejection', 'fail', `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log('\n🔄 TEST 3: Replay Attack Prevention\n');
    const replayNonceRes = await client.post('/auth/nonce', {
      wallet: wallet2.address,
      chainId: CELO_CHAIN_ID
    });
    const replayMessage = replayNonceRes.data.message as string;
    const replayNonce = replayNonceRes.data.nonce as string;
    const replaySignature = await wallet2.signMessage(replayMessage);

    const firstAuth = await client.post<AuthSessionPayload>('/auth/verify', {
      wallet: wallet2.address,
      nonce: replayNonce,
      signature: replaySignature,
      chainId: CELO_CHAIN_ID
    });
    recordResult('First Nonce Use', 'pass', 'Initial nonce use succeeded', { sessionId: firstAuth.data.session.id });

    try {
      await client.post('/auth/verify', {
        wallet: wallet2.address,
        nonce: replayNonce,
        signature: replaySignature,
        chainId: CELO_CHAIN_ID
      });
      recordResult('Replay Attack Prevention', 'fail', 'A consumed nonce was accepted on replay');
    } catch (error) {
      if (axios.isAxiosError(error) && [401, 409].includes(error.response?.status ?? 0)) {
        recordResult('Replay Attack Prevention', 'pass', 'Consumed nonce replay was blocked', { statusCode: error.response?.status });
      } else {
        recordResult('Replay Attack Prevention', 'fail', `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log('\n🛡️  TEST 4: Protected Route Authorization\n');
    try {
      await client.post(
        '/quests/generate',
        { chain: 'Celo' },
        {
          headers: {
            Authorization: 'Bearer invalid_token'
          }
        }
      );
      recordResult('Invalid Token Rejection', 'fail', 'Protected route accepted an invalid access token');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        recordResult('Invalid Token Rejection', 'pass', 'Protected route rejected an invalid access token', { statusCode: 401 });
      } else {
        recordResult('Invalid Token Rejection', 'fail', `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await client.post('/quests/generate', { chain: 'Celo' });
      recordResult('Unauthenticated Route Rejection', 'fail', 'Protected route accepted an unauthenticated request');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        recordResult('Unauthenticated Route Rejection', 'pass', 'Protected route rejected an unauthenticated request', { statusCode: 401 });
      } else {
        recordResult('Unauthenticated Route Rejection', 'fail', `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log('\n✔️  TEST 5: Input Validation\n');
    try {
      await client.post('/auth/nonce', {
        wallet: 'not_a_valid_address',
        chainId: CELO_CHAIN_ID
      });
      recordResult('Invalid Wallet Rejection', 'fail', 'Invalid wallet format was accepted');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        recordResult('Invalid Wallet Rejection', 'pass', 'Invalid wallet format rejected', { statusCode: 400 });
      } else {
        recordResult('Invalid Wallet Rejection', 'fail', `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await client.post('/auth/nonce', {
        wallet: wallet1.address,
        chainId: 1
      });
      recordResult('Wrong Chain Rejection', 'fail', 'Wrong chain authentication request was accepted');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        recordResult('Wrong Chain Rejection', 'pass', 'Wrong chain authentication request rejected', { statusCode: 401 });
      } else {
        recordResult('Wrong Chain Rejection', 'fail', `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const validSession = await authenticateWallet(client, wallet1);
      const authenticatedClient = buildApiClient(apiUrl, validSession.accessToken);
      const questResponse = await authenticatedClient.post('/quests/generate', { chain: 'Celo' });
      recordResult(
        'Authenticated Quest Generation',
        questResponse.data?.quest?.id ? 'pass' : 'fail',
        questResponse.data?.quest?.id ? 'Authenticated quest generation succeeded' : 'Authenticated quest generation response was malformed',
        {
          questId: questResponse.data?.quest?.id
        }
      );
    } catch (error) {
      recordResult('Authenticated Quest Generation', 'fail', `Unexpected auth-protected route failure: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log('\n🚫 TEST 6: Deferred Deep Security Checks\n');
    recordResult(
      'Proof Deduplication',
      'blocked',
      'Requires a full verifier-compatible gameplay transaction and verifier settlement path; covered by integration and contract tests.'
    );
  } catch (error) {
    recordResult('Security Validation', 'fail', `Connection error: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    SECURITY SUMMARY                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const failed = results.filter((result) => result.status === 'fail').length;
  const passed = results.filter((result) => result.status === 'pass').length;
  const blocked = results.filter((result) => result.status === 'blocked').length;

  console.log(`✓ Passed:   ${passed}`);
  console.log(`🚫 Blocked: ${blocked}`);
  console.log(`❌ Failed:   ${failed}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

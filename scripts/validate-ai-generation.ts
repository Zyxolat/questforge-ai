#!/usr/bin/env node

/**
 * QuestForge AI - Live AI Generation Validation
 *
 * Validates:
 * 1. Wallet auth against the real API surface
 * 2. Multiple quest generations through the live generation path
 * 3. Groq source attribution and fallback rate
 * 4. Narrative diversity across title, lore, mission structure, and NPC dialogue
 * 5. Telemetry visibility (latency + token usage) when Groq is active
 *
 * Usage:
 *   npx ts-node scripts/validate-ai-generation.ts
 *
 * Optional env:
 *   API_URL=https://questforge-ai-production.up.railway.app
 *   AI_VALIDATION_TESTS_COUNT=5
 *   AI_VALIDATION_PRIVATE_KEY=0x...
 *   AI_VALIDATION_REQUIRE_REAL_AI=true
 */

import { Wallet } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.join(__dirname, '../.env.production');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

type SignableWallet = {
  address: string;
  signMessage(message: string | Uint8Array): Promise<string>;
};

type QuestGenerationPayload = {
  quest: {
    id: string;
    title: string;
    description: string;
    lore: string;
    missionStructure?: string;
    missionChapters?: Array<{ id?: string; title?: string; summary?: string }>;
    storyline?: string[];
    txRequirements?: Array<{ stage?: string; type?: string }>;
    npc?: {
      name?: string;
      openingDialogue?: string;
    };
    generation?: {
      source?: string;
      provider?: string;
      model?: string | null;
      fallbackReason?: string | null;
      requestId?: string | null;
      latencyMs?: number | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
      totalTokens?: number | null;
      attemptCount?: number | null;
    };
  };
};

type DiagnosticsPayload = {
  orchestration?: {
    questGeneration?: {
      generatedCount?: number;
      aiGeneratedCount?: number;
      fallbackGeneratedCount?: number;
      lastGenerationSource?: string | null;
      lastFallbackReason?: string | null;
      lastLatencyMs?: number | null;
      lastTotalTokens?: number | null;
    };
  };
  healthy?: boolean;
};

type AuthNoncePayload = {
  nonce: string;
  message: string;
};

type AuthSessionPayload = {
  accessToken: string;
};

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

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method || 'GET'} ${url} failed with ${response.status}: ${text}`);
  }

  return JSON.parse(text) as T;
}

async function authenticateWallet(apiUrl: string, wallet: SignableWallet, chainId: number) {
  const noncePayload = await fetchJson<AuthNoncePayload>(`${apiUrl}/auth/nonce`, {
    method: 'POST',
    body: JSON.stringify({
      wallet: wallet.address,
      chainId
    })
  });

  const signature = await wallet.signMessage(noncePayload.message);
  const session = await fetchJson<AuthSessionPayload>(`${apiUrl}/auth/verify`, {
    method: 'POST',
    body: JSON.stringify({
      wallet: wallet.address,
      nonce: noncePayload.nonce,
      signature,
      chainId
    })
  });

  return session.accessToken;
}

async function generateQuest(apiUrl: string, accessToken: string) {
  return fetchJson<QuestGenerationPayload>(`${apiUrl}/quests/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ chain: 'Celo' })
  });
}

async function readDiagnostics(rootUrl: string, apiUrl: string) {
  try {
    return await fetchJson<DiagnosticsPayload>(`${rootUrl}/health/events`);
  } catch {
    return fetchJson<DiagnosticsPayload>(`${apiUrl}/quests/orchestration/diagnostics`);
  }
}

async function main() {
  const rawBase = process.env.API_URL || process.env.BACKEND_URL || 'https://questforge-ai-production.up.railway.app';
  const { rootUrl, apiUrl } = resolveUrls(rawBase);
  const testsCount = Number(process.env.AI_VALIDATION_TESTS_COUNT || '5');
  const requireRealAI = parseBooleanEnv(process.env.AI_VALIDATION_REQUIRE_REAL_AI, true);
  const chainId = Number(process.env.CELO_CHAIN_ID || process.env.AUTH_CHAIN_ID || '42220');
  const wallet = process.env.AI_VALIDATION_PRIVATE_KEY
    ? new Wallet(process.env.AI_VALIDATION_PRIVATE_KEY)
    : Wallet.createRandom();

  console.log('\n========================================');
  console.log('QuestForge AI - Live AI Validation');
  console.log('========================================\n');
  console.log(`Backend root: ${rootUrl}`);
  console.log(`API base:     ${apiUrl}`);
  console.log(`Wallet:       ${wallet.address}`);
  console.log(`Quest runs:   ${testsCount}`);
  console.log(`Require AI:   ${requireRealAI}\n`);

  const accessToken = await authenticateWallet(apiUrl, wallet, chainId);
  console.log('Authenticated wallet session.\n');

  const titles = new Set<string>();
  const descriptions = new Set<string>();
  const lores = new Set<string>();
  const missionStructures = new Set<string>();
  const dialogueLines = new Set<string>();
  const chapterFingerprints = new Set<string>();
  const aiSources: string[] = [];
  const fallbackSources: string[] = [];
  const latencies: number[] = [];
  const tokenTotals: number[] = [];

  for (let index = 0; index < testsCount; index += 1) {
    const result = await generateQuest(apiUrl, accessToken);
    const quest = result.quest;
    const generation = quest.generation || {};

    titles.add(quest.title);
    descriptions.add(quest.description);
    lores.add(quest.lore);
    if (quest.missionStructure) {
      missionStructures.add(quest.missionStructure);
    }
    if (quest.npc?.openingDialogue) {
      dialogueLines.add(quest.npc.openingDialogue);
    }
    if (Array.isArray(quest.missionChapters)) {
      chapterFingerprints.add(
        quest.missionChapters
          .map((chapter) => `${chapter.id || 'chapter'}:${chapter.title || 'untitled'}:${chapter.summary || ''}`)
          .join(' | ')
      );
    }

    if (generation.source === 'groq') {
      aiSources.push(quest.id);
    } else {
      fallbackSources.push(`${quest.id}:${generation.fallbackReason || 'unknown-fallback'}`);
    }

    if (typeof generation.latencyMs === 'number') {
      latencies.push(generation.latencyMs);
    }
    if (typeof generation.totalTokens === 'number') {
      tokenTotals.push(generation.totalTokens);
    }

    console.log(
      `[${index + 1}/${testsCount}] ${quest.title} :: source=${generation.source || 'unknown'} model=${generation.model || 'n/a'}`
    );
    if (generation.fallbackReason) {
      console.log(`  fallbackReason=${generation.fallbackReason}`);
    }
    if (quest.npc?.openingDialogue) {
      console.log(`  npc="${quest.npc.openingDialogue.slice(0, 120)}${quest.npc.openingDialogue.length > 120 ? '…' : ''}"`);
    }

    if (index < testsCount - 1) {
      await sleep(1200);
    }
  }

  const diagnostics = await readDiagnostics(rootUrl, apiUrl).catch(() => null);
  const orchestration = diagnostics?.orchestration?.questGeneration;

  const averageLatencyMs =
    latencies.length > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null;
  const averageTokens =
    tokenTotals.length > 0 ? Math.round(tokenTotals.reduce((sum, value) => sum + value, 0) / tokenTotals.length) : null;

  const varietyChecks = [
    { label: 'Unique titles', value: titles.size, expected: testsCount },
    { label: 'Unique descriptions', value: descriptions.size, expected: testsCount },
    { label: 'Unique lore blocks', value: lores.size, expected: testsCount },
    { label: 'Unique mission structures', value: missionStructures.size, expected: testsCount },
    { label: 'Unique NPC dialogues', value: dialogueLines.size, expected: testsCount },
    { label: 'Unique chapter plans', value: chapterFingerprints.size, expected: testsCount }
  ];

  console.log('\nNarrative diversity:');
  varietyChecks.forEach((check) => {
    console.log(`  - ${check.label}: ${check.value}/${check.expected}`);
  });

  console.log('\nGeneration health:');
  console.log(`  - Groq-sourced quests: ${aiSources.length}/${testsCount}`);
  console.log(`  - Fallback quests: ${fallbackSources.length}/${testsCount}`);
  console.log(`  - Avg latency: ${averageLatencyMs ?? 'n/a'} ms`);
  console.log(`  - Avg total tokens: ${averageTokens ?? 'n/a'}`);

  if (orchestration) {
    console.log('\nBackend diagnostics:');
    console.log(`  - generatedCount: ${orchestration.generatedCount ?? 'n/a'}`);
    console.log(`  - aiGeneratedCount: ${orchestration.aiGeneratedCount ?? 'n/a'}`);
    console.log(`  - fallbackGeneratedCount: ${orchestration.fallbackGeneratedCount ?? 'n/a'}`);
    console.log(`  - lastGenerationSource: ${orchestration.lastGenerationSource ?? 'n/a'}`);
    console.log(`  - lastLatencyMs: ${orchestration.lastLatencyMs ?? 'n/a'}`);
    console.log(`  - lastTotalTokens: ${orchestration.lastTotalTokens ?? 'n/a'}`);
    if (orchestration.lastFallbackReason) {
      console.log(`  - lastFallbackReason: ${orchestration.lastFallbackReason}`);
    }
  }

  const failedChecks: string[] = [];

  if (requireRealAI && aiSources.length !== testsCount) {
    failedChecks.push(`Expected ${testsCount}/${testsCount} quests from Groq, got ${aiSources.length}`);
  }

  if (fallbackSources.length > 0) {
    failedChecks.push(`Fallback was triggered ${fallbackSources.length} time(s): ${fallbackSources.join(', ')}`);
  }

  const insufficientVariety = varietyChecks.filter((check) => check.value < Math.max(2, Math.ceil(testsCount * 0.6)));
  if (insufficientVariety.length > 0) {
    failedChecks.push(
      `Narrative variety too low in: ${insufficientVariety.map((check) => `${check.label}=${check.value}`).join(', ')}`
    );
  }

  if (!averageLatencyMs || !averageTokens) {
    failedChecks.push('Groq telemetry was not exposed for generated quests');
  }

  if (orchestration && typeof orchestration.fallbackGeneratedCount === 'number' && orchestration.fallbackGeneratedCount > 0) {
    failedChecks.push(`Backend diagnostics still report fallbackGeneratedCount=${orchestration.fallbackGeneratedCount}`);
  }

  if (failedChecks.length > 0) {
    console.log('\nAI validation failed:');
    failedChecks.forEach((failure) => console.log(`  - ${failure}`));
    process.exit(1);
  }

  console.log('\nAI validation passed.');
}

main().catch((error) => {
  console.error('Fatal AI validation error:', error);
  process.exit(1);
});

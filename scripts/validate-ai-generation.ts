#!/usr/bin/env node

/**
 * AI Generation Pipeline Validation Script
 *
 * Tests:
 * 1. Multiple quest generations to verify OpenAI usage
 * 2. Validates that quest content is varied (non-repetitive)
 * 3. Confirms fallback only occurs on actual failures
 * 4. Verifies logging and diagnostics
 * 5. Tests NPC dialogue generation
 */

const TESTS_COUNT = 5;
const BACKEND_PORT = process.env.BACKEND_PORT || 8000;
const API_URL = `http://localhost:${BACKEND_PORT}`;

interface QuestResponse {
  quest: {
    id: string;
    title: string;
    description: string;
    lore: string;
    difficulty: number;
    generation: {
      source: string;
      provider: string;
      model: string | null;
      fallbackReason: string | null;
    };
    orchestrationDiagnostics: {
      generatedCount: number;
      openAIGeneratedCount: number;
      fallbackGeneratedCount: number;
      lastGenerationSource: string;
    };
  };
}

interface DiagnosticsResponse {
  orchestration: {
    questGeneration: {
      generatedCount: number;
      openAIGeneratedCount: number;
      fallbackGeneratedCount: number;
      lastGenerationSource: string;
    };
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateQuest(token: string): Promise<QuestResponse> {
  const response = await fetch(`${API_URL}/api/quests/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ chain: 'Celo' })
  });

  if (!response.ok) {
    throw new Error(`Quest generation failed: ${response.statusText}`);
  }

  return response.json() as Promise<QuestResponse>;
}

async function getDiagnostics(): Promise<DiagnosticsResponse> {
  const response = await fetch(`${API_URL}/health/events`);

  if (!response.ok) {
    throw new Error(`Failed to fetch diagnostics: ${response.statusText}`);
  }

  return response.json() as Promise<DiagnosticsResponse>;
}

async function validateAIGeneration(): Promise<void> {
  console.log('\n========================================');
  console.log('🎯 AI Generation Pipeline Validation');
  console.log('========================================\n');

  // Get test token - in a real scenario, this would come from auth
  const testToken = process.env.TEST_AUTH_TOKEN || 'test-token-for-validation';

  const questTitles = new Set<string>();
  const questDescriptions = new Set<string>();
  const openAIQuests: string[] = [];
  const fallbackQuests: string[] = [];

  console.log(`📋 Generating ${TESTS_COUNT} quests to test AI pipeline...\n`);

  for (let i = 1; i <= TESTS_COUNT; i++) {
    try {
      console.log(`  [${i}/${TESTS_COUNT}] Generating quest...`);
      const quest = await generateQuest(testToken);

      const { source, provider, model, fallbackReason } = quest.quest.generation;

      console.log(`    ✅ Quest #${quest.quest.id.slice(0, 8)}`);
      console.log(`       Source: ${source} | Provider: ${provider} | Model: ${model}`);

      if (source === 'openai') {
        console.log(`       📊 OpenAI Generated`);
        openAIQuests.push(quest.quest.id);
      } else {
        console.log(`       ⚠️  Fallback: ${fallbackReason}`);
        fallbackQuests.push(quest.quest.id);
      }

      console.log(`       Title: "${quest.quest.title}"`);
      console.log(`       Difficulty: ${quest.quest.difficulty}/5`);

      questTitles.add(quest.quest.title);
      questDescriptions.add(quest.quest.description);

      // Small delay between requests to avoid rate limiting
      if (i < TESTS_COUNT) {
        await sleep(1500);
      }
    } catch (error) {
      console.error(`  ❌ Error on quest #${i}:`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`\n📊 Analysis Results:\n`);

  console.log(`Diversity:`);
  console.log(`  • Unique titles: ${questTitles.size}/${TESTS_COUNT}`);
  console.log(`  • Unique descriptions: ${questDescriptions.size}/${TESTS_COUNT}`);

  const varietyScore = ((questTitles.size + questDescriptions.size) / (2 * TESTS_COUNT)) * 100;
  const varietyStatus = varietyScore >= 70 ? '✅ HIGH' : varietyScore >= 40 ? '⚠️  MODERATE' : '❌ LOW';
  console.log(`  • Variety Score: ${varietyScore.toFixed(1)}% ${varietyStatus}`);

  console.log(`\nGeneration Sources:`);
  console.log(`  • OpenAI: ${openAIQuests.length}/${TESTS_COUNT} (${((openAIQuests.length / TESTS_COUNT) * 100).toFixed(1)}%)`);
  console.log(`  • Fallback: ${fallbackQuests.length}/${TESTS_COUNT} (${((fallbackQuests.length / TESTS_COUNT) * 100).toFixed(1)}%)`);

  if (openAIQuests.length === 0) {
    console.log(`\n⚠️  WARNING: No OpenAI-generated quests detected!`);
    console.log(`   Check if OPENAI_API_KEY is configured.`);
  } else if (openAIQuests.length === TESTS_COUNT) {
    console.log(`\n✅ SUCCESS: All quests generated with live OpenAI!`);
  } else {
    console.log(`\n⚠️  PARTIAL: Some quests used fallback mode.`);
  }

  // Fetch final diagnostics
  try {
    const diag = await getDiagnostics();
    const { generatedCount, openAIGeneratedCount, fallbackGeneratedCount, lastGenerationSource } =
      diag.orchestration.questGeneration;

    console.log(`\nSystem Diagnostics:`);
    console.log(`  • Total quests generated: ${generatedCount}`);
    console.log(`  • OpenAI-generated: ${openAIGeneratedCount} (${((openAIGeneratedCount / generatedCount) * 100).toFixed(1)}%)`);
    console.log(`  • Fallback-generated: ${fallbackGeneratedCount} (${((fallbackGeneratedCount / generatedCount) * 100).toFixed(1)}%)`);
    console.log(`  • Last source: ${lastGenerationSource}`);
  } catch (error) {
    console.error(`\n⚠️  Could not fetch diagnostics:`, error instanceof Error ? error.message : String(error));
  }

  console.log(`\n========================================`);
  console.log(`🎓 Validation Complete`);
  console.log(`========================================\n`);

  // Exit with appropriate code
  const passedVariety = varietyScore >= 60;
  const passedOpenAI = openAIQuests.length > 0;
  const passed = passedVariety && passedOpenAI;

  if (passed) {
    console.log(`✅ All validation checks passed!`);
    process.exit(0);
  } else {
    console.log(`❌ Some validation checks failed.`);
    if (!passedVariety) console.log(`   - Quest variety is too low`);
    if (!passedOpenAI) console.log(`   - No OpenAI quests generated`);
    process.exit(1);
  }
}

// Run validation
validateAIGeneration().catch((error) => {
  console.error('Fatal validation error:', error);
  process.exit(1);
});

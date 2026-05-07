import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const SAFE_DEFAULT_QUEST = {
  title: 'Forge Initiate Trial',
  description: 'Begin your journey by sending a small CELO tribute to the Forge Vault and returning with proof of completion.',
  difficulty: 'Novice',
  reward: 0.03,
  stakeAmount: 0.01,
  objective: 'Send a small onchain CELO transaction and paste the transaction hash as proof.',
  validationRules: ['Must use Celo network', 'Proof must contain a valid tx hash', 'Quest must complete within 6 hours']
};

function safeParseJSON(text: string) {
  try {
    const start = text.indexOf('{');
    const body = start >= 0 ? text.slice(start) : text;
    return JSON.parse(body.replace(/\n/g, ' '));
  } catch {
    return null;
  }
}

function requiresAPIKey() {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is required for QuestForge AI backend. Falling back to safe defaults.');
  }
  return !!OPENAI_API_KEY;
}

async function createChatCompletion(payload: any) {
  if (!openai) {
    return { text: JSON.stringify(SAFE_DEFAULT_QUEST), success: false };
  }

  try {
    const response = await openai.chat.completions.create(payload);
    const text = response.choices?.[0]?.message?.content || '';
    return { text, success: true };
  } catch (error) {
    console.error('OpenAI request failed:', error);
    return { text: JSON.stringify(SAFE_DEFAULT_QUEST), success: false };
  }
}

export async function generateQuestPrompt(wallet: string, chain: string) {
  if (!requiresAPIKey()) {
    return { raw: JSON.stringify(SAFE_DEFAULT_QUEST), data: SAFE_DEFAULT_QUEST };
  }

  const prompt = `You are the Forge Master AI in a futuristic fantasy blockchain realm. Generate an immersive quest for wallet ${wallet} on ${chain}. Return strictly valid JSON containing title, description, difficulty, reward, stakeAmount, objective, validationRules, and lore. Do not include any extra text outside the JSON object.`;
  const result = await createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are QuestForge AI, a quest generator for a Celo blockchain fantasy RPG.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.9,
    maxTokens: 450
  });

  const parsed = safeParseJSON(result.text);
  return {
    raw: result.text,
    data: parsed || SAFE_DEFAULT_QUEST
  };
}

export async function validateQuestProofPrompt(wallet: string, questTitle: string, proofUri: string) {
  const prompt = `You are a magical onchain verifier. Evaluate whether the proof '${proofUri}' submitted by ${wallet} correctly completes the quest '${questTitle}'. Return strictly valid JSON with properties: verified (true or false) and reason (string). Do not return text outside the JSON object.`;
  const result = await createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Validate quest completion in a fantasy blockchain RPG.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.35,
    maxTokens: 220
  });

  const parsed = safeParseJSON(result.text) || { verified: false, reason: 'Validation unavailable.' };
  return { text: result.text, data: parsed };
}

export async function generateNPCDialogue(npcType: string, playerName: string) {
  if (!requiresAPIKey()) {
    return `The ${npcType} murmurs: The forge will wait while your path is being readied.`;
  }

  const prompt = `You are an AI NPC in QuestForge AI. Create dialogue for a ${npcType} speaking to ${playerName} with hints, lore, and a magical tone. Return the response as plain text.`;
  const result = await createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Generate cinematic NPC dialogue.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.85,
    maxTokens: 220
  });

  return result.text || 'The Forge Master remains silent.';
}

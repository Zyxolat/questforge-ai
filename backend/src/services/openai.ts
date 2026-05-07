import { Configuration, OpenAIApi } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

export async function generateQuestPrompt(wallet: string, chain: string) {
  const prompt = `You are the Forge Master AI in a futuristic fantasy blockchain realm. Generate an immersive quest for wallet ${wallet} on ${chain}. Include a title, description, difficulty, reward token reward, stake amount, lore, and proof step. Format as JSON.`;
  const result = await openai.createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: 'You control the AI-generated quest world.' }, { role: 'user', content: prompt }],
    temperature: 0.9,
    max_tokens: 400
  });
  const text = result.data.choices[0]?.message?.content || '';
  return text;
}

export async function validateQuestProofPrompt(wallet: string, questTitle: string, proofUri: string) {
  const prompt = `You are a magical onchain verifier. Evaluate whether the proof '${proofUri}' submitted by ${wallet} correctly completes the quest '${questTitle}'. Respond with JSON { verified: true|false, reason: string }.`;
  const result = await openai.createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: 'Validate quest completion in a fantasy blockchain RPG.' }, { role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 250
  });
  const text = result.data.choices[0]?.message?.content || '';
  return text;
}

export async function generateNPCDialogue(npcType: string, playerName: string) {
  const prompt = `You are an AI NPC in QuestForge AI. Create dialogue for a ${npcType} speaking to ${playerName} with hints, lore, and a magical tone.`;
  const result = await openai.createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: 'Generate cinematic NPC dialogue.' }, { role: 'user', content: prompt }],
    temperature: 0.85,
    max_tokens: 220
  });
  return result.data.choices[0]?.message?.content || 'The Forge Master remains silent.';
}

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { aiValidator } from './aiSafety';
import { buildQuestTemplate, type QuestVerificationTemplate } from './questTemplates';
import { logger } from './logger';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const SAFE_DEFAULT_NARRATIVE = {
  title: 'Forge Initiate Trial',
  description: 'Accept a tightly scoped onchain trial and return with deterministic proof of completion.',
  difficulty: 3,
  lore: 'The Forge Master only recognizes deeds that can be verified onchain.',
  type: 'AI Quest',
  objective: 'Complete the approved onchain objective and submit the resulting transaction hash.',
  validationRules: ['Only successful Celo transactions are accepted.']
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

async function createChatCompletion(payload: OpenAI.Chat.Completions.ChatCompletionCreateParams) {
  if (!openai) {
    return { text: JSON.stringify(SAFE_DEFAULT_NARRATIVE), success: false };
  }

  try {
    const response = await openai.chat.completions.create({
      ...payload,
      stream: false
    });
    const text = response.choices?.[0]?.message?.content || '';
    return { text, success: true };
  } catch (error) {
    logger.error('OpenAI request failed, falling back to deterministic defaults', error);
    return { text: JSON.stringify(SAFE_DEFAULT_NARRATIVE), success: false };
  }
}

function buildNarrativePrompt(wallet: string, chain: string, template: QuestVerificationTemplate) {
  return `You are the Forge Master AI for QuestForge on ${chain}. You may only provide lore, title, and flavor for an approved quest template.

Wallet: ${wallet}
Approved quest type: ${template.questType}
Approved objective (MUST stay semantically identical): ${template.objective}
Approved validation rules (MUST stay semantically identical): ${template.validationRules.join(' | ')}

Return strictly valid JSON with exactly these fields:
- title
- description
- difficulty
- lore
- type
- objective
- validationRules

Rules:
- Keep the objective aligned with the approved template.
- Do not introduce rewards, stakes, private keys, promises, phishing, or impossible actions.
- Do not mention other chains besides Celo unless you are explicitly comparing them negatively.
- Keep quest type within the approved type only.
- Output JSON only.`;
}

export async function generateQuestPrompt(wallet: string, chain: string, difficultyHint = 3) {
  const template = buildQuestTemplate(difficultyHint, wallet);

  if (!openai) {
    return {
      raw: JSON.stringify(SAFE_DEFAULT_NARRATIVE),
      data: aiValidator.applyTemplateFlavor(SAFE_DEFAULT_NARRATIVE, template),
      template
    };
  }

  const attempts = [0, 1];

  for (const attempt of attempts) {
    const result = await createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You generate safe narrative wrappers for pre-approved Celo quest templates. Never invent new objectives, rewards, or security-sensitive behavior.'
        },
        {
          role: 'user',
          content: buildNarrativePrompt(wallet, chain, template)
        }
      ],
      temperature: attempt === 0 ? 0.4 : 0.2,
      max_tokens: 350,
      response_format: { type: 'json_object' }
    });

    const parsed = safeParseJSON(result.text) || SAFE_DEFAULT_NARRATIVE;
    const checked = aiValidator.comprehensiveValidation(parsed, wallet);
    const flavored = aiValidator.applyTemplateFlavor(checked.sanitized, template);

    if (checked.valid && checked.warnings.length === 0) {
      return {
        raw: result.text,
        data: flavored,
        template
      };
    }

    logger.warn('AI quest narrative required fallback hardening', {
      attempt: attempt + 1,
      errors: checked.errors,
      warnings: checked.warnings
    });
  }

  return {
    raw: JSON.stringify(SAFE_DEFAULT_NARRATIVE),
    data: aiValidator.applyTemplateFlavor(SAFE_DEFAULT_NARRATIVE, template),
    template
  };
}

export async function generateNPCDialogue(npcType: string, playerName: string) {
  if (!openai) {
    return `The ${npcType} murmurs: the Forge only blesses deeds that survive onchain scrutiny, ${playerName}.`;
  }

  const result = await createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'Generate immersive fantasy dialogue for a blockchain RPG NPC. Avoid economic promises and unsafe instructions.'
      },
      {
        role: 'user',
        content: `Create dialogue for a ${npcType} speaking to ${playerName}.`
      }
    ],
    temperature: 0.7,
    max_tokens: 220
  });

  return result.text || 'The Forge Master remains silent.';
}

/**
 * AI Quest Generation Safety and Validation
 * 
 * Implements strict schema validation and safety filters to ensure:
 * - AI cannot generate unbounded rewards
 * - AI cannot create impossible quests
 * - AI output is deterministic enough
 * - All AI-generated fields are validated
 */

import Ajv from 'ajv';
import { objectiveTypes, type ObjectiveType } from './questTemplates';

// Strict JSON Schema for AI Quest Output
interface AIQuestOutput {
  title: string;
  description: string;
  difficulty: number;
  type?: string;
  objective: string;
  lore: string;
  validationRules?: string[];
  reward?: number;
  stakeAmount?: number;
}

type AIQuestCandidate = Partial<Record<keyof AIQuestOutput, unknown>>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const questOutputSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 3,
      maxLength: 200
    },
    description: {
      type: 'string',
      minLength: 10,
      maxLength: 1000
    },
    difficulty: {
      type: 'number',
      minimum: 1,
      maximum: 5,
      multipleOf: 1
    },
    type: {
      type: 'string',
      maxLength: 50,
      nullable: true
    },
    objective: {
      type: 'string',
      minLength: 5,
      maxLength: 500
    },
    lore: {
      type: 'string',
      minLength: 5,
      maxLength: 800
    },
    validationRules: {
      type: 'array',
      items: {
        type: 'string',
        maxLength: 200
      },
      maxItems: 5,
      nullable: true
    },
    reward: {
      type: 'number',
      minimum: 0.01,
      maximum: 0.5,
      nullable: true
    },
    stakeAmount: {
      type: 'number',
      minimum: 0.001,
      maximum: 10.0,
      nullable: true
    }
  },
  required: ['title', 'description', 'difficulty', 'objective', 'lore'],
  additionalProperties: false
} as const;

class AISafetyValidator {
  private ajv = new Ajv({ strict: true });
  private validate = this.ajv.compile<AIQuestOutput>(questOutputSchema);
  private readonly allowedQuestTypes = new Set<string>([
    ...objectiveTypes(),
    'Celo Transfer',
    'Contract Invocation',
    'Token Approval',
    'AI Quest',
    'Blockchain Quest'
  ]);

  /**
   * Validate AI quest output against strict schema
   */
  validateQuestSchema(data: unknown): {
    valid: boolean;
    errors: string[];
    sanitized?: AIQuestOutput;
  } {
    const errors: string[] = [];

    if (!isObjectRecord(data)) {
      errors.push('AI output must be a JSON object');
      return { valid: false, errors };
    }

    // Validate against schema
    if (!this.validate(data)) {
      const schemaErrors = this.validate.errors || [];
      errors.push(...schemaErrors.map((err) => `${err.instancePath} ${err.keyword}: ${err.message}`));
      return { valid: false, errors };
    }

    return { valid: true, errors };
  }

  /**
   * Validate difficulty is within safe range
   */
  validateDifficulty(difficulty: number): { valid: boolean; error?: string } {
    if (!Number.isInteger(difficulty)) {
      return { valid: false, error: 'Difficulty must be integer' };
    }

    if (difficulty < 1 || difficulty > 5) {
      return { valid: false, error: 'Difficulty must be 1-5' };
    }

    return { valid: true };
  }

  /**
   * Detect potentially hallucinated or nonsensical content
   */
  detectHallucinations(text: string): { isHallucinated: boolean; reason?: string } {
    // List of red flags indicating hallucination
    const hallucationPatterns = [
      /\$\d+,\d+/g, // Dollar amounts like $1,000
      /bitcoin|ethereum|dogecoin/gi, // Other cryptocurrencies
      /admin|superuser|root/gi, // Security-related
      /hack|exploit|bypass|cheat/gi, // Exploit language
      /unlimited|infinity|forever/gi, // Impossible guarantees
      /guaranteed|100% return|risk-free/gi, // Financial claims
      /click here|download|visit/gi, // Phishing patterns
      /verify your account|confirm identity/gi, // Social engineering
    ];

    for (const pattern of hallucationPatterns) {
      if (pattern.test(text)) {
        return { isHallucinated: true, reason: `Detected pattern: ${pattern}` };
      }
    }

    // Check for excessive repetition (sign of token confusion)
    const words = text.toLowerCase().split(/\s+/);
    const wordFreq: { [key: string]: number } = {};
    for (const word of words) {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    }

    const maxFreq = Math.max(...Object.values(wordFreq));
    if (maxFreq > text.length * 0.15) {
      // More than 15% of the same word
      return { isHallucinated: true, reason: 'Excessive word repetition detected' };
    }

    return { isHallucinated: false };
  }

  /**
   * Validate objective is achievable on Celo blockchain
   */
  validateObjective(objective: string): { valid: boolean; error?: string } {
    const impossiblePatterns = [
      /hack the network|steal funds|break security/gi,
      /predict the future|read minds|time travel/gi,
      /turn lead into gold|create energy from nothing/gi,
      /bypass all security|unlimited access/gi,
    ];

    for (const pattern of impossiblePatterns) {
      if (pattern.test(objective)) {
        return { valid: false, error: 'Objective is impossible or harmful' };
      }
    }

    // Check if objective mentions Celo or blockchain
    if (!/celo|ethereum|blockchain|transaction|wallet|token|send|swap|approve/gi.test(objective)) {
      return { valid: false, error: 'Objective must be blockchain-related' };
    }

    return { valid: true };
  }

  /**
   * Validate validation rules are reasonable
   */
  validateValidationRules(rules: unknown[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!Array.isArray(rules)) {
      errors.push('Validation rules must be an array');
      return { valid: false, errors };
    }

    if (rules.length > 5) {
      errors.push('Maximum 5 validation rules allowed');
    }

    for (const rule of rules) {
      if (typeof rule !== 'string') {
        errors.push('Each rule must be a string');
        continue;
      }

      if (rule.length < 3 || rule.length > 200) {
        errors.push('Each rule must be 3-200 characters');
      }

      // Check for SQL injection patterns
      if (/DROP|DELETE|INSERT|UPDATE|UNION|SELECT/gi.test(rule)) {
        errors.push(`Suspicious pattern in rule: ${rule.slice(0, 50)}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  validateQuestType(type?: string): { valid: boolean; error?: string } {
    if (!type) {
      return { valid: true };
    }

    if (!this.allowedQuestTypes.has(type)) {
      return { valid: false, error: 'Quest type is not in the production allowlist' };
    }

    return { valid: true };
  }

  /**
   * Sanitize AI output to safe defaults
   */
  sanitizeQuestOutput(data: unknown): AIQuestOutput {
    const candidate: AIQuestCandidate = isObjectRecord(data) ? data : {};
    const sanitized: AIQuestOutput = {
      title: this.sanitizeString(typeof candidate.title === 'string' ? candidate.title : 'Forge Quest'),
      description: this.sanitizeString(
        typeof candidate.description === 'string' ? candidate.description : 'A blockchain mission awaits.'
      ),
      difficulty: Math.max(1, Math.min(5, Math.round(typeof candidate.difficulty === 'number' ? candidate.difficulty : 3))),
      type: this.sanitizeString(typeof candidate.type === 'string' ? candidate.type : 'Blockchain Quest', 50),
      objective: this.sanitizeString(
        typeof candidate.objective === 'string' ? candidate.objective : 'Complete your quest objective on Celo.'
      ),
      lore: this.sanitizeString(
        typeof candidate.lore === 'string' ? candidate.lore : 'The Forge awaits your completion.'
      ),
      validationRules: Array.isArray(candidate.validationRules)
        ? candidate.validationRules.filter((rule): rule is string => typeof rule === 'string').slice(0, 5)
        : []
    };

    return sanitized;
  }

  applyTemplateFlavor(
    data: AIQuestOutput,
    template: { type: ObjectiveType; questType: string; objective: string; validationRules: string[] }
  ) {
    return {
      ...data,
      type: template.questType,
      objective: template.objective,
      validationRules: template.validationRules
    };
  }

  /**
   * Helper: Sanitize string input
   */
  private sanitizeString(str: string, maxLength: number = 1000): string {
    if (typeof str !== 'string') {
      return '';
    }

    return str
      .trim()
      .slice(0, maxLength)
      .replace(/[<>"'`]/g, '') // Remove HTML/injection chars
      .replace(/\n{3,}/g, '\n\n'); // Limit line breaks
  }

  /**
   * Comprehensive validation of AI quest output
   */
  comprehensiveValidation(aiOutput: unknown, wallet: string): {
    valid: boolean;
    errors: string[];
    warnings: string[];
    sanitized: AIQuestOutput;
  } {
    const candidate: AIQuestCandidate = isObjectRecord(aiOutput) ? aiOutput : {};
    const errors: string[] = [];
    const warnings: string[] = [];
    void wallet;

    // 1. Schema validation
    const schemaCheck = this.validateQuestSchema(aiOutput);
    if (!schemaCheck.valid) {
      errors.push(...schemaCheck.errors);
    }

    // 2. Difficulty validation
    const diffCheck = this.validateDifficulty(
      typeof candidate.difficulty === 'number' ? candidate.difficulty : Number.NaN
    );
    if (!diffCheck.valid) {
      errors.push(diffCheck.error || 'Invalid difficulty');
    }

    // 3. Objective validation
    if (typeof candidate.objective === 'string' && candidate.objective) {
      const objCheck = this.validateObjective(candidate.objective);
      if (!objCheck.valid) {
        errors.push(objCheck.error || 'Invalid objective');
      }
    }

    const typeCheck = this.validateQuestType(typeof candidate.type === 'string' ? candidate.type : undefined);
    if (!typeCheck.valid) {
      warnings.push(typeCheck.error || 'Quest type is not allowed');
    }

    // 4. Hallucination detection
    const hallCheck = this.detectHallucinations(
      `${typeof candidate.title === 'string' ? candidate.title : ''} ${
        typeof candidate.description === 'string' ? candidate.description : ''
      } ${typeof candidate.objective === 'string' ? candidate.objective : ''} ${
        typeof candidate.lore === 'string' ? candidate.lore : ''
      }`
    );
    if (hallCheck.isHallucinated) {
      warnings.push(hallCheck.reason || 'Possible hallucination detected');
    }

    // 5. Validation rules check
    if (Array.isArray(candidate.validationRules)) {
      const rulesCheck = this.validateValidationRules(candidate.validationRules);
      if (!rulesCheck.valid) {
        warnings.push(...rulesCheck.errors);
      }
    }

    // Sanitize output regardless of validation status
    const sanitized = this.sanitizeQuestOutput(aiOutput);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitized
    };
  }
}

export const aiValidator = new AISafetyValidator();

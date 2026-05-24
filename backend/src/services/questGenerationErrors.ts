export class QuestGenerationError extends Error {
  status: number;
  code: string;
  details: string[];

  constructor(code: string, message: string, status = 500, details: string[] = []) {
    super(message);
    this.name = 'QuestGenerationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

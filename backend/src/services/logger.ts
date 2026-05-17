type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogContext = Record<string, unknown>;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const activeLevel = (process.env.LOG_LEVEL?.trim().toLowerCase() as LogLevel | undefined) || 'info';
const activeWeight = LOG_LEVELS[activeLevel] ?? LOG_LEVELS.info;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorLike(value: unknown): value is Error | { message?: unknown; stack?: unknown; name?: unknown } {
  return value instanceof Error || (isRecord(value) && ('message' in value || 'stack' in value || 'name' in value));
}

function toErrorPayload(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  if (isRecord(error)) {
    return {
      ...error,
      name: typeof error.name === 'string' ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : JSON.stringify(error),
      stack: typeof error.stack === 'string' ? error.stack : undefined
    };
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : String(error)
  };
}

function splitErrorInputs(errorOrContext?: unknown, context?: LogContext) {
  if (typeof errorOrContext === 'undefined') {
    return { error: undefined, context };
  }

  if (typeof context === 'undefined' && isRecord(errorOrContext) && !isErrorLike(errorOrContext)) {
    return { error: undefined, context: errorOrContext };
  }

  return {
    error: errorOrContext,
    context
  };
}

function buildEntry(level: LogLevel, message: string, context?: LogContext) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ? { context } : {})
  });
}

function write(level: LogLevel, message: string, context?: LogContext) {
  if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < activeWeight) {
    return;
  }

  const entry = buildEntry(level, message, context);

  if (level === 'error') {
    process.stderr.write(`${entry}\n`);
    return;
  }

  process.stdout.write(`${entry}\n`);
}

export const logger = {
  debug(message: string, context?: LogContext) {
    write('debug', message, context);
  },
  info(message: string, context?: LogContext) {
    write('info', message, context);
  },
  warn(message: string, context?: LogContext) {
    write('warn', message, context);
  },
  error(message: string, errorOrContext?: unknown, context?: LogContext) {
    const payload = splitErrorInputs(errorOrContext, context);
    write('error', message, {
      ...(payload.context || {}),
      ...(typeof payload.error === 'undefined' ? {} : { error: toErrorPayload(payload.error) })
    });
  }
};

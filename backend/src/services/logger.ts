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

function toErrorPayload(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return error;
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
  error(message: string, error?: unknown, context?: LogContext) {
    write('error', message, {
      ...(context || {}),
      ...(typeof error === 'undefined' ? {} : { error: toErrorPayload(error) })
    });
  }
};

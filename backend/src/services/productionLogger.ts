import { Logger, createLogger, format, transports } from 'winston';

const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.splat(),
  format.json()
);

const productionFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.json()
);

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `[${timestamp}] ${level}: ${message} ${metaStr}`;
  })
);

class ProductionLogger {
  private logger: Logger;

  constructor() {
    this.logger = createLogger({
      format: logFormat,
      transports: [
        new transports.Console({
          format: consoleFormat,
          level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
        }),
        new transports.File({
          filename: 'logs/error.log',
          level: 'error',
          format: productionFormat
        }),
        new transports.File({
          filename: 'logs/combined.log',
          format: productionFormat
        })
      ]
    });
  }

  info(message: string, meta?: Record<string, unknown>) {
    this.logger.info(message, meta || {});
  }

  error(message: string, meta?: Record<string, unknown>) {
    this.logger.error(message, meta || {});
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.logger.warn(message, meta || {});
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.logger.debug(message, meta || {});
  }
}

export const logger = new ProductionLogger();

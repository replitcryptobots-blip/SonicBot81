// ════════════════════════════════════════════════════════════
// Logger Module
// JSONL logging with console output (Termux-friendly)
// ════════════════════════════════════════════════════════════

import pino from 'pino';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { config } from './config.js';

/**
 * Ensure log directory exists
 */
async function ensureLogDir(filePath) {
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Create logger instance
 */
async function createLogger() {
  await ensureLogDir(config.logging.logFile);

  const streams = [];

  // Console stream (pretty or JSON)
  if (config.logging.pretty) {
    streams.push({
      level: config.logging.level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }),
    });
  } else {
    streams.push({
      level: config.logging.level,
      stream: process.stdout,
    });
  }

  // File stream (JSONL)
  const fileStream = createWriteStream(config.logging.logFile, {
    flags: 'a', // append
    encoding: 'utf8',
  });

  streams.push({
    level: 'trace', // Log everything to file
    stream: fileStream,
  });

  return pino(
    {
      level: config.logging.level,
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ['privateKey', 'key', 'secret', 'password', 'token'],
        censor: '***REDACTED***',
      },
    },
    pino.multistream(streams)
  );
}

/**
 * Global logger instance
 */
export const logger = await createLogger();

/**
 * Safe shutdown - flush logs
 */
export async function flushLogs() {
  return new Promise((resolve) => {
    // Pino handles flushing automatically, but we wait a moment
    setTimeout(resolve, 100);
  });
}

/**
 * Append to trades log (append-only JSONL)
 */
export async function logTrade(tradeData) {
  await ensureLogDir(config.logging.tradesFile);

  const stream = createWriteStream(config.logging.tradesFile, {
    flags: 'a',
    encoding: 'utf8',
  });

  return new Promise((resolve, reject) => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...tradeData,
    }) + '\n';

    stream.write(line, (err) => {
      stream.end();
      if (err) reject(err);
      else resolve();
    });
  });
}

export default logger;

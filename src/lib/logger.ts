/**
 * Pino logger singleton.
 *
 * Two destinations are wired by default:
 *
 *   1. stdout   — pretty-printed in dev (NODE_ENV !== "production"),
 *                 raw JSON in prod (so a log shipper can parse it).
 *   2. file     — raw JSONL appended to `LOG_FILE` (default
 *                 `apps/api/logs/api.log`). Created on first write.
 *                 Always JSON regardless of NODE_ENV — this is the
 *                 source of truth for `view-api-log.sh`.
 *
 * Set LOG_TO_FILE=false to disable the file sink (e.g. on a serverless
 * platform). The directory is auto-created.
 *
 * Import `logger` from here throughout the app.
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import pino from 'pino';
import type { DestinationStream } from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';
const level = process.env['LOG_LEVEL'] ?? 'info';

// Resolve the file path. Default lives next to apps/api/ so dev tools find it
// without extra config; the path is overridable via env for prod.
const fileLogEnabled = (process.env['LOG_TO_FILE'] ?? 'true').toLowerCase() !== 'false';
const rawLogFile = process.env['LOG_FILE'] ?? 'logs/api.log';
// Resolve relative paths against the API package root (process.cwd() when the
// dev script `tsx watch src/index.ts` runs, which is apps/api/).
const logFile = isAbsolute(rawLogFile) ? rawLogFile : resolve(process.cwd(), rawLogFile);

const streams: pino.StreamEntry[] = [];

// Console stream — pretty in dev, raw in prod.
if (isDev) {
  // pino.transport returns a worker-thread destination; use it as a stream entry.
  streams.push({
    level: level as pino.Level,
    stream: pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }) as unknown as DestinationStream,
  });
} else {
  // Production: raw JSON on stdout for the log shipper.
  streams.push({
    level: level as pino.Level,
    stream: pino.destination({ fd: 1, sync: false }),
  });
}

// File stream — always raw JSONL so `view-api-log.sh` can parse it.
if (fileLogEnabled) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    streams.push({
      level: level as pino.Level,
      stream: pino.destination({
        dest: logFile,
        sync: false,
        mkdir: true,
        append: true,
      }),
    });
  } catch (err) {
    // If we cannot create the log directory we still want the app to start —
    // console logging continues to work.
    // eslint-disable-next-line no-console
    console.warn(`[logger] file sink disabled: ${(err as Error).message}`);
  }
}

export const logger = pino(
  {
    level,
    base: { service: 'nexora-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams),
);

/** Path the file sink is writing to (or null when disabled). */
export const logFilePath = fileLogEnabled ? logFile : null;

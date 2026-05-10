/**
 * Nexora HRMS API — Express bootstrap (Phase 0)
 *
 * Startup order:
 *  1. Validate required env vars (fail fast with a friendly message)
 *  2. Create Express app with security middleware (helmet, CORS, rate-limit)
 *  3. Attach pino-http request logger with traceId
 *  4. Mount /api/v1 router
 *  5. 404 + global error handler
 *  6. Listen on API_PORT
 */

import { config as dotenvConfig } from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import crypto from 'crypto';
import { v1Router } from './router.js';
import { errorHandler } from './middleware/errorHandler.js';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { logger } from './lib/logger.js';

// Load .env before anything else accesses process.env
// (Prisma, pino-http, and app config all read env at module init time)
dotenvConfig();

// ── Env validation ────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(
      `\n[FATAL] Missing required environment variable: ${key}\n` +
        `Copy .env.example to .env and fill in all required values.\n`,
    );
    process.exit(1);
  }
  return val;
}

const DATABASE_URL = requireEnv('DATABASE_URL');
const SESSION_SECRET = requireEnv('SESSION_SECRET');
const API_PORT = Number(process.env['API_PORT'] ?? 4000);

if (SESSION_SECRET.length < 32) {
  console.error(
    `\n[FATAL] SESSION_SECRET must be at least 32 characters.\n` +
      `Generate one with: openssl rand -hex 32\n`,
  );
  process.exit(1);
}

// Suppress "unused" lint warning — DATABASE_URL is used by Prisma via process.env
void DATABASE_URL;

// ── Rate limiters ─────────────────────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorEnvelope(
    ErrorCode.RATE_LIMITED,
    'Too many requests. Please try again after 15 minutes.',
  ),
  skip: () => process.env['NODE_ENV'] === 'test',
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorEnvelope(ErrorCode.RATE_LIMITED, 'Too many requests.'),
  skip: () => process.env['NODE_ENV'] === 'test',
});

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();

// Security headers
app.use(helmet());

// CORS — allow frontend origin only
const allowedOrigins = (process.env['CORS_ORIGIN'] ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (same-origin, curl, Postman in dev)
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  }),
);

// Body parsing (1 MB limit to prevent oversized payload attacks)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Cookie parsing — signed cookies use SESSION_SECRET
app.use(cookieParser(SESSION_SECRET));

// Structured request logging (pino-http)
app.use(
  pinoHttp({
    logger,
    genReqId: () => crypto.randomUUID(),
    customProps: (req) => ({
      traceId: req.id,
    }),
    // Redact sensitive headers/bodies from logs
    redact: {
      paths: ['req.headers.cookie', 'req.body.password', 'req.body.newPassword'],
      censor: '[REDACTED]',
    },
  }),
);

// Global rate limiter (applied before routes)
app.use(globalLimiter);

// Tighter rate limit on auth mutation endpoints
app.use('/api/v1/auth/login', authLimiter);
app.use('/api/v1/auth/forgot-password', authLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/v1', v1Router);

// 404 for any unmatched route
app.use((_req, res) => {
  res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Route not found.'));
});

// Global error handler (must be last)
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(API_PORT, () => {
  logger.info(
    { port: API_PORT, env: process.env['NODE_ENV'] ?? 'development' },
    `Nexora HRMS API listening on port ${API_PORT}`,
  );
});

export { app };

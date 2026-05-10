/**
 * Global Express error handler.
 * Must be registered LAST, after all routes.
 *
 * Converts unhandled errors into the standard error envelope
 * from @nexora/contracts/errors.
 */

import type { Request, Response, NextFunction } from 'express';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';
import { logger } from '../lib/logger.js';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // next must be in the signature for Express to recognise this as an error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  logger.error({ err, method: req.method, url: req.url }, 'Unhandled error');

  if (res.headersSent) return;

  res
    .status(500)
    .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.'));
}

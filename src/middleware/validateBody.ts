/**
 * validateBody — zod request body validation middleware factory.
 *
 * Usage:
 *   router.post('/login', validateBody(LoginRequestSchema), handler)
 *
 * On failure: 400 VALIDATION_FAILED with field-level details.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { ZodError } from 'zod';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';

export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const zodErr = result.error as ZodError;
      const details: Record<string, string[]> = {};

      for (const issue of zodErr.issues) {
        const key = issue.path.join('.') || '_root';
        if (!details[key]) {
          details[key] = [];
        }
        details[key]!.push(issue.message);
      }

      res.status(400).json(
        errorEnvelope(ErrorCode.VALIDATION_FAILED, 'Request validation failed.', { details }),
      );
      return;
    }

    // Attach the parsed (coerced / defaulted) body so handlers use it
    req.body = result.data;
    next();
  };
}

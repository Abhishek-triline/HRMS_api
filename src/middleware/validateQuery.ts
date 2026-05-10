/**
 * validateQuery — zod query-string validation middleware factory.
 *
 * Mirrors validateBody but operates on req.query instead of req.body.
 * Coercion is enabled by default (all query values arrive as strings;
 * zod .coerce helpers handle number / boolean transformation).
 *
 * Usage:
 *   router.get('/employees', validateQuery(EmployeeListQuerySchema), handler)
 *
 * On failure: 400 VALIDATION_FAILED with field-level details.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { ZodError } from 'zod';
import { errorEnvelope, ErrorCode } from '@nexora/contracts/errors';

export function validateQuery<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

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
        errorEnvelope(ErrorCode.VALIDATION_FAILED, 'Query validation failed.', { details }),
      );
      return;
    }

    // Attach the parsed (coerced / defaulted) query so handlers use it
    req.query = result.data as Record<string, string>;
    next();
  };
}

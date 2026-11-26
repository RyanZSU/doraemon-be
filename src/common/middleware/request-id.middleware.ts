import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_PATTERN = /^[\w.-]{1,64}$/;

/**
 * Ensures every request has an id that can be correlated between client logs,
 * server logs and Azure App Service log stream.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header('x-request-id');
  const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();

  (req as RequestWithId).id = id;
  res.setHeader('x-request-id', id);
  next();
}

export type RequestWithId = Request & { id?: string };

export function getRequestId(req: Request): string | undefined {
  return (req as RequestWithId).id;
}
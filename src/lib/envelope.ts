import { HTTPException } from 'hono/http-exception';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { DOCS_ERRORS_URL } from './constants';
import type { AppEnv } from '../types';

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'payment_required',
  'quota_exceeded',
  'not_found',
  'gone',
  'rate_limited',
  'unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    docs_url: string;
    /** Machine-parsable specifics, e.g. per-field validation issues. */
    details?: unknown;
  };
}

export function success<T>(data: T, meta?: Record<string, unknown>): SuccessEnvelope<T> {
  return meta === undefined ? { ok: true, data } : { ok: true, data, meta };
}

export function failure(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  const error: ErrorEnvelope['error'] = {
    code,
    message,
    docs_url: `${DOCS_ERRORS_URL}#${code}`,
  };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  402: 'payment_required',
  404: 'not_found',
  429: 'rate_limited',
  503: 'unavailable',
};

export function statusToCode(status: number): ErrorCode {
  return STATUS_TO_CODE[status] ?? 'internal';
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c: Context<AppEnv>) => {
  if (err instanceof HTTPException) {
    return c.json(failure(statusToCode(err.status), err.message || 'Request failed'), err.status);
  }
  console.error(
    JSON.stringify({
      level: 'error',
      requestId: c.get('requestId'),
      message: err.message,
      stack: err.stack,
    }),
  );
  return c.json(failure('internal', 'Internal server error'), 500);
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  return c.json(failure('not_found', `No route for ${c.req.method} ${c.req.path}`), 404);
};

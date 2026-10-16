import type { MiddlewareHandler } from 'hono';
import { chargeBudget, checkBudget, exhaustedMessage } from './budget';
import { creditCost } from './costs';
import { alertThreshold, NUDGE_MESSAGES } from './quota';
import { failure } from '../lib/envelope';
import { getSource } from '../sources/registry';
import type { AppEnv } from '../types';

/**
 * Runs after auth on metered routes. Rejects exhausted quotas with a 402
 * envelope; otherwise charges successful responses, sets credit headers, and
 * surfaces upgrade nudges (header + meta.usage_alert) from 80% usage. A call
 * the plan allowance cannot cover is paid from the top-up balance (credit
 * packs, metering/budget.ts): X-Credits-Source says which, and a top-up call
 * carries no nudge.
 */
export function meterCredits(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const keyCtx = c.get('keyCtx');
    if (!keyCtx) return next(); // auth must be mounted before metering

    // HEAD is re-dispatched as GET by Hono but returns no body; don't bill or
    // count it (a bodyless probe shouldn't consume credits).
    if (c.req.method === 'HEAD') return next();

    const cost = creditCost(getSource(c.req.param('source') ?? ''));
    const check = await checkBudget(c.env, keyCtx, cost);

    if (!check.ok) {
      c.header('X-Credits-Limit', String(check.granted));
      c.header('X-Credits-Remaining', '0');
      return c.json(failure('quota_exceeded', exhaustedMessage(check.granted)), 402);
    }

    await next();
    if (!c.res.ok) return; // only successful responses are charged

    const charged = await chargeBudget(c.env, keyCtx, check);
    const granted = check.granted;
    c.set('creditsCharged', cost);
    c.res.headers.set('X-Credits-Limit', String(granted));
    c.res.headers.set('X-Credits-Remaining', String(charged.remaining));
    c.res.headers.set('X-Credits-Source', charged.source);
    if (charged.source === 'topup') return; // bought credits: no upgrade nudge

    const newUsed = charged.used;
    const alert = alertThreshold(newUsed, granted);
    if (!alert) return;

    c.res.headers.set('X-Upgrade-Nudge', NUDGE_MESSAGES[alert]!);
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'usage_alert',
        keyId: keyCtx.keyId,
        threshold: alert,
        used: newUsed,
        granted,
      }),
    );
    if (c.res.headers.get('content-type')?.includes('application/json')) {
      const body = (await c.res.json()) as { ok?: boolean; meta?: Record<string, unknown> };
      if (body.ok === true) {
        body.meta = { ...(body.meta ?? {}), usage_alert: alert };
      }
      c.res = new Response(JSON.stringify(body), c.res);
    }
  };
}

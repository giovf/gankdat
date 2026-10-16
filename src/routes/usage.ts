import { Hono } from 'hono';
import { success } from '../lib/envelope';
import { currentPeriod, getUsage } from '../metering/counters';
import { usageSummary } from '../metering/quota';
import { getTopup } from '../metering/topup';
import type { AppEnv } from '../types';

// Authed but unmetered: checking your balance never costs credits.
export const usageRoute = new Hono<AppEnv>().get('/', async (c) => {
  const keyCtx = c.get('keyCtx')!;
  const period = currentPeriod();
  const used = await getUsage(c.env, keyCtx.usageSubject, period);
  const topup = await getTopup(c.env, keyCtx.usageSubject);
  const { granted, remaining, alerts } = usageSummary(keyCtx.plan, used, topup);

  return c.json(success({ plan: keyCtx.plan, period, used, granted, remaining, topup, alerts }));
});

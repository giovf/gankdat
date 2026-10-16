import { z } from 'zod';
import type { DataSource } from '../../src/sources/types';

// In-memory source for unit-testing the generic query engine without any
// network or registry coupling. Retired from the production registry when
// uk-planning and uk-tenders landed (task 5).

const demoRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  score: z.number(),
  active: z.boolean(),
});

export type DemoRecord = z.infer<typeof demoRecordSchema>;

const DEMO_RECORDS: DemoRecord[] = [
  { id: 'r1', name: 'Alpha Works', category: 'industrial', score: 82, active: true },
  { id: 'r2', name: 'Beta House', category: 'residential', score: 67, active: true },
  { id: 'r3', name: 'Gamma Yard', category: 'industrial', score: 45, active: false },
  { id: 'r4', name: 'Delta Point', category: 'commercial', score: 91, active: true },
  { id: 'r5', name: 'Epsilon Row', category: 'residential', score: 12, active: false },
];

export const demoSource: DataSource<DemoRecord> = {
  slug: 'demo',
  title: 'Demo dataset',
  description: 'Static in-memory records for exercising the platform before real sources land.',
  recordSchema: demoRecordSchema,
  queryParams: z.object({
    name: z.string().optional(),
    category: z.string().optional(),
    score: z.coerce.number().optional(),
    active: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
  fetchFresh: () => Promise.resolve(DEMO_RECORDS),
};

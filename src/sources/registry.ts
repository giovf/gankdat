import { euTedSource } from './eu-ted';
import { nhsOdsSource } from './nhs-ods';
import { samExclusionsSource } from './sam-exclusions';
import { ukCareLocationsSource } from './uk-care-locations';
import { ukCharitiesSource } from './uk-charities';
import { ukCompaniesSource } from './uk-companies';
import { ukCompanyProfilesSource } from './uk-company-profiles';
import { ukContractAwardsSource } from './uk-contract-awards';
import { ukFoodHygieneSource } from './uk-food-hygiene';
import { ukGamblingOperatorsSource } from './uk-gambling-operators';
import { ukInsolvencySource } from './uk-insolvency';
import { ukPlanningSource } from './uk-planning';
import { ukSanctionsSource } from './uk-sanctions';
import { ukSchoolsSource } from './uk-schools';
import { ukSponsorsSource } from './uk-sponsors';
import { ukTendersSource } from './uk-tenders';
import { ukTrademarkJournalSource } from './uk-trademark-journal';
import type { DataSource } from './types';

// Adding a dataset = one source file + one entry here. Nothing else.
const SOURCES: DataSource[] = [
  ukPlanningSource,
  ukTendersSource,
  ukContractAwardsSource,
  ukSanctionsSource,
  euTedSource,
  samExclusionsSource,
  ukInsolvencySource,
  ukCompaniesSource,
  ukFoodHygieneSource,
  ukSponsorsSource,
  ukCharitiesSource,
  ukCareLocationsSource,
  ukSchoolsSource,
  nhsOdsSource,
  ukTrademarkJournalSource,
  ukGamblingOperatorsSource,
  ukCompanyProfilesSource,
];

export const registry: ReadonlyMap<string, DataSource> = new Map(
  SOURCES.map((source) => [source.slug, source]),
);

export function getSource(slug: string): DataSource | undefined {
  return registry.get(slug);
}

export function listSources(): DataSource[] {
  return [...registry.values()];
}

/** Register datasets — a stable record id in D1 — carry a daily change feed (/v1/changes, get_changes). */
export function hasChangeFeed(source: DataSource): boolean {
  return source.idOf !== undefined && source.storage === 'd1';
}

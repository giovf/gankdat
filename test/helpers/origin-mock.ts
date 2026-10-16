import { vi } from 'vitest';

const PLANNING_ORIGIN = 'https://www.planning.data.gov.uk/entity.json';
const TENDERS_ORIGIN = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const SANCTIONS_ORIGIN = 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv';
const EU_TED_ORIGIN = 'https://api.ted.europa.eu/v3/notices/search';
const SAM_LIST_ORIGIN = 'https://sam.gov/api/prod/fileextractservices/v1/api/listfiles';
const SAM_DOWNLOAD_ORIGIN = 'https://sam.gov/api/prod/fileextractservices/v1/api/download/';
const SAM_FILE_ORIGIN = 'https://falextracts.s3.amazonaws.com/';
const GAZETTE_ORIGIN = 'https://www.thegazette.co.uk/insolvency/notice/data.json';
const CH_ORIGIN = 'https://api.company-information.service.gov.uk/advanced-search/companies';
const CH_API_ORIGIN = 'https://api.company-information.service.gov.uk/';
const FHRS_ORIGIN = 'https://ratings.food.gov.uk/api/open-data-files/';
const GOVUK_CONTENT_ORIGIN = 'https://www.gov.uk/api/content/';
const GOVUK_ASSET_ORIGIN = 'https://assets.publishing.service.gov.uk/';
const CHARITIES_ORIGIN = 'https://ccewuksprdoneregsadata1.blob.core.windows.net/';
const CQC_PAGE_ORIGIN = 'https://www.cqc.org.uk/about-us/';
const CQC_FILE_ORIGIN = 'https://www.cqc.org.uk/system/files/';
const CF_ORIGIN = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
const GIAS_ORIGIN = 'https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public/';
const ODS_ORIGIN = 'https://www.odsdatasearchandexport.nhs.uk/api/getReport?report=';
const TMJ_ORIGIN = 'https://www.ipo.gov.uk/t-tmj/tm-journals/';
const GC_ORIGIN = 'https://www.gamblingcommission.gov.uk/downloads/';

/**
 * Tests run in the same isolate as the worker under test, so stubbing the
 * global fetch intercepts the worker's outbound origin calls (bindings like
 * KV/D1 are unaffected — they don't go through global fetch).
 */
export function stubOrigins(handlers: {
  planning?: () => Response;
  tenders?: () => Response;
  sanctions?: () => Response;
  euTed?: () => Response;
  samList?: () => Response;
  samDownload?: () => Response;
  samFile?: () => Response;
  gazette?: () => Response;
  companies?: () => Response;
  /** Called with the Companies House public-data URL (…/company/<n>[/charges|/filing-history|/persons-with-significant-control], …/search/companies?q=) so a test can serve each resource. */
  companyApi?: (url: string) => Response;
  fhrs?: () => Response;
  govukContent?: () => Response;
  govukAsset?: () => Response;
  charities?: () => Response;
  cqcPage?: () => Response;
  cqcFile?: () => Response;
  contractsFinder?: () => Response;
  /** Called with the dated GIAS URL so a test can 404 the days it wants. */
  gias?: (url: string) => Response;
  /** Called with the ODS report URL (…/getReport?report=<file>) so a test can serve one file per organisation type. */
  nhsOds?: (url: string) => Response;
  /** Called with the journal file URL (…/tm-journals/<yyyy>-<nnn>/jnl.zip|jnl.xml) so a test can serve some issues and 404 the rest. */
  ipoJournal?: (url: string) => Response;
  /** Called with the register file URL (…/downloads/<file>.csv) so a test can serve one file per record kind. */
  gamblingCommission?: (url: string) => Response;
}): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PLANNING_ORIGIN) && handlers.planning) {
      return Promise.resolve(handlers.planning());
    }
    if (url.startsWith(TENDERS_ORIGIN) && handlers.tenders) {
      return Promise.resolve(handlers.tenders());
    }
    if (url.startsWith(SANCTIONS_ORIGIN) && handlers.sanctions) {
      return Promise.resolve(handlers.sanctions());
    }
    if (url.startsWith(EU_TED_ORIGIN) && handlers.euTed) {
      return Promise.resolve(handlers.euTed());
    }
    if (url.startsWith(SAM_LIST_ORIGIN) && handlers.samList) {
      return Promise.resolve(handlers.samList());
    }
    if (url.startsWith(SAM_DOWNLOAD_ORIGIN) && handlers.samDownload) {
      return Promise.resolve(handlers.samDownload());
    }
    if (url.startsWith(SAM_FILE_ORIGIN) && handlers.samFile) {
      return Promise.resolve(handlers.samFile());
    }
    if (url.startsWith(GAZETTE_ORIGIN) && handlers.gazette) {
      return Promise.resolve(handlers.gazette());
    }
    if (url.startsWith(CH_ORIGIN) && handlers.companies) {
      return Promise.resolve(handlers.companies());
    }
    if (url.startsWith(CH_API_ORIGIN) && handlers.companyApi) {
      return Promise.resolve(handlers.companyApi(url));
    }
    if (url.startsWith(FHRS_ORIGIN) && handlers.fhrs) {
      return Promise.resolve(handlers.fhrs());
    }
    if (url.startsWith(GOVUK_CONTENT_ORIGIN) && handlers.govukContent) {
      return Promise.resolve(handlers.govukContent());
    }
    if (url.startsWith(GOVUK_ASSET_ORIGIN) && handlers.govukAsset) {
      return Promise.resolve(handlers.govukAsset());
    }
    if (url.startsWith(CHARITIES_ORIGIN) && handlers.charities) {
      return Promise.resolve(handlers.charities());
    }
    if (url.startsWith(CQC_PAGE_ORIGIN) && handlers.cqcPage) {
      return Promise.resolve(handlers.cqcPage());
    }
    if (url.startsWith(CQC_FILE_ORIGIN) && handlers.cqcFile) {
      return Promise.resolve(handlers.cqcFile());
    }
    if (url.startsWith(CF_ORIGIN) && handlers.contractsFinder) {
      return Promise.resolve(handlers.contractsFinder());
    }
    if (url.startsWith(GIAS_ORIGIN) && handlers.gias) {
      return Promise.resolve(handlers.gias(url));
    }
    if (url.startsWith(ODS_ORIGIN) && handlers.nhsOds) {
      return Promise.resolve(handlers.nhsOds(url));
    }
    if (url.startsWith(TMJ_ORIGIN) && handlers.ipoJournal) {
      return Promise.resolve(handlers.ipoJournal(url));
    }
    if (url.startsWith(GC_ORIGIN) && handlers.gamblingCommission) {
      return Promise.resolve(handlers.gamblingCommission(url));
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

// Minimal non-empty origin payloads. Sources treat a 0-record refresh as an
// origin failure, so stubs that just exercise auth/metering still need ≥1 row.
export function planningResponse(
  entities: unknown[] = [
    { entity: 1, reference: 'A/1', 'organisation-entity': 109, description: 'x' },
  ],
): Response {
  return Response.json({ entities, links: {}, count: entities.length });
}

export function tendersResponse(
  releases: unknown[] = [{ id: 'n/1', ocid: 'ocds-x', tender: { title: 't' } }],
): Response {
  return Response.json({ releases, links: {} });
}

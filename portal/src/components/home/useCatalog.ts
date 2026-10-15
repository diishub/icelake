// --- Dataset catalogue -----------------------------------------------------
//
// The catalogue is a file written by scripts/publish-portal-catalog.sh, not
// an API. The portal has no route to the control-plane database and is not
// given one; this keeps the filtering in a single reviewable place and lets
// search run in the page, which is faster than a round trip and still works
// while the database is down.
//
// Everything is rendered as React text, never as markup: the values come from
// our own publisher, but a catalogue is exactly the kind of file that grows
// new fields from new sources.
import { useEffect, useState } from 'react';

export const AVAILABILITY = ['published', 'withheld', 'pending', 'retired'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const availabilityOf = (value: unknown): Availability =>
  AVAILABILITY.includes(value as Availability) ? (value as Availability) : 'pending';

export interface CatalogDataset {
  key: string;
  title: string;
  title_en?: string | null;
  description?: string | null;
  description_en?: string | null;
  domain?: string | null;
  availability?: string | null;
  load_mode?: string | null;
  owner?: string | null;
  source?: string | null;
  last_success_at?: string | null;
  column_count?: number | null;
  safe_column_count?: number | null;
  rows?: number | null;
}

export interface CatalogDomain {
  key: string;
  label: string;
  label_en?: string | null;
  dataset_count?: number;
  published_count?: number;
}

export type CatalogStatKey = 'datasets_total' | 'datasets_published' | 'data_owners' | 'columns_withheld';

export interface CatalogDocument {
  generated_at?: string | null;
  stats?: Partial<Record<CatalogStatKey, unknown>>;
  datasets?: unknown;
  domains?: unknown;
}

export type CatalogState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; document: CatalogDocument; datasets: CatalogDataset[]; domains: CatalogDomain[] };

/** What psu-auth's GET /auth/catalog/releases returns per release (metadata only). */
interface PublishedRelease {
  tableName: string;
  titleTh: string;
  titleEn?: string | null;
  descriptionTh?: string | null;
  descriptionEn?: string | null;
  domain?: string | null;
  ownerOrgUnit?: string | null;
  publishedAt?: string | null;
  rowCount?: number | null;
}

// Releases approved through /publish appear here as soon as they are
// published, without waiting for scripts/publish-portal-catalog.sh to run
// again. psu-auth answers with metadata only (no account, no snapshot id),
// and when it is not running the catalogue simply shows what the file has.
async function mergePublishedReleases(datasets: CatalogDataset[], domains: CatalogDomain[]) {
  let releases: PublishedRelease[];
  try {
    const response = await fetch('/auth/catalog/releases', { cache: 'no-store' });
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { releases?: unknown };
    releases = Array.isArray(body.releases) ? (body.releases as PublishedRelease[]) : [];
  } catch {
    return;
  }

  for (const release of releases) {
    const dataset: CatalogDataset = {
      key: `published.${release.tableName}`,
      title: release.titleTh,
      title_en: release.titleEn || release.titleTh,
      description: release.descriptionTh,
      description_en: release.descriptionEn || release.descriptionTh,
      domain: release.domain || 'unsorted',
      availability: 'published',
      // A release replaces the whole published table at a pinned snapshot.
      load_mode: 'full_refresh',
      owner: release.ownerOrgUnit,
      last_success_at: release.publishedAt,
      rows: release.rowCount,
    };
    const existing = datasets.findIndex((item) => item.key === dataset.key);
    if (existing >= 0) {
      datasets[existing] = dataset;
      continue;
    }
    datasets.push(dataset);
    const index = domains.findIndex((item) => item.key === dataset.domain);
    const domain = domains[index];
    if (domain) {
      domains[index] = {
        ...domain,
        dataset_count: (domain.dataset_count || 0) + 1,
        published_count: (domain.published_count || 0) + 1,
      };
    }
  }
}

/** Reads /data/catalog.json once, then merges in releases published since. */
export function useCatalog(): CatalogState {
  const [state, setState] = useState<CatalogState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/data/catalog.json', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`catalogue returned ${response.status}`);
        }
        const catalog = (await response.json()) as CatalogDocument;
        // Copies, so merging releases never mutates the parsed document.
        const datasets = Array.isArray(catalog.datasets) ? [...(catalog.datasets as CatalogDataset[])] : [];
        const domains = Array.isArray(catalog.domains) ? [...(catalog.domains as CatalogDomain[])] : [];
        await mergePublishedReleases(datasets, domains);
        if (!cancelled) {
          setState({ status: 'ready', document: catalog, datasets, domains });
        }
      } catch {
        // A missing catalogue is a normal state on a freshly built machine, so
        // it is reported as a note beside the empty list rather than as a
        // failure that implies something is broken.
        if (!cancelled) {
          setState({ status: 'error' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

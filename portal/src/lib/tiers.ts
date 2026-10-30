/*
 * Which access tier sees which page. Mirrors the tier checks in
 * services/auth/src/server.ts. Hiding a link or a page here is only so a
 * reader is not offered something that will refuse them: psu-auth checks
 * every route again, and Trino/OPA checks every query.
 */

export const TIERS = ['none', 'viewer', 'analyst', 'admin'] as const;
export type AccessTier = (typeof TIERS)[number];

export function knownTier(value: unknown): AccessTier {
  return TIERS.includes(value as AccessTier) ? (value as AccessTier) : 'none';
}

export type WorkspacePage = 'upload' | 'review' | 'publish' | 'reports' | 'admin';

export const PAGE_TIERS: Record<WorkspacePage, readonly AccessTier[]> = {
  upload: ['viewer', 'admin'],
  review: ['analyst', 'admin'],
  publish: ['analyst', 'admin'],
  reports: ['viewer', 'analyst', 'admin'],
  admin: ['admin'],
};

export function canOpen(page: WorkspacePage, tier: AccessTier | undefined): boolean {
  return tier !== undefined && PAGE_TIERS[page].includes(tier);
}

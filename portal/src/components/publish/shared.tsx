import { useCallback } from 'react';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/i18n';

/** A release as psu-auth's releaseView sends it (services/auth/src/store.ts ReleaseRecord + canDecide). */
export interface Release {
  releaseId: string;
  tableName: string;
  version: number;
  status: string;
  titleTh: string;
  titleEn: string | null;
  descriptionTh: string | null;
  descriptionEn: string | null;
  domain: string | null;
  tags: string[] | null;
  ownerOrgUnit: string;
  accessLevel: string;
  refreshCadence: string;
  changelog: string | null;
  requestedByName: string | null;
  requestedAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  publishedSnapshotId: string | null;
  rowCount: number | null;
  publishedAt: string | null;
  failureCode: string | null;
  canDecide: boolean;
}

export interface ReleasePreview {
  columns: { name: string; type: string }[];
  rowCount: number;
}

export const OPEN = ['requested', 'approved'];
export const CLOSED = ['rejected', 'failed'];

// Error codes psu-auth answers with that have their own sentence; anything
// else is shown as the generic message with the code beside it.
const KNOWN_ERRORS = [
  'not_authenticated', 'tier_not_permitted', 'publishing_not_configured', 'trino_unavailable',
  'invalid_table_name', 'title_required', 'invalid_owner_org_unit', 'invalid_domain',
  'invalid_tags', 'invalid_text_field', 'source_table_not_found', 'release_already_open',
  'release_not_found', 'self_approval_forbidden', 'not_data_owner', 'release_already_decided',
  'reason_required', 'source_not_found', 'source_has_no_snapshot', 'copy_failed',
  'snapshot_read_failed', 'interrupted',
];

const STATUS_BADGE: Record<string, string> = {
  requested: 'status-badge-pending',
  approved: 'status-badge-progress',
  published: 'status-badge-registered',
  rejected: 'status-badge-rejected',
  failed: 'status-badge-rejected',
};

/** True when psu-auth answered with its own error code (not a network failure or a non-JSON reply). */
export function hasServerCode(error: unknown): error is ApiError {
  return error instanceof ApiError && error.body !== null && typeof error.body.error === 'string';
}

/** Formatting helpers that follow the current language. */
export function usePublishFormat() {
  const { t, tx, language } = useI18n();

  /** A server error code as a sentence, falling back to the code itself rather than to nothing. */
  const errorMessage = useCallback(
    (code: string) => {
      const text = KNOWN_ERRORS.includes(code) ? tx(`publish.error.${code}`) : '';
      return text || t('publish.error.generic', { code });
    },
    [t, tx],
  );

  const formatDate = useCallback(
    (isoString: string | null | undefined) => {
      if (!isoString) return '—';
      try {
        const locale = language === 'th' ? 'th-TH' : 'en-US';
        return new Date(isoString).toLocaleString(locale, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return isoString;
      }
    },
    [language],
  );

  const formatNumber = useCallback(
    (value: number | null | undefined) => {
      if (typeof value !== 'number') return '—';
      return value.toLocaleString(language === 'th' ? 'th-TH' : 'en-US');
    },
    [language],
  );

  const releaseTitle = (release: Release) =>
    language === 'en' && release.titleEn ? release.titleEn : release.titleTh;

  const releaseDescription = (release: Release) =>
    language === 'en' && release.descriptionEn ? release.descriptionEn : release.descriptionTh;

  return { errorMessage, formatDate, formatNumber, releaseTitle, releaseDescription };
}

export function StatusBadge({ release }: { release: Release }) {
  const { tx } = useI18n();
  const cls = STATUS_BADGE[release.status] ?? 'status-badge-pending';
  return <span className={`upload-status-badge ${cls}`}>{tx(`publish.status.${release.status}`)}</span>;
}

export interface Alert {
  message: string;
  kind: 'error' | 'success';
}

export function FeedbackAlert({ alert }: { alert: Alert | null }) {
  if (!alert) return null;
  return (
    <div className={`modal-feedback-alert ${alert.kind === 'error' ? 'alert-error' : 'alert-success'}`}>
      {alert.message}
    </div>
  );
}

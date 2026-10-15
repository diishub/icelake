/*
 * Types and formatting shared by the review page components. Field names are
 * the ones psu-auth returns from GET /auth/reviews and
 * GET /auth/reviews/:id/preview (services/auth/src/server.ts).
 */
import type { Language, MessageKey } from '@/i18n';

export type UploadStatus = 'pending_review' | 'registered' | 'rejected' | string;

export interface ReviewUpload {
  uploadId: string;
  userId?: string;
  uploaderUsername?: string | null;
  uploaderDisplayName?: string | null;
  orgUnit: string;
  fileKind: string;
  originalFilename: string;
  sizeBytes: number;
  uploadedAt?: string | null;
  status: UploadStatus;
  uploaderNote?: string | null;
  reviewedByUsername?: string | null;
  reviewedAt?: string | null;
  targetTable?: string | null;
  columnsIncluded?: number | null;
  columnsExcluded?: number | null;
  rejectionReason?: string | null;
}

export interface PreviewColumn {
  name: string;
  originalName?: string;
  type?: string;
  classification?: string;
}

/** CSV preview: columns + sample rows. Document preview: extracted text. */
export interface ReviewPreview {
  columns?: PreviewColumn[];
  sampleRows?: string[][];
  fileKind?: string;
  hasExtractedText?: boolean;
  extractedText?: string | null;
}

export type Classification = 'public' | 'internal' | 'sensitive';

export interface ColumnState {
  /** What the reviewer typed, shown in the input. */
  raw: string;
  /** Trimmed + lower-cased name sent to psu-auth. */
  name: string;
  originalName: string;
  type: string;
  classification: Classification;
}

export const ALLOWED_TYPES = ['VARCHAR', 'INTEGER', 'BIGINT', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP'] as const;
export const CLASSIFICATIONS: readonly { value: Classification; label: MessageKey }[] = [
  { value: 'public', label: 'review.classPublic' },
  { value: 'internal', label: 'review.classInternal' },
  { value: 'sensitive', label: 'review.classSensitive' },
];

/** Same rule psu-auth enforces for tableSuffix and column names. */
export const SQL_NAME = /^[a-z][a-z0-9_]*$/;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(isoString: string | null | undefined, language: Language): string {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    const locale = language === 'th' ? 'th-TH' : 'en-US';
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

export function uploaderLabel(upload: ReviewUpload): string {
  return upload.uploaderDisplayName
    ? `${upload.uploaderDisplayName} (${upload.uploaderUsername || ''})`
    : upload.uploaderUsername || upload.userId || '';
}

export function statusBadge(status: UploadStatus): { className: string; label: MessageKey } {
  if (status === 'registered') {
    return { className: 'status-badge-registered', label: 'upload.statusRegistered' };
  }
  if (status === 'rejected') {
    return { className: 'status-badge-rejected', label: 'upload.statusRejected' };
  }
  return { className: 'status-badge-pending', label: 'upload.statusPending' };
}

export function isClassification(value: string | undefined): value is Classification {
  return value === 'public' || value === 'internal' || value === 'sensitive';
}

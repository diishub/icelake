/** One row of psu-auth's GET /auth/uploads (store.ts UploadRecord), as far as this page reads it. */
export interface UploadItem {
  uploadId: string;
  originalFilename: string;
  sizeBytes: number;
  uploadedAt: string;
  status: 'pending_review' | 'loading' | 'registered' | 'rejected';
  fileKind: 'csv' | 'pdf' | 'docx';
  reviewedByUsername: string | null;
  targetTable: string | null;
  uploaderNote?: string | null;
  rejectionReason?: string | null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

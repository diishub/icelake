import { useI18n } from '@/i18n';
import { statusBadge } from './shared';
import type { UploadStatus } from './shared';

export function StatusBadge({ status }: { status: UploadStatus }) {
  const { t } = useI18n();
  const badge = statusBadge(status);
  return <span className={`upload-status-badge ${badge.className}`}>{t(badge.label)}</span>;
}

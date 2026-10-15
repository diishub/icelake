import { useEffect, useRef } from 'react';
import { useI18n } from '@/i18n';

interface Props {
  reason: string;
  onReason: (value: string) => void;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Asks for the reason the data owner will see before an upload is rejected. */
export function RejectDrawer({ reason, onReason, busy, onCancel, onConfirm }: Props) {
  const { t } = useI18n();
  const input = useRef<HTMLTextAreaElement>(null);

  // The drawer mounts when the reviewer presses "reject": put them in the box.
  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <div className="modal-reject-drawer">
      <label htmlFor="reject-reason-input" className="reject-drawer-label">
        {t('review.rejectReasonPrompt')}
      </label>
      <textarea
        ref={input}
        id="reject-reason-input"
        rows={2}
        maxLength={500}
        className="reject-reason-input"
        placeholder={t('review.rejectReasonPlaceholder')}
        value={reason}
        onChange={(event) => onReason(event.target.value)}
      />
      <div className="reject-drawer-buttons">
        <button className="button button-ghost button-small" type="button" onClick={onCancel}>
          {t('review.btnCancel')}
        </button>
        <button className="button button-danger button-small" type="button" disabled={busy} onClick={onConfirm}>
          {t(busy ? 'review.btnRejecting' : 'review.btnConfirmReject')}
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { knownTier } from '@/lib/tiers';
import type { AccessTier } from '@/lib/tiers';

/** An account as GET /auth/admin/users lists it (store.ts ManagedAccount). */
export interface ManagedAccount {
  userId: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  accessTier: AccessTier;
  orgUnit: string | null;
  isActive: boolean;
  hasPassword: boolean;
  hasPsuPassport: boolean;
  lastLoginAt: string | null;
}

export interface AccountList {
  accounts?: ManagedAccount[];
  assignableTiers?: AccessTier[];
  self?: string | null;
}

/** One row of GET /auth/admin/events (store.ts AdminEvent). */
export interface AdminEvent {
  eventId: string;
  occurredAt: string;
  action: string;
  actorName: string | null;
  targetName: string | null;
  detail: Record<string, unknown> | null;
}

export interface Alert {
  message: string;
  kind: 'error' | 'success';
}

export const ORG_SCOPED_TIERS: readonly string[] = ['viewer', 'steward'];
export const PASSWORD_MIN_LENGTH = 12;

export function passwordInputProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'password_too_short';
  if (password !== confirm) return 'password_mismatch';
  return null;
}

/** Shared text helpers of the admin page; re-render with the language. */
export function useAdminText() {
  const { t, tx, language } = useI18n();

  const tierLabel = useCallback((tier: unknown) => tx(`tier.${knownTier(tier)}`), [tx]);

  // A psu-auth error code this page has a sentence for (admin.error.<code>),
  // or the generic sentence that carries the code.
  const errorMessage = useCallback(
    (code: string | undefined) => tx(`admin.error.${code ?? 'unknown'}`, { code: code || 'unknown' }, 'admin.error.generic'),
    [tx],
  );

  const formatDate = useCallback(
    (isoString: string | null | undefined) => {
      if (!isoString) return '—';
      try {
        return new Date(isoString).toLocaleString(language === 'th' ? 'th-TH' : 'en-US', {
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

  return { t, tx, tierLabel, errorMessage, formatDate };
}

export function FeedbackAlert({ alert }: { alert: Alert | null }) {
  if (!alert) return null;
  return (
    <div className={`modal-feedback-alert ${alert.kind === 'error' ? 'alert-error' : 'alert-success'}`}>
      {alert.message}
    </div>
  );
}

export function TierOptions({ tiers }: { tiers: readonly AccessTier[] }) {
  const { tierLabel } = useAdminText();
  return (
    <>
      {tiers.map((tier) => (
        <option key={tier} value={tier}>{`${tierLabel(tier)} (${tier})`}</option>
      ))}
    </>
  );
}

interface ModalProps {
  id: string;
  title: MessageKey;
  subtitle: ReactNode;
  /** The field that takes focus when the modal opens. */
  focusId: string;
  submitLabel: MessageKey;
  submitting: boolean;
  alert: Alert | null;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}

/**
 * The frame of the three account modals. Mounted only while open, so its
 * fields (and any password typed into them) are gone once it closes.
 */
export function AdminModal({ id, title, subtitle, focusId, submitLabel, submitting, alert, onClose, onSubmit, children }: ModalProps) {
  const { t } = useI18n();
  // A click that started inside the dialog (e.g. selecting text) and ended on
  // the backdrop must not close it.
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    document.getElementById(focusId)?.focus();
  }, [focusId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="review-modal-backdrop"
      id={`${id}-modal-backdrop`}
      onMouseDown={(event) => {
        pressedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedOnBackdrop.current && event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="review-modal"
        id={`${id}-form`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-heading`}
        noValidate
        onSubmit={onSubmit}
      >
        <header className="review-modal-header">
          <div>
            <h2 className="review-modal-title" id={`${id}-heading`}>
              {t(title)}
            </h2>
            <p className="review-modal-subtitle">{subtitle}</p>
          </div>
          <button className="review-modal-close" type="button" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </header>
        <div className="review-modal-body">
          <FeedbackAlert alert={alert} />
          {children}
        </div>
        <footer className="review-modal-footer">
          <div className="footer-left">
            <button className="button button-ghost" type="button" onClick={onClose}>
              {t('review.btnClose')}
            </button>
          </div>
          <div className="footer-actions">
            <button className="button button-positive" type="submit" id={`${id}-submit`} disabled={submitting}>
              {t(submitLabel)}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

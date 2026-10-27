import { useState } from 'react';
import type { FormEvent } from 'react';
import { PasswordInput } from '@/components/PasswordInput';
import { api } from '@/lib/api';
import { AdminModal, passwordInputProblem, useAdminText } from './shared';
import type { Alert, ManagedAccount } from './shared';

interface Props {
  account: ManagedAccount;
  onClose: () => void;
  onDone: (message: string) => void;
}

/** Like the create modal, the passwords are read from the form on submit only. */
export function ResetPasswordModal({ account, onClose, onDone }: Props) {
  const { t, errorAlert } = useAdminText();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const problem = passwordInputProblem(password, String(form.get('passwordConfirm') ?? ''));
    if (problem) {
      setAlert(errorAlert(problem));
      return;
    }
    setSubmitting(true);
    try {
      await api('POST', `/auth/admin/users/${encodeURIComponent(account.userId)}/password`, { password });
      onDone(t('admin.passwordReset'));
    } catch (error) {
      setAlert(errorAlert(error));
      setSubmitting(false);
    }
  }

  return (
    <AdminModal
      id="password"
      title="admin.resetTitle"
      subtitle={account.displayName || account.email || ''}
      focusId="reset-password"
      submitLabel="admin.resetSubmit"
      submitting={submitting}
      alert={alert}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      <p className="login-note login-note-warning">{t('admin.resetNote')}</p>
      <div className="publish-form-grid">
        <div className="upload-input-group">
          <label htmlFor="reset-password">{t('admin.fieldPassword')}</label>
          <PasswordInput
            id="reset-password"
            name="password"
            className="publish-input"
            minLength={12}
            autoComplete="new-password"
            required
          />
          <p className="input-hint-text">{t('admin.passwordHint')}</p>
        </div>
        <div className="upload-input-group">
          <label htmlFor="reset-password-confirm">{t('admin.fieldPasswordConfirm')}</label>
          <PasswordInput
            id="reset-password-confirm"
            name="passwordConfirm"
            className="publish-input"
            minLength={12}
            autoComplete="new-password"
            required
          />
        </div>
      </div>
    </AdminModal>
  );
}

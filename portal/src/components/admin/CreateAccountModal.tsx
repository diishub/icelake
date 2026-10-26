import { useState } from 'react';
import type { FormEvent } from 'react';
import { PasswordInput } from '@/components/PasswordInput';
import { api, ApiError } from '@/lib/api';
import type { AccessTier } from '@/lib/tiers';
import { AdminModal, ORG_SCOPED_TIERS, passwordInputProblem, TierOptions, useAdminText } from './shared';
import type { Alert } from './shared';

interface Props {
  assignableTiers: readonly AccessTier[];
  onClose: () => void;
  /** Called after psu-auth created the account, with the success sentence. */
  onDone: (message: string) => void;
}

/**
 * Mounted only while open. The passwords stay in their inputs (uncontrolled)
 * and are read once on submit, so they are never held in React state and are
 * gone when the modal unmounts.
 */
export function CreateAccountModal({ assignableTiers, onClose, onDone }: Props) {
  const { t, errorMessage } = useAdminText();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [tier, setTier] = useState<string>(assignableTiers.includes('none') ? 'none' : (assignableTiers[0] ?? 'none'));
  const [orgUnit, setOrgUnit] = useState('');
  const [alert, setAlert] = useState<Alert | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const problem = passwordInputProblem(password, String(form.get('passwordConfirm') ?? ''));
    if (problem) {
      setAlert({ message: errorMessage(problem), kind: 'error' });
      return;
    }
    setSubmitting(true);
    try {
      const created = await api<{ username?: string }>('POST', '/auth/admin/users', {
        email: email.trim(),
        displayName: displayName.trim(),
        username: username.trim(),
        password,
        accessTier: tier,
        orgUnit: orgUnit.trim(),
      });
      onDone(t('admin.created', { username: created.username ?? '' }));
    } catch (error) {
      setAlert({ message: errorMessage(error instanceof ApiError ? error.code : undefined), kind: 'error' });
      setSubmitting(false);
    }
  }

  return (
    <AdminModal
      id="create"
      title="admin.createTitle"
      subtitle={t('admin.createSubtitle')}
      focusId="create-email"
      submitLabel="admin.createSubmit"
      submitting={submitting}
      alert={alert}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      <div className="publish-form-grid">
        <div className="upload-input-group">
          <label htmlFor="create-email">{t('admin.fieldEmail')}</label>
          <input
            id="create-email"
            className="publish-input"
            type="email"
            maxLength={254}
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="upload-input-group">
          <label htmlFor="create-name">{t('admin.fieldDisplayName')}</label>
          <input
            id="create-name"
            className="publish-input"
            type="text"
            maxLength={200}
            autoComplete="off"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="upload-input-group publish-span-2">
          <label htmlFor="create-username">{t('admin.fieldUsername')}</label>
          <input
            id="create-username"
            className="publish-input"
            type="text"
            maxLength={64}
            pattern="^[a-z0-9._-]{1,64}$"
            autoComplete="off"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <p className="input-hint-text">{t('admin.fieldUsernameHint')}</p>
        </div>
        <div className="upload-input-group">
          <label htmlFor="create-password">{t('admin.fieldPassword')}</label>
          <PasswordInput
            id="create-password"
            name="password"
            className="publish-input"
            minLength={12}
            autoComplete="new-password"
            required
          />
          <p className="input-hint-text">{t('admin.passwordHint')}</p>
        </div>
        <div className="upload-input-group">
          <label htmlFor="create-password-confirm">{t('admin.fieldPasswordConfirm')}</label>
          <PasswordInput
            id="create-password-confirm"
            name="passwordConfirm"
            className="publish-input"
            minLength={12}
            autoComplete="new-password"
            required
          />
        </div>
        <div className="upload-input-group">
          <label htmlFor="create-tier">{t('admin.fieldTier')}</label>
          <select id="create-tier" className="publish-input" value={tier} onChange={(event) => setTier(event.target.value)}>
            <TierOptions tiers={assignableTiers} />
          </select>
        </div>
        <div className="upload-input-group">
          <label htmlFor="create-org-unit">{t('admin.fieldOrgUnit')}</label>
          <input
            id="create-org-unit"
            className="publish-input"
            type="text"
            maxLength={64}
            pattern="^[a-z0-9_-]{1,64}$"
            placeholder="eng"
            required={ORG_SCOPED_TIERS.includes(tier)}
            value={orgUnit}
            onChange={(event) => setOrgUnit(event.target.value)}
          />
          <p className="input-hint-text">{t('admin.fieldOrgUnitHint')}</p>
        </div>
      </div>
    </AdminModal>
  );
}

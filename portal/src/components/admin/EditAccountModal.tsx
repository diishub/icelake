import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import type { AccessTier } from '@/lib/tiers';
import { AdminModal, ORG_SCOPED_TIERS, TierOptions, useAdminText } from './shared';
import type { Alert, ManagedAccount } from './shared';

interface Props {
  account: ManagedAccount;
  assignableTiers: readonly AccessTier[];
  onClose: () => void;
  onDone: (message: string) => void;
}

export function EditAccountModal({ account, assignableTiers, onClose, onDone }: Props) {
  const { t, errorMessage } = useAdminText();
  const [tier, setTier] = useState<string>(assignableTiers.includes(account.accessTier) ? account.accessTier : 'none');
  const [orgUnit, setOrgUnit] = useState(account.orgUnit ?? '');
  const [isActive, setIsActive] = useState(account.isActive);
  const [alert, setAlert] = useState<Alert | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api('PUT', `/auth/admin/users/${encodeURIComponent(account.userId)}`, {
        accessTier: tier,
        orgUnit: orgUnit.trim(),
        isActive,
      });
      onDone(t('admin.saved'));
    } catch (error) {
      setAlert({ message: errorMessage(error instanceof ApiError ? error.code : undefined), kind: 'error' });
      setSubmitting(false);
    }
  }

  return (
    <AdminModal
      id="edit"
      title="admin.editTitle"
      subtitle={account.displayName || account.email || account.username || ''}
      focusId="edit-tier"
      submitLabel="admin.saveChanges"
      submitting={submitting}
      alert={alert}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      <div className="publish-form-grid">
        <div className="upload-input-group">
          <label htmlFor="edit-tier">{t('admin.fieldTier')}</label>
          <select id="edit-tier" className="publish-input" value={tier} onChange={(event) => setTier(event.target.value)}>
            <TierOptions tiers={assignableTiers} />
          </select>
        </div>
        <div className="upload-input-group">
          <label htmlFor="edit-org-unit">{t('admin.fieldOrgUnit')}</label>
          <input
            id="edit-org-unit"
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
        <label className="admin-checkbox publish-span-2">
          <input id="edit-active" type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          <span>{t('admin.fieldActive')}</span>
        </label>
      </div>
    </AdminModal>
  );
}

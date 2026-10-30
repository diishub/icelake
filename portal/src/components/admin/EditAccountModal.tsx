import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '@/lib/api';
import type { AccessTier } from '@/lib/tiers';
import { AdminModal, TierOptions, useAdminText } from './shared';
import type { Alert, ManagedAccount } from './shared';

interface Props {
  account: ManagedAccount;
  assignableTiers: readonly AccessTier[];
  onClose: () => void;
  onDone: (message: string) => void;
}

export function EditAccountModal({ account, assignableTiers, onClose, onDone }: Props) {
  const { t, errorAlert } = useAdminText();
  // An account still at 'none' (not offered here) starts on the first tier
  // that is, so what the select shows is what gets saved.
  const [tier, setTier] = useState<string>(
    assignableTiers.includes(account.accessTier) ? account.accessTier : (assignableTiers[0] ?? 'viewer'),
  );
  const [isActive, setIsActive] = useState(account.isActive);
  const [alert, setAlert] = useState<Alert | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api('PUT', `/auth/admin/users/${encodeURIComponent(account.userId)}`, {
        accessTier: tier,
        isActive,
      });
      onDone(t('admin.saved'));
    } catch (error) {
      setAlert(errorAlert(error));
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
        <label className="admin-checkbox publish-span-2">
          <input id="edit-active" type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          <span>{t('admin.fieldActive')}</span>
        </label>
      </div>
    </AdminModal>
  );
}

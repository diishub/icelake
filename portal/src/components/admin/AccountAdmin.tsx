import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AccessTier } from '@/lib/tiers';
import { AuditEvents } from './AuditEvents';
import { CreateAccountModal } from './CreateAccountModal';
import { EditAccountModal } from './EditAccountModal';
import { ResetPasswordModal } from './ResetPasswordModal';
import { UsersTable } from './UsersTable';
import { useAdminText } from './shared';
import type { AccountList, AdminEvent, Alert, ManagedAccount } from './shared';

type OpenModal =
  | { kind: 'create' }
  | { kind: 'edit'; account: ManagedAccount }
  | { kind: 'reset'; account: ManagedAccount }
  | null;

/**
 * Account administration, rendered for the 'admin' tier only. psu-auth
 * refuses every /auth/admin/* call from any other tier, and the database
 * functions behind it re-check again (config/platform/022-admin-tier.sql);
 * what this shows or hides is only so a reader is not offered an action that
 * will be refused.
 */
export function AccountAdmin() {
  const { errorAlert } = useAdminText();
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [assignableTiers, setAssignableTiers] = useState<AccessTier[]>([]);
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [usersAlert, setUsersAlert] = useState<Alert | null>(null);
  const [modal, setModal] = useState<OpenModal>(null);
  // Bumped on every open so the modal (and its password fields) mounts fresh:
  // empty, and with the passwords hidden.
  const [modalSession, setModalSession] = useState(0);

  const loadAccounts = useCallback(async () => {
    setUsersAlert(null);
    try {
      const [list, history] = await Promise.all([
        api<AccountList>('GET', '/auth/admin/users'),
        api<{ events?: AdminEvent[] }>('GET', '/auth/admin/events'),
      ]);
      setAccounts(list.accounts ?? []);
      setAssignableTiers(list.assignableTiers ?? []);
      setSelfUserId(list.self ?? null);
      setEvents(history.events ?? []);
      setLoaded(true);
    } catch (error) {
      setUsersAlert(errorAlert(error));
    }
  }, [errorAlert]);

  // Load once on mount; a language change must not refetch.
  useEffect(() => {
    void loadAccounts();
  }, []);

  const open = (next: Exclude<OpenModal, null>) => {
    setModalSession((value) => value + 1);
    setModal(next);
  };
  const close = useCallback(() => setModal(null), []);
  const done = useCallback(
    async (message: string) => {
      setModal(null);
      await loadAccounts();
      setUsersAlert({ message, kind: 'success' });
    },
    [loadAccounts],
  );
  const onDone = (message: string) => void done(message);

  return (
    <>
      <UsersTable
        accounts={accounts}
        loaded={loaded}
        selfUserId={selfUserId}
        alert={usersAlert}
        onRefresh={() => void loadAccounts()}
        onCreate={() => open({ kind: 'create' })}
        onEdit={(account) => open({ kind: 'edit', account })}
        onReset={(account) => open({ kind: 'reset', account })}
      />
      <AuditEvents events={events} loaded={loaded} />

      {modal?.kind === 'create' ? (
        <CreateAccountModal key={modalSession} assignableTiers={assignableTiers} onClose={close} onDone={onDone} />
      ) : null}
      {modal?.kind === 'edit' ? (
        <EditAccountModal
          key={modalSession}
          account={modal.account}
          assignableTiers={assignableTiers}
          onClose={close}
          onDone={onDone}
        />
      ) : null}
      {modal?.kind === 'reset' ? (
        <ResetPasswordModal key={modalSession} account={modal.account} onClose={close} onDone={onDone} />
      ) : null}
    </>
  );
}

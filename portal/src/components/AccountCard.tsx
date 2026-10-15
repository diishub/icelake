import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/i18n';

/**
 * Name, granted tier and sign-out. Keeps its space while /auth/me is still
 * answering, so the header does not shift when it fills in.
 *
 * `unit` picks what follows the tier: the granted org unit (workspace pages)
 * or, for the home page, the directory's faculty first.
 */
export function AccountCard({ unit = 'org' }: { unit?: 'org' | 'directory' }) {
  const { status, user, signOut } = useAuth();
  const { t, tx } = useI18n();
  const [signingOut, setSigningOut] = useState(false);

  if (status === 'ready' && !user) {
    return null;
  }

  const name = user ? user.displayName || user.username || t('account.fallbackName') : ' ';
  const role = user ? tx(`tier.${user.accessTier}`) : ' ';
  const where = user
    ? unit === 'directory'
      ? user.facultyNameTh || user.orgUnit || user.campusNameTh
      : user.orgUnit
    : null;

  return (
    <div className="account-card" aria-busy={status === 'loading'}>
      <span className="account-copy">
        <strong>{name}</strong>
        <small>{where ? `${role} · ${where}` : role}</small>
      </span>
      <button
        className="account-signout"
        type="button"
        disabled={!user || signingOut}
        onClick={() => {
          setSigningOut(true);
          void signOut();
        }}
      >
        {t('account.signOut')}
      </button>
    </div>
  );
}

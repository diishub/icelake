import { useState } from 'react';
import { FeedbackAlert, useAdminText } from './shared';
import type { Alert, ManagedAccount } from './shared';

interface Props {
  accounts: ManagedAccount[];
  /** False until the first list has arrived. */
  loaded: boolean;
  selfUserId: string | null;
  alert: Alert | null;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (account: ManagedAccount) => void;
  onReset: (account: ManagedAccount) => void;
}

function accountMatches(account: ManagedAccount, query: string): boolean {
  if (!query) return true;
  return [account.displayName, account.email, account.username, account.orgUnit, account.accessTier].some(
    (value) => value && value.toLowerCase().includes(query),
  );
}

export function UsersTable({ accounts, loaded, selfUserId, alert, onRefresh, onCreate, onEdit, onReset }: Props) {
  const { t, tierLabel, formatDate } = useAdminText();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const visible = accounts.filter((account) => accountMatches(account, query));

  return (
    <section className="panel admin-section" id="admin-users" aria-labelledby="admin-users-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="admin-users-title">
            {t('admin.usersTitle')}
          </h2>
          <p className="panel-desc">{t('admin.usersLead')}</p>
        </div>
        <div className="page-actions">
          <button className="button button-ghost" type="button" id="users-refresh-btn" onClick={onRefresh}>
            {t('review.refresh')}
          </button>
          <button className="button button-primary" type="button" id="users-new-btn" onClick={onCreate}>
            {t('admin.newUser')}
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="admin-users-toolbar">
          <label className="sr-only" htmlFor="users-search">
            {t('admin.searchLabel')}
          </label>
          <input
            id="users-search"
            className="publish-input"
            type="search"
            maxLength={100}
            placeholder={t('admin.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <FeedbackAlert alert={alert} />
      </div>
      <div className="admin-table-wrapper">
        <table className="review-table admin-users-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.colAccount')}</th>
              <th scope="col">{t('admin.colTier')}</th>
              <th scope="col">{t('admin.colStatus')}</th>
              <th scope="col">{t('admin.colLastLogin')}</th>
              <th scope="col">
                <span className="sr-only">{t('admin.colActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody id="users-tbody">
            {!loaded ? (
              <tr>
                <td colSpan={5} className="review-empty-state">
                  {t('review.loading')}
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="review-empty-state">
                  {t(accounts.length ? 'admin.noMatch' : 'admin.noUsers')}
                </td>
              </tr>
            ) : (
              visible.map((account) => {
                const isSelf = account.userId === selfUserId;
                // psu-auth refuses it anyway (self_change_forbidden); the
                // disabled button says why up front.
                const editable = !isSelf;
                const meta = [account.email, account.username ? `trino: ${account.username}` : null]
                  .filter(Boolean)
                  .join(' · ');
                const methods = [
                  account.hasPassword ? t('admin.methodPassword') : null,
                  account.hasPsuPassport ? t('admin.methodPassport') : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <tr key={account.userId} className={account.isActive ? undefined : 'admin-row-inactive'}>
                    <td>
                      <strong>{account.displayName || account.email || account.username || '—'}</strong>
                      <span className="admin-account-meta">{meta}</span>
                      <span className="admin-account-meta">{methods}</span>
                      {isSelf ? <span className="state-badge is-ready">{t('admin.you')}</span> : null}
                    </td>
                    <td>
                      <span className="upload-status-badge">{tierLabel(account.accessTier)}</span>
                    </td>
                    <td>
                      <span className={`state-badge ${account.isActive ? 'is-published' : 'is-withheld'}`}>
                        {t(account.isActive ? 'admin.statusActive' : 'admin.statusInactive')}
                      </span>
                    </td>
                    <td>{formatDate(account.lastLoginAt)}</td>
                    <td className="admin-row-actions">
                      <button
                        className="button button-ghost button-small"
                        type="button"
                        disabled={!editable}
                        title={
                          editable ? undefined : t('admin.error.self_change_forbidden')
                        }
                        onClick={() => onEdit(account)}
                      >
                        {t('admin.edit')}
                      </button>
                      {account.hasPassword ? (
                        <button className="button button-ghost button-small" type="button" onClick={() => onReset(account)}>
                          {t('admin.resetPassword')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

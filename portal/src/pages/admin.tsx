/*
 * Platform-team page, for admin and developer accounts.
 *
 * Admins also get account administration: list accounts, create password
 * accounts, grant tiers, switch accounts off and reset passwords. Every tool
 * linked here has its own sign-in, and the commands listed on the page run
 * only on the host.
 */
import { RequireTier } from '@/components/RequireTier';
import { WorkspaceLayout } from '@/components/WorkspaceLayout';
import { AccountAdmin } from '@/components/admin/AccountAdmin';
import { AdminTasks } from '@/components/admin/AdminTasks';
import { AdminTools } from '@/components/admin/AdminTools';
import { useI18n } from '@/i18n';

export default function AdminPage() {
  const { t } = useI18n();
  return (
    <WorkspaceLayout page="admin" title="ws.admin" description="admin.lead" mainId="admin-main">
      <RequireTier page="admin" forbidden="admin.forbidden">
        {(user) => (
          <div id="admin-content">
            <div className="page-head">
              <div>
                <p className="breadcrumb">
                  <span>{t('ws.breadcrumb')}</span> / <span>{t('ws.admin')}</span>
                </p>
                <h1 className="page-title">{t('admin.heading')}</h1>
                <p className="page-lead">{t('admin.lead')}</p>
              </div>
            </div>

            {/* Account administration: 'admin' tier only. psu-auth refuses every
                /auth/admin/* call from any other tier; hiding it is for the reader. */}
            {user.accessTier === 'admin' ? <AccountAdmin /> : null}
            <AdminTools />
            <AdminTasks />
          </div>
        )}
      </RequireTier>
    </WorkspaceLayout>
  );
}

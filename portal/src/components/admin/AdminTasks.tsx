import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

// Commands are run on the host from the repository directory; this table only
// reminds the platform team of them.
const TASKS: { label: MessageKey; command: string }[] = [
  { label: 'admin.taskAdmin', command: './scripts/create-admin-account.sh <email> "<display name>"' },
  { label: 'admin.taskAccount', command: './scripts/create-password-account.sh <email> "<display name>"' },
  {
    label: 'admin.taskTier',
    command: "UPDATE identity.app_user SET access_tier = '<tier>', org_unit = '<unit>' WHERE email = '<email>';",
  },
  { label: 'admin.taskGroups', command: './scripts/publish-trino-groups.sh' },
  { label: 'admin.taskCatalog', command: './scripts/publish-portal-catalog.sh' },
  { label: 'admin.taskVerify', command: './scripts/verify-dev-accounts.sh' },
];

export function AdminTasks() {
  const { t } = useI18n();
  return (
    <section className="panel admin-section" aria-labelledby="admin-tasks-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="admin-tasks-title">
            {t('admin.tasksTitle')}
          </h2>
          <p className="panel-desc">{t('admin.tasksLead')}</p>
        </div>
      </div>
      <div className="admin-table-wrapper">
        <table className="review-table admin-task-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.colTask')}</th>
              <th scope="col">{t('admin.colCommand')}</th>
            </tr>
          </thead>
          <tbody>
            {TASKS.map((task) => (
              <tr key={task.label}>
                <td>{t(task.label)}</td>
                <td>
                  <code>{task.command}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="panel-body admin-tier-note">{t('admin.tierNote')}</p>
    </section>
  );
}

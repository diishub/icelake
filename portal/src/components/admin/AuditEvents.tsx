import { useAdminText } from './shared';
import type { AdminEvent } from './shared';

interface Props {
  events: AdminEvent[];
  /** False until the first list has arrived; the table stays empty till then. */
  loaded: boolean;
}

export function AuditEvents({ events, loaded }: Props) {
  const { t, tx, tierLabel, formatDate } = useAdminText();

  const describe = (state: unknown): string => {
    if (!state || typeof state !== 'object') return '';
    const record = state as Record<string, unknown>;
    const parts = [tierLabel(record.access_tier)];
    if (typeof record.org_unit === 'string' && record.org_unit) parts.push(record.org_unit);
    if (record.is_active === false) parts.push(t('admin.statusInactive'));
    return parts.join(' · ');
  };

  const eventChange = (event: AdminEvent): string => {
    const detail = event.detail ?? {};
    if (event.action === 'account_updated') {
      return `${describe(detail.before)} → ${describe(detail.after)}`;
    }
    if (event.action === 'account_created') {
      return describe(detail);
    }
    return '—';
  };

  return (
    <section className="panel admin-section" id="admin-events" aria-labelledby="admin-events-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="admin-events-title">
            {t('admin.eventsTitle')}
          </h2>
          <p className="panel-desc">{t('admin.eventsLead')}</p>
        </div>
      </div>
      <div className="admin-table-wrapper">
        <table className="review-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.colWhen')}</th>
              <th scope="col">{t('admin.colActor')}</th>
              <th scope="col">{t('admin.colAction')}</th>
              <th scope="col">{t('admin.colAccount')}</th>
              <th scope="col">{t('admin.colChange')}</th>
            </tr>
          </thead>
          <tbody id="events-tbody">
            {!loaded ? null : events.length === 0 ? (
              <tr>
                <td colSpan={5} className="review-empty-state">
                  {t('admin.noEvents')}
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.eventId}>
                  <td>{formatDate(event.occurredAt)}</td>
                  <td>{event.actorName || t('admin.actorHost')}</td>
                  <td>{tx(`admin.action.${event.action}`)}</td>
                  <td>{event.targetName || '—'}</td>
                  <td>{eventChange(event)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

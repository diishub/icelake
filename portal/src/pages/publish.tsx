/*
 * Dataset releases: an analyst asks for a curated table to be published, the
 * data owner for its org unit (or a developer or admin) approves or rejects it, and
 * psu-auth copies it into polaris.published. See
 * config/platform/021-dataset-release.sql.
 *
 * Every rule that matters -- who may ask, who may decide, that nobody decides
 * their own request -- is enforced by psu-auth and the database. This page only
 * shows the buttons the server says apply (release.canDecide, canRequest).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DetailModal } from '@/components/publish/DetailModal';
import { RequestModal } from '@/components/publish/RequestModal';
import { CLOSED, OPEN, StatusBadge, hasServerCode, usePublishFormat } from '@/components/publish/shared';
import type { Alert, Release, ReleasePreview } from '@/components/publish/shared';
import { RequireTier } from '@/components/RequireTier';
import { WorkspaceLayout } from '@/components/WorkspaceLayout';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

// An approved release is copying in the background; poll until it settles.
const POLL_MS = 4000;

type Filter = 'open' | 'published' | 'closed' | 'all';

const TABS: { filter: Filter; label: MessageKey }[] = [
  { filter: 'open', label: 'publish.tabOpen' },
  { filter: 'published', label: 'publish.tabPublished' },
  { filter: 'closed', label: 'publish.tabClosed' },
  { filter: 'all', label: 'review.tabAll' },
];

interface ReleaseList {
  releases?: unknown;
  canRequest?: unknown;
}

function PublishWorkspace() {
  const { t } = useI18n();
  const { errorMessage, formatDate, releaseTitle } = usePublishFormat();

  // null until the first answer from /auth/releases.
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [canRequest, setCanRequest] = useState(false);
  const [filter, setFilter] = useState<Filter>('open');

  const [requestOpen, setRequestOpen] = useState(false);
  const [active, setActive] = useState<Release | null>(null);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [detailAlert, setDetailAlert] = useState<Alert | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decisionCount, setDecisionCount] = useState(0);
  // Which release the detail modal shows, for answers that arrive after it changed.
  const activeId = useRef<string | null>(null);

  const loadReleases = useCallback(async () => {
    let body: ReleaseList;
    try {
      body = await api<ReleaseList>('GET', '/auth/releases');
    } catch (error) {
      // A code from psu-auth gets its sentence; no answer at all is "service unavailable".
      setListError(hasServerCode(error) ? errorMessage(error.code) : t('login.serviceUnavailable'));
      return;
    }
    const next = Array.isArray(body.releases) ? (body.releases as Release[]) : [];
    setListError(null);
    setReleases(next);
    setCanRequest(Boolean(body.canRequest));
    setActive((current) => {
      if (!current) return current;
      return next.find((r) => r.releaseId === current.releaseId) ?? current;
    });
  }, [errorMessage, t]);

  useEffect(() => {
    void loadReleases();
    // First load only: loadReleases changes with the language, which must not
    // refetch. The refresh button, decisions and the poll call it again.
  }, []);

  useEffect(() => {
    if (!releases?.some((r) => r.status === 'approved')) return undefined;
    const timer = window.setTimeout(() => void loadReleases(), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [releases, loadReleases]);

  const closeModals = useCallback(() => {
    setRequestOpen(false);
    setActive(null);
    setPreview(null);
    activeId.current = null;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeModals();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeModals]);

  async function openDetail(release: Release) {
    const releaseId = release.releaseId;
    activeId.current = releaseId;
    setActive(release);
    setPreview(null);
    setDetailAlert(null);
    setPreviewLoading(true);
    try {
      const body = await api<{ release?: Release; preview?: ReleasePreview | null }>(
        'GET',
        `/auth/releases/${encodeURIComponent(releaseId)}/preview`,
      );
      if (activeId.current !== releaseId) return;
      if (body.release) setActive(body.release);
      setPreview(body.preview ?? null);
    } catch (error) {
      if (activeId.current === releaseId) {
        setDetailAlert({ message: errorMessage(error instanceof ApiError ? error.code : 'network_error'), kind: 'error' });
      }
    } finally {
      if (activeId.current === releaseId) setPreviewLoading(false);
    }
  }

  async function decide(action: 'approve' | 'reject', payload: Record<string, unknown> = {}) {
    if (!active) return;
    const releaseId = active.releaseId;
    setDeciding(true);
    try {
      const body = await api<{ release?: Release }>(
        'POST',
        `/auth/releases/${encodeURIComponent(releaseId)}/${action}`,
        payload,
      );
      setDecisionCount((n) => n + 1);
      setDetailAlert({
        message: t(action === 'approve' ? 'publish.approvedNotice' : 'publish.rejectedNotice'),
        kind: 'success',
      });
      if (body.release && activeId.current === releaseId) setActive(body.release);
      await loadReleases();
    } catch (error) {
      if (error instanceof ApiError && error.status !== 0) {
        setDetailAlert({ message: errorMessage(error.code), kind: 'error' });
      } else {
        setDetailAlert({ message: t('login.serviceUnavailable'), kind: 'error' });
      }
    } finally {
      setDeciding(false);
    }
  }

  function onRequestSubmitted() {
    closeModals();
    setFilter('open');
    void loadReleases();
  }

  const all = releases ?? [];
  const count = (statuses: string[]) => all.filter((r) => statuses.includes(r.status)).length;
  const rows =
    filter === 'open'
      ? all.filter((r) => OPEN.includes(r.status))
      : filter === 'published'
        ? all.filter((r) => r.status === 'published')
        : filter === 'closed'
          ? all.filter((r) => CLOSED.includes(r.status))
          : all;

  function renderList() {
    if (listError !== null) {
      return <p className="review-empty-state text-critical">{listError}</p>;
    }
    if (releases === null) {
      return <p className="review-empty-state">{t('review.loading')}</p>;
    }
    if (rows.length === 0) {
      return <p className="review-empty-state">{t('publish.emptyList')}</p>;
    }
    return (
      <table className="review-table">
        <thead>
          <tr>
            <th>{t('publish.colDataset')}</th>
            <th>{t('review.colOrgUnit')}</th>
            <th>{t('publish.colRequester')}</th>
            <th>{t('publish.colRequestedAt')}</th>
            <th>{t('review.colStatus')}</th>
            <th>{t('review.colAction')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr className="review-table-row" key={r.releaseId}>
              <td>
                <div className="file-name-info">
                  <strong className="upload-filename">{releaseTitle(r)}</strong>
                  <small className="upload-size">
                    <code>published.{r.tableName}</code> · v{r.version}
                  </small>
                </div>
              </td>
              <td>
                <code>{r.ownerOrgUnit}</code>
              </td>
              <td>{r.requestedByName || '—'}</td>
              <td>{formatDate(r.requestedAt)}</td>
              <td>
                <StatusBadge release={r} />
              </td>
              <td>
                <button
                  className={`button ${r.canDecide ? 'button-primary' : 'button-ghost'} button-small`}
                  type="button"
                  onClick={() => void openDetail(r)}
                >
                  {t(r.canDecide ? 'review.btnReview' : 'review.btnView')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="breadcrumb">
            <span>{t('ws.breadcrumb')}</span> / <span>{t('ws.publish')}</span>
          </p>
          <h1 className="page-title">{t('publish.heading')}</h1>
          <p className="page-lead">{t('publish.subheading')}</p>
        </div>
        <div className="page-actions">
          <button className="button button-ghost" type="button" onClick={() => void loadReleases()}>
            {t('review.refresh')}
          </button>
          {canRequest ? (
            <button className="button button-primary" type="button" onClick={() => setRequestOpen(true)}>
              {t('publish.newRequest')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="review-stats-grid">
        <div className="review-stat-card">
          <span className="review-stat-label">{t('publish.tabOpen')}</span>
          <strong className="review-stat-value text-caution">{count(OPEN)}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('publish.tabPublished')}</span>
          <strong className="review-stat-value text-positive">{count(['published'])}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('publish.tabClosed')}</span>
          <strong className="review-stat-value text-critical">{count(CLOSED)}</strong>
        </div>
        <div className="review-stat-card">
          <span className="review-stat-label">{t('review.tabAll')}</span>
          <strong className="review-stat-value">{all.length}</strong>
        </div>
      </div>

      <div className="review-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.filter}
            className={`review-tab${filter === tab.filter ? ' is-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={filter === tab.filter}
            onClick={() => setFilter(tab.filter)}
          >
            {tab.filter === 'open' ? (
              <>
                <span>{t(tab.label)}</span>
                <span className="review-badge-counter">{count(OPEN)}</span>
              </>
            ) : (
              t(tab.label)
            )}
          </button>
        ))}
      </div>

      <div className="review-table-wrapper" role="region" aria-live="polite">
        <div className="review-list-container">{renderList()}</div>
      </div>

      {requestOpen ? <RequestModal onClose={closeModals} onSubmitted={onRequestSubmitted} /> : null}
      {active ? (
        <DetailModal
          key={active.releaseId}
          release={active}
          preview={preview}
          loading={previewLoading}
          alert={detailAlert}
          deciding={deciding}
          decisionCount={decisionCount}
          onClose={closeModals}
          onApprove={() => void decide('approve')}
          onReject={(reason) => void decide('reject', { reason })}
          onAlert={setDetailAlert}
        />
      ) : null}
    </>
  );
}

export default function PublishPage() {
  return (
    <WorkspaceLayout page="publish" title="ws.publish" mainId="publish-main">
      <RequireTier page="publish" forbidden="publish.forbidden" checking="review.checking">
        {() => <PublishWorkspace />}
      </RequireTier>
    </WorkspaceLayout>
  );
}

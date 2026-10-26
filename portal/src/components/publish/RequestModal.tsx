import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/i18n';
import { FeedbackAlert, hasServerCode, usePublishFormat } from './shared';
import type { Alert } from './shared';

interface Props {
  onClose: () => void;
  /** Called after psu-auth accepted the request. */
  onSubmitted: () => void;
}

const EMPTY_FORM = {
  table: '',
  titleTh: '',
  titleEn: '',
  descriptionTh: '',
  descriptionEn: '',
  owner: '',
  domain: '',
  access: 'university',
  cadence: 'manual',
  tags: '',
  changelog: '',
};
type FormState = typeof EMPTY_FORM;

const ORG_UNIT = /^[a-z0-9_-]{1,64}$/;

/** New release request. Mounted fresh each time it opens, so the form starts empty. */
export function RequestModal({ onClose, onSubmitted }: Props) {
  const { t } = useI18n();
  const { errorMessage } = usePublishFormat();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // null while /auth/releases/sources is answering; [] with sourcesFailed when it refused.
  const [tables, setTables] = useState<string[] | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const [alert, setAlert] = useState<Alert | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ tables?: unknown }>('GET', '/auth/releases/sources')
      .then((body) => {
        if (cancelled) return;
        setTables(Array.isArray(body.tables) ? body.tables.map(String) : []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTables([]);
        setSourcesFailed(true);
        setAlert({ message: errorMessage(hasServerCode(error) ? error.code : 'trino_unavailable'), kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // Only on open: errorMessage changes with the language, and that must not
    // ask for the sources again.
  }, []);

  const field = (name: keyof FormState) => ({
    value: form[name],
    onChange: (event: { target: { value: string } }) => {
      const value = event.target.value;
      setForm((current) => ({ ...current, [name]: value }));
    },
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = (name: keyof FormState) => form[name].trim();
    const payload = {
      tableName: value('table'),
      titleTh: value('titleTh'),
      titleEn: value('titleEn') || null,
      descriptionTh: value('descriptionTh') || null,
      descriptionEn: value('descriptionEn') || null,
      ownerOrgUnit: value('owner').toLowerCase(),
      domain: value('domain') || null,
      accessLevel: value('access'),
      refreshCadence: value('cadence'),
      tags: value('tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      changelog: value('changelog') || null,
    };
    if (!payload.tableName) return setAlert({ message: errorMessage('invalid_table_name'), kind: 'error' });
    if (!payload.titleTh) return setAlert({ message: errorMessage('title_required'), kind: 'error' });
    if (!ORG_UNIT.test(payload.ownerOrgUnit)) {
      return setAlert({ message: errorMessage('invalid_owner_org_unit'), kind: 'error' });
    }

    setSubmitting(true);
    try {
      await api('POST', '/auth/releases', payload);
      onSubmitted();
    } catch (error) {
      if (error instanceof ApiError && error.status !== 0) {
        setAlert({ message: errorMessage(error.code), kind: 'error' });
      } else {
        setAlert({ message: t('login.serviceUnavailable'), kind: 'error' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="review-modal-backdrop">
      <form
        className="review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-heading"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <header className="review-modal-header">
          <div>
            <h2 className="review-modal-title" id="request-heading">
              {t('publish.requestTitle')}
            </h2>
            <p className="review-modal-subtitle">{t('publish.requestSubtitle')}</p>
          </div>
          <button className="review-modal-close" type="button" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </header>

        <div className="review-modal-body">
          <FeedbackAlert alert={alert} />

          <div className="publish-form-grid">
            <div className="upload-input-group publish-span-2">
              <label htmlFor="request-table">{t('publish.fieldTable')}</label>
              <select id="request-table" className="publish-input" required {...field('table')}>
                {tables === null ? (
                  <option value="">{t('review.loading')}</option>
                ) : sourcesFailed ? null : (
                  <>
                    <option value="">{t(tables.length ? 'publish.chooseTable' : 'publish.noCuratedTables')}</option>
                    {tables.map((name) => (
                      <option key={name} value={name}>
                        curated.{name}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-title-th">{t('publish.fieldTitleTh')}</label>
              <input id="request-title-th" className="publish-input" type="text" maxLength={200} required {...field('titleTh')} />
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-title-en">{t('publish.fieldTitleEn')}</label>
              <input id="request-title-en" className="publish-input" type="text" maxLength={200} {...field('titleEn')} />
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-description-th">{t('publish.fieldDescriptionTh')}</label>
              <textarea
                id="request-description-th"
                className="upload-note-textarea"
                rows={3}
                maxLength={2000}
                {...field('descriptionTh')}
              />
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-description-en">{t('publish.fieldDescriptionEn')}</label>
              <textarea
                id="request-description-en"
                className="upload-note-textarea"
                rows={3}
                maxLength={2000}
                {...field('descriptionEn')}
              />
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-owner">{t('publish.fieldOwner')}</label>
              <input
                id="request-owner"
                className="publish-input"
                type="text"
                maxLength={64}
                pattern="^[a-z0-9_-]{1,64}$"
                placeholder="eng"
                required
                {...field('owner')}
              />
              <p className="input-hint-text">{t('publish.fieldOwnerHint')}</p>
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-domain">{t('publish.fieldDomain')}</label>
              <select id="request-domain" className="publish-input" {...field('domain')}>
                <option value="">{t('publish.domainNone')}</option>
                <option value="student">{t('publish.domain.student')}</option>
                <option value="personnel">{t('publish.domain.personnel')}</option>
                <option value="research">{t('publish.domain.research')}</option>
                <option value="academic_services">{t('publish.domain.academic_services')}</option>
                <option value="indicator">{t('publish.domain.indicator')}</option>
              </select>
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-access">{t('publish.fieldAccess')}</label>
              <select id="request-access" className="publish-input" {...field('access')}>
                <option value="university">{t('publish.access.university')}</option>
                <option value="restricted">{t('publish.access.restricted')}</option>
              </select>
            </div>
            <div className="upload-input-group">
              <label htmlFor="request-cadence">{t('publish.fieldCadence')}</label>
              <select id="request-cadence" className="publish-input" {...field('cadence')}>
                <option value="manual">{t('publish.cadence.manual')}</option>
                <option value="daily">{t('publish.cadence.daily')}</option>
                <option value="weekly">{t('publish.cadence.weekly')}</option>
                <option value="monthly">{t('publish.cadence.monthly')}</option>
              </select>
            </div>
            <div className="upload-input-group publish-span-2">
              <label htmlFor="request-tags">{t('publish.fieldTags')}</label>
              <input id="request-tags" className="publish-input" type="text" maxLength={440} {...field('tags')} />
            </div>
            <div className="upload-input-group publish-span-2">
              <label htmlFor="request-changelog">{t('publish.fieldChangelog')}</label>
              <textarea
                id="request-changelog"
                className="upload-note-textarea"
                rows={2}
                maxLength={2000}
                {...field('changelog')}
              />
            </div>
          </div>
        </div>

        <footer className="review-modal-footer">
          <div className="footer-left">
            <button className="button button-ghost" type="button" onClick={onClose}>
              {t('review.btnClose')}
            </button>
          </div>
          <div className="footer-actions">
            <button className="button button-positive" type="submit" disabled={submitting}>
              {t('publish.submitRequest')}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

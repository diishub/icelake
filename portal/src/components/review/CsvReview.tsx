import { useI18n } from '@/i18n';
import { ALLOWED_TYPES, CLASSIFICATIONS, isClassification } from './shared';
import type { ColumnState, ReviewPreview } from './shared';

interface TableConfigProps {
  orgUnit: string;
  suffix: string;
  onSuffix: (value: string) => void;
}

/** Target Iceberg table name: fixed per-org prefix plus a reviewer-chosen suffix. */
export function TableConfig({ orgUnit, suffix, onSuffix }: TableConfigProps) {
  const { t } = useI18n();
  const val = suffix.trim().toLowerCase();
  return (
    <section className="modal-section">
      <h3 className="modal-section-title">{t('review.sectionTableConfig')}</h3>
      <div className="target-table-form">
        <label htmlFor="review-table-suffix">{t('review.tablePrefixLabel')}</label>
        <div className="target-table-input-group">
          <span className="target-table-prefix">{`polaris.raw.steward_${orgUnit}_`}</span>
          <input
            type="text"
            id="review-table-suffix"
            className="target-table-input"
            pattern="^[a-z][a-z0-9_]*$"
            placeholder={t('review.tableSuffixPlaceholder')}
            required
            value={suffix}
            onChange={(event) => onSuffix(event.target.value)}
          />
        </div>
        <small className="target-table-hint">
          <span>{t('review.tablePrefixLabel')}</span>{' '}
          <code>{`polaris.raw."steward_${orgUnit}_${val || '...'}"`}</code>{' '}
          <span>{t('review.tableSuffixRule')}</span>
        </small>
      </div>
    </section>
  );
}

interface ColumnsProps {
  columns: ColumnState[];
  sampleRows: string[][];
  onChange: (index: number, patch: Partial<ColumnState>) => void;
}

/** Per-column SQL name, type and classification. Only public columns reach Iceberg. */
export function ColumnClassification({ columns, sampleRows, onChange }: ColumnsProps) {
  const { t } = useI18n();
  const publicCount = columns.filter((c) => c.classification === 'public').length;
  const firstRow = sampleRows[0];

  return (
    <section className="modal-section">
      <div className="section-title-flex">
        <h3 className="modal-section-title">{t('review.sectionColumns')}</h3>
        <div className="column-summary-pills">
          <span className="summary-pill pill-included">
            <span>{t('review.summaryIncluded')}</span> <strong>{publicCount}</strong>
          </span>
          <span className="summary-pill pill-excluded">
            <span>{t('review.summaryExcluded')}</span> <strong>{columns.length - publicCount}</strong>
          </span>
        </div>
      </div>

      {publicCount === 0 ? <div className="guardrail-alert">{t('review.guardrailWarning')}</div> : null}

      <div className="columns-table-wrapper">
        <table className="columns-table">
          <thead>
            <tr>
              <th>{t('review.columnColName')}</th>
              <th>{t('review.columnOriginalName')}</th>
              <th>{t('review.columnType')}</th>
              <th>{t('review.columnClassification')}</th>
              <th>{t('review.columnSample')}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, idx) => (
              <tr key={idx}>
                <td>
                  <input
                    type="text"
                    className="column-name-input"
                    pattern="^[a-z][a-z0-9_]*$"
                    required
                    aria-label={`${t('review.columnColName')} ${col.originalName}`}
                    value={col.raw}
                    onChange={(event) =>
                      onChange(idx, { raw: event.target.value, name: event.target.value.trim().toLowerCase() })
                    }
                  />
                </td>
                <td>
                  <span className="original-header-label">{col.originalName}</span>
                </td>
                <td>
                  <select
                    className="column-type-select"
                    aria-label={`${t('review.columnType')} ${col.originalName}`}
                    value={col.type}
                    onChange={(event) => onChange(idx, { type: event.target.value })}
                  >
                    {ALLOWED_TYPES.map((ty) => (
                      <option key={ty} value={ty}>
                        {ty}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className={`column-class-select classification-${col.classification}`}
                    aria-label={`${t('review.columnClassification')} ${col.originalName}`}
                    value={col.classification}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (isClassification(value)) onChange(idx, { classification: value });
                    }}
                  >
                    {CLASSIFICATIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {t(c.label)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <code className="sample-value-cell">{firstRow?.[idx] ?? ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** First sample rows of the CSV, as psu-auth parsed them. */
export function SampleGrid({ preview }: { preview: ReviewPreview | null }) {
  const { t } = useI18n();
  const columns = preview?.columns ?? [];
  const rows = preview?.sampleRows ?? [];
  return (
    <section className="modal-section">
      <h3 className="modal-section-title">{t('review.sectionDataPreview')}</h3>
      <div className="sample-grid-wrapper">
        <table className="sample-grid-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent, MouseEvent } from 'react';
import { signInHref } from '@/lib/auth';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { formatBytes } from './types';

const NOTE_MAX = 1000;
// Same shape psu-auth holds the org unit to (ORG_UNIT in services/auth/src/server.ts).
const ORG_UNIT = /^[a-z0-9_-]{1,64}$/;

// Mirrors psu-auth's own checks (UPLOAD_MAX_BYTES and the extension test in
// services/auth/src/server.ts handleUpload) so a wrong file is refused before
// it is sent. UX only: the server checks again and is the real gate.
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.csv', '.pdf', '.docx'];

interface Props {
  /** Called after a successful submission so the history picks it up. */
  onUploaded: () => void;
}

export function UploadForm({ onUploaded }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  // Kept after a successful submission: the next file is usually from the same unit.
  const [orgUnit, setOrgUnit] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (error) {
      errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [error]);

  useEffect(() => {
    if (success) {
      successRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [success]);

  function selectFile(next: File | null) {
    setError(null);
    setFile(next);
  }

  function clearSelectedFile() {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setFile(null);
  }

  function openPicker() {
    fileInputRef.current?.click();
  }

  function onDropzoneClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // The remove button and the native input's own click (from openPicker)
    // bubble up here; neither should reopen the picker.
    if (target.closest('.selected-file-remove') || target === fileInputRef.current) {
      return;
    }
    openPicker();
  }

  function onDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    const dropped = event.dataTransfer?.files;
    if (dropped && dropped.length > 0) {
      if (fileInputRef.current) {
        fileInputRef.current.files = dropped;
      }
      selectFile(dropped[0] ?? null);
    } else {
      setError(null);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    const unit = orgUnit.trim().toLowerCase();
    if (!ORG_UNIT.test(unit)) {
      setError('upload.errorOrgUnit');
      return;
    }
    if (!file) {
      setError('upload.errorNoFile');
      return;
    }
    const lowerName = file.name.toLowerCase();
    if (!ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
      setError('upload.errorWrongType');
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setError('upload.errorTooLarge');
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      // Before the file: psu-auth reads fields as they arrive.
      formData.append('orgUnit', unit);
      formData.append('file', file);
      if (note.trim()) {
        formData.append('note', note.trim());
      }
      const response = await fetch('/auth/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        body: formData,
      });

      if (response.ok) {
        setSuccess(true);
        setNote('');
        clearSelectedFile();
        onUploaded();
        return;
      }

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 401) {
        void router.replace(signInHref('/upload'));
      } else if (response.status === 403) {
        setError('upload.forbidden');
      } else if (response.status === 413) {
        setError('upload.errorTooLarge');
      } else if (response.status === 400 && body.error === 'unsupported_file_type') {
        setError('upload.errorWrongType');
      } else if (response.status === 400 && body.error === 'invalid_org_unit') {
        setError('upload.errorOrgUnit');
      } else if (response.status === 503) {
        setError('upload.notConfigured');
      } else {
        setError('upload.errorGeneric');
      }
    } catch {
      setError('login.serviceUnavailable');
    } finally {
      setSubmitting(false);
    }
  }

  const ext = file ? (file.name.split('.').pop() || 'file').toUpperCase() : '';

  return (
    <section className="panel upload-form-panel" aria-labelledby="upload-form-title">
      <div className="panel-head">
        <h2 className="panel-title" id="upload-form-title">
          {t('upload.panelUploadTitle')}
        </h2>
      </div>
      <form className="panel-body upload-form" id="upload-form" noValidate onSubmit={onSubmit}>
        {error ? (
          <p className="login-error" id="upload-error" role="alert" ref={errorRef}>
            {t(error)}
          </p>
        ) : null}
        {success ? (
          <div className="upload-success-banner" id="upload-success" role="status" ref={successRef}>
            <strong>{t('upload.success')}</strong>
            <span>{t('upload.successDetail')}</span>
          </div>
        ) : null}

        <div className="field">
          <label className="field-label" htmlFor="upload-org-unit">
            {t('upload.orgUnitLabel')}
          </label>
          <input
            id="upload-org-unit"
            name="orgUnit"
            className="publish-input"
            type="text"
            maxLength={64}
            pattern="^[a-z0-9_-]{1,64}$"
            placeholder="eng"
            required
            value={orgUnit}
            onChange={(event) => setOrgUnit(event.target.value)}
          />
          <p className="input-hint-text">{t('upload.orgUnitHint')}</p>
        </div>

        <div className="field">
          <span className="field-label">{t('upload.fileLabel')}</span>
          <div
            className={`upload-dropzone${dragOver ? ' is-dragover' : ''}`}
            id="upload-dropzone"
            tabIndex={0}
            role="button"
            aria-label={t('upload.dropzoneLabel')}
            onClick={onDropzoneClick}
            onKeyDown={onDropzoneKeyDown}
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDragEnd={onDragLeave}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              id="upload-file"
              name="file"
              accept=".csv,.pdf,.docx,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              required
              className="dropzone-native-input"
              tabIndex={-1}
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
            />
            {file ? (
              <div className="dropzone-selected-content" id="dropzone-selected-file">
                <div className="selected-file-details">
                  <span className={`selected-file-icon icon-${ext.toLowerCase()}`} id="preview-file-icon">
                    {ext}
                  </span>
                  <span className="selected-file-text">
                    <strong className="selected-filename" id="preview-filename">
                      {file.name}
                    </strong>
                    <span className="selected-filesize" id="preview-filesize">
                      {formatBytes(file.size)}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  className="selected-file-remove"
                  id="btn-remove-file"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearSelectedFile();
                  }}
                >
                  {t('upload.removeFile')}
                </button>
              </div>
            ) : (
              <div className="dropzone-idle-content" id="dropzone-idle">
                <svg
                  className="dropzone-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                  <path d="M12 17v-6" />
                  <path d="m9.5 13.5 2.5-2.5 2.5 2.5" />
                </svg>
                <p className="dropzone-prompt">
                  <span>{t('upload.dragDropPrompt')}</span>{' '}
                  <span className="dropzone-highlight-btn">{t('upload.browseText')}</span>
                </p>
                <span className="format-size-limit">{t('upload.maxSizeLimit')}</span>
              </div>
            )}
          </div>
        </div>

        <div className="field">
          <div className="input-label-container">
            <label htmlFor="upload-note">{t('upload.noteLabel')}</label>
            <span className="char-counter" id="note-char-count">
              {note.length} / {NOTE_MAX}
            </span>
          </div>
          <textarea
            id="upload-note"
            name="note"
            rows={4}
            maxLength={NOTE_MAX}
            className="upload-note-textarea"
            placeholder={t('upload.notePlaceholder')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="input-hint-text">{t('upload.noteTip')}</p>
        </div>

        <button className="button button-primary" type="submit" id="upload-submit" disabled={submitting}>
          <span id="upload-submit-label">{submitting ? t('upload.submitting') : t('upload.submit')}</span>
        </button>

        <div className="notice">
          <strong>{t('upload.policyTitle')}</strong>
          <span>{t('upload.note')}</span>
        </div>
      </form>
    </section>
  );
}

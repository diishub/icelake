import { useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useI18n } from '@/i18n';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { id: string };

/**
 * A password field with a show/hide button. The button only switches the
 * input's type; the value never leaves the input. Give it a new `key` to start
 * hidden again, e.g. when a modal reopens.
 */
export function PasswordInput(props: Props) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const label = t(shown ? 'password.hide' : 'password.show');
  return (
    <span className="password-field">
      <input {...props} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="password-toggle"
        aria-controls={props.id}
        aria-pressed={shown}
        aria-label={label}
        title={label}
        onClick={() => setShown((value) => !value)}
      >
        <svg
          className="password-toggle-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {shown ? (
            <>
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
              <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </>
          ) : (
            <>
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </span>
  );
}

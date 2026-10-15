import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';

/** "Copy" button that says "Copied" for two seconds after a successful copy. */
export function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    // Without the Clipboard API (plain http, old browser) the button does nothing,
    // as in the old portal.
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button className="button button-ghost button-small" type="button" onClick={() => void copy()}>
      {t(copied ? 'review.textCopied' : 'review.copyText')}
    </button>
  );
}

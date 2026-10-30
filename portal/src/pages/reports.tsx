/*
 * Dedicated report page for viewer/analyst/admin accounts --
 * embeds a live Superset dashboard via a guest token (services/auth's
 * /auth/embeds/<key>), so seeing real data never requires a second Superset
 * login. Gated client-side for UX only; the real gate is server-side in
 * services/auth/src/server.ts's embedDashboard(), which checks the session
 * and accessTier itself.
 */
import { useEffect, useRef, useState } from 'react';
import { RequireTier } from '@/components/RequireTier';
import { WorkspaceLayout } from '@/components/WorkspaceLayout';
import { buildServiceUrl, usePortalConfig, usePortalConfigLoaded } from '@/lib/config';
import { useI18n } from '@/i18n';

interface EmbedGuestToken {
  dashboardEmbedUuid: string;
  supersetOrigin: string;
  guestToken: string;
}

interface SupersetEmbeddedSdk {
  embedDashboard(options: {
    id: string;
    supersetDomain: string;
    mountPoint: HTMLElement;
    fetchGuestToken: () => Promise<string>;
    dashboardUiConfig?: Record<string, unknown>;
  }): Promise<unknown>;
}

declare global {
  interface Window {
    supersetEmbeddedSdk?: SupersetEmbeddedSdk;
  }
}

const SDK_SRC = '/vendor/superset-embedded-sdk.js';
let sdkPromise: Promise<SupersetEmbeddedSdk> | null = null;

/**
 * The SDK is a static file served from 'self' (the CSP allows nothing else),
 * added once per tab and only on this page.
 */
function loadSdk(): Promise<SupersetEmbeddedSdk> {
  if (window.supersetEmbeddedSdk) {
    return Promise.resolve(window.supersetEmbeddedSdk);
  }
  if (!sdkPromise) {
    sdkPromise = new Promise<SupersetEmbeddedSdk>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_SRC;
      script.async = true;
      script.addEventListener('load', () => {
        if (window.supersetEmbeddedSdk) {
          resolve(window.supersetEmbeddedSdk);
        } else {
          reject(new Error('embedded SDK did not load'));
        }
      });
      script.addEventListener('error', () => reject(new Error('embedded SDK did not load')));
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      // Let a later visit to the page try again.
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}

async function fetchEmbedGuestToken(key: string): Promise<EmbedGuestToken> {
  const response = await fetch(`/auth/embeds/${encodeURIComponent(key)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`embeds/${key} returned ${response.status}`);
  }
  return (await response.json()) as EmbedGuestToken;
}

function EmbeddedDashboard({ dashboardKey }: { dashboardKey: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'loading' | 'mounted' | 'error'>('loading');
  const mountRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  // Read when the SDK asks for a fresh token, so it follows the latest config.
  const keyRef = useRef(dashboardKey);
  useEffect(() => {
    keyRef.current = dashboardKey;
  }, [dashboardKey]);

  useEffect(() => {
    const mount = mountRef.current;
    // Embedding twice would stack two iframes (StrictMode runs effects twice).
    if (!mount || startedRef.current) {
      return;
    }
    startedRef.current = true;
    (async () => {
      try {
        const [first, sdk] = await Promise.all([fetchEmbedGuestToken(keyRef.current), loadSdk()]);
        setState('mounted');
        await sdk.embedDashboard({
          id: first.dashboardEmbedUuid,
          supersetDomain: first.supersetOrigin,
          mountPoint: mount,
          // Called again by the SDK as the short-lived token nears expiry.
          fetchGuestToken: async () => (await fetchEmbedGuestToken(keyRef.current)).guestToken,
          dashboardUiConfig: {
            hideTitle: true,
            hideTab: true,
            hideChartControls: true,
            filters: { visible: false },
          },
        });
      } catch {
        setState('error');
      }
    })();
  }, []);

  return (
    <section className="panel reports-panel">
      <p className="panel-body embedded-dashboard-status" hidden={state === 'mounted'}>
        {t(state === 'error' ? 'embed.error' : 'embed.loading')}
      </p>
      <div className="embedded-dashboard-mount" ref={mountRef} />
    </section>
  );
}

export default function ReportsPage() {
  const { t } = useI18n();
  const config = usePortalConfig();
  const configLoaded = usePortalConfigLoaded();

  const breadcrumb = (
    <p className="breadcrumb">
      <span>{t('ws.breadcrumb')}</span> / <span>{t('ws.reports')}</span>
    </p>
  );

  return (
    <WorkspaceLayout page="reports" title="ws.reports" mainId="reports-main">
      <RequireTier
        page="reports"
        checking="reports.checking"
        forbidden={
          <div className="page-head">
            <div>
              {breadcrumb}
              <h1 className="page-title">{t('reports.forbiddenHeading')}</h1>
              <p className="page-lead">{t('reports.forbiddenDetail')}</p>
            </div>
          </div>
        }
      >
        {() => (
          <>
            <div className="page-head">
              <div>
                {breadcrumb}
                <h1 className="page-title">{t('reports.heading')}</h1>
                <p className="page-lead">{t('reports.lead')}</p>
              </div>
              <div className="page-actions">
                <a className="button button-ghost" href={buildServiceUrl(config, 'reports') ?? '#help'}>
                  {t('embed.openInSuperset')}
                </a>
              </div>
            </div>

            {/* Waits for config.json so the first embed uses the deployment's key.
                No key means no dashboard has been chosen for this page yet. */}
            {configLoaded && config.embeddedDashboardKey ? (
              <EmbeddedDashboard dashboardKey={config.embeddedDashboardKey} />
            ) : configLoaded ? (
              <section className="panel reports-panel">
                <p className="panel-body embedded-dashboard-status">{t('reports.noDashboard')}</p>
              </section>
            ) : (
              <section className="panel reports-panel">
                <p className="panel-body embedded-dashboard-status">{t('embed.loading')}</p>
              </section>
            )}
          </>
        )}
      </RequireTier>
    </WorkspaceLayout>
  );
}

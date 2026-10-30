import { useEffect, useState } from 'react';
import { buildServiceUrl, usePortalConfig } from '@/lib/config';
import type { ServiceName } from '@/lib/config';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

const TOOLS: { service: ServiceName; title: MessageKey; detail: MessageKey }[] = [
  { service: 'ingestion', title: 'operator.ingestion', detail: 'operator.ingestionDetail' },
  { service: 'query', title: 'operator.query', detail: 'operator.queryDetail' },
  { service: 'vectors', title: 'operator.vectors', detail: 'operator.vectorsDetail' },
  { service: 'storage', title: 'operator.storage', detail: 'operator.storageDetail' },
  { service: 'users', title: 'operator.users', detail: 'operator.usersDetail' },
];

// The tools listen on the host only (README: SSH tunnel is the access path),
// so a link built from any other hostname would point at nothing.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalHost(): boolean {
  const { hostname } = window.location;
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

export function AdminTools() {
  const { t } = useI18n();
  const config = usePortalConfig();
  // Null until mounted: the prerendered page cannot know where it is opened.
  const [local, setLocal] = useState<boolean | null>(null);

  useEffect(() => {
    setLocal(isLocalHost());
  }, []);

  return (
    <section className="panel admin-section" id="admin-tools" aria-labelledby="admin-tools-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="admin-tools-title">
            {t('admin.toolsTitle')}
          </h2>
          <p className="panel-desc">{t('admin.toolsLead')}</p>
        </div>
      </div>
      <div className="panel-body">
        {local === false ? <p className="login-note login-note-warning">{t('admin.hostNotice')}</p> : null}
        <div className="operator-grid">
          {TOOLS.map((tool) => {
            // A service marked public is fronted by the proxy on this same host
            // name, so its link works wherever the page was opened.
            const reachable = local || (local === false && config.services?.[tool.service]?.public === true);
            const url = reachable ? buildServiceUrl(config, tool.service) : null;
            const body = (
              <>
                <strong>{t(tool.title)}</strong>
                <span>{t(tool.detail)}</span>
              </>
            );
            return url ? (
              <a key={tool.service} href={url} target="_blank" rel="noopener">
                {body}
              </a>
            ) : (
              <a key={tool.service} aria-disabled="true">
                {body}
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}

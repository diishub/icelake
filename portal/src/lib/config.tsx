/*
 * Deployment-facing settings from /config.json (public/config.json). Fetched
 * at run time rather than compiled in, so a deployment can change the copy or
 * a service port by editing that file and reloading -- no rebuild.
 *
 * Never put a credential here: every browser that opens the portal reads it.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Language } from '@/i18n';

export type LocalizedText = string | Partial<Record<Language, string>>;

export interface ServiceLink {
  port: string;
  protocol: 'http:' | 'https:';
  path: string;
}

export type ServiceName = 'reports' | 'analytics' | 'users' | 'ingestion' | 'query' | 'vectors' | 'storage';

export interface PortalConfig {
  pilotLabel?: LocalizedText;
  publishedReportsReady?: boolean;
  embeddedDashboardKey?: string;
  publishedStateMessage?: LocalizedText;
  supportMessage?: LocalizedText;
  services?: Partial<Record<ServiceName, ServiceLink>>;
}

const ConfigContext = createContext<{ config: PortalConfig; loaded: boolean }>({ config: {}, loaded: false });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ config: PortalConfig; loaded: boolean }>({ config: {}, loaded: false });

  useEffect(() => {
    let cancelled = false;
    fetch('/config.json', { cache: 'no-cache', credentials: 'same-origin' })
      .then((response) => (response.ok ? (response.json() as Promise<PortalConfig>) : {}))
      .then((loaded) => {
        if (!cancelled) setState({ config: Object.freeze(loaded), loaded: true });
      })
      .catch(() => {
        // Every reader of the config has a default; a missing file is not fatal.
        if (!cancelled) setState({ config: {}, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <ConfigContext.Provider value={state}>{children}</ConfigContext.Provider>;
}

export function usePortalConfig(): PortalConfig {
  return useContext(ConfigContext).config;
}

/** False until /config.json has answered (or failed): wait on it before acting on a setting. */
export function usePortalConfigLoaded(): boolean {
  return useContext(ConfigContext).loaded;
}

/**
 * A link to one of the stack's own web UIs, on this host at the service's
 * port. Null when the service is not configured.
 */
export function buildServiceUrl(config: PortalConfig, name: ServiceName): string | null {
  const service = config.services?.[name];
  if (!service || typeof window === 'undefined') {
    return null;
  }
  const url = new URL(window.location.href);
  url.protocol = service.protocol;
  url.port = service.port;
  url.pathname = service.path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

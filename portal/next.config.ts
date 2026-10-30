import type { NextConfig } from 'next';

/**
 * The portal is built to static files (`out/`) and served by nginx, exactly as
 * the hand-written HTML portal was: no Node process runs in production, and
 * nginx keeps owning the CSP, the cache headers and the /auth proxy
 * (config/portal/default.conf.template).
 *
 * Pages Router rather than App Router on purpose: a static App Router export
 * ships its page data as inline <script> pushes, which the portal's
 * `script-src 'self'` refuses. The Pages Router export carries its data in a
 * non-executable `application/json` block and loads every script by URL.
 */
const isDev = process.env.NODE_ENV === 'development';
// Where `next dev` forwards what nginx would proxy: the running portal.
const devBackend = process.env.PORTAL_DEV_BACKEND ?? 'http://localhost:8085';

const nextConfig: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  poweredByHeader: false,
  trailingSlash: false,
  images: { unoptimized: true },
  // Static export ignores rewrites; they exist only for `next dev`.
  ...(isDev
    ? {
        async rewrites() {
          return [
            { source: '/auth/:path*', destination: `${devBackend}/auth/:path*` },
            { source: '/api/:path*', destination: `${devBackend}/api/:path*` },
          ];
        },
      }
    : {}),
};

export default nextConfig;

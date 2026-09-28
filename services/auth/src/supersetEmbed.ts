/**
 * Mints a Superset guest token so the portal can embed a dashboard for a
 * signed-in account without a second Superset login.
 *
 * The guest token carries the account's own psu_username as its impersonated
 * Trino identity (config/superset/bootstrap_database.py already has
 * `impersonate_user = True` on the Superset<->Trino connection), so the
 * embedded dashboard's queries reach Trino under exactly that account's own
 * OPA/Trino grants -- never wider. This module never reads or returns any
 * data itself; it only calls two Superset REST endpoints as a dedicated
 * service account (config/superset/bootstrap_embed.py) whose only permission
 * is minting guest tokens.
 */

export interface SupersetEmbedConfig {
  internalOrigin: string;
  publicOrigin: string;
  serviceUsername: string;
  servicePassword: string;
  dashboards: Map<string, string>;
}

async function login(config: SupersetEmbedConfig): Promise<string> {
  const response = await fetch(`${config.internalOrigin}/api/v1/security/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.serviceUsername,
      password: config.servicePassword,
      provider: 'db',
      refresh: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Superset login failed with status ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('Superset login response had no access_token');
  }
  return body.access_token;
}

/**
 * `dashboardUuid` is one value from `config.dashboards` -- the caller
 * (services/auth/src/server.ts) resolves the portal-facing key to a UUID and
 * has already 404'd an unknown key before this runs.
 *
 * `username` must be the account's own psu_username -- the identity Trino
 * impersonates it as (server.ts only ever passes the signed-in account's own
 * value, never a caller-supplied one).
 */
export async function mintDashboardGuestToken(
  config: SupersetEmbedConfig,
  dashboardUuid: string,
  username: string,
  displayName: string | null,
): Promise<string> {
  const accessToken = await login(config);
  const [firstName, ...rest] = (displayName ?? username).split(' ');

  const response = await fetch(`${config.internalOrigin}/api/v1/security/guest_token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      user: {
        username,
        first_name: firstName || username,
        last_name: rest.join(' ') || username,
      },
      resources: [{ type: 'dashboard', id: dashboardUuid }],
      // Empty on purpose: impersonation above is what scopes the data, not a
      // row-level rule added here on top of it.
      rls: [],
    }),
  });
  if (!response.ok) {
    throw new Error(`Superset guest token request failed with status ${response.status}`);
  }
  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new Error('Superset guest token response had no token');
  }
  return body.token;
}

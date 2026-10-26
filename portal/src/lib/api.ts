/*
 * Same-origin JSON calls to psu-auth (proxied by nginx at /auth/). The session
 * is an HttpOnly cookie, so nothing here ever holds a token.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** psu-auth's machine-readable error code, or 'network_error' / 'invalid_response'. */
    readonly code: string,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(code);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export async function api<T = Record<string, unknown>>(
  method: Method,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const code = parsed && typeof parsed.error === 'string' ? parsed.error : `http_${response.status}`;
    throw new ApiError(response.status, code, parsed);
  }
  if (parsed === null) {
    throw new ApiError(response.status, 'invalid_response');
  }
  return parsed as T;
}

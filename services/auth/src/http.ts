/**
 * Small helpers shared by the routes. Every response here is no-store: an
 * intermediary caching a sign-in state or a profile would hand one person's
 * session details to the next.
 */
import type { ServerResponse } from 'node:http';

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...baseHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { ...baseHeaders, Location: location });
  response.end();
}

export function setCookie(
  response: ServerResponse,
  name: string,
  value: string,
  options: CookieOptions,
): void {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? '/'}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ];
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  appendHeader(response, 'Set-Cookie', parts.join('; '));
}

export function clearCookie(response: ServerResponse, name: string, secure: boolean): void {
  setCookie(response, name, '', { maxAgeSeconds: 0, secure });
}

export function readCookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) {
    return jar;
  }
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name) {
      jar.set(name, decodeURIComponent(value));
    }
  }
  return jar;
}

/**
 * Only a same-site path is ever used as a redirect target. A value that names
 * a host -- including the protocol-relative `//host` form, which is the one
 * usually missed -- is replaced with the site root rather than corrected.
 */
export function safeNextPath(candidate: string | null): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return '/';
  }
  if (candidate.includes("\\") || candidate.includes("\n") || candidate.includes("\r")) {
    return '/';
  }
  return candidate;
}

function appendHeader(response: ServerResponse, name: string, value: string): void {
  const existing = response.getHeader(name);
  if (existing === undefined) {
    response.setHeader(name, value);
    return;
  }
  const list = Array.isArray(existing) ? existing : [String(existing)];
  response.setHeader(name, [...list, value]);
}

/**
 * PSU directory lookups through the API gateway.
 *
 * Ported from the dotblueAI implementation and kept deliberately narrow: the
 * gateway's responses also carry names, nationality, study status, email
 * addresses and telephone numbers for the person being looked up. None of
 * those are typed here, so they cannot be read or stored by accident, and the
 * request line is never logged because it carries the identifier.
 */
import type { AppConfig } from './config.js';

export type DirectoryGroup = 'student' | 'staff';

/** Affiliation fields, the only thing either endpoint is read for. */
export interface DirectoryRecord {
  campusCode?: string | undefined;
  campusNameTh?: string | undefined;
  facultyNameTh?: string | undefined;
  departmentNameTh?: string | undefined;
  majorNameTh?: string | undefined;
}

export interface DirectoryResult {
  group: DirectoryGroup;
  record: DirectoryRecord;
}

interface StudentPayload {
  studentId?: string;
  campusId?: string;
  campusNameThai?: string;
  facNameThai?: string;
  deptNameThai?: string;
  majorNameThai?: string;
  data?: StudentPayload[];
}

interface StaffPayload {
  username?: string;
  campNameThai?: string;
  facNameThai?: string;
  deptNameThai?: string;
  data?: StaffPayload[];
}

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text === '' ? undefined : text;
};

const hasAffiliation = (record: DirectoryRecord): boolean =>
  Boolean(record.campusNameTh ?? record.facultyNameTh ?? record.departmentNameTh);

/**
 * One authenticated GET. Only the endpoint label and the status reach the log:
 * the path and query string carry a student id or a username.
 */
async function requestJson<T>(
  label: string,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        credential: `api_key=${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      console.warn(`[directory] ${label} returned status ${response.status}`);
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'failed';
    console.warn(`[directory] ${label} ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks a student up in one campus database. `campusCode` is the `:campus`
 * path segment; each code selects a different database, which is why the
 * caller may have to try several.
 */
async function fetchStudent(
  studentId: string,
  campusCode: string,
  config: AppConfig,
): Promise<DirectoryRecord | null> {
  const key = config.directory.studentKey;
  if (!key) {
    console.warn('[directory] student lookup skipped: API_STUDENT_KEY is not configured');
    return null;
  }

  const url = new URL(
    `${config.directory.baseUrl}/regist/v3/student/${encodeURIComponent(campusCode)}`,
  );
  url.searchParams.set('studentId', studentId);

  const payload = await requestJson<StudentPayload>(
    'student lookup',
    url.toString(),
    key,
    config.directory.timeoutMs,
  );
  if (!payload) {
    return null;
  }

  const found = payload.campusNameThai != null ? payload : payload.data?.[0];
  if (!found) {
    return null;
  }

  /**
   * Attaching someone else's faculty to an account is worse than no
   * enrichment at all, so a response that does not prove it answers the
   * requested student is discarded rather than used.
   */
  if (trimmed(found.studentId) !== studentId) {
    console.warn(
      `[directory] student lookup in campus ${campusCode} answered for a different or unstated id; discarded`,
    );
    return null;
  }

  const record: DirectoryRecord = {
    campusCode: trimmed(found.campusId) ?? campusCode,
    campusNameTh: trimmed(found.campusNameThai),
    facultyNameTh: trimmed(found.facNameThai),
    departmentNameTh: trimmed(found.deptNameThai),
    majorNameTh: trimmed(found.majorNameThai),
  };
  return hasAffiliation(record) ? record : null;
}

/** Looks a staff member up by PSU username. The gateway returns a paged list. */
async function fetchStaff(username: string, config: AppConfig): Promise<DirectoryRecord | null> {
  const key = config.directory.staffKey;
  if (!key) {
    console.warn('[directory] staff lookup skipped: API_STAFF_KEY is not configured');
    return null;
  }

  const url = new URL(
    `${config.directory.baseUrl}/Personnel/GetStaffDetailsByUserName/${encodeURIComponent(username)}`,
  );
  url.searchParams.set('offset', '0');
  url.searchParams.set('limit', '5');
  url.searchParams.set('campusID', '');
  url.searchParams.set('facID', '');
  url.searchParams.set('depID', '');

  const payload = await requestJson<StaffPayload>(
    'staff lookup',
    url.toString(),
    key,
    config.directory.timeoutMs,
  );
  if (!payload) {
    return null;
  }

  const rows = payload.data ?? (payload.campNameThai != null ? [payload] : []);
  if (rows.length === 0) {
    return null;
  }

  // Same identity rule as the student lookup: prefer the row that states this
  // username, and accept an unnamed row only when it is the only one.
  const wanted = username.toLowerCase();
  const matched = rows.find((row) => trimmed(row.username)?.toLowerCase() === wanted);
  const only = rows.length === 1 && rows[0] !== undefined && trimmed(rows[0].username) === undefined;
  const chosen = matched ?? (only ? rows[0] : undefined);

  if (!chosen) {
    console.warn(
      `[directory] staff lookup returned ${rows.length} record(s), none matching the requested username; discarded`,
    );
    return null;
  }

  const record: DirectoryRecord = {
    campusNameTh: trimmed(chosen.campNameThai),
    facultyNameTh: trimmed(chosen.facNameThai),
    departmentNameTh: trimmed(chosen.deptNameThai),
  };
  return hasAffiliation(record) ? record : null;
}

/**
 * Resolves which group a username belongs to by asking the gateway, not by
 * reading the username. A numeric username only decides which endpoint is
 * tried first; whichever endpoint answers decides the group, and when neither
 * answers the caller is told nothing was resolved rather than given a guess.
 */
export async function resolveDirectory(
  username: string,
  config: AppConfig,
  claimedCampusCode?: string,
  knownCampusCode?: string,
): Promise<DirectoryResult | null> {
  const identifier = username.trim().split('@')[0]?.toLowerCase();
  if (!identifier) {
    return null;
  }

  if (/^[0-9]+/.test(identifier)) {
    const candidates = [
      ...new Set(
        [knownCampusCode, claimedCampusCode, ...config.directory.campusCodes].filter(
          (code): code is string => typeof code === 'string' && code !== '',
        ),
      ),
    ];
    for (const campusCode of candidates) {
      const record = await fetchStudent(identifier, campusCode, config);
      if (record) {
        return { group: 'student', record };
      }
    }
    console.info('[directory] no student record for a numeric username; retrying as staff');
  }

  const staff = await fetchStaff(identifier, config);
  return staff ? { group: 'staff', record: staff } : null;
}

"""ThaiLLM Data Repository source adapter.

Target: https://data-repository.thaillm.or.th/

Findings from live exploration (see plan):
* Express SPA behind Cloudflare; plain HTTP gets 403, so all requests go
  through :class:`pipeline.session.Session` (curl-cffi impersonation + cookies).
* Public metadata API: ``GET /api/dataset/{id}`` returns
  ``{status, message, data:{id,name,description,dataOwner,license,accessTier,
  topic, Organization:{name,bucket,...}}}``.
* Home page lists 21 public datasets grouped by topic; dataset detail page is
  ``/dataset/{id}``, files page is ``/dataset/{id}/files``.
* Downloading files requires login + a per-dataset usage form, so
  :meth:`authenticate` runs the headless browser login first.

The authenticated file-list endpoint could not be confirmed without a real
session, so :meth:`list_files` probes a small set of candidate endpoints and
caches whichever returns 200 JSON.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from typing import Iterator, Optional
from urllib.parse import quote

from sources.base import CorpusRecord, Dataset, FileRef, Source

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ORIGIN = "https://data-repository.thaillm.or.th"
# Candidate authenticated file-list endpoints, tried in order. The first that
# returns JSON with file data is cached per-session. The confirmed endpoint is
# /api/dataset/list-files/{id} (public -- returns 200 even unauthenticated).
_FILES_ENDPOINT_CANDIDATES = [
    "/api/dataset/list-files/{id}",  # confirmed
    "/api/dataset/{id}/files",
    "/api/datasets/{id}/files",
    "/api/dataset/{id}/file",
]
# Confirmed download endpoint (captured from the SPA's network traffic):
#   GET /api/storage/sign-get-object?dataset_id={ds}&key={url-encoded key}
# The handler signs an S3 GET and either streams the object back through the
# backend or (depending on build) returns a JSON/redirect with a presigned URL.
# It is flaky under load (502/504), so fetch() retries with backoff.
_SIGN_ENDPOINT = "/api/storage/sign-get-object?dataset_id={ds}&key={key}"
# Column names we treat as the document text, tried in order.
_TEXT_COLUMNS = ("text", "content", "body", "message", "paragraph", "doc", "raw")
# Extensions we can normalize.
_SUPPORTED_EXT = ("parquet", "json", "jsonl", "csv", "txt", "zip")
# Standard usage-form answer used when (re-)submitting a dataset survey.
# The server has been observed to drop previously-submitted responses, so
# _survey_filled re-submits with this on a 404.
_SURVEY_CONTENT = {
    "notes": "",
    "company": "",
    "purpose": "Personal use",
    "useCase": "การใช้ข้อมูลสำหรับการทำ CPT model LLM",
    "teamSize": "",
    "dbdNumber": "",
}


class _TransientDownloadError(Exception):
    """Raised for retriable download failures (502/503/504/timeout/429)."""


def _quote_key(key: str) -> str:
    """Percent-encode the S3 key, including slashes (the SPA sends %2F)."""
    return quote(key, safe="")


def _peek_text(res, n: int = 300) -> str:
    """Read up to n bytes from a (streaming) response as text, then close."""
    buf = b""
    try:
        for chunk in res.iter_content(chunk_size=n):
            buf += chunk
            if len(buf) >= n:
                break
    except Exception:
        pass
    try:
        res.close()
    except Exception:
        pass
    try:
        return buf[:n].decode("utf-8", "replace")
    except Exception:
        return "<binary>"


class ThaiLLMSource(Source):
    """Adapter for data-repository.thaillm.or.th."""

    name = "thaillm"

    def __init__(self, session, verbose: bool = True):
        self.session = session
        self.verbose = verbose
        self._files_endpoint: Optional[str] = None

    # ------------------------------------------------------------------ #
    # discover
    # ------------------------------------------------------------------ #
    def discover(self) -> list[Dataset]:
        """Enumerate datasets by probing ``/api/dataset/{id}`` for id 1..N.

        The metadata endpoint is public but Cloudflare-fronted, so it still
        needs the cookie-authenticated session. Stop after 5 consecutive 404s.
        """
        datasets: list[Dataset] = []
        miss_streak = 0
        max_id = 300  # safety cap; observed ids go up to ~58 with gaps
        streak_cap = 30  # tolerate sparse ids (e.g. 1-7 are absent, first is 8)
        for ds_id in range(1, max_id + 1):
            res = self.session.get(f"/api/dataset/{ds_id}")
            if res.status_code == 404:
                miss_streak += 1
                if miss_streak >= streak_cap:
                    break
                continue
            if res.status_code != 200:
                if self.verbose:
                    print(f"[thaillm] id={ds_id} -> HTTP {res.status_code}, stopping")
                break
            data = _safe_json(res)
            if not data or data.get("status") != 200:
                miss_streak += 1
                continue
            miss_streak = 0
            d = data.get("data") or {}
            datasets.append(
                Dataset(
                    id=str(d.get("id", ds_id)),
                    name=d.get("name", f"dataset-{ds_id}"),
                    topic=d.get("topic", ""),
                    license=d.get("license", ""),
                    owner=(d.get("Organization") or {}).get("name", d.get("dataOwner", "")),
                    url=f"{ORIGIN}/dataset/{d.get('id', ds_id)}",
                    extra={
                        "description": d.get("description", ""),
                        "access_tier": d.get("accessTier"),
                        "bucket": (d.get("Organization") or {}).get("bucket"),
                        "data_owner": d.get("dataOwner"),
                    },
                )
            )
        if self.verbose:
            print(f"[thaillm] discovered {len(datasets)} dataset(s)")
        return datasets

    # ------------------------------------------------------------------ #
    # authenticate
    # ------------------------------------------------------------------ #
    def authenticate(self, session) -> None:
        if not session.load():
            if self.verbose:
                print("[thaillm] no cached session, launching browser login")
            session.login_via_browser()
            return
        # Proactively ensure the cached session is still usable. The bearer
        # expires (~1h) and the Cloudflare clearance lapses too; if the first
        # authenticated call only happens deep in the download loop, a mid-flight
        # 401 poisons the per-dataset survey cache and every file gets skipped as
        # "not submitted" even when the form IS filled. Re-establish the session
        # here so the loop runs against a live token.
        if not session._ensure_access_token():
            if self.verbose:
                print("[thaillm] cached session expired, launching browser login")
            session.login_via_browser()

    # ------------------------------------------------------------------ #
    # list_files
    # ------------------------------------------------------------------ #
    def list_files(self, dataset: Dataset) -> list[FileRef]:
        endpoint = self._resolve_files_endpoint(dataset)
        if endpoint is None:
            raise RuntimeError(
                f"Could not find the file-list endpoint for dataset {dataset.id}. "
                "Log in once, open /dataset/{id}/files in a browser, inspect the "
                "Network tab, and add the endpoint pattern to _FILES_ENDPOINT_CANDIDATES."
            )
        res = self.session.get(endpoint)
        if res.status_code != 200:
            raise RuntimeError(f"file list HTTP {res.status_code} for {dataset.id}")
        files = _extract_file_list(_safe_json(res), dataset.id)
        if self.verbose:
            print(f"[thaillm] dataset {dataset.id}: {len(files)} file(s)")
        return files

    def _resolve_files_endpoint(self, dataset: Dataset) -> Optional[str]:
        if self._files_endpoint:
            return self._files_endpoint.format(id=dataset.id)
        for pat in _FILES_ENDPOINT_CANDIDATES:
            url = pat.format(id=dataset.id)
            try:
                res = self.session.get(url)
            except Exception:
                continue
            if res.status_code == 200 and _looks_like_file_list(res):
                self._files_endpoint = pat
                if self.verbose:
                    print(f"[thaillm] files endpoint = {url}")
                return url
        return None

    # ------------------------------------------------------------------ #
    # fetch
    # ------------------------------------------------------------------ #
    def fetch(self, file_ref: FileRef, dest_dir: str) -> str:
        """Download one file via the confirmed sign-get-object endpoint.

        Handles three response shapes (direct stream / JSON presigned URL /
        302 redirect), retries on the backend's flaky 502/504, and gives a clear
        message if the per-dataset usage form has not been submitted.
        """
        # survey gate -- check once per dataset (cached). Downloading requires
        # the user to have submitted the usage form for that dataset.
        if not self._survey_filled(file_ref.dataset_id):
            raise RuntimeError(
                f"The usage form for dataset {file_ref.dataset_id} has not been "
                f"submitted. Open {self.session.origin}/dataset/"
                f"{file_ref.dataset_id}/files in a browser, fill the form once, "
                "then re-run."
            )
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, _safe_filename(file_ref.name))
        key = file_ref.extra.get("key") or ""
        if not key:
            raise RuntimeError(f"no S3 key for {file_ref.name}")
        url = f"{self.session.origin}{_SIGN_ENDPOINT}".format(
            ds=file_ref.dataset_id, key=_quote_key(key))
        return self._download_with_retries(url, dest, file_ref)

    def _download_with_retries(self, url: str, dest: str, file_ref: FileRef,
                              *, attempts: int = 5) -> str:
        last: Optional[_TransientDownloadError] = None
        for i in range(1, attempts + 1):
            try:
                return self._download_one(url, dest, file_ref)
            except _TransientDownloadError as e:
                last = e
                wait = min(10 * i, 60)
                if self.verbose:
                    print(f"[thaillm] {file_ref.name}: {e} "
                          f"(attempt {i}/{attempts}, retry in {wait}s)")
                time.sleep(wait)
        raise RuntimeError(
            f"download failed after {attempts} attempts ({file_ref.name}): {last}")

    def _download_one(self, sign_url: str, dest: str, file_ref: FileRef) -> str:
        self.session._ensure_access_token()
        headers = {
            **self.session._auth_headers(),
            "Referer": f"{self.session.origin}/dataset/{file_ref.dataset_id}/files",
        }
        try:
            res = self.session.http.get(sign_url, headers=headers,
                                         allow_redirects=False, stream=True,
                                         timeout=180)
        except Exception as e:
            raise _TransientDownloadError(f"connection error: {e}")
        try:
            code = res.status_code
            if code in (502, 503, 504, 408, 429):
                raise _TransientDownloadError(f"HTTP {code}")
            if code == 401:
                self.session._ensure_access_token(force=True)
                raise _TransientDownloadError("HTTP 401 (token refreshed)")
            if code == 403:
                body = _peek_text(res, 300)
                raise RuntimeError(
                    f"HTTP 403 downloading {file_ref.name} -- the usage form "
                    f"for dataset {file_ref.dataset_id} may not be submitted. "
                    f"Open {self.session.origin}/dataset/{file_ref.dataset_id}"
                    "/files in a browser, fill the form once, then re-run. "
                    f"({body})")
            if code in (301, 302, 303, 307, 308):
                loc = res.headers.get("Location", "")
                if not loc:
                    raise RuntimeError(f"redirect without Location ({file_ref.name})")
                if loc.startswith("/"):
                    loc = self.session.origin + loc
                # presigned S3 URL -> fetch WITHOUT auth headers (a Bearer
                # header would make S3 ignore the query-string signature)
                return self._stream_url(loc, dest, file_ref, auth=False)
            if code == 200:
                ctype = (res.headers.get("content-type") or "").lower()
                if "json" in ctype:
                    # small JSON body (a presigned URL). stream=True means the
                    # body isn't auto-read -- consume it, capped at 64 KiB so a
                    # mislabeled large stream can't blow memory.
                    body = b""
                    for chunk in res.iter_content(chunk_size=8192):
                        body += chunk
                        if len(body) > 65536:
                            break
                    try:
                        data = json.loads(body.decode("utf-8"))
                    except Exception:
                        # not actually JSON -- treat what we have as the file
                        # stream and keep streaming to disk.
                        return self._stream_response(res, dest, file_ref,
                                                     prefix=body)
                    for k in ("signed_url", "url", "signedUrl", "presignedUrl",
                              "downloadUrl", "download_url"):
                        v = (data or {}).get(k) if isinstance(data, dict) else None
                        if v:
                            return self._stream_url(v, dest, file_ref, auth=False)
                    raise RuntimeError(
                        f"JSON response without a URL field ({file_ref.name}): "
                        f"{body[:300]!r}")
                # otherwise the body IS the file (proxied stream)
                return self._stream_response(res, dest, file_ref)
            raise RuntimeError(f"download failed (HTTP {code}) for {file_ref.name}")
        finally:
            try:
                res.close()
            except Exception:
                pass

    def _stream_url(self, url: str, dest: str, file_ref: FileRef, *, auth: bool) -> str:
        headers = {}
        if auth:
            self.session._ensure_access_token()
            headers = self.session._auth_headers()
        # the presigned S3 URL is valid for minutes, so retry a transient
        # connection failure (the S3 host often drops the first connect) a
        # couple of times on the SAME url before bubbling up to the outer
        # retry (which would re-sign and risk another 504 on sign-get-object).
        last: Optional[Exception] = None
        for attempt in range(1, 4):
            try:
                res = self.session.http.get(url, headers=headers, stream=True,
                                             timeout=300)
            except Exception as e:
                last = e
                if self.verbose:
                    print(f"[thaillm] {file_ref.name}: connect attempt {attempt}/3 "
                          f"failed ({e}); retry in 5s")
                time.sleep(5)
                continue
            if res.status_code in (502, 503, 504):
                try:
                    res.close()
                except Exception:
                    pass
                raise _TransientDownloadError(f"HTTP {res.status_code} on stream")
            if res.status_code not in (200, 206):
                try:
                    res.close()
                except Exception:
                    pass
                raise RuntimeError(
                    f"stream HTTP {res.status_code} for {file_ref.name}")
            try:
                return self._stream_response(res, dest, file_ref)
            finally:
                try:
                    res.close()
                except Exception:
                    pass
        raise _TransientDownloadError(f"connect failed after 3 tries: {last}")


    def _stream_response(self, res, dest: str, file_ref: FileRef,
                         *, prefix: bytes = b"") -> str:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        written = 0
        with open(dest, "wb") as f:
            if prefix:
                f.write(prefix)
                written += len(prefix)
            for buf in res.iter_content(chunk_size=1 << 20):
                if buf:
                    f.write(buf)
                    written += len(buf)
        if self.verbose:
            print(f"[thaillm] downloaded {os.path.basename(dest)} ({written} bytes)")
        return dest

    def _survey_filled(self, dataset_id: str) -> bool:
        """Check the per-dataset usage form has been submitted (cached).

        Only the genuine survey states are cached: HTTP 200 (filled) or 404 (not
        filled). An auth failure (401/403) is NOT cached -- ``Session.request``
        already retries once after a token refresh, so a 401 reaching here means
        the session is unusable. Raise so the caller re-logs in rather than
        silently skipping every file in the dataset as "not submitted".

        **Auto-recover on 404**: the ThaiLLM server has been observed to DROP
        previously-submitted survey responses (datasets 8 and 18 both reverted
        to 404 mid-session), which on a multi-day run would silently skip a
        whole dataset. On a 404 we therefore re-submit the standard usage form
        once and re-check before caching -- so a disappearing survey no longer
        blocks the run.
        """
        if not hasattr(self, "_survey_cache"):
            self._survey_cache: dict[str, bool] = {}
        if dataset_id in self._survey_cache:
            return self._survey_cache[dataset_id]
        res = self.session.get(
            f"/api/survey-response/check-survey-cutoff?dataset_id={dataset_id}")
        if res.status_code in (401, 403):
            raise RuntimeError(
                f"auth failed ({res.status_code}) checking survey for dataset "
                f"{dataset_id}. Run `python cpt_ingest.py login` to refresh "
                f"the session, then re-run."
            )
        ok = res.status_code == 200 and "found" in (res.text or "").lower()
        if not ok and res.status_code == 404:
            # survey response vanished (server-side pruning observed) -- re-submit
            # the standard usage form and re-check once before giving up.
            if self.verbose:
                print(f"[thaillm] survey for dataset {dataset_id} returned 404 "
                      f"(was filled before); re-submitting usage form...")
            self._submit_survey(dataset_id)
            res2 = self.session.get(
                f"/api/survey-response/check-survey-cutoff?dataset_id={dataset_id}")
            ok = res2.status_code == 200 and "found" in (res2.text or "").lower()
        self._survey_cache[dataset_id] = ok
        return ok

    def _submit_survey(self, dataset_id: str) -> None:
        """Submit the per-dataset usage form with the standard answer."""
        res = self.session.request(
            "POST", "/api/survey-response/create-survey-response",
            json={"dataset_id": int(dataset_id), "content": _SURVEY_CONTENT})
        if self.verbose:
            print(f"[thaillm] submit survey for dataset {dataset_id}: "
                  f"HTTP {res.status_code}")

    # ------------------------------------------------------------------ #
    # normalize
    # ------------------------------------------------------------------ #
    def normalize(self, raw_path: str, dataset: Dataset) -> Iterator[CorpusRecord]:
        ext = raw_path.rsplit(".", 1)[-1].lower() if "." in raw_path else ""
        if ext not in _SUPPORTED_EXT:
            if self.verbose:
                print(f"[thaillm] skip unsupported .{ext}: {os.path.basename(raw_path)}")
            return
        for row in _iter_rows(raw_path, ext):
            text = _pick_text(row)
            if not text:
                continue
            doc_id = _pick_id(row) or hashlib.md5(text.encode("utf-8")).hexdigest()
            yield CorpusRecord(
                source=self.name,
                dataset_id=dataset.id,
                dataset_name=dataset.name,
                topic=dataset.topic,
                license=dataset.license,
                doc_id=str(doc_id),
                text=text,
            )


# ---------------------------------------------------------------------- #
# helpers
# ---------------------------------------------------------------------- #
def _safe_json(res):
    try:
        return res.json()
    except Exception:
        return None


def _looks_like_file_list(res) -> bool:
    """Heuristic: the response is JSON and mentions file-ish keys."""
    data = _safe_json(res)
    if data is None:
        return False
    text = res.text[:2000].lower()
    return any(k in text for k in ("filename", "file_name", "download", ".parquet", "url", "size"))


def _extract_file_list(data, dataset_id: str) -> list[FileRef]:
    """Pull FileRefs out of the file-list JSON.

    Confirmed shape from /api/dataset/list-files/{id}::

        {"status":200, "data":[{"id":11,"datasetId":8,"bucket":"nectec",
        "key":"cc100/cc100_th/cc100_th_1.jsonl","logicalName":"cc100_th_1.jsonl",
        "downloadCount":2,"fileFormat":null,...}]}
    """
    if data is None:
        return []
    items = None
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in ("data", "files", "result", "items"):
            v = data.get(key)
            if isinstance(v, list):
                items = v
                break
    if items is None:
        return []
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        name = (
            it.get("logicalName")
            or it.get("name")
            or it.get("filename")
            or it.get("file_name")
            or (it.get("key", "").rsplit("/", 1)[-1] if it.get("key") else None)
            or "file"
        )
        file_id = it.get("id")
        bucket = it.get("bucket")
        key = it.get("key")
        size = it.get("size") or it.get("fileSize") or it.get("bytes")
        ext = ""
        if isinstance(name, str) and "." in name:
            ext = name.rsplit(".", 1)[-1].lower()
        elif isinstance(key, str) and "." in key:
            ext = key.rsplit(".", 1)[-1].lower()
        # the download URL is resolved lazily by fetch() (needs auth); store the
        # file id + bucket + key so fetch can probe the download endpoint.
        out.append(
            FileRef(
                dataset_id=dataset_id,
                name=name,
                url="",  # resolved in fetch()
                size=size,
                fmt=ext,
                extra={"file_id": str(file_id) if file_id is not None else "", "bucket": bucket or "", "key": key or ""},
            )
        )
    return out


def _safe_filename(name: str) -> str:
    if not name:
        return "file"
    return "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in name)


def _pick_text(row: dict) -> str:
    """Return the first non-empty value among common text columns."""
    for key in _TEXT_COLUMNS:
        v = row.get(key)
        if isinstance(v, str) and v.strip():
            return v
    # fallback: join all string values longer than 40 chars
    candidates = [v for v in row.values() if isinstance(v, str) and len(v) > 40]
    return candidates[0] if candidates else ""


def _pick_id(row: dict) -> Optional[str]:
    for key in ("id", "_id", "uid", "doc_id", "document_id", "hash"):
        v = row.get(key)
        if v not in (None, ""):
            return str(v)
    return None


def _iter_rows(raw_path: str, ext: str):
    """Yield dict rows from a raw file, format-dispatched."""
    if ext == "txt":
        with open(raw_path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        if text.strip():
            yield {"text": text}
        return
    if ext == "csv":
        import csv
        with open(raw_path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
            for row in csv.DictReader(f):
                yield row
        return
    if ext in ("json", "jsonl"):
        with open(raw_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        # try JSONL first, then a single JSON array
        try:
            arr = json.loads(content)
            if isinstance(arr, dict) and "data" in arr and isinstance(arr["data"], list):
                arr = arr["data"]
        except json.JSONDecodeError:
            arr = None
        if isinstance(arr, list):
            for it in arr:
                yield it if isinstance(it, dict) else {"text": str(it)}
            return
        # fall back to line-by-line JSONL
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                it = json.loads(line)
            except json.JSONDecodeError:
                yield {"text": line}
                continue
            yield it if isinstance(it, dict) else {"text": str(it)}
        return
    if ext == "zip":
        # extract each member to a temp file on the SAME volume (scratch dir,
        # on D:) and recurse -- never hold the archive or a large member in
        # memory. A member can be a multi-GB parquet, which must stream from
        # disk (see the parquet branch below). Temp file is removed after.
        import zipfile, tempfile
        with zipfile.ZipFile(raw_path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                inner_ext = (info.filename.rsplit(".", 1)[-1].lower()
                             if "." in info.filename else "")
                if inner_ext not in _SUPPORTED_EXT or inner_ext == "zip":
                    continue  # nested zips not handled (rare); skip dirs/unknown
                fd, tmp_path = tempfile.mkstemp(
                    suffix="_" + os.path.basename(info.filename),
                    dir=os.path.dirname(raw_path) or ".")
                try:
                    os.close(fd)
                    with zf.open(info) as src, open(tmp_path, "wb") as dst:
                        while True:
                            chunk = src.read(1 << 20)  # 1 MiB
                            if not chunk:
                                break
                            dst.write(chunk)
                    yield from _iter_rows(tmp_path, inner_ext)
                finally:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
        return
    if ext == "parquet":
        import pyarrow.parquet as pq
        # STREAM row-group by row-group. Do NOT use pq.read_table() -- it
        # loads the whole file into memory and OOMs on multi-GB parquets
        # (e.g. fineweb2 train-00000.parquet is ~5 GB; on a RAM-constrained
        # box that dies with ArrowMemoryError). ParquetFile.iter_batches
        # reads one row group at a time, bounding peak memory.
        pf = pq.ParquetFile(raw_path)
        cols = pf.schema_arrow.names
        # batch_size caps rows per yielded batch so a single huge row group
        # (fineweb2 has ~GB-sized groups) can't OOM the box.
        for batch in pf.iter_batches(columns=cols, batch_size=4096):
            cols_data = {c: batch.column(c).to_pylist() for c in cols}
            for i in range(batch.num_rows):
                yield {c: cols_data[c][i] for c in cols}
        return

"""Sharded parquet writer to RustFS (S3).

Writes :class:`sources.CorpusRecord` rows as zstd-compressed parquet shards
directly into the RustFS bucket declared by ``.env``::

    s3://<CPT_OUTPUT_BUCKET>/<CPT_OUTPUT_PREFIX>/part-NNNNN.parquet

Design choices (per the approved plan):

* No Trino / Iceberg registration -- the user chose RustFS-only, which is the
  scalable path for GB-scale corpora (the existing ``INSERT ... VALUES``
  pattern in ``multimodal_pipeline.py`` batches 50 rows and does not scale).
* Shards flush at ~ ``shard_chars`` characters of text (a proxy for ~256 MB
  per shard), each written as a single row group.
* Stops accepting rows once ``target`` characters have been written.
* Emits ``_MANIFEST.json`` next to the shards summarizing the run.
"""
from __future__ import annotations

import json
import os
import re
import sys
from types import SimpleNamespace
from typing import Iterator, Optional

import pyarrow as pa
import pyarrow.parquet as pq

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# stable, source-agnostic schema
SCHEMA = pa.schema(
    [
        ("source", pa.string()),
        ("dataset_id", pa.string()),
        ("dataset_name", pa.string()),
        ("topic", pa.string()),
        ("license", pa.string()),
        ("doc_id", pa.string()),
        ("text", pa.string()),
        ("char_count", pa.int64()),
        ("fetched_at", pa.string()),
    ]
)


def _s3_filesystem(endpoint: str, access_key: str, secret_key: str):
    import pyarrow.fs as fs
    host, _, port = endpoint.replace("http://", "").replace("https://", "").partition(":")
    return fs.S3FileSystem(
        endpoint_override=f"{host}:{port or '9000'}",
        access_key=access_key,
        secret_key=secret_key,
        region="us-west-2",
        allow_bucket_creation=False,
        scheme="http",
    )


class ParquetWriter:
    """Streaming writer that accumulates records and flushes shards to S3."""

    def __init__(
        self,
        *,
        bucket: str,
        prefix: str,
        endpoint: str,
        access_key: str,
        secret_key: str,
        shard_chars: int = 100_000_000,  # ~100M chars/shard; tunable via CPT_SHARD_CHARS
        target: Optional[int] = None,
        verbose: bool = True,
        resume: bool = False,
    ):
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.shard_chars = shard_chars
        self.target = target
        self.verbose = verbose
        self._fs = _s3_filesystem(endpoint, access_key, secret_key)
        self._buf: list[tuple] = []
        self._shard_chars = 0
        self._total_chars = 0
        self._total_rows = 0
        self._shard_no = 0
        self._paths: list[str] = []
        self._per_dataset: dict[str, dict] = {}
        if resume:
            self._resume_init()

    # ------------------------------------------------------------------ #
    # resume support
    # ------------------------------------------------------------------ #
    def _resume_init(self) -> None:
        """On a resumed run: continue at the next shard number (append, never
        overwrite), and restore cumulative totals / per-dataset stats from the
        last checkpoint manifest. The caller then seeds the deduper from the
        existing shards via :meth:`iter_existing_records` so re-processed files
        are recognized as duplicates and not written again.
        """
        parts = self._list_existing_parts()
        if parts:
            self._shard_no = max(parts) + 1
            if self.verbose:
                print(f"[writer] resume: {len(parts)} existing shard(s) "
                      f"(part-00000..part-{max(parts):05d}); "
                      f"continuing at part-{self._shard_no:05d}")
        man = self._load_manifest()
        if man:
            self._total_chars = int(man.get("total_chars", 0))
            self._total_rows = int(man.get("total_rows", 0))
            self._per_dataset = man.get("per_dataset", {}) or {}
            self._paths = list(man.get("shards", []) or [])
            if self.verbose:
                print(f"[writer] resume: restored totals "
                      f"{self._total_chars:,} chars, {self._total_rows:,} rows "
                      f"from checkpoint manifest")

    def _list_existing_parts(self) -> list[int]:
        """List the shard numbers already present in the prefix."""
        import pyarrow.fs as fs
        nums: list[int] = []
        try:
            selector = fs.FileSelector(
                f"{self.bucket}/{self.prefix}",
                allow_not_found=True,
                recursive=False,
            )
            for info in self._fs.get_file_info(selector):
                name = (info.path or "").split("/")[-1]
                m = re.match(r"part-(\d{5})\.parquet$", name)
                if m:
                    nums.append(int(m.group(1)))
        except Exception as e:
            if self.verbose:
                print(f"[writer] resume: could not list existing parts ({e}); "
                      f"starting fresh at part-00000")
        return sorted(nums)

    def _load_manifest(self) -> Optional[dict]:
        """Read the checkpoint manifest (written after every shard flush)."""
        uri = f"{self.bucket}/{self.prefix}/_MANIFEST.json"
        try:
            with self._fs.open_input_stream(uri) as src:
                return json.loads(src.read().decode("utf-8"))
        except Exception:
            return None

    def iter_existing_records(self):
        """Yield the records stored in already-written shards.

        Used on resume to seed the deduper (see :meth:`Deduper.seed`) so that
        re-processed files do not produce duplicate output. Yields
        ``SimpleNamespace(doc_id, text, char_count)`` per row, streaming one
        row-batch at a time to bound peak memory.

        Uses ``open_input_file`` (NOT ``open_input_stream``): parquet metadata
        lives at the END of the file, so the reader must seek; the streaming
        input handle is non-seekable and raises "only valid on seekable files".
        """
        import pyarrow.parquet as pq
        cols = ["doc_id", "text", "char_count"]
        for n in self._list_existing_parts():
            uri = f"{self.bucket}/{self.prefix}/part-{n:05d}.parquet"
            try:
                with self._fs.open_input_file(uri) as src:
                    pf = pq.ParquetFile(src)
                    for batch in pf.iter_batches(columns=cols):
                        dids = batch.column("doc_id").to_pylist()
                        texts = batch.column("text").to_pylist()
                        ccs = batch.column("char_count").to_pylist()
                        for d, t, c in zip(dids, texts, ccs):
                            if t:
                                yield SimpleNamespace(doc_id=d, text=t,
                                                      char_count=int(c))
            except Exception as e:
                if self.verbose:
                    print(f"[writer] resume: skip part-{n:05d} during seed ({e})")

    def is_target_reached(self) -> bool:
        return self.target is not None and self._total_chars >= self.target

    # ------------------------------------------------------------------ #
    def write(self, rec) -> bool:
        """Append a record. Returns False if the target has been reached."""
        if self.target is not None and self._total_chars >= self.target:
            return False
        row = (
            rec.source,
            rec.dataset_id,
            rec.dataset_name,
            rec.topic,
            rec.license,
            rec.doc_id,
            rec.text,
            rec.char_count,
            rec.fetched_at,
        )
        self._buf.append(row)
        self._shard_chars += rec.char_count
        self._total_chars += rec.char_count
        self._total_rows += 1
        ds_key = f"{rec.source}:{rec.dataset_id}"
        d = self._per_dataset.setdefault(
            ds_key,
            {"dataset_name": rec.dataset_name, "topic": rec.topic, "rows": 0, "chars": 0},
        )
        d["rows"] += 1
        d["chars"] += rec.char_count
        if self._shard_chars >= self.shard_chars:
            self._flush()
        return True

    def _flush(self) -> None:
        if not self._buf:
            return
        table = pa.Table.from_pylist(
            [dict(zip([f.name for f in SCHEMA], row)) for row in self._buf],
            schema=SCHEMA,
        )
        part = f"{self.prefix}/part-{self._shard_no:05d}.parquet"
        uri = f"{self.bucket}/{part}"
        if self.verbose:
            print(f"[writer] flush shard {self._shard_no}: {len(self._buf)} rows, ~{self._shard_chars} chars -> s3://{uri}")
        with self._fs.open_output_stream(uri) as sink:
            pq.write_table(
                table,
                sink,
                compression="zstd",
                compression_level=3,
                write_statistics=True,
            )
        self._paths.append(f"s3://{uri}")
        self._shard_no += 1
        self._buf.clear()
        self._shard_chars = 0
        # checkpoint after every shard so a crash mid-run is recoverable:
        # the next `--resume` restores these totals + the deduper seed.
        self._write_checkpoint()

    def _state_dict(self) -> dict:
        return {
            "bucket": self.bucket,
            "prefix": self.prefix,
            "shards": self._paths,
            "total_rows": self._total_rows,
            "total_chars": self._total_chars,
            "per_dataset": self._per_dataset,
        }

    def _write_checkpoint(self) -> None:
        """Persist current totals + shard list as the manifest (crash recovery)."""
        uri = f"{self.bucket}/{self.prefix}/_MANIFEST.json"
        data = json.dumps(self._state_dict(), ensure_ascii=False,
                          indent=2).encode("utf-8")
        try:
            with self._fs.open_output_stream(uri) as sink:
                sink.write(data)
        except Exception as e:
            if self.verbose:
                print(f"[writer] checkpoint write failed ({e})")

    def close(self) -> dict:
        self._flush()
        return self._state_dict()

    # ------------------------------------------------------------------ #
    def write_manifest(self, manifest: dict, extra: Optional[dict] = None) -> str:
        path = f"{self.prefix}/_MANIFEST.json"
        uri = f"{self.bucket}/{path}"
        payload = dict(manifest)
        if extra:
            payload.update(extra)
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        with self._fs.open_output_stream(uri) as sink:
            sink.write(data)
        if self.verbose:
            print(f"[writer] manifest -> s3://{uri}")
        return f"s3://{uri}"

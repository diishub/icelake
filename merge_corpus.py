#!/usr/bin/env python
"""Re-merge all CPT shards on RustFS into a single local parquet file.

Reads shard-by-shard (not a single streaming scanner) so a transient RustFS
network blip only costs a per-shard retry, not the whole merge. Each shard is
streamed row-group-by-row-group so a multi-GB corpus never sits in RAM all at
once (the Docker lakehouse stack already eats most of the box's memory).
Replaces the stale 1B-char single-file copy.
"""
import os
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.fs as fs
from dotenv import load_dotenv

load_dotenv()

ENDPOINT = os.environ["RUSTFS_ENDPOINT"].replace("http://", "").replace("https://", "")
BUCKET = os.environ["RUSTFS_BUCKET"]
PREFIX = "cpt/thaillm"
OUT = Path("output/cpt_thaillm_corpus.parquet")
OUT.parent.mkdir(parents=True, exist_ok=True)

MAX_RETRIES = 6

s3 = fs.S3FileSystem(
    endpoint_override=ENDPOINT,
    access_key=os.environ["RUSTFS_ACCESS_KEY"],
    secret_key=os.environ["RUSTFS_SECRET_KEY"],
    scheme="http",
)

# Enumerate shard files (sorted) so progress is deterministic + resumable.
selector = fs.FileSelector(f"{BUCKET}/{PREFIX}")
files = sorted(
    f"{BUCKET}/{PREFIX}/{p.base_name}"
    for p in s3.get_file_info(selector)
    if p.base_name.startswith("part-") and p.base_name.endswith(".parquet")
)
print(f"[merge] source: s3://{BUCKET}/{PREFIX}/  ({len(files)} shards)")
if not files:
    raise SystemExit("no part-*.parquet shards found")

# Probe schema from the first shard.
with s3.open_input_file(files[0]) as f:
    schema = pq.ParquetFile(f).schema_arrow
print(f"[merge] schema: {schema.names}")
print(f"[merge] output: {OUT}  (zstd, batch=4096, per-shard retry x{MAX_RETRIES})")

writer = pq.ParquetWriter(str(OUT), schema, compression="zstd")
total_rows = 0
rg = 0
try:
    for i, path in enumerate(files):
        shard_rows = 0
        # Per-shard retry loop: a RustFS GetObject can short-read once then
        # succeed on the next attempt.
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                with s3.open_input_file(path) as f:
                    pf = pq.ParquetFile(f)
                    for batch in pf.iter_batches(batch_size=4096, columns=schema.names):
                        if batch.num_rows == 0:
                            continue
                        writer.write_table(pa.Table.from_batches([batch], schema=schema))
                        total_rows += batch.num_rows
                        shard_rows += batch.num_rows
                        rg += 1
                break  # shard done
            except (OSError, pa.ArrowIOError) as e:
                if attempt == MAX_RETRIES:
                    raise
                wait = 5 * attempt
                print(f"[merge]   shard {i} ({path.split('/')[-1]}) read failed "
                      f"attempt {attempt}/{MAX_RETRIES}: {e}; retrying in {wait}s")
                time.sleep(wait)
        print(f"[merge]   {i+1}/{len(files)} {path.split('/')[-1]}: "
              f"+{shard_rows:,} rows (total {total_rows:,}, {rg} row-groups)")
finally:
    writer.close()

size = OUT.stat().st_size
print(f"[merge] DONE: {rg} row-groups, {total_rows:,} rows, "
      f"{size/1e6:.1f} MB -> {OUT}")

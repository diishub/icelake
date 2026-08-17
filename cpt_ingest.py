#!/usr/bin/env python3
"""CPT corpus ingestion CLI.

Runs the source-agnostic pipeline that scrapes Thai text corpora, cleans them,
deduplicates (exact + fuzzy), and writes sharded zstd parquet into RustFS.

Usage::

    python cpt_ingest.py login                         # one-time headless login
    python cpt_ingest.py run --source thaillm --dry-run
    python cpt_ingest.py run --source thaillm --target 5000000
    python cpt_ingest.py run --resume

Environment (see .env): THAILLM_USERNAME, THAILLM_PASSWORD, RUSTFS_ENDPOINT,
RUSTFS_ACCESS_KEY, RUSTFS_SECRET_KEY, CPT_OUTPUT_BUCKET, CPT_OUTPUT_PREFIX,
CPT_TARGET_CHARS.

This script is a peer to ``auto_ingest.py`` / ``multimodal_pipeline.py`` and
runs on the host (not in a container). It writes parquet straight to RustFS
via pyarrow's S3 filesystem and does NOT register tables in Iceberg/Trino.
"""
from __future__ import annotations

import argparse
import os
import sys

# UTF-8 for Thai on the Windows console
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SCRATCH_DIR = os.path.join(BASE_DIR, "data", "incoming", "landing", "thaillm")

# pipeline + sources live next to this file
sys.path.insert(0, BASE_DIR)
from sources.base import Source  # noqa: E402
from sources.thaillm import ThaiLLMSource  # noqa: E402
from pipeline.session import Session  # noqa: E402
from pipeline.clean import clean_record  # noqa: E402
from pipeline.dedupe import Deduper  # noqa: E402
from pipeline.parquet_writer import ParquetWriter  # noqa: E402


SOURCES: dict[str, type[Source]] = {
    "thaillm": ThaiLLMSource,
}


def _load_env() -> dict:
    """Load .env values, preferring real environment variables."""
    env_path = os.path.join(BASE_DIR, ".env")
    values = {}
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip()
    # real env wins
    for k in list(values):
        if os.environ.get(k):
            values[k] = os.environ[k]
    return values


def _build_source(name: str, session, verbose: bool) -> Source:
    if name not in SOURCES:
        raise SystemExit(f"unknown source '{name}'. available: {', '.join(SOURCES)}")
    return SOURCES[name](session, verbose=verbose)


# ---------------------------------------------------------------------- #
# commands
# ---------------------------------------------------------------------- #
def cmd_login(args, env: dict) -> int:
    # ThaiLLM login uses ThaiID (national digital identity) -- there is no site
    # password, so we open a visible browser and let the user authenticate.
    session = Session(verbose=True)
    ok = session.login_via_browser()
    if not ok:
        print("\nFallback: log in with a normal browser, export cookies as JSON")
        print("(e.g. with an 'EditThisCookie'-style extension), then run:")
        print("  python -c \"from pipeline.session import Session; s=Session(); s.load_cookies_file('cookies.json')\"")
        return 1
    return 0


def cmd_run(args, env: dict) -> int:
    verbose = not args.quiet
    target = args.target if args.target is not None else int(env.get("CPT_TARGET_CHARS", "1000000000"))
    skip_ids = {s.strip() for s in (args.skip_datasets or "").split(",") if s.strip()}

    session = Session(verbose=verbose)
    source = _build_source(args.source, session, verbose=verbose)

    # 1. discover
    print(f"\n=== discover ({source.name}) ===")
    datasets = source.discover()
    if not datasets:
        print("No datasets found. The site may be blocking the request (Cloudflare).")
        return 1
    total_chars_estimate = 0
    for ds in datasets:
        print(f"  {ds}")
    print(f"  ({len(datasets)} dataset(s))")

    if args.dry_run:
        print("\n[--dry-run] no downloads. Done.")
        return 0

    # 2. authenticate
    print("\n=== authenticate ===")
    if not session.load():
        try:
            session.login_via_browser()
        except RuntimeError as e:
            print(f"Login failed: {e}")
            print("Tip: run `python cpt_ingest.py login` first, or use the manual")
            print("     cookie export fallback (Session.load_cookies_file).")
            return 1
    # make sure the adapter knows the session is ready
    source.authenticate(session)

    # 3. set up writer
    writer = ParquetWriter(
        bucket=env.get("CPT_OUTPUT_BUCKET", "psu-lakehouse"),
        prefix=env.get("CPT_OUTPUT_PREFIX", "cpt/thaillm"),
        endpoint=env.get("RUSTFS_ENDPOINT", "http://localhost:9000"),
        access_key=env.get("RUSTFS_ACCESS_KEY", "change-me"),
        secret_key=env.get("RUSTFS_SECRET_KEY", "change-me"),
        shard_chars=int(env.get("CPT_SHARD_CHARS", "100000000")),
        target=target,
        verbose=verbose,
        resume=args.resume,
    )

    deduper = Deduper(fuzzy=args.fuzzy)
    if args.fuzzy and verbose:
        print("  [dedupe] fuzzy (MinHash-LSH) dedup ENABLED -- memory grows with"
              " corpus size; only safe for small runs.")
    elif verbose:
        print("  [dedupe] exact (MD5) dedup only -- bounded memory, safe for any size.")

    # 3b. on resume, seed the deduper from already-written shards so that
    # re-processed files are recognized as duplicates and skipped (no
    # duplicate output, no double-counting toward the char budget).
    if args.resume:
        # already reached target in a previous run? short-circuit before
        # the (potentially expensive) deduper seed.
        if writer.is_target_reached():
            print("  [target already reached in a prior run] finishing.")
            return _finish(writer, deduper, target)
        seeded = 0
        for rec in writer.iter_existing_records():
            deduper.seed(rec)
            seeded += 1
        if seeded and verbose:
            print(f"  [resume] seeded deduper from {seeded:,} existing record(s)")

    # 4. download -> normalize -> clean -> dedup -> write
    print(f"\n=== ingest (target {target:,} chars) ===")
    for ds in datasets:
        print(f"\n--- {ds} ---")
        if ds.id in skip_ids:
            print(f"  [skip] dataset {ds.id} {ds.name} — already in shards (--skip-datasets)")
            continue
        try:
            files = source.list_files(ds)
        except Exception as e:
            print(f"  [skip] list_files failed: {e}")
            continue
        if not files:
            print("  (no files)")
            continue
        ds_dir = os.path.join(SCRATCH_DIR, ds.id)
        for fref in files:
            try:
                raw_path = source.fetch(fref, ds_dir)
            except Exception as e:
                print(f"  [skip] fetch {fref.name}: {e}")
                continue
            kept = 0
            target_reached = False
            for rec in source.normalize(raw_path, ds):
                cleaned = clean_record(rec)
                if cleaned is None:
                    continue
                if not deduper.add(cleaned):
                    continue
                if not writer.write(cleaned):
                    # target reached mid-file -- stop, but still delete the
                    # raw file below before returning so scratch stays bounded.
                    print("  [target reached] stopping.")
                    target_reached = True
                    break
                kept += 1
            print(f"  {fref.name}: kept {kept} record(s) after clean+dedup")
            # bound scratch disk: the raw file is fully processed into the
            # parquet shards now, so delete it unless --keep-raw. (On a crash
            # the next --resume re-downloads; the deduper seed from the
            # written shards still prevents duplicate output.) This runs even
            # on the target-reaching file (break, not return) so the last file
            # doesn't leak to scratch.
            if not args.keep_raw:
                try:
                    os.remove(raw_path)
                except OSError:
                    pass
            if target_reached:
                return _finish(writer, deduper, target)

    return _finish(writer, deduper, target)


def _finish(writer: ParquetWriter, deduper: Deduper, target: int) -> int:
    print("\n=== finalize ===")
    summary = writer.close()
    summary["target"] = target
    summary["target_reached"] = summary["total_chars"] >= target
    summary["dedup"] = deduper.stats()
    manifest_uri = writer.write_manifest(summary)
    print(f"\nDONE.")
    print(f"  rows:       {summary['total_rows']:,}")
    print(f"  chars:      {summary['total_chars']:,} / {target:,}")
    print(f"  shards:     {len(summary['shards'])}")
    print(f"  dedup:      {summary['dedup']}")
    print(f"  manifest:   {manifest_uri}")
    return 0


# ---------------------------------------------------------------------- #
def main() -> int:
    env = _load_env()
    parser = argparse.ArgumentParser(description="CPT corpus ingestion pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="one-time headless browser login to ThaiLLM")
    p_login.set_defaults(func=cmd_login)

    p_run = sub.add_parser("run", help="discover, download, clean, dedup, write")
    p_run.add_argument("--source", default="thaillm", choices=list(SOURCES))
    p_run.add_argument("--target", type=int, default=None, help="char budget (default: CPT_TARGET_CHARS)")
    p_run.add_argument("--dry-run", action="store_true", help="discover only, report estimate")
    p_run.add_argument("--resume", action="store_true", help="skip files already downloaded")
    p_run.add_argument("--skip-datasets", default="",
                       help="comma-separated dataset IDs to skip entirely on resume "
                            "(records already in shards); e.g. --skip-datasets 8,18")
    p_run.add_argument("--fuzzy", action="store_true",
                       help="enable MinHash-LSH near-duplicate dedup (memory-heavy; "
                            "only for small runs -- millions of docs will exhaust RAM)")
    p_run.add_argument("--keep-raw", action="store_true",
                       help="keep downloaded raw files in scratch (default: delete "
                            "after processing to bound disk usage)")
    p_run.add_argument("--quiet", action="store_true")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    return args.func(args, env)


if __name__ == "__main__":
    sys.exit(main())

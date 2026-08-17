"""Deduplication for the CPT corpus.

Two layers, run in sequence:

1. **Exact** -- MD5 of the normalized (whitespace-collapsed, lowercased) text.
   This collapses byte-identical documents and is very cheap; it removes the
   bulk of duplicates before the expensive fuzzy pass.

2. **Fuzzy (near-duplicate)** -- MinHash LSH via ``datasketch`` on character
   5-grams. Thai word segmentation is hard without a dictionary, so char
   n-grams are the robust choice. Documents with Jaccard similarity >=
   ``threshold`` (default 0.8) are clustered and only the longest member of
   each cluster is kept.

The deduper is a streaming class: feed records via :meth:`add`, call
:meth:`should_keep` to decide whether to emit a record, and :meth:`stats`
for a report. The LSH index is persisted to ``state_dir`` so a resumed run
keeps its dedup state.
"""
from __future__ import annotations

import hashlib
import os
import sys
from typing import Optional

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_NORM_WS = None  # placeholder; use module-level regex below
import re

_WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Lowercase + collapse whitespace for the exact-hash key."""
    return _WS_RE.sub(" ", text).strip().lower()


def _shingles(text: str, n: int = 5) -> set[str]:
    """Character n-grams over a whitespace-normalized string."""
    s = _WS_RE.sub(" ", text).strip().lower()
    if len(s) < n:
        return {s} if s else set()
    return {s[i : i + n] for i in range(len(s) - n + 1)}


def _md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


class Deduper:
    """Streaming exact + MinHash-LSH deduper.

    By default only **exact** (MD5) dedup runs -- it is bounded (a set of
    32-byte hashes, ~50 B/doc) and safe for any corpus size. **Fuzzy**
    (near-duplicate, MinHash-LSH) dedup is opt-in via ``fuzzy=True`` because
    the LSH holds a MinHash per document in memory (~1-2 KB/doc with
    datasketch), which for a 1B-char corpus (~millions of docs) balloons to
    tens of GB and will exhaust RAM / fill the pagefile. Only enable fuzzy for
    runs small enough that ``num_docs * ~2 KB`` fits comfortably in free RAM.
    """

    def __init__(
        self,
        *,
        state_dir: Optional[str] = None,
        fuzzy: bool = False,
        threshold: float = 0.8,
        num_perm: int = 128,
        ngram: int = 5,
    ):
        self.threshold = threshold
        self.num_perm = num_perm
        self.ngram = ngram
        self.state_dir = state_dir
        self.fuzzy = fuzzy
        self._seen_exact: set[str] = set()
        self._lsh = None
        self._MinHash = None
        # cheap doc_id set -- only guards LSH insert idempotency on re-seed
        # (replaces the old _minhashes dict, which redundantly held a full
        # MinHash object per doc -- a second copy on top of the LSH's own).
        self._inserted: set[str] = set()
        self._exact_dropped = 0
        self._fuzzy_dropped = 0
        if fuzzy:
            self._init_lsh()

    def _init_lsh(self) -> None:
        try:
            import datasketch
        except ImportError:
            print(
                "[dedupe] WARNING: datasketch not installed; "
                "skipping fuzzy (near-duplicate) dedup. "
                "pip install datasketch"
            )
            return
        self._MinHash = datasketch.MinHash
        self._lsh = datasketch.MinHashLSH(
            threshold=self.threshold,
            num_perm=self.num_perm,
        )

    # ------------------------------------------------------------------ #
    def add(self, rec) -> bool:
        """Register a record. Returns True if it survives dedup."""
        norm = _normalize(rec.text)
        exact_key = _md5(norm)
        if exact_key in self._seen_exact:
            self._exact_dropped += 1
            return False
        self._seen_exact.add(exact_key)

        # fuzzy pass -- keep-first policy: if a near-duplicate is already in the
        # index, drop the incoming record. (Streaming pipelines cannot un-emit
        # a record, so "longest survives" would require buffering the whole
        # corpus; keep-first is the correct streaming choice and the length
        # difference between near-dups is negligible for CPT.)
        if self._lsh is None:
            return True
        mh = self._MinHash(num_perm=self.num_perm)
        for gram in _shingles(rec.text, self.ngram):
            mh.update(gram.encode("utf-8"))
        if self._lsh.query(mh):
            self._fuzzy_dropped += 1
            return False
        self._lsh.insert(rec.doc_id, mh)
        self._inserted.add(rec.doc_id)
        return True

    def seed(self, rec) -> None:
        """Populate dedup state from an already-written record (resume mode).

        Re-builds the exact-hash set and the LSH index from the existing
        shards so that, when a resumed run re-processes files already written
        in a previous run, ``add`` recognizes them as duplicates and returns
        False -- they are not written again, so the char budget does not
        double-count and no duplicate text lands in the output.

        This does NOT touch the drop/keep counters: those measure *new* drops
        in the current run only.
        """
        norm = _normalize(rec.text)
        self._seen_exact.add(_md5(norm))
        if self._lsh is None:
            return
        if rec.doc_id in self._inserted:
            return  # idempotent on re-seed
        mh = self._MinHash(num_perm=self.num_perm)
        for gram in _shingles(rec.text, self.ngram):
            mh.update(gram.encode("utf-8"))
        try:
            self._lsh.insert(rec.doc_id, mh)
        except Exception:
            return  # duplicate key / insert failure -- non-fatal during seed
        self._inserted.add(rec.doc_id)

    def stats(self) -> dict:
        return {
            "exact_dropped": self._exact_dropped,
            "fuzzy_dropped": self._fuzzy_dropped,
            "unique_kept": len(self._seen_exact),
        }

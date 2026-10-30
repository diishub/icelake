"""Source adapter contract + shared dataclasses.

A :class:`Source` is the pluggable boundary between the CPT pipeline and some
external origin of Thai text. The pipeline calls the adapter methods in order::

    discover()             -> list of datasets available at the source
    authenticate(session)  -> log in / refresh, cache session state
    list_files(dataset)    -> files inside one dataset (requires auth)
    fetch(file_ref, dest)  -> download one file to a local scratch dir
    normalize(path, ds)    -> iterator of CorpusRecord from a raw file

All downstream stages (clean / dedup / parquet_writer) consume
:class:`CorpusRecord` only, so adding a new source never touches them.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterator, Optional


@dataclass
class Dataset:
    """A single dataset exposed by a source."""

    id: str
    name: str
    topic: str = ""
    license: str = ""
    owner: str = ""
    url: str = ""
    extra: dict = field(default_factory=dict)

    def __str__(self) -> str:
        return f"[{self.id}] {self.name} ({self.topic or 'no-topic'})"


@dataclass
class FileRef:
    """A downloadable file inside a dataset."""

    dataset_id: str
    name: str
    url: str
    size: Optional[int] = None
    fmt: str = ""  # lowercased extension without the dot, e.g. "parquet"
    extra: dict = field(default_factory=dict)


@dataclass
class CorpusRecord:
    """One normalized text document in the corpus, source-agnostic."""

    source: str           # adapter name, e.g. "thaillm"
    dataset_id: str
    dataset_name: str
    topic: str
    license: str
    doc_id: str           # stable per-document id (hash or source id)
    text: str
    char_count: int = 0
    fetched_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )

    def __post_init__(self) -> None:
        if not self.char_count:
            self.char_count = len(self.text)


class Source(ABC):
    """Pluggable source adapter. See module docstring for the call order."""

    #: short identifier used as CorpusRecord.source and in CLI --source
    name: str = "base"

    @abstractmethod
    def discover(self) -> list[Dataset]:
        """Return every dataset available at this source."""

    @abstractmethod
    def authenticate(self, session) -> None:
        """Log in / refresh credentials, caching state into ``session``."""

    @abstractmethod
    def list_files(self, dataset: Dataset) -> list[FileRef]:
        """Return the downloadable files for one dataset (requires auth)."""

    @abstractmethod
    def fetch(self, file_ref: FileRef, dest_dir: str) -> str:
        """Download one file into ``dest_dir`` and return its local path.

        Must be resumable / idempotent: if the file already exists locally with
        the expected size, skip the download.
        """

    @abstractmethod
    def normalize(self, raw_path: str, dataset: Dataset) -> Iterator[CorpusRecord]:
        """Read a downloaded raw file and yield :class:`CorpusRecord` objects.

        Adapters auto-detect the text column from common names
        (``text`` / ``content`` / ``body`` / ``message`` / ``paragraph``).
        """

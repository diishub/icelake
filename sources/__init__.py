"""Source adapters for the CPT corpus ingestion pipeline.

Each adapter implements :class:`sources.base.Source` so that the pipeline
can pull corpora from any origin (ThaiLLM repository today; HuggingFace Thai,
CommonCrawl Thai later) without changing the downstream clean / dedup / write
stages.
"""
from sources.base import Source, Dataset, FileRef, CorpusRecord  # noqa: F401

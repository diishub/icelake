"""CPT corpus pipeline stages.

Each module is independent of the source adapter and consumes
:class:`sources.CorpusRecord`. Stages:

* :mod:`pipeline.session`   -- one-time browser login + cookie export,
                               then a cookie-authenticated bulk HTTP session.
* :mod:`pipeline.clean`     -- whitespace/HTML normalization, Thai-language
                               filter, drop short docs.
* :mod:`pipeline.dedupe`    -- exact MD5 dedup then MinHash LSH near-dup dedup.
* :mod:`pipeline.parquet_writer` -- sharded zstd parquet into RustFS via S3.
"""

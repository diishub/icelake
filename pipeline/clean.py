"""Text cleaning for the CPT corpus.

Steps applied per :class:`sources.CorpusRecord`:

1. Strip HTML tags (the news/document datasets carry inline markup).
2. Normalize whitespace (collapse runs, trim, unify newlines).
3. Drop documents shorter than ``min_chars`` (default 200).
4. Drop documents that are not Thai enough (``thai_ratio`` < ``min_thai_ratio``,
   default 0.30) -- counted as the share of characters in U+0E00..U+0E7F.

Returns a (possibly different) :class:`CorpusRecord` with cleaned text and an
updated ``char_count``, or ``None`` if the record was dropped.
"""
from __future__ import annotations

import html
import re
from sources.base import CorpusRecord

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_NL_RE = re.compile(r"\n{3,}")
_THAI_RE = re.compile(r"[฀-๿]")

# optional noise lines: URLs, emails, long runs of punctuation
_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def clean_text(
    text: str,
    *,
    strip_html: bool = True,
    strip_urls: bool = False,
    strip_emails: bool = False,
) -> str:
    if not text:
        return ""
    if strip_html:
        text = html.unescape(text)
        text = _TAG_RE.sub(" ", text)
    if strip_urls:
        text = _URL_RE.sub(" ", text)
    if strip_emails:
        text = _EMAIL_RE.sub(" ", text)
    # normalize whitespace
    text = _WS_RE.sub(" ", text)
    text = _NL_RE.sub("\n\n", text)
    # keep newlines but strip each line
    text = "\n".join(line.strip() for line in text.split("\n"))
    return text.strip()


def thai_ratio(text: str) -> float:
    if not text:
        return 0.0
    thai = len(_THAI_RE.findall(text))
    # count non-space characters only (avoid inflating the ratio denominator
    # with whitespace)
    non_space = sum(1 for c in text if not c.isspace())
    if non_space == 0:
        return 0.0
    return thai / non_space


def clean_record(
    rec: CorpusRecord,
    *,
    min_chars: int = 200,
    min_thai_ratio: float = 0.30,
    strip_html: bool = True,
    strip_urls: bool = False,
    strip_emails: bool = False,
) -> CorpusRecord | None:
    text = clean_text(
        rec.text,
        strip_html=strip_html,
        strip_urls=strip_urls,
        strip_emails=strip_emails,
    )
    if len(text) < min_chars:
        return None
    if thai_ratio(text) < min_thai_ratio:
        return None
    rec.text = text
    rec.char_count = len(text)
    return rec

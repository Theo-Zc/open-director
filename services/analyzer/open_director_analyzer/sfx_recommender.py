"""Zero-LLM bilingual SFX keyword matching recommender (MIT, derived from adudir-open)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_STOPWORDS_EN = frozenset({
    "the", "a", "an", "of", "to", "and", "or", "in", "on", "at", "for",
    "with", "from", "is", "are", "was", "were", "be", "been", "by", "as",
    "it", "this", "that", "his", "her", "him", "she", "he", "they", "them",
    "their", "we", "us", "you", "your", "my", "me", "i",
})

_STOPWORDS_ZH = frozenset({
    "的", "了", "在", "是", "和", "也", "都", "不", "就", "着", "把", "被",
    "让", "向", "从", "到", "她", "他", "它", "你", "我", "我们",
    "你们", "他们", "这", "那", "这个", "那个", "这些", "那些",
})

_TOKEN_RE = re.compile(r"[a-zA-Z]+|[\u4e00-\u9fff]+")


@dataclass
class SfxRecommendation:
    entry: Any
    score: float
    matched_tokens: list[str]


def _is_chinese(s: str) -> bool:
    return any("\u4e00" <= c <= "\u9fff" for c in s)


def _tokenize(text: str) -> list[str]:
    out: list[str] = []
    for match in _TOKEN_RE.finditer(text):
        tok = match.group(0).lower()
        if len(tok) < 2 and not _is_chinese(tok):
            continue
        if tok in _STOPWORDS_EN or tok in _STOPWORDS_ZH:
            continue
        out.append(tok)
    return out


def _entry_match_score(entry: Any, query_tokens: list[str]) -> tuple[float, list[str]]:
    title_lower = (
        (getattr(entry, "title", "") or "") + " " + (getattr(entry, "title_en", "") or "")
    ).lower()
    tags_lower = [t.lower() for t in (getattr(entry, "tags", []) or [])]
    category = (getattr(entry, "category", "") or "").lower()
    subcategory = (getattr(entry, "subcategory", "") or "").lower()
    usage_lower = " ".join(
        [getattr(entry, "description", "") or ""] + list(getattr(entry, "use_for", []) or [])
    ).lower()

    hits = 0.0
    matched: list[str] = []

    for tok in query_tokens:
        if tok in tags_lower:
            hits += 2.0
            matched.append(tok)
            continue
        if _is_chinese(tok):
            chinese_tag_match = False
            for tag in tags_lower:
                if _is_chinese(tag) and (tag in tok or tok in tag):
                    hits += 2.0
                    matched.append(tag)
                    chinese_tag_match = True
                    break
            if chinese_tag_match:
                continue
        if tok == category or (subcategory and tok in subcategory):
            hits += 1.0
            matched.append(tok)
            continue
        if tok in title_lower:
            hits += 1.0
            matched.append(tok)
            continue
        if usage_lower and (tok in usage_lower or (
            _is_chinese(tok)
            and len(tok) >= 4
            and sum(tok[i:i + 2] in usage_lower for i in range(len(tok) - 1)) >= max(2, (len(tok) - 1) // 2)
        )):
            hits += 0.75
            matched.append(tok)
            continue

    max_score = max(1.0, len(query_tokens) * 2.0)
    return hits / max_score, matched


def recommend_sfx_by_query(
    query: str,
    catalog: list[Any],
    *,
    top_k: int = 5,
    category_filter: str | None = None,
) -> list[SfxRecommendation]:
    tokens = _tokenize(query)
    if not tokens:
        return []

    candidates = [
        e for e in catalog
        if not category_filter or getattr(e, "category", "") == category_filter
    ]
    if not candidates:
        return []

    scored: list[SfxRecommendation] = []
    for entry in candidates:
        score, matched = _entry_match_score(entry, tokens)
        if score <= 0:
            continue
        scored.append(SfxRecommendation(entry=entry, score=score, matched_tokens=matched))

    scored.sort(
        key=lambda r: (
            -r.score,
            -(getattr(r.entry, "quality", 0) or 0),
            getattr(r.entry, "duration_sec", 0.0) or 999.0,
        ),
    )

    seen_family: set[str] = set()
    first: list[SfxRecommendation] = []
    rest: list[SfxRecommendation] = []
    for r in scored:
        fam = getattr(r.entry, "family", "") or ""
        if fam and fam in seen_family:
            rest.append(r)
            continue
        if fam:
            seen_family.add(fam)
        first.append(r)
    return (first + rest)[:top_k]

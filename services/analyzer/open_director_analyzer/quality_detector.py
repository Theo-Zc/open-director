"""Timeline footage quality and topology check (MIT, derived from adudir-open)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .video_quality_types import QualityThresholds, VideoQualityReport

QualityReason = Literal[
    "black_frame",
    "blurry",
    "static_frame",
    "duplicate_asset",
    "long_gap",
    "flash_clip",
    "isolated_clip",
]
Severity = Literal["low", "medium", "high"]
DetectionMode = Literal["aggressive", "temperate", "conservative"]
QualityAction = Literal["keep", "remove"]


@dataclass
class TimelineClipForQuality:
    clip_id: str
    timeline_start_sec: float
    duration_sec: float
    asset_id: str | None
    trim_start_sec: float = 0.0
    trim_end_sec: float = 0.0
    is_locked: bool = False
    has_audio_or_video: bool = True
    track_index: int = 0


@dataclass
class QualityMark:
    id: str
    reason: QualityReason
    severity: Severity
    start_sec: float
    end_sec: float
    description: str
    suggested_action: QualityAction = "remove"
    related_clip_ids: list[str] | None = None


_MODE_THRESHOLDS: dict[DetectionMode, QualityThresholds] = {
    "aggressive": QualityThresholds(24.0, 120.0, 2.0, 0.25),
    "temperate": QualityThresholds(16.0, 80.0, 1.0, 0.40),
    "conservative": QualityThresholds(10.0, 40.0, 0.5, 0.80),
}


@dataclass
class MetadataThresholds:
    long_gap_sec: float
    flash_clip_sec: float
    isolation_sec: float


_METADATA_THRESHOLDS: dict[DetectionMode, MetadataThresholds] = {
    "aggressive": MetadataThresholds(long_gap_sec=1.5, flash_clip_sec=0.50, isolation_sec=4.0),
    "temperate": MetadataThresholds(long_gap_sec=2.5, flash_clip_sec=0.30, isolation_sec=6.0),
    "conservative": MetadataThresholds(long_gap_sec=4.0, flash_clip_sec=0.15, isolation_sec=10.0),
}


def get_mode_thresholds(mode: DetectionMode) -> QualityThresholds:
    return _MODE_THRESHOLDS.get(mode, _MODE_THRESHOLDS["temperate"])


def get_metadata_thresholds(mode: DetectionMode) -> MetadataThresholds:
    return _METADATA_THRESHOLDS.get(mode, _METADATA_THRESHOLDS["temperate"])


def _severity_from_score(score: float, *, weight: float = 1.0) -> Severity:
    s = score * weight
    if s >= 0.7:
        return "high"
    if s >= 0.4:
        return "medium"
    return "low"


def report_to_marks(*, clip: TimelineClipForQuality, report: VideoQualityReport) -> list[QualityMark]:
    out: list[QualityMark] = []
    base = clip.timeline_start_sec
    for seg in report.black_segments:
        dur = seg.end_sec - seg.start_sec
        out.append(QualityMark(
            id=f"black-{clip.clip_id}-{int(seg.start_sec * 1000)}",
            reason="black_frame",
            severity=_severity_from_score(seg.score, weight=1.2),
            start_sec=base + seg.start_sec,
            end_sec=base + seg.end_sec,
            description=f"{dur:.1f}s black / underexposed segment",
            suggested_action="remove",
            related_clip_ids=[clip.clip_id],
        ))
    for seg in report.blurry_segments:
        dur = seg.end_sec - seg.start_sec
        out.append(QualityMark(
            id=f"blur-{clip.clip_id}-{int(seg.start_sec * 1000)}",
            reason="blurry",
            severity=_severity_from_score(seg.score, weight=0.8),
            start_sec=base + seg.start_sec,
            end_sec=base + seg.end_sec,
            description=f"{dur:.1f}s blurry / out-of-focus segment",
            suggested_action="keep",
            related_clip_ids=[clip.clip_id],
        ))
    for seg in report.static_segments:
        dur = seg.end_sec - seg.start_sec
        out.append(QualityMark(
            id=f"static-{clip.clip_id}-{int(seg.start_sec * 1000)}",
            reason="static_frame",
            severity=_severity_from_score(seg.score, weight=0.8),
            start_sec=base + seg.start_sec,
            end_sec=base + seg.end_sec,
            description=f"{dur:.1f}s static frame segment",
            suggested_action="keep",
            related_clip_ids=[clip.clip_id],
        ))
    return out


def detect_duplicate_assets(clips: list[TimelineClipForQuality]) -> list[QualityMark]:
    seen: dict[tuple[str, int, int], TimelineClipForQuality] = {}
    out: list[QualityMark] = []
    for c in sorted(clips, key=lambda item: item.timeline_start_sec):
        if c.is_locked or not c.has_audio_or_video or not c.asset_id:
            continue
        key = (c.asset_id, int(round(c.trim_start_sec * 100)), int(round(c.duration_sec * 100)))
        first = seen.get(key)
        if first is None:
            seen[key] = c
            continue
        out.append(QualityMark(
            id=f"dup-{c.clip_id}",
            reason="duplicate_asset",
            severity="medium",
            start_sec=c.timeline_start_sec,
            end_sec=c.timeline_start_sec + c.duration_sec,
            description=f"Duplicate trim range of asset already at {first.timeline_start_sec:.1f}s",
            suggested_action="keep",
            related_clip_ids=[c.clip_id, first.clip_id],
        ))
    return out


def _by_track(clips: list[TimelineClipForQuality]) -> dict[int, list[TimelineClipForQuality]]:
    out: dict[int, list[TimelineClipForQuality]] = {}
    for c in clips:
        out.setdefault(c.track_index, []).append(c)
    for arr in out.values():
        arr.sort(key=lambda item: item.timeline_start_sec)
    return out


def detect_long_gaps(clips: list[TimelineClipForQuality], *, min_gap_sec: float = 2.5) -> list[QualityMark]:
    out: list[QualityMark] = []
    for ti, arr in _by_track(clips).items():
        usable = [c for c in arr if not c.is_locked]
        for prev, cur in zip(usable, usable[1:]):
            prev_end = prev.timeline_start_sec + prev.duration_sec
            gap = cur.timeline_start_sec - prev_end
            if gap <= min_gap_sec:
                continue
            sev: Severity = "high" if gap > min_gap_sec * 3 else "medium" if gap > min_gap_sec * 1.8 else "low"
            out.append(QualityMark(
                id=f"gap-{ti}-{int(round(prev_end * 1000))}",
                reason="long_gap",
                severity=sev,
                start_sec=prev_end,
                end_sec=cur.timeline_start_sec,
                description=f"{gap:.1f}s blank gap on track {ti + 1}",
                suggested_action="keep",
                related_clip_ids=[prev.clip_id, cur.clip_id],
            ))
    return out


def detect_flash_clips(clips: list[TimelineClipForQuality], *, max_clip_sec: float = 0.30) -> list[QualityMark]:
    out: list[QualityMark] = []
    for c in clips:
        if c.is_locked or not c.has_audio_or_video or c.duration_sec >= max_clip_sec:
            continue
        sev: Severity = "high" if c.duration_sec < max_clip_sec * 0.5 else "medium"
        out.append(QualityMark(
            id=f"flash-{c.clip_id}",
            reason="flash_clip",
            severity=sev,
            start_sec=c.timeline_start_sec,
            end_sec=c.timeline_start_sec + c.duration_sec,
            description=f"{c.duration_sec:.2f}s flash fragment clip",
            suggested_action="remove",
            related_clip_ids=[c.clip_id],
        ))
    return out


def detect_isolated_clips(
    clips: list[TimelineClipForQuality],
    *,
    isolation_sec: float = 6.0,
    overlay_min_track: int = 1,
) -> list[QualityMark]:
    out: list[QualityMark] = []
    for ti, arr in _by_track(clips).items():
        if ti < overlay_min_track:
            continue
        usable = [c for c in arr if not c.is_locked and c.has_audio_or_video]
        if len(usable) < 2:
            continue
        for i, c in enumerate(usable):
            prev_gap = (
                c.timeline_start_sec - (usable[i - 1].timeline_start_sec + usable[i - 1].duration_sec)
                if i > 0 else float("inf")
            )
            next_gap = (
                usable[i + 1].timeline_start_sec - (c.timeline_start_sec + c.duration_sec)
                if i + 1 < len(usable) else float("inf")
            )
            nearest = min(prev_gap, next_gap)
            if nearest <= isolation_sec:
                continue
            out.append(QualityMark(
                id=f"isolated-{c.clip_id}",
                reason="isolated_clip",
                severity="low",
                start_sec=c.timeline_start_sec,
                end_sec=c.timeline_start_sec + c.duration_sec,
                description=f"Isolated overlay clip on track {ti + 1} ({nearest:.1f}s away from neighbors)",
                suggested_action="keep",
                related_clip_ids=[c.clip_id],
            ))
    return out

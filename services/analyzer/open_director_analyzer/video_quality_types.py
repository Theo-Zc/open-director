from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class QualityThresholds:
    black_luminance_max: float = 16.0
    blur_laplacian_min: float = 80.0
    static_diff_max: float = 1.0
    min_segment_sec: float = 0.40


@dataclass
class QualitySegment:
    start_sec: float
    end_sec: float
    score: float


@dataclass
class VideoQualityReport:
    black_segments: list[QualitySegment] = field(default_factory=list)
    blurry_segments: list[QualitySegment] = field(default_factory=list)
    static_segments: list[QualitySegment] = field(default_factory=list)

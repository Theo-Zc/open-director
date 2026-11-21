"""Real image-buffer quality & dHash analyzer using Pillow + NumPy (no heavy OpenCV binary required)."""

from __future__ import annotations

import base64
import io
from typing import Iterable

import numpy as np
from PIL import Image

from .quality_detector import DetectionMode, get_mode_thresholds
from .video_quality_types import QualitySegment, VideoQualityReport


def _decode_gray(raw_b64: str) -> np.ndarray:
    payload = raw_b64.split(",", 1)[-1]
    img_bytes = base64.b64decode(payload)
    img = Image.open(io.BytesIO(img_bytes)).convert("L")
    return np.asarray(img, dtype=np.float32)


def compute_dhash_from_b64(raw_b64: str) -> int:
    """Compute a 64-bit dHash integer directly from an encoded PNG/JPEG frame."""
    payload = raw_b64.split(",", 1)[-1]
    img_bytes = base64.b64decode(payload)
    img = Image.open(io.BytesIO(img_bytes)).convert("L").resize((9, 8), Image.Resampling.BILINEAR)
    arr = np.asarray(img, dtype=np.uint8)
    bits = 0
    for r in range(8):
        for c in range(8):
            if int(arr[r, c]) < int(arr[r, c + 1]):
                bits |= 1 << (r * 8 + c)
    return bits


def analyze_frame_sequence(
    frames: Iterable[tuple[float, str]],
    mode: DetectionMode = "temperate",
) -> VideoQualityReport:
    """Measure luminance, Laplacian variance (blur), and inter-frame diff on sampled frames."""
    thresholds = get_mode_thresholds(mode)
    items = list(frames)
    if not items:
        return VideoQualityReport()

    black_segs: list[QualitySegment] = []
    blurry_segs: list[QualitySegment] = []
    static_segs: list[QualitySegment] = []

    prev_arr: np.ndarray | None = None
    prev_t: float = 0.0

    for idx, (t, b64) in enumerate(items):
        gray = _decode_gray(b64)
        next_t = items[idx + 1][0] if idx + 1 < len(items) else t + 0.5
        seg_end = max(t + 0.1, next_t)

        mean_luma = float(np.mean(gray))
        if mean_luma <= thresholds.black_luminance_max:
            score = min(1.0, (thresholds.black_luminance_max - mean_luma + 1.0) / max(1.0, thresholds.black_luminance_max))
            black_segs.append(QualitySegment(start_sec=t, end_sec=seg_end, score=score))

        # Discrete 2D Laplacian variance for sharpness/blur detection
        if gray.shape[0] >= 3 and gray.shape[1] >= 3:
            lap = (
                gray[:-2, 1:-1]
                + gray[2:, 1:-1]
                + gray[1:-1, :-2]
                + gray[1:-1, 2:]
                - 4.0 * gray[1:-1, 1:-1]
            )
            lap_var = float(np.var(lap))
            if lap_var < thresholds.blur_laplacian_min:
                score = min(1.0, (thresholds.blur_laplacian_min - lap_var) / max(1.0, thresholds.blur_laplacian_min))
                blurry_segs.append(QualitySegment(start_sec=t, end_sec=seg_end, score=score))

        if prev_arr is not None and prev_arr.shape == gray.shape:
            diff = float(np.mean(np.abs(gray - prev_arr)))
            if diff <= thresholds.static_diff_max:
                score = min(1.0, (thresholds.static_diff_max - diff + 0.1) / max(0.2, thresholds.static_diff_max))
                static_segs.append(QualitySegment(start_sec=prev_t, end_sec=t, score=score))

        prev_arr = gray
        prev_t = t

    return VideoQualityReport(
        black_segments=black_segs,
        blurry_segments=blurry_segs,
        static_segments=static_segs,
    )

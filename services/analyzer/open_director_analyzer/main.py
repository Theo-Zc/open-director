from __future__ import annotations

from dataclasses import asdict
from fastapi import FastAPI
from pydantic import BaseModel, Field

from .bgm_format import is_supported_bgm, unsupported_reason
from .finishing_loudness import TrackLoudnessInput, plan_loudness_batch
from .finishing_neardup import ClipHash, cluster_near_duplicates
from .frame_inspector import analyze_frame_sequence, compute_dhash_from_b64
from .quality_detector import (
    DetectionMode,
    TimelineClipForQuality,
    detect_duplicate_assets,
    detect_flash_clips,
    detect_isolated_clips,
    detect_long_gaps,
    get_metadata_thresholds,
    report_to_marks,
)
from .sfx_recommender import recommend_sfx_by_query

app = FastAPI(title="Open Director Analyzer", version="0.1.0")


class BgmCheckRequest(BaseModel):
    filename: str = ""
    remote_url: str = ""


class SfxEntryDTO(BaseModel):
    id: str
    title: str = ""
    title_en: str = ""
    tags: list[str] = Field(default_factory=list)
    category: str = ""
    subcategory: str = ""
    description: str = ""
    use_for: list[str] = Field(default_factory=list)
    duration_sec: float = 1.0
    quality: int = 0
    family: str = ""


class SfxRecommendRequest(BaseModel):
    query: str
    catalog: list[SfxEntryDTO]
    top_k: int = 5
    category_filter: str | None = None


class LoudnessTrackDTO(BaseModel):
    trackIndex: int
    role: str = "default"
    measuredLufs: float
    measuredTruePeakDbtp: float
    measuredLra: float | None = None


class LoudnessBatchRequest(BaseModel):
    tracks: list[LoudnessTrackDTO]


class ClipHashDTO(BaseModel):
    clipId: str
    dhash: int


class NearDupRequest(BaseModel):
    clips: list[ClipHashDTO]
    max_distance: int = 5


class QualityClipDTO(BaseModel):
    clip_id: str
    timeline_start_sec: float
    duration_sec: float
    asset_id: str | None = None
    trim_start_sec: float = 0.0
    trim_end_sec: float = 0.0
    is_locked: bool = False
    has_audio_or_video: bool = True
    track_index: int = 0


class QualityCheckRequest(BaseModel):
    clips: list[QualityClipDTO]
    mode: DetectionMode = "temperate"


class SampledFrameDTO(BaseModel):
    time_sec: float
    image_b64: str


class AnalyzeFramesRequest(BaseModel):
    clip_id: str
    timeline_start_sec: float = 0.0
    duration_sec: float = 1.0
    mode: DetectionMode = "temperate"
    frames: list[SampledFrameDTO]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "open-director-analyzer"}


@app.post("/v1/bgm/validate")
def bgm_validate(req: BgmCheckRequest) -> dict[str, object]:
    supported = is_supported_bgm(req.filename, req.remote_url)
    return {"supported": supported, "reason": unsupported_reason(req.filename, req.remote_url)}


@app.post("/v1/sfx/recommend")
def sfx_recommend(req: SfxRecommendRequest) -> dict[str, object]:
    recs = recommend_sfx_by_query(
        req.query,
        req.catalog,
        top_k=req.top_k,
        category_filter=req.category_filter,
    )
    return {
        "recommendations": [
            {"entry": r.entry.model_dump(), "score": r.score, "matched_tokens": r.matched_tokens}
            for r in recs
        ]
    }


@app.post("/v1/audio/loudness-plan")
def audio_loudness_plan(req: LoudnessBatchRequest) -> dict[str, object]:
    payload: list[TrackLoudnessInput] = [t.model_dump() for t in req.tracks]  # type: ignore[misc]
    return {"plans": plan_loudness_batch(payload)}


@app.post("/v1/video/near-duplicates")
def video_near_duplicates(req: NearDupRequest) -> dict[str, object]:
    payload: list[ClipHash] = [{"clipId": c.clipId, "dhash": c.dhash} for c in req.clips]
    return {"clusters": cluster_near_duplicates(payload, max_distance=req.max_distance)}


@app.post("/v1/video/quality-check")
def video_quality_check(req: QualityCheckRequest) -> dict[str, object]:
    clips = [TimelineClipForQuality(**c.model_dump()) for c in req.clips]
    meta = get_metadata_thresholds(req.mode)
    marks = [
        *detect_duplicate_assets(clips),
        *detect_long_gaps(clips, min_gap_sec=meta.long_gap_sec),
        *detect_flash_clips(clips, max_clip_sec=meta.flash_clip_sec),
        *detect_isolated_clips(clips, isolation_sec=meta.isolation_sec),
    ]
    return {"marks": [asdict(m) for m in marks]}


@app.post("/v1/video/analyze-frames")
def video_analyze_frames(req: AnalyzeFramesRequest) -> dict[str, object]:
    report = analyze_frame_sequence([(f.time_sec, f.image_b64) for f in req.frames], mode=req.mode)
    clip = TimelineClipForQuality(
        clip_id=req.clip_id,
        timeline_start_sec=req.timeline_start_sec,
        duration_sec=req.duration_sec,
        asset_id=None,
    )
    marks = report_to_marks(clip=clip, report=report)
    dhashes = [{"time_sec": f.time_sec, "dhash": str(compute_dhash_from_b64(f.image_b64))} for f in req.frames]
    return {"marks": [asdict(m) for m in marks], "dhashes": dhashes}

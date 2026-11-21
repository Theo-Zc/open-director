from __future__ import annotations

import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from open_director_analyzer.main import app

client = TestClient(app)


def test_health_and_bgm_validate() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"

    assert client.post("/v1/bgm/validate", json={"filename": "track.mp3"}).json()["supported"] is True
    bad = client.post("/v1/bgm/validate", json={"filename": "legacy.wma"}).json()
    assert bad["supported"] is False
    assert ".wma" in bad["reason"]


def test_loudness_plan() -> None:
    res = client.post(
        "/v1/audio/loudness-plan",
        json={
            "tracks": [
                {"trackIndex": 0, "role": "dialogue", "measuredLufs": -24.0, "measuredTruePeakDbtp": -2.0, "measuredLra": 5.0},
                {"trackIndex": 1, "role": "bgm", "measuredLufs": -14.0, "measuredTruePeakDbtp": -0.5, "measuredLra": 4.0},
            ]
        },
    )
    assert res.status_code == 200
    plans = res.json()["plans"]
    assert plans[0]["gainDb"] == 6.0
    assert plans[0]["needsLimiting"] is True
    assert plans[1]["targetLufs"] == -23.0


def test_sfx_recommend_and_quality_and_neardup() -> None:
    sfx = client.post(
        "/v1/sfx/recommend",
        json={
            "query": "门砰地关上",
            "catalog": [
                {"id": "1", "title": "木门重重关上", "tags": ["门", "关门"], "category": "impact", "duration_sec": 0.6, "quality": 2},
                {"id": "2", "title": "微风吹过", "tags": ["wind"], "category": "ambient", "duration_sec": 2.0, "quality": 1},
            ],
        },
    )
    assert sfx.status_code == 200
    assert sfx.json()["recommendations"][0]["entry"]["id"] == "1"

    dups = client.post(
        "/v1/video/near-duplicates",
        json={
            "clips": [
                {"clipId": "c1", "dhash": 0b10101010},
                {"clipId": "c2", "dhash": 0b10101011},
                {"clipId": "c3", "dhash": 0b00000000},
            ],
            "max_distance": 2,
        },
    )
    assert dups.json()["clusters"][0]["clipIds"] == ["c1", "c2"]

    qual = client.post(
        "/v1/video/quality-check",
        json={
            "mode": "temperate",
            "clips": [
                {"clip_id": "a", "timeline_start_sec": 0.0, "duration_sec": 0.1, "asset_id": "v1", "track_index": 0},
                {"clip_id": "b", "timeline_start_sec": 5.0, "duration_sec": 2.0, "asset_id": "v2", "track_index": 0},
            ],
        },
    )
    reasons = {m["reason"] for m in qual.json()["marks"]}
    assert "flash_clip" in reasons
    assert "long_gap" in reasons


def test_analyze_frames_detects_black_and_static_and_dhash() -> None:
    def make_png_b64(rgb: tuple[int, int, int]) -> str:
        buf = io.BytesIO()
        Image.new("RGB", (32, 32), rgb).save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")

    black_b64 = make_png_b64((2, 2, 2))
    res = client.post(
        "/v1/video/analyze-frames",
        json={
            "clip_id": "v1",
            "timeline_start_sec": 1.0,
            "duration_sec": 2.0,
            "mode": "temperate",
            "frames": [
                {"time_sec": 0.0, "image_b64": black_b64},
                {"time_sec": 0.5, "image_b64": black_b64},
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    reasons = {m["reason"] for m in body["marks"]}
    assert "black_frame" in reasons
    assert "static_frame" in reasons
    assert len(body["dhashes"]) == 2

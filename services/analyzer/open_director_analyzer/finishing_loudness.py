"""Deterministic loudness gain & true-peak planning (MIT, derived from adudir-open)."""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

TrackRole = Literal["dialogue", "dub", "bgm", "default"]
DynamicRangeFlag = Literal["ok", "too_wide", "too_compressed", "unknown"]

_LRA_WINDOW: dict[str, tuple[float, float]] = {
    "dialogue": (2.0, 9.0),
    "dub": (2.0, 8.0),
    "bgm": (3.0, 14.0),
    "default": (2.0, 11.0),
}

_TARGET_LUFS: dict[str, float] = {
    "dialogue": -18.0,
    "dub": -16.0,
    "bgm": -23.0,
    "default": -18.0,
}

TRUE_PEAK_CEILING_DBTP = -1.0


class GainPlan(TypedDict):
    role: str
    targetLufs: float
    measuredLufs: float
    gainDb: float
    truePeakAfterDbtp: float
    needsLimiting: bool
    measuredLra: float | None
    dynamicRangeFlag: str


class TrackLoudnessInput(TypedDict):
    trackIndex: int
    role: str
    measuredLufs: float
    measuredTruePeakDbtp: float
    measuredLra: NotRequired[float | None]


class TrackGainPlan(GainPlan):
    trackIndex: int


def target_lufs_for_role(role: str) -> float:
    return _TARGET_LUFS.get(role, _TARGET_LUFS["default"])


def classify_lra(measured_lra: float | None, role: str = "default") -> DynamicRangeFlag:
    if measured_lra is None:
        return "unknown"
    lo, hi = _LRA_WINDOW.get(role, _LRA_WINDOW["default"])
    if measured_lra > hi:
        return "too_wide"
    if measured_lra < lo:
        return "too_compressed"
    return "ok"


def plan_gain(
    measured_lufs: float,
    measured_true_peak_dbtp: float,
    role: str = "default",
    measured_lra: float | None = None,
) -> GainPlan:
    target = target_lufs_for_role(role)
    gain_db = target - measured_lufs
    tp_after = measured_true_peak_dbtp + gain_db
    return {
        "role": role,
        "targetLufs": target,
        "measuredLufs": measured_lufs,
        "gainDb": gain_db,
        "truePeakAfterDbtp": tp_after,
        "needsLimiting": tp_after > TRUE_PEAK_CEILING_DBTP + 1e-9,
        "measuredLra": measured_lra,
        "dynamicRangeFlag": classify_lra(measured_lra, role),
    }


def plan_loudness_batch(tracks: list[TrackLoudnessInput]) -> list[TrackGainPlan]:
    out: list[TrackGainPlan] = []
    for t in tracks:
        p = plan_gain(
            t["measuredLufs"],
            t["measuredTruePeakDbtp"],
            t.get("role", "default") or "default",
            t.get("measuredLra"),
        )
        out.append({**p, "trackIndex": t["trackIndex"]})
    return out

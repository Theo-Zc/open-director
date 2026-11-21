"""Cross-clip near-duplicate clustering via dHash Hamming distance (MIT, derived from adudir-open)."""

from __future__ import annotations

from typing import TypedDict


class ClipHash(TypedDict):
    clipId: str
    dhash: int


class DupCluster(TypedDict):
    clipIds: list[str]
    size: int
    maxDistance: int


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def cluster_near_duplicates(
    clips: list[ClipHash],
    max_distance: int = 5,
) -> list[DupCluster]:
    n = len(clips)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    for i in range(n):
        for j in range(i + 1, n):
            if hamming(clips[i]["dhash"], clips[j]["dhash"]) <= max_distance:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out: list[DupCluster] = []
    for root in sorted(groups.keys()):
        members = groups[root]
        if len(members) < 2:
            continue
        max_d = 0
        for a in range(len(members)):
            for b in range(a + 1, len(members)):
                d = hamming(clips[members[a]]["dhash"], clips[members[b]]["dhash"])
                max_d = max(max_d, d)
        out.append({
            "clipIds": [clips[m]["clipId"] for m in members],
            "size": len(members),
            "maxDistance": max_d,
        })
    return out

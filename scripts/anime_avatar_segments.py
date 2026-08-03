#!/usr/bin/env python3
"""Plan cacheable anime-avatar units without cutting continuous speech."""

from __future__ import annotations

from typing import Protocol, Sequence


class TimedSpeechUnit(Protocol):
    start: float
    end: float


def _split_long_silence(
    start: int,
    end: int,
    target_frames: int,
) -> list[int]:
    """Return internal boundaries for silence while avoiding tiny tail units."""
    duration = end - start
    if duration <= target_frames:
        return []
    count = max(2, (duration + target_frames - 1) // target_frames)
    return [start + round(duration * index / count) for index in range(1, count)]


def plan_unit_ranges(
    units: Sequence[TimedSpeechUnit],
    total_frames: int,
    fps: int,
    target_unit_seconds: float,
    maximum_continuous_unit_seconds: float,
    split_silence_seconds: float,
) -> list[tuple[int, int]]:
    """Split only inside reviewed silence and keep continuous phrases intact.

    ``target_unit_seconds`` is a cache-granularity target, not permission to cut
    an active utterance. A continuous region may exceed that target up to the
    explicit hard limit. Longer uninterrupted speech must be fixed upstream or
    handled by a future context-overlap contract; silently cutting it would make
    a unit start mid-viseme and corrupt the visible motion.
    """
    if total_frames < 4:
        raise ValueError("角色总帧数必须至少为四帧")
    if fps <= 0:
        raise ValueError("角色分段 fps 必须大于零")
    if maximum_continuous_unit_seconds < target_unit_seconds:
        raise ValueError("连续讲话硬上限不能短于目标单元长度")

    target_frames = max(4, int(round(target_unit_seconds * fps)))
    maximum_continuous_frames = max(
        target_frames,
        int(round(maximum_continuous_unit_seconds * fps)),
    )
    minimum_gap = float(split_silence_seconds)
    safe_boundaries = {0, total_frames}
    silent_regions: list[tuple[int, int]] = []

    for left, right in zip(units, units[1:]):
        gap = max(0.0, float(right.start) - float(left.end))
        if gap + 1e-9 < minimum_gap:
            continue
        silence_start = max(0, min(total_frames, int(round(left.end * fps))))
        silence_end = max(
            silence_start,
            min(total_frames, int(round(right.start * fps))),
        )
        if silence_end - silence_start < 4:
            continue
        safe_boundaries.update((silence_start, silence_end))
        silent_regions.append((silence_start, silence_end))

    for silence_start, silence_end in silent_regions:
        safe_boundaries.update(
            _split_long_silence(silence_start, silence_end, target_frames)
        )

    boundaries = sorted(safe_boundaries)
    # A boundary may quantize close to the beginning or end. Removing a boundary
    # only merges across reviewed silence; it never invents a speech cut.
    index = 1
    while index < len(boundaries):
        if boundaries[index] - boundaries[index - 1] >= 4:
            index += 1
            continue
        if index == len(boundaries) - 1:
            boundaries.pop(index - 1)
            index = max(1, index - 1)
        else:
            boundaries.pop(index)

    ranges = list(zip(boundaries, boundaries[1:]))
    for start, end in ranges:
        overlaps_speech = any(
            float(unit.end) * fps > start + 1e-9
            and float(unit.start) * fps < end - 1e-9
            for unit in units
        )
        if overlaps_speech and end - start > maximum_continuous_frames:
            raise RuntimeError(
                "连续讲话区间超过 render.maximum_continuous_unit_seconds，"
                f"无法在不切断发音的前提下分段：{start / fps:.3f}s–"
                f"{end / fps:.3f}s。请增加真实停顿或明确提高连续讲话硬上限。"
            )
    if any(end - start < 4 for start, end in ranges):
        raise RuntimeError("角色分段短于接缝预检所需的四帧上下文")
    return ranges

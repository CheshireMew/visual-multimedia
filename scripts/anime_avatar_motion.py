"""Schedule AI-reviewed gesture and idle clips on a speech timeline.

This module intentionally works above individual source frames.  Dense vowel
nuclei become explicit coarticulation clusters, stable pauses become continuous
idle blocks, and source motion is used only through reviewed low→peak→low clips
and directed natural transitions recorded in the visual-viseme library.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from typing import Any, Mapping, Sequence

import numpy as np

from anime_avatar_common import VISEMES


VOWEL_VISEMES = tuple(viseme for viseme in VISEMES if viseme != "CLOSED")
_CLOSED_LEVEL_THRESHOLD = 0.35
_MIN_SOURCE_SPEED = 0.12
_MAX_SOURCE_SPEED = 2.0
_MAX_SOURCE_ACCELERATION = 1.25
_MIN_EVENT_INTERVAL_AT_24_FPS = 8
_BEAM_WIDTH = 256
_BEAM_PORTFOLIO_PER_EXIT = 2
_STRENGTH_NEAR_BEST_MARGIN = 0.35
_DIVERSITY_WINDOW = 5
_MAX_MATCHED_GESTURE_ENDPOINT_LEVEL = 2
_MATCHED_SAME_VISEME_TRANSITION_REWARD = 8.0


@dataclass(frozen=True)
class Clip:
    id: str
    kind: str
    viseme: str
    take: int
    start: int
    end: int
    entry: int
    exit: int
    peak_start: int | None = None
    peak_end: int | None = None
    peak_strength_level: float = 0.0
    low_entries: tuple[int, ...] = ()
    low_exits: tuple[int, ...] = ()

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass(frozen=True)
class AnchorEvent:
    frame: int
    viseme: str
    level: float
    vowel_duration: int
    prominence: float


@dataclass(frozen=True)
class CoarticulationCluster:
    index: int
    events: tuple[AnchorEvent, ...]
    primary: AnchorEvent


@dataclass(frozen=True)
class Block:
    index: int
    kind: str
    start: int
    end: int
    viseme: str
    anchor: int | None
    target_peak_level: float
    cluster_index: int | None = None
    anchor_events: tuple[AnchorEvent, ...] = ()

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass(frozen=True)
class Option:
    id: str
    block_index: int
    clip: Clip
    source_positions: np.ndarray
    source_entry: int
    source_peak: int | None
    source_exit: int
    entry_level: int
    exit_level: int
    source_speed_min: float
    source_speed_max: float
    source_acceleration_max: float
    target_strength_error: float

    @property
    def key(self) -> str:
        peak = "none" if self.source_peak is None else str(self.source_peak)
        return (
            f"{self.clip.id}|entry={self.source_entry}|peak={peak}|"
            f"exit={self.source_exit}|entry_level={self.entry_level}|"
            f"exit_level={self.exit_level}"
        )


@dataclass(frozen=True)
class Transition:
    kind: str
    from_clip_id: str
    to_clip_id: str
    from_option_key: str
    to_option_key: str
    from_source_exit: int
    to_source_entry: int
    output_frame: int
    boundary: bool
    static_rms: float | None
    velocity_rms: float | None
    normalized_cost: float
    natural_span: tuple[int, int] | None = None

    def report(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "from_clip_id": self.from_clip_id,
            "to_clip_id": self.to_clip_id,
            "from_option_key": self.from_option_key,
            "to_option_key": self.to_option_key,
            "option_pair_key": [
                self.from_option_key,
                self.to_option_key,
            ],
            "from_source_exit": self.from_source_exit,
            "to_source_entry": self.to_source_entry,
            "output_frame": self.output_frame,
            "boundary": self.boundary,
            "static_descriptor_rms": (
                round(self.static_rms, 8)
                if self.static_rms is not None
                else None
            ),
            "motion_velocity_rms": (
                round(self.velocity_rms, 8)
                if self.velocity_rms is not None
                else None
            ),
            "normalized_compatibility_cost": round(
                self.normalized_cost,
                6,
            ),
            "natural_span": (
                list(self.natural_span)
                if self.natural_span is not None
                else None
            ),
        }


@dataclass(frozen=True)
class BeamState:
    cost: float
    options: tuple[Option, ...]
    transitions: tuple[Transition, ...]
    last_boundary_frame: int | None
    gesture_clip_ids: frozenset[str]
    gesture_take_ids: frozenset[int]
    viseme_clip_ids: frozenset[tuple[str, str]]
    viseme_take_ids: frozenset[tuple[str, int]]
    recent_gesture_clip_ids: tuple[str, ...]


@dataclass(frozen=True)
class DiversityPolicy:
    gesture_block_count: int
    available_clip_ids: frozenset[str]
    available_take_ids: frozenset[int]
    available_clip_ids_by_viseme: Mapping[str, frozenset[str]]
    available_take_ids_by_viseme: Mapping[str, frozenset[int]]
    required_unique_clip_count: int
    required_unique_take_count: int
    required_unique_clip_count_by_viseme: Mapping[str, int]
    required_unique_take_count_by_viseme: Mapping[str, int]
    gesture_block_count_by_viseme: Mapping[str, int]
    maximum_same_clip_in_recent_5: int
    maximum_same_clip_in_recent_5_by_viseme: Mapping[str, int]
    suffix_clip_ids: tuple[frozenset[str], ...]
    suffix_take_ids: tuple[frozenset[int], ...]
    suffix_clip_ids_by_viseme: Mapping[
        str,
        tuple[frozenset[str], ...],
    ]
    suffix_take_ids_by_viseme: Mapping[
        str,
        tuple[frozenset[int], ...],
    ]


def _span_bounds(item: Mapping[str, Any], label: str) -> tuple[int, int]:
    start = item.get("start_frame")
    end = item.get("end_frame_exclusive")
    if not isinstance(start, int) or not isinstance(end, int):
        raise ValueError(f"{label} 缺少整数帧边界")
    if start < 0 or end <= start:
        raise ValueError(f"{label} 帧边界无效：[{start}, {end})")
    return start, end


def _parse_library(
    library: Mapping[str, Any],
    source_count: int,
    source_takes: np.ndarray,
) -> tuple[list[Clip], list[Clip], dict[tuple[int, str, str], tuple[int, int]]]:
    if library.get("version") != 1:
        raise ValueError("gesture scheduler requires visual-viseme library v1")

    gestures: list[Clip] = []
    ids: set[str] = set()
    for index, item in enumerate(library.get("gesture_clips") or []):
        if not isinstance(item, Mapping):
            raise ValueError(f"gesture_clips[{index}] 必须是对象")
        clip_id = item.get("id")
        viseme = item.get("viseme")
        take = item.get("take")
        if not isinstance(clip_id, str) or not clip_id or clip_id in ids:
            raise ValueError(f"gesture_clips[{index}].id 缺失或重复")
        if viseme not in VOWEL_VISEMES or not isinstance(take, int):
            raise ValueError(f"gesture_clips[{index}] 的 viseme/take 无效")
        start, end = _span_bounds(item, f"gesture_clips[{index}]")
        if end > source_count:
            raise ValueError(f"gesture_clips[{index}] 越出源视频")
        peak = item.get("peak_frame_range_inclusive")
        peak_strength_level = item.get("peak_strength_level")
        if (
            not isinstance(peak, list)
            or len(peak) != 2
            or not all(isinstance(value, int) for value in peak)
            or peak[0] > peak[1]
            or peak[0] < start
            or peak[1] >= end
        ):
            raise ValueError(f"gesture_clips[{index}] 的 peak 无效")
        if (
            isinstance(peak_strength_level, bool)
            or not isinstance(peak_strength_level, (int, float))
            or not 1.0 <= float(peak_strength_level) <= 4.0
        ):
            raise ValueError(
                f"gesture_clips[{index}].peak_strength_level 必须为 1.0..4.0"
            )
        rise_frames = item.get("rise_frames_by_intensity")
        fall_frames = item.get("fall_frames_by_intensity")
        if (
            not isinstance(rise_frames, list)
            or not isinstance(fall_frames, list)
            or len(rise_frames) != 5
            or len(fall_frames) != 5
            or not all(isinstance(value, int) for value in rise_frames)
            or not all(isinstance(value, int) for value in fall_frames)
            or any(not start <= value < end for value in rise_frames)
            or any(not start <= value < end for value in fall_frames)
            or any(
                right <= left
                for left, right in zip(rise_frames, rise_frames[1:])
            )
            or any(
                right >= left
                for left, right in zip(fall_frames, fall_frames[1:])
            )
            or rise_frames[0] != start
            or fall_frames[0] != end - 1
        ):
            raise ValueError(
                f"gesture_clips[{index}] 的 rise/fall 必须是片段内真实、"
                "严格有序的 0..4 帧，且低口型端点等于 start/end-1"
            )
        low_entries = tuple(rise_frames[:3])
        low_exits = tuple(fall_frames[:3])
        entry = low_entries[0]
        exit_frame = low_exits[0]
        gestures.append(
            Clip(
                id=clip_id,
                kind="gesture",
                viseme=str(viseme),
                take=take,
                start=start,
                end=end,
                entry=entry,
                exit=exit_frame,
                peak_start=int(peak[0]),
                peak_end=int(peak[1]),
                peak_strength_level=float(peak_strength_level),
                low_entries=low_entries,
                low_exits=low_exits,
            )
        )
        ids.add(clip_id)

    closed: list[Clip] = []
    for index, item in enumerate(library.get("closed_motion_clips") or []):
        if not isinstance(item, Mapping):
            raise ValueError(f"closed_motion_clips[{index}] 必须是对象")
        clip_id = item.get("id")
        if not isinstance(clip_id, str) or not clip_id or clip_id in ids:
            raise ValueError(f"closed_motion_clips[{index}].id 缺失或重复")
        start, end = _span_bounds(item, f"closed_motion_clips[{index}]")
        if end > source_count:
            raise ValueError(f"closed_motion_clips[{index}] 越出源视频")
        take_values = source_takes[start:end]
        nonzero = take_values[take_values > 0]
        take = (
            int(np.bincount(nonzero).argmax())
            if len(nonzero)
            else index + 1
        )
        closed.append(
            Clip(
                id=clip_id,
                kind="idle",
                viseme="CLOSED",
                take=take,
                start=start,
                end=end,
                entry=start,
                exit=end - 1,
                low_entries=(start,),
                low_exits=(end - 1,),
            )
        )
        ids.add(clip_id)

    if not gestures or not closed:
        raise ValueError("library must contain gesture and closed-motion clips")
    takes_by_viseme = {
        viseme: {clip.take for clip in gestures if clip.viseme == viseme}
        for viseme in VOWEL_VISEMES
    }
    missing = [
        viseme for viseme, takes in takes_by_viseme.items() if len(takes) < 2
    ]
    if missing:
        raise ValueError(
            "each vowel needs at least two reviewed takes: " + ", ".join(missing)
        )

    natural: dict[tuple[int, str, str], tuple[int, int]] = {}
    for index, item in enumerate(library.get("natural_transition_spans") or []):
        if not isinstance(item, Mapping):
            raise ValueError(f"natural_transition_spans[{index}] 必须是对象")
        take = item.get("take")
        source_viseme = item.get("from")
        target_viseme = item.get("to")
        if (
            not isinstance(take, int)
            or source_viseme not in VOWEL_VISEMES
            or target_viseme not in VOWEL_VISEMES
        ):
            raise ValueError(
                f"natural_transition_spans[{index}] 的方向或 take 无效"
            )
        start, end = _span_bounds(
            item,
            f"natural_transition_spans[{index}]",
        )
        if end > source_count:
            raise ValueError(f"natural_transition_spans[{index}] 越出源视频")
        natural[(take, str(source_viseme), str(target_viseme))] = (
            start,
            end,
        )
    return gestures, closed, natural


def _runs(values: Sequence[bool]) -> list[tuple[int, int, bool]]:
    if not values:
        return []
    output: list[tuple[int, int, bool]] = []
    start = 0
    current = bool(values[0])
    for index in range(1, len(values)):
        value = bool(values[index])
        if value != current:
            output.append((start, index, current))
            start = index
            current = value
    output.append((start, len(values), current))
    return output


def _vowel_duration(
    frame: int,
    viseme: str,
    target_labels: Sequence[str],
    roles: Sequence[str],
) -> int:
    start = frame
    while (
        start > 0
        and target_labels[start - 1] == viseme
        and roles[start - 1] != "silence"
    ):
        start -= 1
    end = frame + 1
    while (
        end < len(target_labels)
        and target_labels[end] == viseme
        and roles[end] != "silence"
    ):
        end += 1
    return end - start


def _anchor_event(
    frame: int,
    anchors: Sequence[str | None],
    target_labels: Sequence[str],
    target_levels: np.ndarray,
    roles: Sequence[str],
) -> AnchorEvent:
    viseme = str(anchors[frame])
    duration = _vowel_duration(frame, viseme, target_labels, roles)
    level = float(target_levels[frame])
    return AnchorEvent(
        frame=frame,
        viseme=viseme,
        level=level,
        vowel_duration=duration,
        prominence=level * (1.0 + 0.06 * min(duration, 12)),
    )


def _primary_event(events: Sequence[AnchorEvent]) -> AnchorEvent:
    if not events:
        raise ValueError("coarticulation cluster must contain at least one anchor")
    return max(
        events,
        key=lambda event: (
            event.prominence,
            event.level,
            event.vowel_duration,
            -event.frame,
        ),
    )


def _cluster_events(
    events: Sequence[AnchorEvent],
    minimum_interval: int,
) -> list[CoarticulationCluster]:
    if not events:
        return []

    ordered = sorted(events, key=lambda event: event.frame)
    predecessor: list[int] = []
    for index, event in enumerate(ordered):
        compatible = -1
        for candidate in range(index - 1, -1, -1):
            if event.frame - ordered[candidate].frame >= minimum_interval:
                compatible = candidate
                break
        predecessor.append(compatible)

    def score(selection: tuple[AnchorEvent, ...]) -> tuple[Any, ...]:
        return (
            len(selection),
            round(sum(event.prominence for event in selection), 9),
            sum(event.vowel_duration for event in selection),
            -sum(event.frame for event in selection),
        )

    best: list[tuple[AnchorEvent, ...]] = [()]
    for index, event in enumerate(ordered):
        excluded = best[index]
        included = best[predecessor[index] + 1] + (event,)
        best.append(included if score(included) > score(excluded) else excluded)
    primaries = tuple(sorted(best[-1], key=lambda event: event.frame))
    if not primaries:
        primaries = (_primary_event(ordered),)
    if any(
        right.frame - left.frame < minimum_interval
        for left, right in zip(primaries, primaries[1:])
    ):
        raise AssertionError("non-transitive primary selection violated spacing")

    grouped: dict[int, list[AnchorEvent]] = {
        primary.frame: [] for primary in primaries
    }
    primary_by_frame = {primary.frame: primary for primary in primaries}
    for event in ordered:
        nearest = min(
            primaries,
            key=lambda primary: (
                abs(primary.frame - event.frame),
                -primary.prominence,
                primary.frame,
            ),
        )
        grouped[nearest.frame].append(event)
    return [
        CoarticulationCluster(
            index=index,
            events=tuple(grouped[primary.frame]),
            primary=primary_by_frame[primary.frame],
        )
        for index, primary in enumerate(primaries)
    ]


def _cluster_blocks(
    start: int,
    end: int,
    clusters: Sequence[CoarticulationCluster],
) -> list[Block]:
    if not clusters:
        return []
    splits = [start]
    for left, right in zip(clusters, clusters[1:]):
        split = (left.primary.frame + right.primary.frame + 1) // 2
        split = max(splits[-1] + 1, min(end - 1, split))
        splits.append(split)
    splits.append(end)
    output: list[Block] = []
    for index, cluster in enumerate(clusters):
        block_start = splits[index]
        block_end = splits[index + 1]
        primary = cluster.primary
        output.append(
            Block(
                index=index,
                kind="gesture",
                start=block_start,
                end=block_end,
                viseme=primary.viseme,
                anchor=primary.frame,
                target_peak_level=primary.level,
                cluster_index=cluster.index,
                anchor_events=cluster.events,
            )
        )
    return output


def _gesture_block_has_option(
    block: Block,
    gestures: Sequence[Clip],
) -> bool:
    for clip in gestures:
        if clip.viseme != block.viseme:
            continue
        try:
            if _gesture_options(block, clip):
                return True
        except ValueError:
            continue
    return False


def _merge_cluster_pair(
    clusters: Sequence[CoarticulationCluster],
    left_index: int,
) -> list[CoarticulationCluster]:
    left = clusters[left_index]
    right = clusters[left_index + 1]
    combined = tuple(
        sorted(
            left.events + right.events,
            key=lambda event: event.frame,
        )
    )
    surviving_primary = _primary_event((left.primary, right.primary))
    merged = (
        list(clusters[:left_index])
        + [
            CoarticulationCluster(
                index=left_index,
                events=combined,
                primary=surviving_primary,
            )
        ]
        + list(clusters[left_index + 2 :])
    )
    return [
        replace(cluster, index=index)
        for index, cluster in enumerate(merged)
    ]


def _fit_clusters(
    start: int,
    end: int,
    clusters: Sequence[CoarticulationCluster],
    gestures: Sequence[Clip],
    minimum_interval: int,
) -> tuple[list[CoarticulationCluster], list[Block]]:
    fitted = list(clusters)
    while fitted:
        try:
            blocks = _cluster_blocks(start, end, fitted)
        except ValueError:
            blocks = []
        failing = [
            index
            for index, block in enumerate(blocks)
            if block.length < minimum_interval
            or not _gesture_block_has_option(block, gestures)
        ]
        if blocks and not failing:
            return fitted, blocks
        if len(fitted) == 1:
            primary = fitted[0].primary
            raise ValueError(
                "coarticulation cluster cannot realize a continuous "
                "low→peak→low path within the 2x speed/acceleration limits: "
                f"region=[{start},{end}), primary={primary.viseme}@{primary.frame}"
            )
        failing_index = failing[0] if failing else 0
        if failing_index == 0:
            merge_left = 0
        elif failing_index >= len(fitted) - 1:
            merge_left = len(fitted) - 2
        else:
            left_gap = (
                fitted[failing_index].primary.frame
                - fitted[failing_index - 1].primary.frame
            )
            right_gap = (
                fitted[failing_index + 1].primary.frame
                - fitted[failing_index].primary.frame
            )
            merge_left = failing_index - 1 if left_gap <= right_gap else failing_index
        fitted = _merge_cluster_pair(fitted, merge_left)
    return [], []


def _partition_idle(
    start: int,
    end: int,
    maximum_clip_length: int,
    minimum_interval: int,
    kind: str,
) -> list[Block]:
    length = end - start
    if length <= 0:
        return []
    count = max(1, int(np.ceil(length / max(1, maximum_clip_length))))
    while count > 1 and length // count < minimum_interval:
        count -= 1
    base, remainder = divmod(length, count)
    blocks: list[Block] = []
    cursor = start
    for index in range(count):
        block_length = base + (1 if index < remainder else 0)
        blocks.append(
            Block(
                index=0,
                kind=kind,
                start=cursor,
                end=cursor + block_length,
                viseme="CLOSED",
                anchor=None,
                target_peak_level=0.0,
            )
        )
        cursor += block_length
    return blocks


def _build_blocks(
    target_labels: Sequence[str],
    target_levels: np.ndarray,
    anchors: Sequence[str | None],
    roles: Sequence[str],
    gestures: Sequence[Clip],
    closed: Sequence[Clip],
    minimum_interval: int,
) -> tuple[list[Block], list[CoarticulationCluster]]:
    stable_silence = [False] * len(roles)
    for start, end, is_silence in _runs(
        [role == "silence" for role in roles]
    ):
        if is_silence and end - start >= minimum_interval:
            stable_silence[start:end] = [True] * (end - start)

    blocks: list[Block] = []
    all_clusters: list[CoarticulationCluster] = []
    maximum_idle_length = max(clip.length for clip in closed)
    for start, end, is_stable_silence in _runs(stable_silence):
        if is_stable_silence:
            blocks.extend(
                _partition_idle(
                    start,
                    end,
                    maximum_idle_length,
                    minimum_interval,
                    "idle",
                )
            )
            continue
        events = [
            _anchor_event(
                frame,
                anchors,
                target_labels,
                target_levels,
                roles,
            )
            for frame in range(start, end)
            if anchors[frame] in VOWEL_VISEMES
        ]
        if not events:
            blocks.extend(
                _partition_idle(
                    start,
                    end,
                    maximum_idle_length,
                    minimum_interval,
                    "speech_idle",
                )
            )
            continue
        clusters = _cluster_events(events, minimum_interval)
        fitted, region_blocks = _fit_clusters(
            start,
            end,
            clusters,
            gestures,
            minimum_interval,
        )
        cluster_offset = len(all_clusters)
        adjusted_clusters = [
            replace(cluster, index=cluster_offset + index)
            for index, cluster in enumerate(fitted)
        ]
        all_clusters.extend(adjusted_clusters)
        by_local_index = {
            local.index: adjusted_clusters[index]
            for index, local in enumerate(fitted)
        }
        for block in region_blocks:
            cluster = by_local_index[int(block.cluster_index)]
            blocks.append(
                replace(
                    block,
                    cluster_index=cluster.index,
                    anchor_events=cluster.events,
                )
            )

    ordered = [
        replace(block, index=index)
        for index, block in enumerate(blocks)
        if block.end > block.start
    ]
    if not ordered or ordered[0].start != 0 or ordered[-1].end != len(roles):
        raise RuntimeError("motion blocks do not cover the complete target timeline")
    for previous, current in zip(ordered, ordered[1:]):
        if previous.end != current.start:
            raise RuntimeError("motion blocks contain a gap or overlap")
    return ordered, all_clusters


def _piecewise_positions(
    target_frames: Sequence[int],
    source_frames: Sequence[float],
    start: int,
    end: int,
) -> np.ndarray:
    target = np.asarray(target_frames, dtype=np.float64)
    source = np.asarray(source_frames, dtype=np.float64)
    if len(target) != len(source) or len(target) < 2:
        raise ValueError("piecewise source map needs aligned control points")
    if np.any(np.diff(target) <= 0) or np.any(np.diff(source) <= 0):
        raise ValueError("piecewise source map must be strictly increasing")
    positions = np.interp(
        np.arange(start, end, dtype=np.float64),
        target,
        source,
    )
    differences = np.diff(positions)
    accelerations = np.diff(differences)
    if len(differences) and (
        float(np.min(differences)) < _MIN_SOURCE_SPEED
        or float(np.max(differences)) > _MAX_SOURCE_SPEED
        or (
            len(accelerations)
            and float(np.max(np.abs(accelerations)))
            > _MAX_SOURCE_ACCELERATION
        )
    ):
        raise ValueError(
            "bounded time stretch exceeded: "
            f"source speed [{float(np.min(differences)):.4f}, "
            f"{float(np.max(differences)):.4f}], "
            "max acceleration "
            f"{float(np.max(np.abs(accelerations))) if len(accelerations) else 0.0:.4f}"
        )
    return positions.astype(np.float32)


def _gesture_options(block: Block, clip: Clip) -> list[Option]:
    if (
        block.anchor is None
        or clip.peak_start is None
        or clip.peak_end is None
    ):
        raise ValueError("gesture block/clip lacks an anchor or source peak")
    if block.length < 3 or not block.start < block.anchor < block.end - 1:
        raise ValueError(
            f"gesture event [{block.start}, {block.end}) has no pre/post-roll "
            f"around anchor {block.anchor}"
        )
    output: list[Option] = []
    seen: set[tuple[int, int, int]] = set()
    for entry_level, entry in enumerate(clip.low_entries[:3]):
        for exit_level, exit_frame in enumerate(clip.low_exits[:3]):
            for peak_frame in range(clip.peak_start, clip.peak_end + 1):
                signature = (entry, peak_frame, exit_frame)
                if signature in seen or not entry < peak_frame < exit_frame:
                    continue
                seen.add(signature)
                try:
                    positions = _piecewise_positions(
                        [block.start, block.anchor, block.end - 1],
                        [entry, peak_frame, exit_frame],
                        block.start,
                        block.end,
                    )
                except ValueError:
                    continue
                differences = np.diff(positions)
                accelerations = np.diff(differences)
                output.append(
                    Option(
                        id=(
                            f"{clip.id}:entry{entry_level}:"
                            f"exit{exit_level}:peak{peak_frame}"
                        ),
                        block_index=block.index,
                        clip=clip,
                        source_positions=positions,
                        source_entry=entry,
                        source_peak=peak_frame,
                        source_exit=exit_frame,
                        entry_level=entry_level,
                        exit_level=exit_level,
                        source_speed_min=(
                            float(np.min(differences))
                            if len(differences)
                            else 0.0
                        ),
                        source_speed_max=(
                            float(np.max(differences))
                            if len(differences)
                            else 0.0
                        ),
                        source_acceleration_max=(
                            float(np.max(np.abs(accelerations)))
                            if len(accelerations)
                            else 0.0
                        ),
                        target_strength_error=abs(
                            clip.peak_strength_level
                            - block.target_peak_level
                        ),
                    )
                )
    return sorted(
        output,
        key=lambda option: (
            option.entry_level + option.exit_level,
            option.entry_level,
            option.exit_level,
            option.source_speed_max,
            option.id,
        ),
    )


def _idle_options(block: Block, clips: Sequence[Clip]) -> list[Option]:
    output: list[Option] = []
    for clip in clips:
        length = block.length
        if length <= clip.length:
            offsets = {
                0,
                max(0, (clip.length - length) // 2),
                max(0, clip.length - length),
            }
            for offset in sorted(offsets):
                entry = clip.start + offset
                exit_frame = entry + length - 1
                positions = np.arange(
                    entry,
                    exit_frame + 1,
                    dtype=np.float32,
                )
                output.append(
                    Option(
                        id=f"{clip.id}:window:{entry}-{exit_frame + 1}",
                        block_index=block.index,
                        clip=clip,
                        source_positions=positions,
                        source_entry=entry,
                        source_peak=None,
                        source_exit=exit_frame,
                        entry_level=0,
                        exit_level=0,
                        source_speed_min=1.0 if length > 1 else 0.0,
                        source_speed_max=1.0 if length > 1 else 0.0,
                        source_acceleration_max=0.0,
                        target_strength_error=0.0,
                    )
                )
        else:
            positions = np.linspace(
                clip.start,
                clip.end - 1,
                length,
                dtype=np.float32,
            )
            differences = np.diff(positions)
            accelerations = np.diff(differences)
            if len(differences) and (
                float(np.min(differences)) < _MIN_SOURCE_SPEED
                or float(np.max(differences)) > _MAX_SOURCE_SPEED
                or (
                    len(accelerations)
                    and float(np.max(np.abs(accelerations)))
                    > _MAX_SOURCE_ACCELERATION
                )
            ):
                continue
            output.append(
                Option(
                    id=f"{clip.id}:stretched:{length}",
                    block_index=block.index,
                    clip=clip,
                    source_positions=positions,
                    source_entry=clip.start,
                    source_peak=None,
                    source_exit=clip.end - 1,
                    entry_level=0,
                    exit_level=0,
                    source_speed_min=(
                        float(np.min(differences)) if len(differences) else 0.0
                    ),
                    source_speed_max=(
                        float(np.max(differences)) if len(differences) else 0.0
                    ),
                    source_acceleration_max=(
                        float(np.max(np.abs(accelerations)))
                        if len(accelerations)
                        else 0.0
                    ),
                    target_strength_error=0.0,
                )
            )
    return output


def _options_by_block(
    blocks: Sequence[Block],
    gestures: Sequence[Clip],
    closed: Sequence[Clip],
) -> list[list[Option]]:
    output: list[list[Option]] = []
    for block in blocks:
        if block.kind != "gesture":
            options = _idle_options(block, closed)
        else:
            options = []
            for clip in gestures:
                if clip.viseme != block.viseme:
                    continue
                options.extend(_gesture_options(block, clip))
        if not options:
            raise ValueError(
                f"block {block.index} [{block.start}, {block.end}) "
                f"has no bounded clip option"
            )
        output.append(options)
    return output


def _strength_eligible_options(
    block: Block,
    options: Sequence[Option],
) -> list[Option]:
    """Keep every near-best strength take, never a visibly wrong strength tier."""

    if block.kind != "gesture":
        return list(options)
    minimum_error = min(option.target_strength_error for option in options)
    maximum_error = minimum_error + _STRENGTH_NEAR_BEST_MARGIN
    eligible = [
        option
        for option in options
        if option.target_strength_error <= maximum_error + 1e-9
    ]
    if not eligible:
        raise AssertionError(
            f"strength eligibility removed every option for block {block.index}"
        )
    return eligible


def _adaptive_unique_requirement(
    block_count: int,
    available_count: int,
    preferred_maximum: int,
) -> int:
    if block_count <= 0 or available_count <= 0:
        return 0
    return min(block_count, available_count, preferred_maximum)


def _adaptive_recent_clip_limit(
    block_count: int,
    available_clip_count: int,
) -> int:
    if block_count <= 0:
        return 0
    window_size = min(_DIVERSITY_WINDOW, block_count)
    if available_clip_count >= 2 and block_count >= 4:
        return min(3, window_size)
    return window_size


def _diversity_policy(
    blocks: Sequence[Block],
    options_by_block: Sequence[Sequence[Option]],
) -> DiversityPolicy:
    block_count_by_viseme = Counter(
        block.viseme for block in blocks if block.kind == "gesture"
    )
    available_clips_by_viseme: dict[str, set[str]] = defaultdict(set)
    available_takes_by_viseme: dict[str, set[int]] = defaultdict(set)
    block_clip_ids: list[frozenset[str]] = []
    block_take_ids: list[frozenset[int]] = []
    for block, options in zip(blocks, options_by_block):
        if block.kind != "gesture":
            block_clip_ids.append(frozenset())
            block_take_ids.append(frozenset())
            continue
        clip_ids = frozenset(option.clip.id for option in options)
        take_ids = frozenset(option.clip.take for option in options)
        block_clip_ids.append(clip_ids)
        block_take_ids.append(take_ids)
        available_clips_by_viseme[block.viseme].update(clip_ids)
        available_takes_by_viseme[block.viseme].update(take_ids)

    available_clip_ids = frozenset().union(*block_clip_ids)
    available_take_ids = frozenset().union(*block_take_ids)
    gesture_block_count = sum(block.kind == "gesture" for block in blocks)
    required_unique_clip_count = _adaptive_unique_requirement(
        gesture_block_count,
        len(available_clip_ids),
        3,
    )
    required_unique_take_count = _adaptive_unique_requirement(
        gesture_block_count,
        len(available_take_ids),
        2,
    )
    required_clips_by_viseme = {
        viseme: _adaptive_unique_requirement(
            block_count,
            len(available_clips_by_viseme[viseme]),
            2,
        )
        for viseme, block_count in block_count_by_viseme.items()
    }
    required_takes_by_viseme = {
        viseme: _adaptive_unique_requirement(
            block_count,
            len(available_takes_by_viseme[viseme]),
            2,
        )
        for viseme, block_count in block_count_by_viseme.items()
    }
    recent_limit_by_viseme = {
        viseme: _adaptive_recent_clip_limit(
            block_count,
            len(available_clips_by_viseme[viseme]),
        )
        for viseme, block_count in block_count_by_viseme.items()
    }
    maximum_recent = (
        max(recent_limit_by_viseme.values())
        if recent_limit_by_viseme
        else 0
    )

    suffix_clips: list[frozenset[str]] = [
        frozenset() for _ in range(len(blocks) + 1)
    ]
    suffix_takes: list[frozenset[int]] = [
        frozenset() for _ in range(len(blocks) + 1)
    ]
    for index in range(len(blocks) - 1, -1, -1):
        suffix_clips[index] = suffix_clips[index + 1] | block_clip_ids[index]
        suffix_takes[index] = suffix_takes[index + 1] | block_take_ids[index]

    suffix_clips_by_viseme: dict[
        str,
        tuple[frozenset[str], ...],
    ] = {}
    suffix_takes_by_viseme: dict[
        str,
        tuple[frozenset[int], ...],
    ] = {}
    for viseme in block_count_by_viseme:
        clip_suffix = [frozenset() for _ in range(len(blocks) + 1)]
        take_suffix = [frozenset() for _ in range(len(blocks) + 1)]
        for index in range(len(blocks) - 1, -1, -1):
            if blocks[index].kind == "gesture" and blocks[index].viseme == viseme:
                current_clips = block_clip_ids[index]
                current_takes = block_take_ids[index]
            else:
                current_clips = frozenset()
                current_takes = frozenset()
            clip_suffix[index] = clip_suffix[index + 1] | current_clips
            take_suffix[index] = take_suffix[index + 1] | current_takes
        suffix_clips_by_viseme[viseme] = tuple(clip_suffix)
        suffix_takes_by_viseme[viseme] = tuple(take_suffix)

    return DiversityPolicy(
        gesture_block_count=gesture_block_count,
        available_clip_ids=available_clip_ids,
        available_take_ids=available_take_ids,
        available_clip_ids_by_viseme={
            viseme: frozenset(values)
            for viseme, values in available_clips_by_viseme.items()
        },
        available_take_ids_by_viseme={
            viseme: frozenset(values)
            for viseme, values in available_takes_by_viseme.items()
        },
        required_unique_clip_count=required_unique_clip_count,
        required_unique_take_count=required_unique_take_count,
        required_unique_clip_count_by_viseme=required_clips_by_viseme,
        required_unique_take_count_by_viseme=required_takes_by_viseme,
        gesture_block_count_by_viseme=dict(block_count_by_viseme),
        maximum_same_clip_in_recent_5=maximum_recent,
        maximum_same_clip_in_recent_5_by_viseme=recent_limit_by_viseme,
        suffix_clip_ids=tuple(suffix_clips),
        suffix_take_ids=tuple(suffix_takes),
        suffix_clip_ids_by_viseme=suffix_clips_by_viseme,
        suffix_take_ids_by_viseme=suffix_takes_by_viseme,
    )


def _descriptor_rms(left: np.ndarray, right: np.ndarray) -> float:
    difference = np.asarray(left, dtype=np.float64) - np.asarray(
        right,
        dtype=np.float64,
    )
    return float(np.sqrt(np.mean(difference * difference)))


def _velocity_signature(
    descriptors: np.ndarray,
    frame: int,
    incoming: bool,
) -> tuple[np.ndarray, ...]:
    output: list[np.ndarray] = []
    for horizon in (2, 3):
        if incoming and frame + horizon < len(descriptors):
            output.append(
                (descriptors[frame + horizon] - descriptors[frame]) / horizon
            )
        elif not incoming and frame - horizon >= 0:
            output.append(
                (descriptors[frame] - descriptors[frame - horizon]) / horizon
            )
    if output:
        return tuple(output)
    if incoming and frame + 1 < len(descriptors):
        return (descriptors[frame + 1] - descriptors[frame],)
    if not incoming and frame > 0:
        return (descriptors[frame] - descriptors[frame - 1],)
    return (np.zeros(descriptors.shape[1], dtype=np.float64),)


def _velocity_rms(
    descriptors: np.ndarray,
    exit_frame: int,
    entry_frame: int,
) -> float:
    outgoing = _velocity_signature(descriptors, exit_frame, False)
    incoming = _velocity_signature(descriptors, entry_frame, True)
    return float(
        np.mean(
            [
                _descriptor_rms(outgoing[index], incoming[index])
                for index in range(min(len(outgoing), len(incoming)))
            ]
        )
    )


def _natural_span(
    previous: Option,
    current: Option,
    natural: Mapping[tuple[int, str, str], tuple[int, int]],
) -> tuple[int, int] | None:
    if previous.clip.kind != "gesture" or current.clip.kind != "gesture":
        return None
    if previous.clip.take != current.clip.take:
        return None
    span = natural.get(
        (
            previous.clip.take,
            previous.clip.viseme,
            current.clip.viseme,
        )
    )
    if span is None:
        return None
    if (
        previous.source_peak is None
        or current.source_peak is None
        or previous.source_peak >= current.source_peak
    ):
        return None
    if not (
        previous.clip.start <= span[0] < previous.clip.end
        and current.clip.start < span[1] <= current.clip.end
        and previous.source_peak <= span[0]
        and span[1] - 1 <= current.source_peak
    ):
        return None
    return span


def _native_contiguous(previous: Option, current: Option) -> bool:
    return (
        previous.clip.id == current.clip.id
        and previous.source_exit + 1 == current.source_entry
    )


def _motion_limits_pass(positions: np.ndarray) -> bool:
    speeds = np.diff(np.asarray(positions, dtype=np.float64))
    if len(speeds) and (
        float(np.min(speeds)) < _MIN_SOURCE_SPEED
        or float(np.max(speeds)) > _MAX_SOURCE_SPEED
    ):
        return False
    accelerations = np.diff(speeds)
    return not len(accelerations) or (
        float(np.max(np.abs(accelerations))) <= _MAX_SOURCE_ACCELERATION
    )


def _compatibility_thresholds(
    descriptors: np.ndarray,
) -> tuple[float, float, float, float]:
    natural_static = np.asarray(
        [
            _descriptor_rms(descriptors[index], descriptors[index + 1])
            for index in range(len(descriptors) - 1)
        ],
        dtype=np.float64,
    )
    natural_velocity = np.asarray(
        [
            _velocity_rms(descriptors, index, index + 1)
            for index in range(3, len(descriptors) - 3)
        ],
        dtype=np.float64,
    )
    static_scale = max(1e-7, float(np.percentile(natural_static, 90)))
    velocity_scale = max(1e-7, float(np.percentile(natural_velocity, 90)))
    static_limit = static_scale * 8.0
    velocity_limit = velocity_scale * 8.0
    return static_limit, velocity_limit, static_scale, velocity_scale


def _transition(
    previous: Option,
    current: Option,
    previous_block: Block,
    current_block: Block,
    output_frame: int,
    descriptors: np.ndarray,
    natural: Mapping[tuple[int, str, str], tuple[int, int]],
    static_limit: float,
    velocity_limit: float,
    static_scale: float,
    velocity_scale: float,
) -> Transition | None:
    if _native_contiguous(previous, current) and _motion_limits_pass(
        np.concatenate((previous.source_positions, current.source_positions))
    ):
        return Transition(
            kind="native_contiguous",
            from_clip_id=previous.clip.id,
            to_clip_id=current.clip.id,
            from_option_key=previous.key,
            to_option_key=current.key,
            from_source_exit=previous.source_exit,
            to_source_entry=current.source_entry,
            output_frame=output_frame,
            boundary=False,
            static_rms=None,
            velocity_rms=None,
            normalized_cost=0.0,
        )
    span = _natural_span(previous, current, natural)
    if span is not None:
        try:
            _piecewise_positions(
                [
                    previous_block.start,
                    int(previous_block.anchor),
                    int(current_block.anchor),
                    current_block.end - 1,
                ],
                [
                    previous.source_entry,
                    int(previous.source_peak),
                    int(current.source_peak),
                    current.source_exit,
                ],
                previous_block.start,
                current_block.end,
            )
        except ValueError:
            span = None
        else:
            return Transition(
                kind="directed_natural_chain",
                from_clip_id=previous.clip.id,
                to_clip_id=current.clip.id,
                from_option_key=previous.key,
                to_option_key=current.key,
                from_source_exit=previous.source_exit,
                to_source_entry=current.source_entry,
                output_frame=output_frame,
                boundary=False,
                static_rms=None,
                velocity_rms=None,
                normalized_cost=0.02,
                natural_span=span,
            )
    matched_gesture_endpoint = (
        previous.clip.kind == "gesture"
        and current.clip.kind == "gesture"
        and previous.exit_level == current.entry_level
        and 1
        < previous.exit_level
        <= _MAX_MATCHED_GESTURE_ENDPOINT_LEVEL
    )
    matched_same_viseme_endpoint = (
        matched_gesture_endpoint
        and previous.clip.viseme == current.clip.viseme
    )
    if (
        previous.exit_level > 1 or current.entry_level > 1
    ) and not matched_gesture_endpoint:
        return None
    static = _descriptor_rms(
        descriptors[previous.source_exit],
        descriptors[current.source_entry],
    )
    velocity = _velocity_rms(
        descriptors,
        previous.source_exit,
        current.source_entry,
    )
    if static > static_limit or velocity > velocity_limit:
        return None
    normalized = static / static_scale + 0.72 * velocity / velocity_scale
    return Transition(
        kind=(
            "compatible_matched_same_viseme_endpoint_seam"
            if matched_same_viseme_endpoint
            else (
                "compatible_matched_cross_viseme_endpoint_seam"
                if matched_gesture_endpoint
                else "compatible_low_endpoint_seam"
            )
        ),
        from_clip_id=previous.clip.id,
        to_clip_id=current.clip.id,
        from_option_key=previous.key,
        to_option_key=current.key,
        from_source_exit=previous.source_exit,
        to_source_entry=current.source_entry,
        output_frame=output_frame,
        boundary=True,
        static_rms=static,
        velocity_rms=velocity,
        normalized_cost=normalized,
    )


def _option_intrinsic_penalty(option: Option) -> float:
    strength_error = option.target_strength_error
    return (
        0.10 * (option.entry_level + option.exit_level)
        + 0.18 * option.source_speed_max
        + 0.25 * option.source_acceleration_max
        + 1.5 * strength_error
        + 2.0 * strength_error * strength_error
    )


def _selection_penalty(
    state: BeamState,
    current: Option,
    transition: Transition | None,
) -> float:
    repeated_clip = sum(
        clip_id == current.clip.id
        for clip_id in state.recent_gesture_clip_ids
    )
    penalty = _option_intrinsic_penalty(current) + 0.25 * repeated_clip
    if current.clip.kind == "gesture":
        same_viseme = [
            option
            for option in reversed(state.options)
            if option.clip.kind == "gesture"
            and option.clip.viseme == current.clip.viseme
        ]
        if same_viseme and same_viseme[0].clip.take == current.clip.take:
            penalty += 0.20
        take_count = sum(
            option.clip.kind == "gesture"
            and option.clip.take == current.clip.take
            for option in state.options
        )
        penalty += 0.03 * take_count
        if current.clip.id not in state.gesture_clip_ids:
            penalty -= 0.35
        if (
            current.clip.viseme,
            current.clip.id,
        ) not in state.viseme_clip_ids:
            penalty -= 0.30
        if current.clip.take not in state.gesture_take_ids:
            penalty -= 0.12
        if (
            current.clip.viseme,
            current.clip.take,
        ) not in state.viseme_take_ids:
            penalty -= 0.10
    if transition is not None:
        pair = (transition.from_option_key, transition.to_option_key)
        repeated_transition = sum(
            (item.from_option_key, item.to_option_key) == pair
            for item in state.transitions[-5:]
        )
        penalty += 0.15 * repeated_transition
        if transition.boundary:
            penalty += 12.0 + 1.5 * transition.normalized_cost
            if (
                transition.kind
                == "compatible_matched_same_viseme_endpoint_seam"
            ):
                penalty -= _MATCHED_SAME_VISEME_TRANSITION_REWARD
        else:
            penalty += transition.normalized_cost
    return penalty


def _initial_state(option: Option) -> BeamState:
    if option.clip.kind == "gesture":
        gesture_clip_ids = frozenset({option.clip.id})
        gesture_take_ids = frozenset({option.clip.take})
        viseme_clip_ids = frozenset(
            {(option.clip.viseme, option.clip.id)}
        )
        viseme_take_ids = frozenset(
            {(option.clip.viseme, option.clip.take)}
        )
        recent = (option.clip.id,)
    else:
        gesture_clip_ids = frozenset()
        gesture_take_ids = frozenset()
        viseme_clip_ids = frozenset()
        viseme_take_ids = frozenset()
        recent = ()
    return BeamState(
        cost=_option_intrinsic_penalty(option),
        options=(option,),
        transitions=(),
        last_boundary_frame=None,
        gesture_clip_ids=gesture_clip_ids,
        gesture_take_ids=gesture_take_ids,
        viseme_clip_ids=viseme_clip_ids,
        viseme_take_ids=viseme_take_ids,
        recent_gesture_clip_ids=recent,
    )


def _append_state(
    state: BeamState,
    current: Option,
    transition: Transition,
    penalty: float,
) -> BeamState:
    if current.clip.kind == "gesture":
        gesture_clip_ids = state.gesture_clip_ids | {current.clip.id}
        gesture_take_ids = state.gesture_take_ids | {current.clip.take}
        viseme_clip_ids = state.viseme_clip_ids | {
            (current.clip.viseme, current.clip.id)
        }
        viseme_take_ids = state.viseme_take_ids | {
            (current.clip.viseme, current.clip.take)
        }
        recent = (
            state.recent_gesture_clip_ids + (current.clip.id,)
        )[-(_DIVERSITY_WINDOW - 1) :]
    else:
        gesture_clip_ids = state.gesture_clip_ids
        gesture_take_ids = state.gesture_take_ids
        viseme_clip_ids = state.viseme_clip_ids
        viseme_take_ids = state.viseme_take_ids
        recent = state.recent_gesture_clip_ids
    return BeamState(
        cost=state.cost + penalty,
        options=state.options + (current,),
        transitions=state.transitions + (transition,),
        last_boundary_frame=(
            transition.output_frame
            if transition.boundary
            else state.last_boundary_frame
        ),
        gesture_clip_ids=gesture_clip_ids,
        gesture_take_ids=gesture_take_ids,
        viseme_clip_ids=viseme_clip_ids,
        viseme_take_ids=viseme_take_ids,
        recent_gesture_clip_ids=recent,
    )


def _recent_clip_limit_passes(
    state: BeamState,
    current: Option,
    policy: DiversityPolicy,
) -> bool:
    if current.clip.kind != "gesture":
        return True
    maximum = policy.maximum_same_clip_in_recent_5_by_viseme[
        current.clip.viseme
    ]
    recent = (
        state.recent_gesture_clip_ids + (current.clip.id,)
    )[-_DIVERSITY_WINDOW:]
    return recent.count(current.clip.id) <= maximum


def _diversity_reachable(
    state: BeamState,
    next_block_index: int,
    policy: DiversityPolicy,
) -> bool:
    if len(
        state.gesture_clip_ids | policy.suffix_clip_ids[next_block_index]
    ) < policy.required_unique_clip_count:
        return False
    if len(
        state.gesture_take_ids | policy.suffix_take_ids[next_block_index]
    ) < policy.required_unique_take_count:
        return False
    for viseme, required in policy.required_unique_clip_count_by_viseme.items():
        selected = {
            clip_id
            for selected_viseme, clip_id in state.viseme_clip_ids
            if selected_viseme == viseme
        }
        if len(
            selected
            | policy.suffix_clip_ids_by_viseme[viseme][next_block_index]
        ) < required:
            return False
    for viseme, required in policy.required_unique_take_count_by_viseme.items():
        selected = {
            take
            for selected_viseme, take in state.viseme_take_ids
            if selected_viseme == viseme
        }
        if len(
            selected
            | policy.suffix_take_ids_by_viseme[viseme][next_block_index]
        ) < required:
            return False
    return True


def _diversity_satisfied(
    state: BeamState,
    policy: DiversityPolicy,
) -> bool:
    return _diversity_reachable(state, len(policy.suffix_clip_ids) - 1, policy)


def _diversity_deficit(
    state: BeamState,
    policy: DiversityPolicy,
) -> int:
    deficit = max(
        0,
        policy.required_unique_clip_count - len(state.gesture_clip_ids),
    )
    deficit += max(
        0,
        policy.required_unique_take_count - len(state.gesture_take_ids),
    )
    for viseme, required in policy.required_unique_clip_count_by_viseme.items():
        selected_count = sum(
            selected_viseme == viseme
            for selected_viseme, _ in state.viseme_clip_ids
        )
        deficit += max(0, required - selected_count)
    for viseme, required in policy.required_unique_take_count_by_viseme.items():
        selected_count = sum(
            selected_viseme == viseme
            for selected_viseme, _ in state.viseme_take_ids
        )
        deficit += max(0, required - selected_count)
    return deficit


def _beam_rank(
    state: BeamState,
    policy: DiversityPolicy,
) -> tuple[Any, ...]:
    return (
        _diversity_deficit(state, policy),
        state.cost,
        tuple(option.id for option in state.options[-4:]),
    )


def _prune_beam_states(
    states: Sequence[BeamState],
    policy: DiversityPolicy,
) -> list[BeamState]:
    """Keep the cheapest beam plus a small portfolio of every usable exit."""
    ranked = sorted(states, key=lambda state: _beam_rank(state, policy))
    if len(ranked) <= _BEAM_WIDTH:
        return ranked
    portfolio_counts: Counter[tuple[str, int, int]] = Counter()
    selected: list[BeamState] = []
    selected_ids: set[int] = set()
    for state in ranked:
        option = state.options[-1]
        key = (option.clip.id, option.exit_level, option.source_exit)
        if portfolio_counts[key] >= _BEAM_PORTFOLIO_PER_EXIT:
            continue
        portfolio_counts[key] += 1
        selected.append(state)
        selected_ids.add(id(state))
        if len(selected) >= _BEAM_WIDTH:
            return selected
    for state in ranked:
        if id(state) in selected_ids:
            continue
        selected.append(state)
        if len(selected) >= _BEAM_WIDTH:
            break
    return selected


def _choose_options(
    blocks: Sequence[Block],
    options_by_block: Sequence[Sequence[Option]],
    descriptors: np.ndarray,
    natural: Mapping[tuple[int, str, str], tuple[int, int]],
    minimum_boundary_gap: int,
) -> tuple[
    tuple[Option, ...],
    tuple[Transition, ...],
    dict[str, float],
    DiversityPolicy,
]:
    eligible_options_by_block = [
        _strength_eligible_options(block, options)
        for block, options in zip(blocks, options_by_block)
    ]
    policy = _diversity_policy(blocks, eligible_options_by_block)
    (
        static_limit,
        velocity_limit,
        static_scale,
        velocity_scale,
    ) = _compatibility_thresholds(descriptors)
    states = []
    for option in eligible_options_by_block[0]:
        state = _initial_state(option)
        if _diversity_reachable(state, 1, policy):
            states.append(state)
    if not states:
        raise ValueError(
            "first motion block has no strength-eligible option that can "
            "still satisfy the adaptive gesture-diversity contract"
        )
    states = _prune_beam_states(states, policy)
    for block_index in range(1, len(blocks)):
        next_states: list[BeamState] = []
        for state in states:
            previous = state.options[-1]
            for current in eligible_options_by_block[block_index]:
                if not _recent_clip_limit_passes(state, current, policy):
                    continue
                transition = _transition(
                    previous,
                    current,
                    blocks[block_index - 1],
                    blocks[block_index],
                    blocks[block_index].start,
                    descriptors,
                    natural,
                    static_limit,
                    velocity_limit,
                    static_scale,
                    velocity_scale,
                )
                if transition is None:
                    continue
                if (
                    transition.boundary
                    and state.last_boundary_frame is not None
                    and transition.output_frame - state.last_boundary_frame
                    < minimum_boundary_gap
                ):
                    continue
                penalty = _selection_penalty(state, current, transition)
                candidate = _append_state(
                    state,
                    current,
                    transition,
                    penalty,
                )
                if _diversity_reachable(
                    candidate,
                    block_index + 1,
                    policy,
                ):
                    next_states.append(candidate)
        if not next_states:
            previous_ids = sorted(
                {state.options[-1].clip.id for state in states}
            )
            current_ids = sorted(
                {option.clip.id for option in options_by_block[block_index]}
            )
            raise ValueError(
                "no reviewed clip route passes the endpoint thresholds at "
                f"block {block_index} (output frame {blocks[block_index].start}); "
                f"from={previous_ids}, to={current_ids}, "
                f"static_limit={static_limit:.8f}, "
                f"velocity_limit={velocity_limit:.8f}, "
                f"minimum_boundary_gap={minimum_boundary_gap}"
            )
        deduplicated: dict[tuple[Any, ...], BeamState] = {}
        for state in next_states:
            signature = (
                state.options[-1].key,
                state.last_boundary_frame,
                state.gesture_clip_ids,
                state.gesture_take_ids,
                state.viseme_clip_ids,
                state.viseme_take_ids,
                state.recent_gesture_clip_ids,
            )
            incumbent = deduplicated.get(signature)
            if incumbent is None or state.cost < incumbent.cost:
                deduplicated[signature] = state
        states = _prune_beam_states(
            list(deduplicated.values()),
            policy,
        )
    states = [
        state for state in states if _diversity_satisfied(state, policy)
    ]
    if not states:
        raise ValueError(
            "no reviewed clip route satisfies the adaptive gesture-diversity "
            "contract after strength eligibility and transition constraints"
        )
    best = min(
        states,
        key=lambda state: (
            state.cost,
            tuple(option.id for option in state.options),
        ),
    )
    return (
        best.options,
        best.transitions,
        {
            "static_limit": static_limit,
            "velocity_limit": velocity_limit,
            "static_scale": static_scale,
            "velocity_scale": velocity_scale,
        },
        policy,
    )


def _chain_positions(
    blocks: Sequence[Block],
    options: Sequence[Option],
) -> np.ndarray:
    first_block = blocks[0]
    last_block = blocks[-1]
    target_controls = [first_block.start]
    source_controls = [float(options[0].source_entry)]
    for block, option in zip(blocks, options):
        if block.anchor is None or option.source_peak is None:
            raise ValueError("natural gesture chain lacks an anchor/peak")
        target_controls.append(block.anchor)
        source_controls.append(float(option.source_peak))
    target_controls.append(last_block.end - 1)
    source_controls.append(float(options[-1].source_exit))
    return _piecewise_positions(
        target_controls,
        source_controls,
        first_block.start,
        last_block.end,
    )


def _assemble_positions(
    target_count: int,
    blocks: Sequence[Block],
    options: Sequence[Option],
    transitions: Sequence[Transition],
) -> tuple[np.ndarray, list[int]]:
    positions = np.full(target_count, np.nan, dtype=np.float32)
    boundaries: list[int] = []
    cursor = 0
    while cursor < len(blocks):
        chain_end = cursor
        while (
            chain_end < len(transitions)
            and transitions[chain_end].kind == "directed_natural_chain"
            and blocks[chain_end].kind == "gesture"
            and blocks[chain_end + 1].kind == "gesture"
        ):
            chain_end += 1
        if chain_end > cursor:
            chain = _chain_positions(
                blocks[cursor : chain_end + 1],
                options[cursor : chain_end + 1],
            )
            start = blocks[cursor].start
            end = blocks[chain_end].end
            positions[start:end] = chain
            cursor = chain_end + 1
            continue
        block = blocks[cursor]
        option = options[cursor]
        positions[block.start : block.end] = option.source_positions
        cursor += 1
    for transition in transitions:
        if transition.boundary:
            boundaries.append(transition.output_frame)
    if np.isnan(positions).any():
        missing = int(np.flatnonzero(np.isnan(positions))[0])
        raise RuntimeError(f"source schedule left output frame {missing} unplanned")
    return positions, boundaries


def _continuous_motion_metrics(
    positions: np.ndarray,
    boundaries: Sequence[int],
) -> dict[str, Any]:
    speeds = np.diff(np.asarray(positions, dtype=np.float64))
    continuous = np.ones(len(speeds), dtype=bool)
    for boundary in boundaries:
        if 1 <= boundary < len(positions):
            continuous[boundary - 1] = False
    selected_speeds = speeds[continuous]
    acceleration_mask = continuous[:-1] & continuous[1:]
    accelerations = np.diff(speeds)[acceleration_mask]
    return {
        "minimum_speed": (
            float(np.min(selected_speeds)) if len(selected_speeds) else 0.0
        ),
        "maximum_speed": (
            float(np.max(selected_speeds)) if len(selected_speeds) else 0.0
        ),
        "maximum_acceleration": (
            float(np.max(np.abs(accelerations))) if len(accelerations) else 0.0
        ),
        "continuous_edge_count": int(np.sum(continuous)),
        "boundary_edge_count": len(boundaries),
    }


def _nearest_source_indices(
    positions: np.ndarray,
    source_count: int,
) -> np.ndarray:
    return np.clip(
        np.rint(positions).astype(np.int32),
        0,
        source_count - 1,
    )


def _report(
    positions: np.ndarray,
    boundaries: Sequence[int],
    blocks: Sequence[Block],
    options: Sequence[Option],
    transitions: Sequence[Transition],
    clusters: Sequence[CoarticulationCluster],
    thresholds: Mapping[str, float],
    diversity_policy: DiversityPolicy,
    source_labels: Sequence[str],
    source_levels: np.ndarray,
    source_takes: np.ndarray,
    target_labels: Sequence[str],
    target_levels: np.ndarray,
    anchors: Sequence[str | None],
    roles: Sequence[str],
    fps: float,
    minimum_interval: int,
) -> dict[str, Any]:
    indices = _nearest_source_indices(positions, len(source_labels))
    realized_frames = {cluster.primary.frame for cluster in clusters}
    selected_labels = np.asarray(source_labels, dtype=object)[indices]
    selected_levels = np.interp(
        positions,
        np.arange(len(source_levels), dtype=np.float32),
        source_levels,
    )
    selected_takes = source_takes[indices]
    closed_compatible = (selected_labels == "CLOSED") | (
        selected_levels <= _CLOSED_LEVEL_THRESHOLD
    )
    target_label_values = np.asarray(target_labels, dtype=object)
    compatible = (selected_labels == target_label_values) | (
        (target_label_values == "CLOSED") & closed_compatible
    )
    silence_mask = np.asarray(
        [role == "silence" for role in roles],
        dtype=bool,
    )
    stable_pause_mask = np.zeros(len(roles), dtype=bool)
    for start, end, is_silence in _runs(silence_mask.tolist()):
        if is_silence and end - start >= minimum_interval:
            stable_pause_mask[start:end] = True
    coarticulated_micro_pause_mask = silence_mask & ~stable_pause_mask
    speech_mask = ~silence_mask
    anchor_mask = np.asarray(
        [anchor is not None for anchor in anchors],
        dtype=bool,
    )
    anchor_match = np.asarray(
        [
            anchor is None
            or (anchor == "CLOSED" and closed_compatible[index])
            or selected_labels[index] == anchor
            for index, anchor in enumerate(anchors)
        ],
        dtype=bool,
    )
    original_large_core = np.asarray(
        [
            anchor in VOWEL_VISEMES and target_levels[index] >= 2.5
            for index, anchor in enumerate(anchors)
        ],
        dtype=bool,
    )
    realized_large_core = np.asarray(
        [
            index in realized_frames and original_large_core[index]
            for index in range(len(anchors))
        ],
        dtype=bool,
    )
    large_covered = selected_levels >= 2.5
    realized_event_mask = np.asarray(
        [index in realized_frames for index in range(len(anchors))],
        dtype=bool,
    )
    realized_strength_errors = np.abs(
        selected_levels[realized_event_mask]
        - target_levels[realized_event_mask]
    )
    silence_differences = [
        abs(float(positions[index] - positions[index - 1]))
        for index in range(1, len(positions))
        if silence_mask[index] and silence_mask[index - 1]
    ]
    active_silence = [
        difference >= _MIN_SOURCE_SPEED * 0.5
        for difference in silence_differences
    ]
    take_usage: dict[str, Any] = {
        "gesture_by_take": {},
        "gesture_by_viseme_and_take": {},
        "idle_by_clip": {},
    }
    for option in options:
        clip = option.clip
        if clip.kind == "gesture":
            key = str(clip.take)
            take_usage["gesture_by_take"][key] = (
                take_usage["gesture_by_take"].get(key, 0) + 1
            )
            viseme_key = f"{clip.viseme}:take:{clip.take}"
            take_usage["gesture_by_viseme_and_take"][viseme_key] = (
                take_usage["gesture_by_viseme_and_take"].get(viseme_key, 0)
                + 1
            )
        else:
            take_usage["idle_by_clip"][clip.id] = (
                take_usage["idle_by_clip"].get(clip.id, 0) + 1
            )
    repeated_clip_windows: list[dict[str, Any]] = []
    for index, option in enumerate(options):
        previous = [
            earlier
            for earlier in range(max(0, index - 4), index)
            if options[earlier].clip.id == option.clip.id
        ]
        if previous:
            repeated_clip_windows.append(
                {
                    "block_index": index,
                    "clip_id": option.clip.id,
                    "previous_block_indices": previous,
                }
            )
    gesture_options = [
        option for option in options if option.clip.kind == "gesture"
    ]
    gesture_pairs = [
        (block, option)
        for block, option in zip(blocks, options)
        if option.clip.kind == "gesture"
    ]
    gesture_recent_counts = [
        sum(
            candidate.clip.id == option.clip.id
            for candidate in gesture_options[max(0, index - 4) : index + 1]
        )
        for index, option in enumerate(gesture_options)
    ]
    selected_clip_counts = Counter(
        option.clip.id for option in gesture_options
    )
    selected_take_counts = Counter(
        option.clip.take for option in gesture_options
    )
    selected_clip_counts_by_viseme: dict[str, Counter[str]] = defaultdict(
        Counter
    )
    selected_take_counts_by_viseme: dict[str, Counter[int]] = defaultdict(
        Counter
    )
    recent_maximum_by_viseme: dict[str, int] = defaultdict(int)
    for index, option in enumerate(gesture_options):
        viseme = option.clip.viseme
        selected_clip_counts_by_viseme[viseme][option.clip.id] += 1
        selected_take_counts_by_viseme[viseme][option.clip.take] += 1
        recent_count = sum(
            candidate.clip.id == option.clip.id
            for candidate in gesture_options[
                max(0, index - (_DIVERSITY_WINDOW - 1)) : index + 1
            ]
        )
        recent_maximum_by_viseme[viseme] = max(
            recent_maximum_by_viseme[viseme],
            recent_count,
        )

    clip_strength_errors = np.asarray(
        [option.target_strength_error for _, option in gesture_pairs],
        dtype=np.float64,
    )
    strength_by_viseme: dict[str, dict[str, Any]] = {}
    for viseme in sorted(diversity_policy.gesture_block_count_by_viseme):
        pairs = [
            (block, option)
            for block, option in gesture_pairs
            if block.viseme == viseme
        ]
        target_strengths = np.asarray(
            [block.target_peak_level for block, _ in pairs],
            dtype=np.float64,
        )
        clip_strengths = np.asarray(
            [option.clip.peak_strength_level for _, option in pairs],
            dtype=np.float64,
        )
        clip_errors = np.abs(clip_strengths - target_strengths)
        realized_errors = np.asarray(
            [
                abs(
                    float(selected_levels[int(block.anchor)])
                    - block.target_peak_level
                )
                for block, _ in pairs
                if block.anchor is not None
            ],
            dtype=np.float64,
        )
        strength_by_viseme[viseme] = {
            "gesture_block_count": len(pairs),
            "target_strength_mean": round(
                float(np.mean(target_strengths)),
                6,
            ),
            "selected_clip_peak_strength_mean": round(
                float(np.mean(clip_strengths)),
                6,
            ),
            "clip_strength_mean_absolute_error": round(
                float(np.mean(clip_errors)),
                6,
            ),
            "clip_strength_p95_absolute_error": round(
                float(np.percentile(clip_errors, 95)),
                6,
            ),
            "clip_strength_maximum_absolute_error": round(
                float(np.max(clip_errors)),
                6,
            ),
            "realized_source_strength_mean_absolute_error": round(
                float(np.mean(realized_errors)),
                6,
            ),
            "realized_source_strength_p95_absolute_error": round(
                float(np.percentile(realized_errors, 95)),
                6,
            ),
        }

    diversity_by_viseme: dict[str, dict[str, Any]] = {}
    per_viseme_satisfied = True
    for viseme in sorted(diversity_policy.gesture_block_count_by_viseme):
        clip_counts = selected_clip_counts_by_viseme[viseme]
        take_counts = selected_take_counts_by_viseme[viseme]
        required_clips = (
            diversity_policy.required_unique_clip_count_by_viseme[viseme]
        )
        required_takes = (
            diversity_policy.required_unique_take_count_by_viseme[viseme]
        )
        maximum_recent = (
            diversity_policy.maximum_same_clip_in_recent_5_by_viseme[viseme]
        )
        viseme_satisfied = (
            len(clip_counts) >= required_clips
            and len(take_counts) >= required_takes
            and recent_maximum_by_viseme[viseme] <= maximum_recent
        )
        per_viseme_satisfied = per_viseme_satisfied and viseme_satisfied
        diversity_by_viseme[viseme] = {
            "gesture_block_count": (
                diversity_policy.gesture_block_count_by_viseme[viseme]
            ),
            "available_clip_ids": sorted(
                diversity_policy.available_clip_ids_by_viseme[viseme]
            ),
            "available_take_ids": sorted(
                diversity_policy.available_take_ids_by_viseme[viseme]
            ),
            "required_unique_clip_count": required_clips,
            "required_unique_take_count": required_takes,
            "required_maximum_same_clip_occurrences_in_recent_5": (
                maximum_recent
            ),
            "selected_clip_counts": dict(sorted(clip_counts.items())),
            "selected_take_counts": {
                str(key): value
                for key, value in sorted(take_counts.items())
            },
            "selected_unique_clip_count": len(clip_counts),
            "selected_unique_take_count": len(take_counts),
            "observed_maximum_same_clip_occurrences_in_recent_5": (
                recent_maximum_by_viseme[viseme]
            ),
            "satisfied": viseme_satisfied,
        }
    global_diversity_satisfied = (
        len(selected_clip_counts)
        >= diversity_policy.required_unique_clip_count
        and len(selected_take_counts)
        >= diversity_policy.required_unique_take_count
        and per_viseme_satisfied
    )
    if not global_diversity_satisfied:
        raise AssertionError(
            "selected route violated the planner-owned adaptive "
            "gesture-diversity contract"
        )
    transition_counts: dict[tuple[str, str], int] = {}
    for transition in transitions:
        pair = (transition.from_option_key, transition.to_option_key)
        transition_counts[pair] = transition_counts.get(pair, 0) + 1
    repeated_transitions = [
        {
            "from_option_key": pair[0],
            "to_option_key": pair[1],
            "count": count,
        }
        for pair, count in sorted(transition_counts.items())
        if count > 1
    ]
    boundary_gaps = np.diff(np.asarray(boundaries, dtype=np.int32))
    motion = _continuous_motion_metrics(positions, boundaries)
    if motion["maximum_speed"] > _MAX_SOURCE_SPEED + 1e-5:
        raise AssertionError(
            "gesture scheduler exceeded its source-speed bound outside a "
            f"reviewed seam: {motion['maximum_speed']:.6f}"
        )
    if motion["maximum_acceleration"] > _MAX_SOURCE_ACCELERATION + 1e-5:
        raise AssertionError(
            "gesture scheduler exceeded its source-acceleration bound outside "
            f"a reviewed seam: {motion['maximum_acceleration']:.6f}"
        )
    if len(boundary_gaps) and int(np.min(boundary_gaps)) < minimum_interval:
        raise AssertionError(
            "gesture scheduler produced crowded boundaries: "
            f"minimum={int(np.min(boundary_gaps))}, required={minimum_interval}"
        )
    duration_seconds = len(positions) / fps
    block_reports = []
    for block, option in zip(blocks, options):
        actual = _continuous_motion_metrics(
            positions[block.start : block.end],
            [],
        )
        block_reports.append({
            "block_index": block.index,
            "kind": block.kind,
            "output_start_frame": block.start,
            "output_end_frame_exclusive": block.end,
            "target_viseme": block.viseme,
            "target_anchor_frame": block.anchor,
            "coarticulation_cluster_index": block.cluster_index,
            "cluster_anchor_frames": [
                event.frame for event in block.anchor_events
            ],
            "clip_id": option.clip.id,
            "option_key": option.key,
            "take": option.clip.take,
            "source_entry_frame": option.source_entry,
            "source_peak_frame": option.source_peak,
            "source_exit_frame": option.source_exit,
            "entry_intensity_level": option.entry_level,
            "exit_intensity_level": option.exit_level,
            "target_acoustic_strength_level": round(
                block.target_peak_level,
                6,
            ),
            "clip_peak_strength_level": round(
                option.clip.peak_strength_level,
                6,
            ),
            "target_strength_error": round(
                option.target_strength_error,
                6,
            ),
            "actual_source_speed_min": round(actual["minimum_speed"], 6),
            "actual_source_speed_max": round(actual["maximum_speed"], 6),
            "actual_source_acceleration_max": round(
                actual["maximum_acceleration"],
                6,
            ),
        })
    vowel_anchor_frames = [
        index
        for index, anchor in enumerate(anchors)
        if anchor in VOWEL_VISEMES
    ]
    cluster_reports = [
        {
            "cluster_index": cluster.index,
            "selection_basis": (
                "maximum-cardinality non-transitive interval selection at "
                "the required event gap; ties prefer acoustic prominence, "
                "longer vowel duration, then earlier anchors"
            ),
            "primary_anchor_frame": cluster.primary.frame,
            "primary_viseme": cluster.primary.viseme,
            "anchors": [
                {
                    "frame": event.frame,
                    "viseme": event.viseme,
                    "target_level": round(event.level, 6),
                    "vowel_duration_frames": event.vowel_duration,
                    "prominence": round(event.prominence, 6),
                    "status": (
                        "realized"
                        if event.frame == cluster.primary.frame
                        else "absorbed"
                    ),
                }
                for event in cluster.events
            ],
        }
        for cluster in clusters
    ]
    cluster_status_by_frame = {
        item["frame"]: item["status"]
        for cluster in cluster_reports
        for item in cluster["anchors"]
    }
    anchor_inventory = []
    for frame, anchor in enumerate(anchors):
        if anchor is None:
            continue
        if anchor in VOWEL_VISEMES:
            status = cluster_status_by_frame[frame]
        else:
            status = (
                "realized_closure"
                if closed_compatible[frame]
                else "unrealized_closure"
            )
        anchor_inventory.append(
            {
                "frame": frame,
                "viseme": anchor,
                "status": status,
            }
        )
    realized_anchor_statuses = {"realized", "realized_closure"}
    realized_anchor_count = sum(
        item["status"] in realized_anchor_statuses
        for item in anchor_inventory
    )
    realized_event_frames = sorted(realized_frames)
    realized_event_gaps = np.diff(
        np.asarray(realized_event_frames, dtype=np.int32)
    )
    if (
        len(realized_event_gaps)
        and int(np.min(realized_event_gaps)) < minimum_interval
    ):
        raise AssertionError(
            "coarticulation scheduler produced crowded realized events: "
            f"minimum={int(np.min(realized_event_gaps))}, "
            f"required={minimum_interval}"
        )
    transition_kind_counts = {
        kind: sum(transition.kind == kind for transition in transitions)
        for kind in (
            "native_contiguous",
            "directed_natural_chain",
            "compatible_low_endpoint_seam",
        )
    }
    threshold_failures = sum(
        transition.boundary
        and (
            transition.static_rms is None
            or transition.velocity_rms is None
            or transition.static_rms > thresholds["static_limit"]
            or transition.velocity_rms > thresholds["velocity_limit"]
        )
        for transition in transitions
    )
    return {
        "planned_annotation_method": (
            "AI-reviewed coarticulation-cluster scheduler with complete "
            "low→peak→low gesture/idle clips, directed natural chains, exact "
            "entry/exit endpoint compatibility, and bounded floating-point "
            "source-time maps"
        ),
        "planned_annotation_source_position_dtype": "float32",
        "planned_annotation_frame_count": len(positions),
        "planned_annotation_coarticulation_clusters": cluster_reports,
        "planned_annotation_anchor_inventory": anchor_inventory,
        "planned_annotation_original_anchor_count": len(anchor_inventory),
        "planned_annotation_realized_anchor_count": realized_anchor_count,
        "planned_annotation_absorbed_or_unrealized_anchor_count": (
            len(anchor_inventory) - realized_anchor_count
        ),
        "planned_annotation_realized_anchor_coverage_rate": round(
            realized_anchor_count / len(anchor_inventory)
            if anchor_inventory
            else 1.0,
            6,
        ),
        "planned_annotation_original_vowel_anchor_count": len(
            vowel_anchor_frames
        ),
        "planned_annotation_realized_vowel_anchor_count": len(realized_frames),
        "planned_annotation_absorbed_vowel_anchor_count": (
            len(vowel_anchor_frames) - len(realized_frames)
        ),
        "planned_annotation_realized_vowel_anchor_coverage_rate": round(
            len(realized_frames) / len(vowel_anchor_frames)
            if vowel_anchor_frames
            else 1.0,
            6,
        ),
        "planned_annotation_minimum_realized_event_gap": (
            int(np.min(realized_event_gaps))
            if len(realized_event_gaps)
            else None
        ),
        "planned_annotation_required_minimum_event_gap": minimum_interval,
        "planned_annotation_speech_viseme_match_rate": round(
            float(np.mean(compatible[speech_mask]))
            if np.any(speech_mask)
            else 1.0,
            6,
        ),
        "planned_annotation_anchor_match_rate": round(
            float(np.mean(anchor_match[anchor_mask]))
            if np.any(anchor_mask)
            else 1.0,
            6,
        ),
        "planned_annotation_silence_closed_match_rate": round(
            float(np.mean(closed_compatible[silence_mask]))
            if np.any(silence_mask)
            else 1.0,
            6,
        ),
        "planned_annotation_stable_pause_closed_match_rate": round(
            float(np.mean(closed_compatible[stable_pause_mask]))
            if np.any(stable_pause_mask)
            else 1.0,
            6,
        ),
        "planned_annotation_coarticulated_micro_pause_closed_match_rate": round(
            float(
                np.mean(
                    closed_compatible[coarticulated_micro_pause_mask]
                )
            )
            if np.any(coarticulated_micro_pause_mask)
            else 1.0,
            6,
        ),
        "planned_annotation_stable_pause_frame_count": int(
            np.sum(stable_pause_mask)
        ),
        "planned_annotation_coarticulated_micro_pause_frame_count": int(
            np.sum(coarticulated_micro_pause_mask)
        ),
        "planned_annotation_original_large_mouth_core_count": int(
            np.sum(original_large_core)
        ),
        "planned_annotation_realized_large_mouth_core_count": int(
            np.sum(realized_large_core)
        ),
        "planned_annotation_large_mouth_original_core_coverage_rate": round(
            float(np.mean(large_covered[original_large_core]))
            if np.any(original_large_core)
            else 1.0,
            6,
        ),
        "planned_annotation_large_mouth_realized_core_coverage_rate": round(
            float(np.mean(large_covered[realized_large_core]))
            if np.any(realized_large_core)
            else 1.0,
            6,
        ),
        "planned_annotation_realized_strength_mean_absolute_error": round(
            float(np.mean(realized_strength_errors))
            if len(realized_strength_errors)
            else 0.0,
            6,
        ),
        "planned_annotation_realized_strength_p95_absolute_error": round(
            float(np.percentile(realized_strength_errors, 95))
            if len(realized_strength_errors)
            else 0.0,
            6,
        ),
        "planned_annotation_clip_strength_mean_absolute_error": round(
            float(np.mean(clip_strength_errors))
            if len(clip_strength_errors)
            else 0.0,
            6,
        ),
        "planned_annotation_clip_strength_p95_absolute_error": round(
            float(np.percentile(clip_strength_errors, 95))
            if len(clip_strength_errors)
            else 0.0,
            6,
        ),
        "planned_annotation_clip_strength_maximum_absolute_error": round(
            float(np.max(clip_strength_errors))
            if len(clip_strength_errors)
            else 0.0,
            6,
        ),
        "planned_annotation_strength_by_viseme": strength_by_viseme,
        "planned_annotation_silence_dynamic_rate": round(
            float(np.mean(active_silence)) if active_silence else 1.0,
            6,
        ),
        "planned_annotation_boundary_count": len(boundaries),
        "planned_annotation_boundaries_per_second": round(
            len(boundaries) / duration_seconds,
            6,
        ),
        "planned_annotation_minimum_boundary_gap": (
            int(np.min(boundary_gaps)) if len(boundary_gaps) else None
        ),
        "planned_annotation_minimum_continuous_source_speed": round(
            motion["minimum_speed"],
            6,
        ),
        "planned_annotation_maximum_continuous_source_speed": round(
            motion["maximum_speed"],
            6,
        ),
        "planned_annotation_maximum_continuous_source_acceleration": round(
            motion["maximum_acceleration"],
            6,
        ),
        "planned_annotation_source_speed_limit": _MAX_SOURCE_SPEED,
        "planned_annotation_source_acceleration_limit": (
            _MAX_SOURCE_ACCELERATION
        ),
        "planned_annotation_required_minimum_boundary_gap": minimum_interval,
        "planned_annotation_transition_kind_counts": transition_kind_counts,
        "planned_annotation_boundary_output_frames": list(boundaries),
        "planned_annotation_selected_clip_transitions": [
            transition.report() for transition in transitions
        ],
        "planned_annotation_take_usage": take_usage,
        "planned_annotation_repeated_clip_windows": repeated_clip_windows,
        "planned_annotation_repeated_transitions": repeated_transitions,
        "planned_annotation_gesture_block_count": len(gesture_options),
        "planned_annotation_selected_gesture_take_count": len(
            take_usage["gesture_by_take"]
        ),
        "planned_annotation_unique_gesture_clip_count": len(
            {option.clip.id for option in gesture_options}
        ),
        "planned_annotation_available_gesture_clip_count": len(
            diversity_policy.available_clip_ids
        ),
        "planned_annotation_available_gesture_take_count": len(
            diversity_policy.available_take_ids
        ),
        "planned_annotation_required_unique_gesture_clip_count": (
            diversity_policy.required_unique_clip_count
        ),
        "planned_annotation_required_unique_gesture_take_count": (
            diversity_policy.required_unique_take_count
        ),
        "planned_annotation_required_maximum_same_gesture_clip_occurrences_in_recent_5": (
            diversity_policy.maximum_same_clip_in_recent_5
        ),
        "planned_annotation_maximum_same_gesture_clip_occurrences_in_recent_5": (
            max(gesture_recent_counts) if gesture_recent_counts else 0
        ),
        "planned_annotation_gesture_diversity_contract_satisfied": (
            global_diversity_satisfied
        ),
        "planned_annotation_gesture_diversity_contract": {
            "selection_basis": (
                "strength-eligible clip inventory after the per-block "
                "near-best strength filter"
            ),
            "recent_window_size": _DIVERSITY_WINDOW,
            "global": {
                "gesture_block_count": diversity_policy.gesture_block_count,
                "available_clip_ids": sorted(
                    diversity_policy.available_clip_ids
                ),
                "available_take_ids": sorted(
                    diversity_policy.available_take_ids
                ),
                "required_unique_clip_count": (
                    diversity_policy.required_unique_clip_count
                ),
                "required_unique_take_count": (
                    diversity_policy.required_unique_take_count
                ),
                "required_maximum_same_clip_occurrences_in_recent_5": (
                    diversity_policy.maximum_same_clip_in_recent_5
                ),
                "selected_clip_counts": dict(
                    sorted(selected_clip_counts.items())
                ),
                "selected_take_counts": {
                    str(key): value
                    for key, value in sorted(selected_take_counts.items())
                },
                "selected_unique_clip_count": len(selected_clip_counts),
                "selected_unique_take_count": len(selected_take_counts),
                "observed_maximum_same_clip_occurrences_in_recent_5": (
                    max(gesture_recent_counts)
                    if gesture_recent_counts
                    else 0
                ),
                "satisfied": global_diversity_satisfied,
            },
            "per_viseme": diversity_by_viseme,
            "satisfied": global_diversity_satisfied,
        },
        "planned_annotation_blocks": block_reports,
        "planned_annotation_static_descriptor_rms_limit": round(
            thresholds["static_limit"],
            8,
        ),
        "planned_annotation_motion_velocity_rms_limit": round(
            thresholds["velocity_limit"],
            8,
        ),
        "planned_annotation_threshold_failed_selected_transition_count": int(
            threshold_failures
        ),
        "planned_annotation_selected_source_take_count": int(
            len(set(int(value) for value in selected_takes if value > 0))
        ),
    }


def _validate_inputs(
    source_labels: Sequence[str],
    source_levels: np.ndarray,
    source_takes: np.ndarray,
    descriptors: np.ndarray,
    target_labels: Sequence[str],
    target_levels: np.ndarray,
    anchors: Sequence[str | None],
    roles: Sequence[str],
    fps: float,
) -> None:
    source_count = len(source_labels)
    target_count = len(target_labels)
    if not (
        source_count
        == len(source_levels)
        == len(source_takes)
        == len(descriptors)
    ):
        raise ValueError(
            "source_labels/source_levels/source_takes/descriptors must align"
        )
    if not (
        target_count
        == len(target_levels)
        == len(anchors)
        == len(roles)
    ):
        raise ValueError(
            "target_labels/target_levels/anchors/roles must align"
        )
    if target_count < 1 or source_count < 4:
        raise ValueError("source and target timelines must be non-empty")
    if descriptors.ndim != 2 or descriptors.shape[1] < 1:
        raise ValueError("descriptors must be [source_frame, feature]")
    if not (
        np.isfinite(source_levels).all()
        and np.isfinite(target_levels).all()
        and np.isfinite(descriptors).all()
    ):
        raise ValueError("planner inputs contain non-finite values")
    invalid = {
        value
        for value in list(source_labels)
        + list(target_labels)
        + [anchor for anchor in anchors if anchor is not None]
        if value not in VISEMES
    }
    if invalid:
        raise ValueError(f"invalid visemes: {sorted(invalid)}")
    if fps <= 0:
        raise ValueError("fps must be positive")


def plan_gesture_motion(
    library: Mapping[str, Any],
    source_labels: Sequence[str],
    source_levels: Sequence[float] | np.ndarray,
    source_takes: Sequence[int] | np.ndarray,
    descriptors: np.ndarray,
    target_labels: Sequence[str],
    target_levels: Sequence[float] | np.ndarray,
    anchors: Sequence[str | None],
    roles: Sequence[str],
    *,
    fps: float = 24.0,
) -> tuple[np.ndarray, list[int], dict[str, Any]]:
    """Plan complete gesture/idle clips and return fractional source positions."""

    source_level_values = np.asarray(source_levels, dtype=np.float64)
    source_take_values = np.asarray(source_takes, dtype=np.int32)
    descriptor_values = np.asarray(descriptors, dtype=np.float64)
    target_level_values = np.asarray(target_levels, dtype=np.float64)
    _validate_inputs(
        source_labels,
        source_level_values,
        source_take_values,
        descriptor_values,
        target_labels,
        target_level_values,
        anchors,
        roles,
        fps,
    )
    gestures, closed, natural = _parse_library(
        library,
        len(source_labels),
        source_take_values,
    )
    minimum_interval = max(
        1,
        int(np.ceil(_MIN_EVENT_INTERVAL_AT_24_FPS * fps / 24.0)),
    )
    blocks, clusters = _build_blocks(
        target_labels,
        target_level_values,
        anchors,
        roles,
        gestures,
        closed,
        minimum_interval,
    )
    options_by_block = _options_by_block(blocks, gestures, closed)
    options, transitions, thresholds, diversity_policy = _choose_options(
        blocks,
        options_by_block,
        descriptor_values,
        natural,
        minimum_interval,
    )
    positions, boundaries = _assemble_positions(
        len(target_labels),
        blocks,
        options,
        transitions,
    )
    report = _report(
        positions,
        boundaries,
        blocks,
        options,
        transitions,
        clusters,
        thresholds,
        diversity_policy,
        source_labels,
        source_level_values,
        source_take_values,
        target_labels,
        target_level_values,
        anchors,
        roles,
        fps,
        minimum_interval,
    )
    report["planned_annotation_boundary_option_pairs"] = [
        {
            "output_frame": transition.output_frame,
            "option_pair_key": [
                transition.from_option_key,
                transition.to_option_key,
            ],
        }
        for transition in transitions
        if transition.boundary
    ]
    return positions.astype(np.float32, copy=False), boundaries, report


def _synthetic_fixture() -> tuple[Any, ...]:
    clip_length = 9
    closed_ranges = [(0, 12), (57, 69), (114, 126)]
    take_starts = {1: 12, 2: 69}
    source_count = 126
    source_labels = ["CLOSED"] * source_count
    source_levels = np.zeros(source_count, dtype=np.float64)
    source_takes = np.zeros(source_count, dtype=np.int32)
    gestures: list[dict[str, Any]] = []
    natural: list[dict[str, Any]] = []
    for take, take_start in take_starts.items():
        previous: tuple[str, int, int] | None = None
        for viseme_index, viseme in enumerate(VOWEL_VISEMES):
            start = take_start + viseme_index * clip_length
            end = start + clip_length
            source_labels[start:end] = [viseme] * clip_length
            source_levels[start:end] = [0, 1, 2, 3, 4, 3, 2, 1, 0]
            source_takes[start:end] = take
            gestures.append(
                {
                    "id": f"{viseme}_take_{take}",
                    "viseme": viseme,
                    "take": take,
                    "peak_strength_level": 4.0,
                    "start_frame": start,
                    "end_frame_exclusive": end,
                    "rise_frames_by_intensity": [
                        start,
                        start + 1,
                        start + 2,
                        start + 3,
                        start + 4,
                    ],
                    "peak_frame_range_inclusive": [
                        start + 4,
                        start + 4,
                    ],
                    "fall_frames_by_intensity": [
                        end - 1,
                        end - 2,
                        end - 3,
                        end - 4,
                        start + 4,
                    ],
                    "representative_frames_by_intensity": [
                        start,
                        start + 1,
                        start + 2,
                        start + 3,
                        start + 4,
                    ],
                }
            )
            if previous is not None:
                previous_viseme, previous_start, previous_end = previous
                natural.append(
                    {
                        "from": previous_viseme,
                        "to": viseme,
                        "take": take,
                        "start_frame": previous_end - 3,
                        "end_frame_exclusive": start + 3,
                    }
                )
            previous = (viseme, start, end)
    closed = []
    for index, (start, end) in enumerate(closed_ranges, start=1):
        source_takes[start:end] = index
        closed.append(
            {
                "id": f"closed_{index}",
                "start_frame": start,
                "end_frame_exclusive": end,
            }
        )
    phase = np.arange(source_count, dtype=np.float64)
    descriptors = np.column_stack(
        (
            0.04 * np.sin(2 * np.pi * phase / 57),
            0.03 * np.cos(2 * np.pi * phase / 57),
            0.02 * np.sin(2 * np.pi * phase / 19),
            0.01 * np.cos(2 * np.pi * phase / 13),
        )
    )
    target_count = 116
    target_labels = ["CLOSED"] * target_count
    target_levels = np.zeros(target_count, dtype=np.float64)
    anchors: list[str | None] = [None] * target_count
    roles = ["silence"] * target_count
    speech_runs = [
        (12, 52, [16, 20, 30, 38, 46]),
        (64, 104, [68, 72, 82, 90, 98]),
    ]
    for run_start, run_end, nuclei in speech_runs:
        for frame in range(run_start, run_end):
            roles[frame] = "vowel"
        splits = [run_start]
        splits.extend(
            (left + right + 1) // 2
            for left, right in zip(nuclei, nuclei[1:])
        )
        splits.append(run_end)
        for index, (viseme, nucleus) in enumerate(
            zip(VOWEL_VISEMES, nuclei)
        ):
            anchors[nucleus] = viseme
            for frame in range(splits[index], splits[index + 1]):
                target_labels[frame] = viseme
                distance = abs(frame - nucleus)
                target_levels[frame] = max(0.65, 4.0 - 0.8 * distance)
    anchors[6] = "CLOSED"
    anchors[56] = "CLOSED"
    anchors[108] = "CLOSED"
    library = {
        "version": 1,
        "gesture_clips": gestures,
        "closed_motion_clips": closed,
        "natural_transition_spans": natural,
    }
    return (
        library,
        source_labels,
        source_levels,
        source_takes,
        descriptors,
        target_labels,
        target_levels,
        anchors,
        roles,
    )


def _regression_clip(
    clip_id: str,
    viseme: str,
    take: int,
    start: int,
    strength: float,
) -> Clip:
    return Clip(
        id=clip_id,
        kind="gesture",
        viseme=viseme,
        take=take,
        start=start,
        end=start + 9,
        entry=start,
        exit=start + 8,
        peak_start=start + 4,
        peak_end=start + 4,
        peak_strength_level=strength,
        low_entries=(start, start + 1),
        low_exits=(start + 8, start + 7),
    )


def _regression_block(
    index: int,
    viseme: str,
    strength: float,
) -> Block:
    start = index * 9
    return Block(
        index=index,
        kind="gesture",
        start=start,
        end=start + 9,
        viseme=viseme,
        anchor=start + 4,
        target_peak_level=strength,
    )


def _selection_regression_tests() -> dict[str, Any]:
    descriptors = np.zeros((64, 4), dtype=np.float64)

    first_block = _regression_block(0, "A", 1.0)
    first_low = _regression_clip("A_strength_1", "A", 1, 0, 1.0)
    first_high = _regression_clip("A_strength_4", "A", 2, 9, 4.0)
    first_options = [
        _gesture_options(first_block, first_low)
        + _gesture_options(first_block, first_high)
    ]
    first_selected, _, _, _ = _choose_options(
        [first_block],
        first_options,
        descriptors,
        {},
        8,
    )
    assert first_selected[0].clip.peak_strength_level == 1.0
    assert _initial_state(first_selected[0]).cost > 0.0
    assert (
        _option_intrinsic_penalty(
            _gesture_options(first_block, first_high)[0]
        )
        > _option_intrinsic_penalty(first_selected[0])
    )

    second_blocks = [
        _regression_block(0, "A", 1.0),
        _regression_block(1, "I", 4.0),
    ]
    second_a = _regression_clip("A_low_take_1", "A", 1, 0, 1.0)
    second_i_low = _regression_clip(
        "I_low_natural_take_1",
        "I",
        1,
        9,
        1.0,
    )
    second_i_high = _regression_clip(
        "I_high_seam_take_2",
        "I",
        2,
        18,
        4.0,
    )
    second_options = [
        _gesture_options(second_blocks[0], second_a),
        (
            _gesture_options(second_blocks[1], second_i_low)
            + _gesture_options(second_blocks[1], second_i_high)
        ),
    ]
    low_natural_option = _gesture_options(
        second_blocks[1],
        second_i_low,
    )[0]
    assert _natural_span(
        _gesture_options(second_blocks[0], second_a)[0],
        low_natural_option,
        {(1, "A", "I"): (6, 12)},
    ) == (6, 12)
    second_selected, second_transitions, _, _ = _choose_options(
        second_blocks,
        second_options,
        descriptors,
        {(1, "A", "I"): (6, 12)},
        8,
    )
    assert second_selected[1].clip.id == "I_high_seam_take_2"
    assert second_transitions[0].kind == "compatible_low_endpoint_seam"

    repeated_blocks = [
        _regression_block(index, "A", 4.0)
        for index in range(4)
    ]
    repeated_clips = [
        _regression_clip("A_take_1", "A", 1, 0, 4.0),
        _regression_clip("A_take_2", "A", 2, 9, 4.0),
    ]
    repeated_options = [
        [
            option
            for clip in repeated_clips
            for option in _gesture_options(block, clip)
        ]
        for block in repeated_blocks
    ]
    repeated_selected, _, _, repeated_policy = _choose_options(
        repeated_blocks,
        repeated_options,
        descriptors,
        {},
        8,
    )
    selected_repeated_clips = {
        option.clip.id for option in repeated_selected
    }
    selected_repeated_takes = {
        option.clip.take for option in repeated_selected
    }
    assert selected_repeated_clips == {"A_take_1", "A_take_2"}
    assert selected_repeated_takes == {1, 2}
    assert repeated_policy.required_unique_clip_count == 2
    assert repeated_policy.required_unique_take_count == 2
    assert (
        repeated_policy.maximum_same_clip_in_recent_5_by_viseme["A"]
        == 3
    )
    assert max(
        sum(
            candidate.clip.id == option.clip.id
            for candidate in repeated_selected[max(0, index - 4) : index + 1]
        )
        for index, option in enumerate(repeated_selected)
    ) <= 3

    matched_blocks = [
        _regression_block(0, "I", 4.0),
        _regression_block(1, "I", 4.0),
    ]
    matched_clips = [
        replace(
            _regression_clip("I_matched_1", "I", 1, 0, 4.0),
            end=13,
            exit=12,
            peak_start=6,
            peak_end=6,
            low_entries=(0, 1, 2),
            low_exits=(12, 11, 10),
        ),
        replace(
            _regression_clip("I_matched_2", "I", 2, 13, 4.0),
            end=26,
            exit=25,
            peak_start=19,
            peak_end=19,
            low_entries=(13, 14, 15),
            low_exits=(25, 24, 23),
        ),
    ]
    matched_options = [
        next(
            option
            for option in _gesture_options(block, clip)
            if option.entry_level == 2 and option.exit_level == 2
        )
        for block, clip in zip(matched_blocks, matched_clips)
    ]
    matched_transition = _transition(
        matched_options[0],
        matched_options[1],
        matched_blocks[0],
        matched_blocks[1],
        matched_blocks[1].start,
        descriptors,
        {},
        1.0,
        1.0,
        1.0,
        1.0,
    )
    assert matched_transition is not None
    assert (
        matched_transition.kind
        == "compatible_matched_same_viseme_endpoint_seam"
    )
    different_viseme_option = replace(
        matched_options[1],
        clip=replace(matched_options[1].clip, viseme="E"),
    )
    cross_viseme_transition = _transition(
        matched_options[0],
        different_viseme_option,
        matched_blocks[0],
        replace(matched_blocks[1], viseme="E"),
        matched_blocks[1].start,
        descriptors,
        {},
        1.0,
        1.0,
        1.0,
        1.0,
    )
    assert cross_viseme_transition is not None
    assert (
        cross_viseme_transition.kind
        == "compatible_matched_cross_viseme_endpoint_seam"
    )
    assert (
        _transition(
            matched_options[0],
            replace(different_viseme_option, entry_level=1),
            matched_blocks[0],
            replace(matched_blocks[1], viseme="E"),
            matched_blocks[1].start,
            descriptors,
            {},
            1.0,
            1.0,
            1.0,
            1.0,
        )
        is None
    )
    asymmetric_left = next(
        option
        for option in _gesture_options(
            matched_blocks[0],
            matched_clips[0],
        )
        if option.entry_level == 0 and option.exit_level == 2
    )
    asymmetric_right = next(
        option
        for option in _gesture_options(
            matched_blocks[1],
            replace(matched_clips[1], viseme="E"),
        )
        if option.entry_level == 2 and option.exit_level == 0
    )
    asymmetric_transition = _transition(
        asymmetric_left,
        asymmetric_right,
        matched_blocks[0],
        replace(matched_blocks[1], viseme="E"),
        matched_blocks[1].start,
        descriptors,
        {},
        1.0,
        1.0,
        1.0,
        1.0,
    )
    assert asymmetric_transition is not None
    assert (
        asymmetric_transition.kind
        == "compatible_matched_cross_viseme_endpoint_seam"
    )
    return {
        "first_block_target_1_selected_strength": (
            first_selected[0].clip.peak_strength_level
        ),
        "target_4_ignored_wrong_strength_natural_edge": (
            second_selected[1].clip.id
        ),
        "four_same_vowel_two_take_selected_clips": sorted(
            selected_repeated_clips
        ),
        "matched_same_vowel_endpoint_seam": matched_transition.kind,
        "matched_cross_vowel_endpoint_seam": cross_viseme_transition.kind,
        "asymmetric_entry_exit_chain": (
            f"{asymmetric_left.entry_level}->{asymmetric_left.exit_level}"
            f" / {asymmetric_right.entry_level}->{asymmetric_right.exit_level}"
        ),
    }


def lightweight_self_test() -> dict[str, Any]:
    selection_regressions = _selection_regression_tests()
    dense_events = [
        AnchorEvent(
            frame=index * 6,
            viseme=VOWEL_VISEMES[index % len(VOWEL_VISEMES)],
            level=3.0 + 0.1 * (index % 3),
            vowel_duration=5,
            prominence=3.0 + 0.1 * (index % 3),
        )
        for index in range(10)
    ]
    dense_clusters = _cluster_events(dense_events, 8)
    assert len(dense_clusters) >= 5
    assert {
        event.frame
        for cluster in dense_clusters
        for event in cluster.events
    } == {event.frame for event in dense_events}
    assert all(
        right.primary.frame - left.primary.frame >= 8
        for left, right in zip(dense_clusters, dense_clusters[1:])
    )

    fixture = _synthetic_fixture()
    parsed_gestures, _, _ = _parse_library(
        fixture[0],
        len(fixture[1]),
        np.asarray(fixture[3], dtype=np.int32),
    )
    assert all(
        len(clip.low_entries) == 3 and len(clip.low_exits) == 3
        for clip in parsed_gestures
    )
    positions, boundaries, report = plan_gesture_motion(*fixture)
    assert positions.dtype == np.float32
    assert len(positions) == len(fixture[5])
    original_vowel_anchors = {
        index
        for index, value in enumerate(fixture[7])
        if value in VOWEL_VISEMES
    }
    clustered_anchors = {
        item["frame"]
        for cluster in report["planned_annotation_coarticulation_clusters"]
        for item in cluster["anchors"]
    }
    assert clustered_anchors == original_vowel_anchors
    assert report["planned_annotation_original_vowel_anchor_count"] == 10
    assert report["planned_annotation_absorbed_vowel_anchor_count"] >= 2
    assert (
        report["planned_annotation_realized_vowel_anchor_coverage_rate"] < 1.0
    )
    assert any(
        len({item["viseme"] for item in cluster["anchors"]}) > 1
        and any(item["status"] == "absorbed" for item in cluster["anchors"])
        for cluster in report["planned_annotation_coarticulation_clusters"]
    )
    assert (
        report["planned_annotation_maximum_continuous_source_speed"]
        <= _MAX_SOURCE_SPEED + 1e-6
    )
    assert (
        report["planned_annotation_maximum_continuous_source_acceleration"]
        <= _MAX_SOURCE_ACCELERATION + 1e-6
    )
    assert report[
        "planned_annotation_gesture_diversity_contract_satisfied"
    ]
    assert (
        report["planned_annotation_unique_gesture_clip_count"]
        >= report["planned_annotation_required_unique_gesture_clip_count"]
    )
    assert (
        report["planned_annotation_selected_gesture_take_count"]
        >= report["planned_annotation_required_unique_gesture_take_count"]
    )
    assert report["planned_annotation_gesture_diversity_contract"][
        "satisfied"
    ]
    assert set(
        report["planned_annotation_strength_by_viseme"]
    ) == set(
        report["planned_annotation_gesture_diversity_contract"][
            "per_viseme"
        ]
    )
    minimum_gap = report["planned_annotation_minimum_boundary_gap"]
    required_gap = report["planned_annotation_required_minimum_boundary_gap"]
    assert minimum_gap is None or minimum_gap >= required_gap >= 8
    event_gap = report["planned_annotation_minimum_realized_event_gap"]
    required_event_gap = report[
        "planned_annotation_required_minimum_event_gap"
    ]
    assert event_gap is None or event_gap >= required_event_gap >= 8
    return {
        "ok": True,
        "frame_count": len(positions),
        "boundary_count": len(boundaries),
        "original_vowel_anchor_count": report[
            "planned_annotation_original_vowel_anchor_count"
        ],
        "realized_vowel_anchor_count": report[
            "planned_annotation_realized_vowel_anchor_count"
        ],
        "maximum_source_speed": report[
            "planned_annotation_maximum_continuous_source_speed"
        ],
        "maximum_source_acceleration": report[
            "planned_annotation_maximum_continuous_source_acceleration"
        ],
        "minimum_boundary_gap": minimum_gap,
        "dense_chain_anchor_count": len(dense_events),
        "dense_chain_realized_cluster_count": len(dense_clusters),
        "selection_regressions": selection_regressions,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Anime-avatar gesture/idle clip scheduler"
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run the lightweight synthetic scheduler test",
    )
    args = parser.parse_args()
    if not args.self_test:
        parser.error("only --self-test is supported")
    print(lightweight_self_test())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Render Mandarin speech from an AI-reviewed whole-frame anime viseme library."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from pypinyin import Style, pinyin

from anime_avatar_common import (
    VISEMES,
    bgr_to_pil,
    contact_sheet,
    ensure_crop,
    executable,
    frame_cells,
    library_path,
    load_cropped_frames,
    load_project,
    parse_xywh,
    probe_video,
    read_json,
    resolve_source,
    validate_library_payload,
    validate_media_manifest,
    write_json,
)


VISEME_DISTANCE = {
    ("A", "E"): 1.1,
    ("E", "A"): 1.1,
    ("I", "E"): 1.3,
    ("E", "I"): 1.3,
    ("U", "O"): 1.2,
    ("O", "U"): 1.2,
    ("A", "O"): 2.2,
    ("O", "A"): 2.2,
}


@dataclass(frozen=True)
class SpeechUnit:
    text: str
    start: float
    end: float


@dataclass(frozen=True)
class PhoneEvent:
    text: str
    pinyin_final: str
    viseme: str
    start: float
    end: float
    role: str
    unit_index: int


def final_visemes(final: str) -> tuple[str, ...]:
    value = final.lower().replace("v", "ü")
    exact = {
        "ai": ("A", "I"),
        "ei": ("E", "I"),
        "ao": ("A", "O"),
        "ou": ("O", "U"),
        "ia": ("I", "A"),
        "ie": ("I", "E"),
        "iao": ("I", "A", "O"),
        "iu": ("I", "O", "U"),
        "iou": ("I", "O", "U"),
        "ua": ("U", "A"),
        "uai": ("U", "A", "I"),
        "uo": ("U", "O"),
        "ui": ("U", "E", "I"),
        "uei": ("U", "E", "I"),
        "üe": ("U", "E"),
        "ve": ("U", "E"),
    }
    if value in exact:
        return exact[value]
    if value.startswith(("ia", "ian", "iang")):
        return ("I", "A")
    if value.startswith(("ua", "uan", "uang")):
        return ("U", "A")
    if value.startswith(("ü", "v")):
        return ("U",)
    if value.startswith("i"):
        return ("I",)
    if value.startswith("u"):
        return ("U",)
    if value.startswith("o") or value == "ong":
        return ("O",)
    if "a" in value:
        return ("A",)
    return ("E",)


def split_weights(count: int) -> np.ndarray:
    if count == 1:
        return np.asarray([1.0], dtype=np.float32)
    if count == 2:
        return np.asarray([0.58, 0.42], dtype=np.float32)
    if count == 3:
        return np.asarray([0.24, 0.48, 0.28], dtype=np.float32)
    return np.full(count, 1.0 / count, dtype=np.float32)


def chinese_characters(text: str) -> str:
    return "".join(character for character in text if "\u4e00" <= character <= "\u9fff")


def validate_timeline(payload: dict[str, Any]) -> list[SpeechUnit]:
    errors: list[str] = []
    if payload.get("protocol") != "visual-multimedia-speech-timeline":
        errors.append("protocol 必须是 visual-multimedia-speech-timeline")
    if payload.get("version") != 1:
        errors.append("version 必须是 1")
    if payload.get("language") != "zh-CN":
        errors.append("当前渲染器只接受 zh-CN")
    timing = payload.get("timing")
    if not isinstance(timing, dict) or timing.get("reviewed") is not True:
        errors.append("timing.reviewed 必须是 true")
    units_payload = payload.get("units")
    if not isinstance(units_payload, list) or not units_payload:
        errors.append("units 必须是非空数组")
        units_payload = []
    units: list[SpeechUnit] = []
    previous_end = 0.0
    for index, item in enumerate(units_payload):
        if not isinstance(item, dict):
            errors.append(f"units[{index}] 必须是对象")
            continue
        text = item.get("text")
        start = item.get("start_seconds")
        end = item.get("end_seconds")
        if not isinstance(text, str) or len(text) != 1:
            errors.append(f"units[{index}].text 必须是一个汉字")
            continue
        if not ("\u4e00" <= text <= "\u9fff"):
            errors.append(f"units[{index}].text 不是普通话汉字：{text}")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            errors.append(f"units[{index}] 缺少数字时间")
            continue
        start_value = float(start)
        end_value = float(end)
        if start_value < previous_end - 1e-6:
            errors.append(f"units[{index}] 与前一项重叠或倒序")
        if end_value <= start_value:
            errors.append(f"units[{index}] 结束时间必须大于开始时间")
        units.append(SpeechUnit(text, start_value, end_value))
        previous_end = max(previous_end, end_value)
    if chinese_characters(str(payload.get("text") or "")) != "".join(
        unit.text for unit in units
    ):
        errors.append("text 去除标点后的汉字序列必须与 units 完全一致")
    trim_start = payload.get("trim_start_seconds")
    trim_end = payload.get("trim_end_seconds")
    if not isinstance(trim_start, (int, float)) or float(trim_start) < 0:
        errors.append("trim_start_seconds 必须是非负数")
    if trim_end is not None:
        if (
            not isinstance(trim_end, (int, float))
            or float(trim_end) <= float(trim_start or 0)
        ):
            errors.append("trim_end_seconds 必须为空或大于 trim_start_seconds")
    if errors:
        raise ValueError("speech-timeline.json 无效：\n- " + "\n- ".join(errors))
    return units


def build_phone_events(units: list[SpeechUnit]) -> list[PhoneEvent]:
    events: list[PhoneEvent] = []
    bilabials = {"b", "p", "m"}
    for unit_index, unit in enumerate(units):
        initial = pinyin(unit.text, style=Style.INITIALS, strict=False)[0][0].lower()
        final = pinyin(unit.text, style=Style.FINALS, strict=False)[0][0].lower()
        vowel_start = unit.start
        if initial in bilabials:
            closure = min(0.045, max(0.025, (unit.end - unit.start) * 0.22))
            events.append(
                PhoneEvent(
                    unit.text,
                    final,
                    "CLOSED",
                    unit.start,
                    min(unit.end, unit.start + closure),
                    "bilabial_onset",
                    unit_index,
                )
            )
            vowel_start = min(unit.end, unit.start + closure)
        sequence = final_visemes(final)
        weights = split_weights(len(sequence))
        available = max(unit.end - vowel_start, 0.001)
        cursor = vowel_start
        for index, (viseme, weight) in enumerate(zip(sequence, weights)):
            end = (
                unit.end
                if index == len(sequence) - 1
                else cursor + available * float(weight)
            )
            events.append(
                PhoneEvent(
                    unit.text,
                    final,
                    viseme,
                    cursor,
                    end,
                    "vowel",
                    unit_index,
                )
            )
            cursor = end
    return events


def extract_audio(
    ffmpeg: str,
    source: Path,
    destination: Path,
    trim_start: float,
    trim_end: float | None,
) -> float:
    destination.parent.mkdir(parents=True, exist_ok=True)
    trim = f"atrim=start={trim_start:.6f}"
    if trim_end is not None:
        trim += f":end={trim_end:.6f}"
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-af",
        f"{trim},asetpts=PTS-STARTPTS",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    result = subprocess.run(command, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "无法从指定素材提取音频："
            + result.stderr.decode("utf-8", errors="replace")
        )
    with wave.open(str(destination), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
    if duration <= 0:
        raise ValueError("裁切后的音频时长为 0")
    return duration


def read_wave(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as source:
        sample_rate = source.getframerate()
        channels = source.getnchannels()
        values = np.frombuffer(
            source.readframes(source.getnframes()),
            dtype=np.int16,
        )
    if channels > 1:
        values = values.reshape(-1, channels).mean(axis=1)
    return values.astype(np.float32) / 32768.0, sample_rate


def normalized_energy(
    samples: np.ndarray,
    sample_rate: int,
    fps: int,
    frame_count: int,
) -> np.ndarray:
    values = np.zeros(frame_count, dtype=np.float32)
    for frame_index in range(frame_count):
        start = round(frame_index * sample_rate / fps)
        end = min(len(samples), round((frame_index + 1) * sample_rate / fps))
        window = samples[start:end]
        if len(window):
            values[frame_index] = float(np.sqrt(np.mean(window * window)))
    if len(values) >= 3:
        values = np.convolve(
            values,
            np.asarray([0.18, 0.64, 0.18], dtype=np.float32),
            mode="same",
        )
    voiced = values[values > 1e-7]
    if not len(voiced):
        return np.zeros_like(values)
    low, high = np.percentile(voiced, [8, 94])
    if high <= low + 1e-8:
        return np.zeros_like(values)
    return np.clip((values - low) / (high - low), 0.0, 1.0)


def label_runs(labels: list[str]) -> list[tuple[int, int, str]]:
    runs: list[tuple[int, int, str]] = []
    start = 0
    for index in range(1, len(labels) + 1):
        if index == len(labels) or labels[index] != labels[start]:
            runs.append((start, index, labels[start]))
            start = index
    return runs


def build_target_timeline(
    units: list[SpeechUnit],
    events: list[PhoneEvent],
    samples: np.ndarray,
    sample_rate: int,
    audio_duration: float,
    fps: int,
    frame_count: int,
) -> tuple[
    list[str],
    np.ndarray,
    np.ndarray,
    list[str | None],
    list[str],
    list[dict[str, Any]],
]:
    if frame_count <= 0:
        raise ValueError("目标时间线至少需要一帧")
    audio_frames = min(frame_count, int(math.ceil(audio_duration * fps)))
    energy = normalized_energy(samples, sample_rate, fps, frame_count)
    labels = ["CLOSED"] * frame_count
    roles = ["silence"] * frame_count
    event_index_by_frame = np.full(frame_count, -1, dtype=np.int32)

    for event_index, event in enumerate(events):
        first = max(0, int(math.floor(event.start * fps)))
        last = min(audio_frames, max(first + 1, int(math.ceil(event.end * fps))))
        for frame_index in range(first, last):
            center = (frame_index + 0.5) / fps
            if event.start <= center < event.end or last - first == 1:
                labels[frame_index] = event.viseme
                roles[frame_index] = event.role
                event_index_by_frame[frame_index] = event_index

    for frame_index in range(1, audio_frames - 1):
        if labels[frame_index] != "CLOSED" or roles[frame_index] != "silence":
            continue
        previous_label = labels[frame_index - 1]
        next_label = labels[frame_index + 1]
        if previous_label != "CLOSED" and next_label != "CLOSED":
            labels[frame_index] = (
                previous_label if energy[frame_index] < 0.45 else next_label
            )
            roles[frame_index] = "coarticulation"

    levels = np.zeros(frame_count, dtype=np.float32)
    anchors: list[str | None] = [None] * frame_count
    for unit_index, unit in enumerate(units):
        vowel_event_indices = [
            event_index
            for event_index, event in enumerate(events)
            if event.unit_index == unit_index and event.role == "vowel"
        ]
        vowel_frames = np.where(np.isin(event_index_by_frame, vowel_event_indices))[0]
        if len(vowel_frames):
            local_energy = energy[vowel_frames]
            local_max = max(float(np.max(local_energy)), 0.08)
            anchor_frame = int(vowel_frames[int(np.argmax(local_energy))])
            anchors[anchor_frame] = labels[anchor_frame]
            nucleus_strength = 2.25 + 1.75 * float(
                energy[anchor_frame] ** 0.62
            )
            for local_index, frame_index in enumerate(vowel_frames):
                if len(vowel_frames) == 1:
                    envelope = 1.0
                else:
                    phase = local_index / (len(vowel_frames) - 1)
                    envelope = 0.42 + 0.58 * math.sin(math.pi * phase) ** 0.55
                energy_ratio = min(1.0, float(energy[frame_index]) / local_max)
                articulation = max(0.28, energy_ratio) * envelope
                levels[frame_index] = np.clip(
                    0.65 + (nucleus_strength - 0.65) * articulation,
                    0.65,
                    4.0,
                )
            levels[anchor_frame] = max(levels[anchor_frame], nucleus_strength)

        closure_events = [
            event_index
            for event_index, event in enumerate(events)
            if event.unit_index == unit_index and event.role == "bilabial_onset"
        ]
        for event_index in closure_events:
            closure_frames = np.where(event_index_by_frame == event_index)[0]
            if len(closure_frames):
                anchors[int(closure_frames[len(closure_frames) // 2])] = "CLOSED"

    for start, end, label in label_runs(labels):
        if (
            label == "CLOSED"
            and end - start >= 3
            and all(roles[index] == "silence" for index in range(start, end))
        ):
            anchors[start + (end - start) // 2] = "CLOSED"

    report_events = [
        {
            "text": event.text,
            "unit_index": event.unit_index,
            "pinyin_final": event.pinyin_final,
            "viseme": event.viseme,
            "role": event.role,
            "start_seconds": round(event.start, 6),
            "end_seconds": round(event.end, 6),
        }
        for event in events
    ]
    return labels, levels, energy, anchors, roles, report_events


def source_annotation(
    library: dict[str, Any],
    source_count: int,
) -> tuple[list[str], np.ndarray, np.ndarray]:
    labels = ["CLOSED"] * source_count
    levels = np.zeros(source_count, dtype=np.float32)
    takes = np.zeros(source_count, dtype=np.int16)
    clips_by_id = {clip["id"]: clip for clip in library["gesture_clips"]}
    for span in library["runtime_state_spans"]:
        start = span["start_frame"]
        end = span["end_frame_exclusive"]
        labels[start:end] = [span["viseme"]] * (end - start)
        takes[start:end] = int(span["take"])
        if span["viseme"] == "CLOSED":
            continue
        clip = clips_by_id[span["clip_id"]]
        points: list[tuple[float, float]] = []
        for intensity, frame_index in enumerate(clip["rise_frames_by_intensity"]):
            points.append((float(frame_index), float(intensity)))
        peak_start, peak_end = clip["peak_frame_range_inclusive"]
        points.extend([(float(peak_start), 4.0), (float(peak_end), 4.0)])
        for intensity, frame_index in enumerate(clip["fall_frames_by_intensity"]):
            points.append((float(frame_index), float(intensity)))
        ordered: dict[float, float] = {}
        for frame_index, intensity in sorted(points):
            ordered[frame_index] = max(intensity, ordered.get(frame_index, 0.0))
        point_frames = np.asarray(list(ordered.keys()), dtype=np.float32)
        point_levels = np.asarray(list(ordered.values()), dtype=np.float32)
        source_frames = np.arange(start, end, dtype=np.float32)
        levels[start:end] = np.interp(source_frames, point_frames, point_levels)
    return labels, levels, takes


def visual_descriptors(
    frames: list[np.ndarray],
    mouth_crop: tuple[int, int, int, int],
) -> np.ndarray:
    descriptor_size = 32
    source_height, source_width = frames[0].shape[:2]
    x, y, width, height = mouth_crop
    left = max(0, int(math.floor(x / source_width * descriptor_size)) - 1)
    right = min(
        descriptor_size,
        int(math.ceil((x + width) / source_width * descriptor_size)) + 1,
    )
    top = max(0, int(math.floor(y / source_height * descriptor_size)) - 1)
    bottom = min(
        descriptor_size,
        int(math.ceil((y + height) / source_height * descriptor_size)) + 1,
    )
    descriptors = []
    for frame in frames:
        small = cv2.resize(
            frame,
            (descriptor_size, descriptor_size),
            interpolation=cv2.INTER_AREA,
        )
        lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32) / 255.0
        weights = np.ones((descriptor_size, descriptor_size, 1), dtype=np.float32)
        weights[top:bottom, left:right] = 0.0
        descriptors.append((lab * weights).reshape(-1))
    return np.asarray(descriptors, dtype=np.float32)


def build_idle_path(
    library: dict[str, Any],
    descriptors: np.ndarray,
    frame_count: int,
    previous_source_frame: int | None,
    next_source_frame: int | None,
) -> tuple[np.ndarray, dict[str, Any]]:
    if frame_count <= 0:
        return (
            np.zeros(0, dtype=np.int32),
            {"frame_count": 0, "clip_sequence": []},
        )
    clips: list[dict[str, Any]] = []
    for item in library["closed_motion_clips"]:
        start = int(item["start_frame"])
        end = int(item["end_frame_exclusive"])
        if end - start < 3:
            continue
        clips.append(
            {
                "id": item["id"],
                "start": start,
                "end": end,
                "frames": np.arange(start, end, dtype=np.int32),
            }
        )
    if not clips:
        raise ValueError("素材库没有可用于无声待机的连续闭嘴动作段")

    output: list[int] = []
    sequence: list[dict[str, Any]] = []
    usage = {clip["id"]: 0 for clip in clips}
    previous_clip_id: str | None = None
    previous = (
        int(previous_source_frame)
        if previous_source_frame is not None
        else None
    )
    while len(output) < frame_count:
        remaining = frame_count - len(output)
        candidates: list[tuple[float, dict[str, Any], np.ndarray]] = []
        for clip in clips:
            clip_frames = clip["frames"]
            if remaining <= len(clip_frames):
                chunks = [
                    clip_frames[offset : offset + remaining]
                    for offset in range(len(clip_frames) - remaining + 1)
                ]
            else:
                chunks = [clip_frames]
            for chunk in chunks:
                start_cost = (
                    float(
                        np.sqrt(
                            np.mean(
                                (
                                    descriptors[previous]
                                    - descriptors[int(chunk[0])]
                                )
                                ** 2
                            )
                        )
                    )
                    if previous is not None
                    else 0.0
                )
                finishes_interval = len(chunk) == remaining
                end_cost = (
                    float(
                        np.sqrt(
                            np.mean(
                                (
                                    descriptors[int(chunk[-1])]
                                    - descriptors[int(next_source_frame)]
                                )
                                ** 2
                            )
                        )
                    )
                    if finishes_interval and next_source_frame is not None
                    else 0.0
                )
                repeat_penalty = (
                    0.04 if clip["id"] == previous_clip_id else 0.0
                )
                usage_penalty = 0.006 * usage[clip["id"]]
                coverage_reward = 0.0002 * len(chunk)
                candidates.append(
                    (
                        start_cost
                        + 0.9 * end_cost
                        + repeat_penalty
                        + usage_penalty
                        - coverage_reward,
                        clip,
                        chunk,
                    )
                )
        _, chosen, chunk = min(
            candidates,
            key=lambda item: (
                item[0],
                item[1]["id"],
                int(item[2][0]),
            ),
        )
        output_start = len(output)
        output.extend(int(value) for value in chunk)
        sequence.append(
            {
                "clip_id": chosen["id"],
                "source_start_frame": int(chunk[0]),
                "source_end_frame_exclusive": int(chunk[-1]) + 1,
                "output_start_frame": output_start,
                "output_end_frame_exclusive": len(output),
            }
        )
        usage[chosen["id"]] += 1
        previous_clip_id = chosen["id"]
        previous = output[-1]
    return (
        np.asarray(output, dtype=np.int32),
        {
            "method": (
                "AI-reviewed continuous CLOSED clips, joined by whole-frame "
                "visual continuity at both ends"
            ),
            "frame_count": frame_count,
            "clip_sequence": sequence,
            "clip_usage": usage,
        },
    )


def boolean_runs(mask: np.ndarray, value: bool) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, item in enumerate(mask):
        if bool(item) == value and start is None:
            start = index
        if bool(item) != value and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def summarize_timeline_path(
    path: np.ndarray,
    target_labels: list[str],
    target_levels: np.ndarray,
    anchors: list[str | None],
    roles: list[str],
    source_labels: list[str],
    source_levels: np.ndarray,
    source_takes: np.ndarray,
    active_segments: list[dict[str, Any]],
    silent_intervals: list[dict[str, Any]],
) -> tuple[list[int], dict[str, Any]]:
    steps = np.diff(path)
    boundaries = [
        index + 1 for index, step in enumerate(steps) if step not in (1, 2)
    ]
    exact_match = np.asarray(
        [
            target_labels[index] == source_labels[source_index]
            for index, source_index in enumerate(path)
        ],
        dtype=bool,
    )
    target_nonclosed = np.asarray(target_labels) != "CLOSED"
    anchor_mask = np.asarray([anchor is not None for anchor in anchors], dtype=bool)
    anchor_match = np.asarray(
        [
            anchor is None or anchor == source_labels[source_index]
            for anchor, source_index in zip(anchors, path)
        ],
        dtype=bool,
    )
    silence_mask = np.asarray([role == "silence" for role in roles], dtype=bool)
    selected_takes = source_takes[path]
    takes_by_viseme: dict[str, list[int]] = {}
    for viseme in VISEMES:
        takes_by_viseme[viseme] = sorted(
            {
                int(selected_takes[index])
                for index, label in enumerate(target_labels)
                if label == viseme
            }
        )
    silence_steps = np.asarray(
        [
            int(path[index]) - int(path[index - 1])
            for index in range(1, len(path))
            if silence_mask[index] and silence_mask[index - 1]
        ],
        dtype=np.int32,
    )
    report = {
        "method": (
            "Mandarin phone nuclei on speaking intervals plus AI-reviewed "
            "continuous CLOSED motion on every silent interval"
        ),
        "active_segments": active_segments,
        "silent_intervals": silent_intervals,
        "path_jump_count": len(boundaries),
        "boundary_output_frames": boundaries,
        "identical_source_frame_holds": int(np.sum(steps == 0)),
        "silence_identical_source_frame_holds": (
            int(np.sum(silence_steps == 0)) if len(silence_steps) else 0
        ),
        "exact_viseme_match_rate": round(float(np.mean(exact_match)), 5),
        "speech_viseme_match_rate": round(
            float(np.mean(exact_match[target_nonclosed]))
            if np.any(target_nonclosed)
            else 1.0,
            5,
        ),
        "silence_closed_match_rate": round(
            float(
                np.mean(
                    np.asarray(source_labels, dtype=object)[path[silence_mask]]
                    == "CLOSED"
                )
            )
            if np.any(silence_mask)
            else 1.0,
            5,
        ),
        "phone_nucleus_match_rate": round(
            float(np.mean(anchor_match[anchor_mask]))
            if np.any(anchor_mask)
            else 1.0,
            5,
        ),
        "takes_used_by_target_viseme": takes_by_viseme,
        "source_step_counts": {
            str(step): int(np.sum(steps == step))
            for step in sorted(set(int(value) for value in steps))
        },
    }
    return boundaries, report


def plan_timeline_path(
    target_labels: list[str],
    target_levels: np.ndarray,
    anchors: list[str | None],
    roles: list[str],
    source_labels: list[str],
    source_levels: np.ndarray,
    source_takes: np.ndarray,
    descriptors: np.ndarray,
    library: dict[str, Any],
    fps: int,
) -> tuple[np.ndarray, list[int], dict[str, Any]]:
    frame_count = len(target_labels)
    silence_mask = np.asarray([role == "silence" for role in roles], dtype=bool)
    path = np.full(frame_count, -1, dtype=np.int32)
    active_segments: list[dict[str, Any]] = []

    for start, end in boolean_runs(silence_mask, False):
        segment_path, _, segment_report = choose_source_path(
            target_labels[start:end],
            target_levels[start:end],
            anchors[start:end],
            source_labels,
            source_levels,
            source_takes,
            descriptors,
        )
        path[start:end] = segment_path
        active_segments.append(
            {
                "start_frame": start,
                "end_frame_exclusive": end,
                "start_seconds": round(start / fps, 6),
                "end_seconds": round(end / fps, 6),
                "selection": segment_report,
            }
        )

    silent_intervals: list[dict[str, Any]] = []
    for start, end in boolean_runs(silence_mask, True):
        previous_source = int(path[start - 1]) if start > 0 else None
        next_source = int(path[end]) if end < frame_count else None
        idle_path, idle_report = build_idle_path(
            library,
            descriptors,
            end - start,
            previous_source,
            next_source,
        )
        path[start:end] = idle_path
        if start == 0:
            kind = "leading"
        elif end == frame_count:
            kind = "trailing"
        else:
            kind = "internal"
        silent_intervals.append(
            {
                "kind": kind,
                "start_frame": start,
                "end_frame_exclusive": end,
                "start_seconds": round(start / fps, 6),
                "end_seconds": round(end / fps, 6),
                **idle_report,
            }
        )

    if np.any(path < 0):
        raise RuntimeError("完整时间线仍有未规划的角色帧")
    boundaries, selection = summarize_timeline_path(
        path,
        target_labels,
        target_levels,
        anchors,
        roles,
        source_labels,
        source_levels,
        source_takes,
        active_segments,
        silent_intervals,
    )
    return path, boundaries, selection


def pairwise_rms(values: np.ndarray) -> np.ndarray:
    squared = np.sum(values * values, axis=1)
    distances = squared[:, None] + squared[None, :] - 2.0 * values @ values.T
    np.maximum(distances, 0.0, out=distances)
    return np.sqrt(distances / values.shape[1])


def viseme_cost(target: str, source: str) -> float:
    if target == source:
        return 0.0
    if target == "CLOSED" or source == "CLOSED":
        return 7.0
    return VISEME_DISTANCE.get((target, source), 3.2)


def allowed_jump_frames(anchors: list[str | None]) -> list[int]:
    candidates: set[int] = set()
    for frame_index, anchor in enumerate(anchors):
        if anchor is None:
            continue
        candidates.add(frame_index)
        if frame_index > 0:
            candidates.add(frame_index - 1)
    return sorted(candidates)


def choose_source_path(
    target_labels: list[str],
    target_levels: np.ndarray,
    anchors: list[str | None],
    source_labels: list[str],
    source_levels: np.ndarray,
    source_takes: np.ndarray,
    descriptors: np.ndarray,
) -> tuple[np.ndarray, list[int], dict[str, Any]]:
    frame_count = len(target_labels)
    source_count = len(source_labels)
    visual_distance = pairwise_rms(descriptors)

    transition = (
        0.95
        + 52.0 * visual_distance
        + 0.10 * np.abs(source_levels[:, None] - source_levels[None, :])
        + 0.18 * (source_takes[:, None] == source_takes[None, :])
    ).astype(np.float32)
    np.fill_diagonal(transition, np.inf)
    for source_index in range(source_count):
        if source_index + 1 < source_count:
            transition[source_index, source_index + 1] = 0.0
        if source_index + 2 < source_count:
            transition[source_index, source_index + 2] = 0.08

    source_phase = np.linspace(0.0, 1.0, source_count, dtype=np.float32)
    output_phase = np.linspace(0.0, 1.0, frame_count, dtype=np.float32)
    emission = np.zeros((frame_count, source_count), dtype=np.float32)
    source_labels_array = np.asarray(source_labels)
    for output_index, target_label in enumerate(target_labels):
        emission[output_index] = (
            3.0
            * np.asarray(
                [
                    viseme_cost(target_label, source_label)
                    for source_label in source_labels
                ],
                dtype=np.float32,
            )
            + 2.35 * (source_levels - target_levels[output_index]) ** 2
            + 0.38 * np.abs(source_phase - output_phase[output_index])
        )
        anchor = anchors[output_index]
        if anchor is not None:
            emission[output_index, source_labels_array != anchor] = np.inf
            emission[output_index] += (
                1.8 * (source_levels - target_levels[output_index]) ** 2
            )

    natural_edge = np.zeros((source_count, source_count), dtype=bool)
    rows = np.arange(source_count - 1)
    natural_edge[rows, rows + 1] = True
    rows = np.arange(source_count - 2)
    natural_edge[rows, rows + 2] = True
    jump_frames = allowed_jump_frames(anchors)
    jump_set = set(jump_frames)

    back_dtype = np.int16 if source_count < np.iinfo(np.int16).max else np.int32
    back = np.zeros((frame_count, source_count), dtype=back_dtype)
    previous = emission[0].copy()
    for output_index in range(1, frame_count):
        scores = previous[:, None] + transition
        if output_index not in jump_set:
            scores = np.where(natural_edge, scores, np.inf)
        best_previous = np.argmin(scores, axis=0)
        best_cost = scores[best_previous, np.arange(source_count)]
        back[output_index] = best_previous.astype(back_dtype)
        previous = best_cost + emission[output_index]
        if not np.isfinite(previous).any():
            raise RuntimeError(
                f"第 {output_index} 个输出帧没有可行素材路径；检查素材库覆盖和音节核心标签"
            )

    path = np.zeros(frame_count, dtype=np.int32)
    path[-1] = int(np.argmin(previous))
    for output_index in range(frame_count - 1, 0, -1):
        path[output_index - 1] = back[output_index, path[output_index]]

    steps = np.diff(path)
    boundaries = [
        index + 1 for index, step in enumerate(steps) if step not in (1, 2)
    ]
    exact_match = np.asarray(
        [
            target_labels[index] == source_labels[source_index]
            for index, source_index in enumerate(path)
        ],
        dtype=bool,
    )
    target_nonclosed = np.asarray(target_labels) != "CLOSED"
    anchor_mask = np.asarray([anchor is not None for anchor in anchors], dtype=bool)
    anchor_match = np.asarray(
        [
            anchor is None or anchor == source_labels[source_index]
            for anchor, source_index in zip(anchors, path)
        ],
        dtype=bool,
    )
    selected_takes = source_takes[path]
    takes_by_viseme: dict[str, list[int]] = {}
    for viseme in VISEMES:
        takes_by_viseme[viseme] = sorted(
            {
                int(selected_takes[index])
                for index, label in enumerate(target_labels)
                if label == viseme
            }
        )
    report = {
        "method": (
            "Mandarin phone nuclei + within-syllable acoustic intensity + "
            "AI-reviewed whole-frame viseme library + coarticulated motion graph"
        ),
        "phone_nucleus_anchor_count": int(np.sum(anchor_mask)),
        "candidate_jump_output_frames": jump_frames,
        "path_jump_count": len(boundaries),
        "boundary_output_frames": boundaries,
        "identical_source_frame_holds": int(np.sum(steps == 0)),
        "exact_viseme_match_rate": round(float(np.mean(exact_match)), 5),
        "speech_viseme_match_rate": round(
            float(np.mean(exact_match[target_nonclosed]))
            if np.any(target_nonclosed)
            else 1.0,
            5,
        ),
        "phone_nucleus_match_rate": round(
            float(np.mean(anchor_match[anchor_mask]))
            if np.any(anchor_mask)
            else 1.0,
            5,
        ),
        "takes_used_by_target_viseme": takes_by_viseme,
        "source_step_counts": {
            str(step): int(np.sum(steps == step))
            for step in sorted(set(int(value) for value in steps))
        },
    }
    return path, boundaries, report


def resize_frames(
    frames: list[np.ndarray],
    width: int,
    height: int,
) -> list[np.ndarray]:
    interpolation = (
        cv2.INTER_AREA
        if frames[0].shape[1] >= width and frames[0].shape[0] >= height
        else cv2.INTER_CUBIC
    )
    return [
        cv2.resize(frame, (width, height), interpolation=interpolation)
        for frame in frames
    ]


def one_frame_flow_joins(
    portraits: list[np.ndarray],
    boundaries: list[int],
) -> list[np.ndarray]:
    result = [portrait.copy() for portrait in portraits]
    full_height, full_width = result[0].shape[:2]
    grid_x, grid_y = np.meshgrid(
        np.arange(full_width, dtype=np.float32),
        np.arange(full_height, dtype=np.float32),
    )
    flow_scale = min(1.0, 480.0 / max(full_width, full_height))
    flow_width = max(2, int(round(full_width * flow_scale)))
    flow_height = max(2, int(round(full_height * flow_scale)))
    for boundary in boundaries:
        if boundary < 1 or boundary >= len(result):
            continue
        first = portraits[boundary - 1]
        second = portraits[boundary]
        first_gray = cv2.resize(
            cv2.cvtColor(first, cv2.COLOR_BGR2GRAY),
            (flow_width, flow_height),
            interpolation=cv2.INTER_AREA,
        )
        second_gray = cv2.resize(
            cv2.cvtColor(second, cv2.COLOR_BGR2GRAY),
            (flow_width, flow_height),
            interpolation=cv2.INTER_AREA,
        )
        estimator = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        estimator.setFinestScale(0)
        forward = estimator.calc(first_gray, second_gray, None)
        backward = estimator.calc(second_gray, first_gray, None)
        if flow_scale < 1.0:
            forward = cv2.resize(
                forward,
                (full_width, full_height),
                interpolation=cv2.INTER_LINEAR,
            )
            backward = cv2.resize(
                backward,
                (full_width, full_height),
                interpolation=cv2.INTER_LINEAR,
            )
            forward[..., 0] *= full_width / flow_width
            forward[..., 1] *= full_height / flow_height
            backward[..., 0] *= full_width / flow_width
            backward[..., 1] *= full_height / flow_height
        amount = 0.58
        first_warped = cv2.remap(
            first,
            grid_x - amount * forward[..., 0],
            grid_y - amount * forward[..., 1],
            cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )
        second_warped = cv2.remap(
            second,
            grid_x - (1.0 - amount) * backward[..., 0],
            grid_y - (1.0 - amount) * backward[..., 1],
            cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )
        result[boundary] = cv2.addWeighted(
            first_warped,
            1.0 - amount,
            second_warped,
            amount,
            0.0,
        )
    return result


def encode_silent(
    ffmpeg: str,
    frames: list[np.ndarray],
    fps: int,
    destination: Path,
) -> None:
    height, width = frames[0].shape[:2]
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s:v",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "15",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(destination),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame in frames:
            process.stdin.write(np.ascontiguousarray(frame).tobytes())
        process.stdin.close()
        stderr = process.stderr.read() if process.stderr is not None else b""
        return_code = process.wait()
    except BrokenPipeError as error:
        stderr = process.stderr.read() if process.stderr is not None else b""
        process.wait()
        raise RuntimeError(
            "FFmpeg 编码管道提前关闭："
            + stderr.decode("utf-8", errors="replace")
        ) from error
    if return_code != 0:
        raise RuntimeError(
            "FFmpeg 无法编码无声视频："
            + stderr.decode("utf-8", errors="replace")
        )


def mux_audio(
    ffmpeg: str,
    silent: Path,
    audio: Path,
    destination: Path,
    video_duration: float,
) -> None:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(silent),
        "-i",
        str(audio),
        "-filter_complex",
        f"[1:a]apad=pad_dur={video_duration:.6f}[a]",
        "-map",
        "0:v:0",
        "-map",
        "[a]",
        "-t",
        f"{video_duration:.6f}",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(destination),
    ]
    result = subprocess.run(command, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "FFmpeg 无法装配声音："
            + result.stderr.decode("utf-8", errors="replace")
        )


def interpolate_delivery(
    ffmpeg: str,
    source: Path,
    destination: Path,
    delivery_fps: int,
    duration_seconds: float,
) -> None:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vf",
        (
            "tpad=stop_mode=clone:stop_duration=0.250,"
            f"minterpolate=fps={delivery_fps}:mi_mode=mci:"
            "mc_mode=aobmc:me_mode=bidir:vsbmc=1,"
            f"trim=duration={duration_seconds:.6f},setpts=PTS-STARTPTS,"
            f"fps={delivery_fps}"
        ),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "15",
        "-pix_fmt",
        "yuv420p",
        "-t",
        f"{duration_seconds:.6f}",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(destination),
    ]
    result = subprocess.run(command, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "FFmpeg 运动补帧失败："
            + result.stderr.decode("utf-8", errors="replace")
        )


def save_render_review(
    destination: Path,
    portraits: list[np.ndarray],
    path: np.ndarray,
    boundaries: list[int],
    target_labels: list[str],
    target_levels: np.ndarray,
    source_labels: list[str],
    source_levels: np.ndarray,
    fps: int,
) -> list[str]:
    destination.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    indices = sorted(
        set(
            list(range(0, len(portraits), max(1, fps // 2)))
            + boundaries
            + [max(0, boundary - 1) for boundary in boundaries]
            + [len(portraits) - 1]
        )
    )
    cells = []
    for index in indices:
        source_index = int(path[index])
        cells.append(
            (
                bgr_to_pil(portraits[index]),
                (
                    f"o{index} {index / fps:.3f}s "
                    f"T={target_labels[index]}{target_levels[index]:.1f} "
                    f"S=f{source_index}:{source_labels[source_index]}"
                    f"{source_levels[source_index]:.1f}"
                ),
            )
        )
    for page_index, page in enumerate(
        [cells[index : index + 30] for index in range(0, len(cells), 30)],
        start=1,
    ):
        output = destination / f"final-contact-sheet-{page_index:02d}.jpg"
        contact_sheet(
            page,
            output,
            columns=5,
            cell_width=260,
            cell_height=260,
        )
        outputs.append(str(output))

    boundary_cells = []
    for boundary in boundaries:
        for index in range(max(0, boundary - 2), min(len(portraits), boundary + 3)):
            boundary_cells.append(
                (
                    bgr_to_pil(portraits[index]),
                    f"cut@{boundary} o{index} src{int(path[index])}",
                )
            )
    if boundary_cells:
        for page_index, page in enumerate(
            [
                boundary_cells[index : index + 50]
                for index in range(0, len(boundary_cells), 50)
            ],
            start=1,
        ):
            output = destination / f"boundary-strips-{page_index:02d}.jpg"
            contact_sheet(
                page,
                output,
                columns=5,
                cell_width=240,
                cell_height=240,
            )
            outputs.append(str(output))
    return outputs


def render(args: argparse.Namespace) -> dict[str, Any]:
    project, paths = load_project(Path(args.project))
    if project["character"].get("master_status") != "confirmed":
        raise ValueError("角色母版尚未确认，不能正式渲染")
    if project["motion_source"].get("status") != "accepted":
        raise ValueError("校准视频尚未通过检查，不能正式渲染")
    manifest = validate_media_manifest(paths["manifest"])
    _, motion_path = resolve_source(
        manifest,
        paths["root"],
        project["motion_source"].get("source_id"),
        {"video", "generated"},
    )
    crop = parse_xywh(
        project["motion_source"].get("source_crop_xywh"),
        "motion_source.source_crop_xywh",
    )
    mouth_crop = parse_xywh(
        project["motion_source"].get("mouth_review_crop_xywh"),
        "motion_source.mouth_review_crop_xywh",
    )
    source_frames, source_fps = load_cropped_frames(motion_path, crop)
    ensure_crop(mouth_crop, crop[2], crop[3], "mouth_review_crop_xywh")

    library = read_json(library_path(project, paths))
    library_validation = validate_library_payload(
        library,
        source_id=project["motion_source"]["source_id"],
        source_fps=source_fps,
        source_frame_count=len(source_frames),
        source_crop=crop,
    )
    if not library_validation["ok"]:
        raise ValueError(
            "视觉口型库未通过质量门：\n- "
            + "\n- ".join(library_validation["errors"])
        )

    render_config = project["render"]
    fps = int(render_config["internal_fps"])
    if abs(source_fps - fps) > 0.02:
        raise ValueError(
            f"校准视频为 {source_fps:.6f} fps，但项目 internal_fps={fps}。"
            "先统一帧率和标注边界，不能在运行时静默换算帧号。"
        )
    delivery_fps = int(render_config["delivery_fps"])
    width, height = [int(value) for value in render_config["output_size"]]

    timeline_path = Path(args.timeline).expanduser().resolve()
    timeline = read_json(timeline_path)
    units = validate_timeline(timeline)
    _, audio_path = resolve_source(
        manifest,
        paths["root"],
        timeline.get("audio_source_id"),
        {"audio", "video", "generated"},
    )
    ffmpeg = executable("ffmpeg", args.ffmpeg)
    ffprobe = executable("ffprobe", args.ffprobe)

    task_id = args.task_id or timeline_path.stem
    working = paths["root"] / "working" / "anime-avatar" / task_id
    report_dir = paths["root"] / "reports" / "avatar-renders" / task_id
    working.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)
    trimmed_audio = working / "trimmed-audio.wav"
    silent_video = working / "motion-match-silent.mp4"
    motion_match_video = working / "motion-match-with-audio.mp4"
    output = Path(args.output).expanduser().resolve()
    if output.exists():
        raise FileExistsError(f"不会覆盖已有输出：{output}")
    output.parent.mkdir(parents=True, exist_ok=True)

    audio_duration = extract_audio(
        ffmpeg,
        audio_path,
        trimmed_audio,
        float(timeline["trim_start_seconds"]),
        (
            float(timeline["trim_end_seconds"])
            if timeline["trim_end_seconds"] is not None
            else None
        ),
    )
    if units[-1].end > audio_duration + 0.08:
        raise ValueError(
            f"最后字结束于 {units[-1].end:.3f}s，超过裁切音频 {audio_duration:.3f}s"
        )
    requested_duration = (
        float(args.duration_seconds)
        if args.duration_seconds is not None
        else audio_duration
    )
    if requested_duration <= 0:
        raise ValueError("--duration-seconds 必须大于 0")
    duration_tolerance = 0.5 / fps
    if requested_duration + duration_tolerance < audio_duration:
        raise ValueError(
            "--duration-seconds 短于裁切后的完整音频："
            f"音频 {audio_duration:.6f}s，目标 {requested_duration:.6f}s"
        )
    requested_internal_frames = int(math.ceil(requested_duration * fps - 1e-9))
    samples, sample_rate = read_wave(trimmed_audio)
    phone_events = build_phone_events(units)
    target_labels, target_levels, energy, anchors, roles, phone_report = (
        build_target_timeline(
            units,
            phone_events,
            samples,
            sample_rate,
            audio_duration,
            fps,
            requested_internal_frames,
        )
    )

    source_labels, source_levels, source_takes = source_annotation(
        library,
        len(source_frames),
    )
    descriptors = visual_descriptors(source_frames, mouth_crop)
    path, boundaries, selection = plan_timeline_path(
        target_labels,
        target_levels,
        anchors,
        roles,
        source_labels,
        source_levels,
        source_takes,
        descriptors,
        library,
        fps,
    )
    selection["total_internal_frames"] = len(path)
    resized_source = resize_frames(source_frames, width, height)
    portraits = [resized_source[int(source_index)].copy() for source_index in path]
    portraits = one_frame_flow_joins(portraits, boundaries)

    encode_silent(ffmpeg, portraits, fps, silent_video)
    video_duration = len(portraits) / fps
    mux_audio(
        ffmpeg,
        silent_video,
        trimmed_audio,
        motion_match_video,
        video_duration,
    )
    if delivery_fps == fps:
        output.write_bytes(motion_match_video.read_bytes())
    else:
        interpolate_delivery(
            ffmpeg,
            motion_match_video,
            output,
            delivery_fps,
            video_duration,
        )

    review_outputs = save_render_review(
        report_dir,
        portraits,
        path,
        boundaries,
        target_labels,
        target_levels,
        source_labels,
        source_levels,
        fps,
    )
    output_probe = probe_video(output, ffprobe)
    duration_tolerance = max(0.002, 0.5 / delivery_fps)
    if abs(output_probe["video_duration_seconds"] - video_duration) > duration_tolerance:
        raise RuntimeError(
            "交付视频画面时长与内部帧时间线不一致："
            f"预期 {video_duration:.6f}s，"
            f"实际 {output_probe['video_duration_seconds']:.6f}s"
        )
    report = {
        "protocol": "visual-multimedia-anime-avatar-render",
        "version": 1,
        "character_id": project["character"]["id"],
        "motion_source_id": project["motion_source"]["source_id"],
        "audio_source_id": timeline["audio_source_id"],
        "speech_timeline": str(timeline_path),
        "text": timeline["text"],
        "audio_trim": {
            "start_seconds": timeline["trim_start_seconds"],
            "end_seconds": timeline["trim_end_seconds"],
            "rendered_duration_seconds": round(audio_duration, 6),
        },
        "output_timing": {
            "requested_duration_seconds": args.duration_seconds,
            "audio_duration_seconds": round(audio_duration, 6),
            "timeline_duration_seconds": round(video_duration, 6),
            "silence_idle_seconds": round(
                sum(role == "silence" for role in roles) / fps,
                6,
            ),
        },
        "architecture": (
            "confirmed speech timeline -> Mandarin phoneme/viseme nuclei -> "
            "within-syllable acoustic intensity -> reusable AI-reviewed "
            "whole-frame library -> continuity-constrained motion graph -> "
            "one-frame optical-flow joins -> motion-compensated delivery"
        ),
        "classification_boundary": {
            "source_classification": "read only from visual-viseme-library.json",
            "runtime_image_classification": False,
            "pixel_or_contour_mouth_classification": False,
        },
        "phone_events": phone_report,
        "target_by_internal_frame": [
            {
                "frame": index,
                "seconds": round(index / fps, 6),
                "viseme": target_labels[index],
                "phone_nucleus_anchor": anchors[index],
                "intensity": round(float(target_levels[index]), 4),
                "energy": round(float(energy[index]), 4),
            }
            for index in range(len(path))
        ],
        "source_frame_by_internal_frame": [int(value) for value in path],
        "selected_annotation_by_internal_frame": [
            {
                "source_frame": int(source_index),
                "viseme": source_labels[source_index],
                "intensity": round(float(source_levels[source_index]), 4),
                "take": int(source_takes[source_index]),
            }
            for source_index in path
        ],
        "selection": selection,
        "technical_result": {
            "output": str(output),
            "internal_fps": fps,
            "internal_frame_count": len(path),
            "delivery_probe": output_probe,
            "fixed_source_crop_xywh": list(crop),
            "output_size": [width, height],
            "fixed_anchor_policy": (
                "one source crop for every frame; no per-frame landmark or accessory tracking"
            ),
        },
        "review_artifacts": review_outputs,
        "human_full_review": {
            "required": True,
            "completed": False,
            "checks": [
                "watch the complete output with sound",
                "inspect every boundary strip",
                "confirm no rapid meaningless open-close",
                "confirm large openings appear on sufficiently strong vowel nuclei",
                "confirm late sections do not mechanically repeat one take",
                "confirm every silent interval uses closed-mouth motion rather than a frozen frame",
                "confirm no fixed post-speech tail was added beyond the requested timeline",
                "confirm identity, chin, hair, ears, accessories and shoulders stay coherent",
            ],
        },
    }
    report_path = report_dir / "render-report.json"
    write_json(report_path, report)
    return {
        "ok": True,
        "output": str(output),
        "report": str(report_path),
        "audio_duration_seconds": round(audio_duration, 6),
        "internal_frames": len(path),
        "delivery_fps": delivery_fps,
        "selection": selection,
        "review_artifacts": review_outputs,
        "next": (
            "完整观看输出并查看 boundary strips；确认后再进入常规视频时间线做圆形或方形窗口合成。"
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从 AI 视觉标注的完整帧素材库合成普通话二次元口播视频。"
    )
    parser.add_argument("--project", required=True)
    parser.add_argument("--timeline", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--task-id")
    parser.add_argument(
        "--duration-seconds",
        type=float,
        help=(
            "最终角色轨时长；省略时匹配裁切音频。长于音频的实际时间线按无声区间动态待机，不自动添加固定尾段"
        ),
    )
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    return parser.parse_args()


def main() -> int:
    report = render(parse_args())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        FileExistsError,
        FileNotFoundError,
        ValueError,
        RuntimeError,
        OSError,
    ) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

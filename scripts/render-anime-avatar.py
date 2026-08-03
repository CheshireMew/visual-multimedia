#!/usr/bin/env python3
"""Render Mandarin speech from an AI-reviewed whole-frame anime viseme library."""

from __future__ import annotations

import argparse
import copy
import gc
import hashlib
import json
import math
import shutil
import subprocess
import sys
import time
import uuid
import wave
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from pypinyin import Style, pinyin

from anime_avatar_blend import blend_compatible_join_window_in_place
from anime_avatar_common import (
    bgr_to_pil,
    contact_sheet,
    ensure_crop,
    executable,
    frame_cells,
    load_project,
    parse_xywh,
    probe_video,
    read_json,
    resolve_avatar_library,
    resolve_media_cache_root,
    resolve_project_path,
    resolve_source,
    validate_library_payload,
    validate_media_manifest,
    write_json,
)
from anime_avatar_motion import plan_gesture_motion
from anime_avatar_segments import plan_unit_ranges


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
    if payload.get("version") != 2:
        errors.append("version 必须是 2")
    if payload.get("language") != "zh-CN":
        errors.append("当前渲染器只接受 zh-CN")
    if payload.get("time_origin") != "trimmed-audio-start":
        errors.append("time_origin 必须是 trimmed-audio-start")
    if not isinstance(payload.get("audio_sha256"), str) or len(
        payload["audio_sha256"]
    ) != 64:
        errors.append("audio_sha256 必须是 64 位 sha256")
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
        elif units and units[-1].end > (
            float(trim_end) - float(trim_start or 0)
        ) + 0.02:
            errors.append("逐字边界越出裁切后音频时长")
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
        "-n",
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
        peak_strength = float(clip["peak_strength_level"])
        relative_scale = peak_strength / 4.0
        points: list[tuple[float, float]] = []
        for intensity, frame_index in enumerate(clip["rise_frames_by_intensity"]):
            points.append(
                (float(frame_index), float(intensity) * relative_scale)
            )
        peak_start, peak_end = clip["peak_frame_range_inclusive"]
        points.extend(
            [
                (float(peak_start), peak_strength),
                (float(peak_end), peak_strength),
            ]
        )
        for intensity, frame_index in enumerate(clip["fall_frames_by_intensity"]):
            points.append(
                (float(frame_index), float(intensity) * relative_scale)
            )
        ordered: dict[float, float] = {}
        for frame_index, intensity in sorted(points):
            ordered[frame_index] = max(intensity, ordered.get(frame_index, 0.0))
        point_frames = np.asarray(list(ordered.keys()), dtype=np.float32)
        point_levels = np.asarray(list(ordered.values()), dtype=np.float32)
        source_frames = np.arange(start, end, dtype=np.float32)
        levels[start:end] = np.interp(source_frames, point_frames, point_levels)
    return labels, levels, takes


def build_disk_backed_source_store(
    source: Path,
    crop: tuple[int, int, int, int],
    mouth_crop: tuple[int, int, int, int],
    expected_frame_count: int,
    destination: Path,
) -> tuple[np.memmap, float, np.ndarray, dict[str, Any]]:
    """Decode once into an exact disk-backed frame store and compact descriptors."""
    if expected_frame_count <= 0:
        raise ValueError("视觉口型库没有声明有效 source_frame_count")
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise ValueError(f"无法打开校准视频：{source}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    metadata_frame_count = int(
        round(float(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    )
    if (
        metadata_frame_count > 0
        and metadata_frame_count != expected_frame_count
    ):
        capture.release()
        raise ValueError(
            "校准视频容器帧数与视觉口型库不一致："
            f"视频 {metadata_frame_count}，素材库 {expected_frame_count}"
        )
    try:
        ensure_crop(crop, frame_width, frame_height, "source_crop_xywh")
        x, y, width, height = crop
        ensure_crop(mouth_crop, width, height, "mouth_review_crop_xywh")
    except Exception:
        capture.release()
        raise
    destination.parent.mkdir(parents=True, exist_ok=True)
    frames = np.memmap(
        destination,
        dtype=np.uint8,
        mode="w+",
        shape=(expected_frame_count, height, width, 3),
    )
    descriptor_size = 32
    mouth_x, mouth_y, mouth_width, mouth_height = mouth_crop
    left = max(0, int(math.floor(mouth_x / width * descriptor_size)) - 1)
    right = min(
        descriptor_size,
        int(
            math.ceil(
                (mouth_x + mouth_width) / width * descriptor_size
            )
        )
        + 1,
    )
    top = max(
        0,
        int(math.floor(mouth_y / height * descriptor_size)) - 1,
    )
    bottom = min(
        descriptor_size,
        int(
            math.ceil(
                (mouth_y + mouth_height) / height * descriptor_size
            )
        )
        + 1,
    )
    weights = np.ones(
        (descriptor_size, descriptor_size, 1),
        dtype=np.float32,
    )
    weights[top:bottom, left:right] = 0.0
    descriptors = np.empty(
        (expected_frame_count, descriptor_size * descriptor_size * 3),
        dtype=np.float32,
    )
    decoded = 0
    try:
        while decoded < expected_frame_count:
            ok, frame = capture.read()
            if not ok:
                raise ValueError(
                    "校准视频实际帧数少于视觉口型库声明："
                    f"声明 {expected_frame_count}，读取 {decoded}"
                )
            cropped = frame[y : y + height, x : x + width]
            frames[decoded] = cropped
            small = cv2.resize(
                cropped,
                (descriptor_size, descriptor_size),
                interpolation=cv2.INTER_AREA,
            )
            lab = (
                cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
                / 255.0
            )
            descriptors[decoded] = (lab * weights).reshape(-1)
            decoded += 1
        extra_ok, _ = capture.read()
        if extra_ok:
            raise ValueError(
                "校准视频实际帧数多于视觉口型库声明："
                f"声明 {expected_frame_count}"
            )
    finally:
        capture.release()
        frames.flush()
    if fps <= 0:
        raise ValueError(f"校准视频没有有效帧率：{source}")
    shape = (expected_frame_count, height, width, 3)
    store_bytes = int(frames.size * frames.dtype.itemsize)
    writable_mmap_handle = getattr(frames, "_mmap", None)
    if writable_mmap_handle is not None:
        writable_mmap_handle.close()
    frames = np.memmap(
        destination,
        dtype=np.uint8,
        mode="r",
        shape=shape,
    )
    return (
        frames,
        fps,
        descriptors,
        {
            "storage": "disk_backed_uint8_memmap",
            "path": str(destination),
            "shape": list(shape),
            "bytes": store_bytes,
            "descriptor_shape": list(descriptors.shape),
            "container_reported_frame_count": metadata_frame_count,
            "full_resolution_source_frames_loaded_as_python_objects": 0,
        },
    )


class SourceFrameSampler:
    """Random-access source sampler with a fixed-size resize cache."""

    def __init__(
        self,
        frames: np.ndarray,
        width: int,
        height: int,
        *,
        cache_size: int = 8,
    ) -> None:
        if len(frames) == 0:
            raise ValueError("校准视频没有可采样帧")
        if width <= 0 or height <= 0:
            raise ValueError("输出尺寸必须大于 0")
        if cache_size < 2:
            raise ValueError("采样缓存至少需要容纳两帧")
        self.frames = frames
        self.width = width
        self.height = height
        self.cache_size = cache_size
        source_height, source_width = frames[0].shape[:2]
        self.source_width = source_width
        self.source_height = source_height
        self.interpolation = (
            cv2.INTER_AREA
            if source_width >= width and source_height >= height
            else cv2.INTER_CUBIC
        )
        self.resized_cache: OrderedDict[int, np.ndarray] = OrderedDict()
        self.maximum_resident_cached_frames = 0

    def validate_positions(self, source_positions: np.ndarray) -> np.ndarray:
        positions = np.asarray(source_positions, dtype=np.float64)
        if positions.ndim != 1 or not len(positions):
            raise ValueError("source_positions 必须是一维非空数组")
        if not np.isfinite(positions).all():
            raise ValueError("source_positions 含非有限数值")
        if (
            float(np.min(positions)) < 0
            or float(np.max(positions)) > len(self.frames) - 1
        ):
            raise ValueError("source_positions 超出校准视频帧范围")
        return positions

    def _resized(self, index: int) -> np.ndarray:
        cached = self.resized_cache.get(index)
        if cached is not None:
            self.resized_cache.move_to_end(index)
            return cached
        source = self.frames[index]
        value = (
            source
            if (self.source_width, self.source_height)
            == (self.width, self.height)
            else cv2.resize(
                source,
                (self.width, self.height),
                interpolation=self.interpolation,
            )
        )
        self.resized_cache[index] = value
        self.resized_cache.move_to_end(index)
        while len(self.resized_cache) > self.cache_size:
            self.resized_cache.popitem(last=False)
        self.maximum_resident_cached_frames = max(
            self.maximum_resident_cached_frames,
            len(self.resized_cache),
        )
        return value

    def sample(self, position: float) -> np.ndarray:
        value = float(position)
        if not math.isfinite(value) or value < 0 or value > len(self.frames) - 1:
            raise ValueError(f"源时间位置越界：{value}")
        left = int(math.floor(value))
        right = min(len(self.frames) - 1, left + 1)
        amount = value - left
        if right == left or amount <= 1e-6:
            return self._resized(left).copy()
        if amount >= 1.0 - 1e-6:
            return self._resized(right).copy()
        return cv2.addWeighted(
            self._resized(left),
            1.0 - amount,
            self._resized(right),
            amount,
            0.0,
        )

    def close(self) -> None:
        self.resized_cache.clear()
        if isinstance(self.frames, np.memmap):
            self.frames.flush()
            mmap_handle = getattr(self.frames, "_mmap", None)
            if mmap_handle is not None:
                mmap_handle.close()


def frame_sha256(frame: np.ndarray) -> str:
    contiguous = np.ascontiguousarray(frame)
    return hashlib.sha256(memoryview(contiguous).cast("B")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def portable_locator(path: Path, project_root: Path) -> str:
    resolved = path.resolve()
    for prefix, root in (
        ("project://", project_root.resolve()),
        ("skill://", Path(__file__).resolve().parent.parent),
    ):
        try:
            relative = resolved.relative_to(root)
        except ValueError:
            continue
        return prefix + relative.as_posix()
    raise ValueError(
        "渲染计划输入必须位于当前媒体项目或 visual-multimedia Skill："
        f"{resolved}"
    )


def resolve_portable_locator(locator: str, project_root: Path) -> Path:
    if locator.startswith("project://"):
        base = project_root.resolve()
        relative = locator.removeprefix("project://")
    elif locator.startswith("skill://"):
        base = Path(__file__).resolve().parent.parent
        relative = locator.removeprefix("skill://")
    else:
        raise ValueError(f"渲染计划输入 locator 无效：{locator}")
    candidate = (base / relative).resolve()
    try:
        candidate.relative_to(base)
    except ValueError as error:
        raise ValueError(f"渲染计划 locator 越出允许目录：{locator}") from error
    if not candidate.is_file():
        raise FileNotFoundError(f"渲染计划输入不存在：{candidate}")
    return candidate


def canonical_payload_sha256(payload: dict[str, Any]) -> str:
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def immutable_render_plan_sha256(payload: dict[str, Any]) -> str:
    immutable = copy.deepcopy(payload)
    immutable.pop("approval", None)
    return canonical_payload_sha256(immutable)


def validate_render_plan_payload(
    payload: dict[str, Any],
    *,
    require_confirmed: bool,
) -> None:
    errors: list[str] = []
    expected_fields = {
        "protocol",
        "version",
        "status",
        "plan_id",
        "created_at",
        "inputs",
        "library_capabilities",
        "execution",
        "master",
        "units",
        "seams",
        "summary",
        "approval",
    }
    if set(payload) != expected_fields:
        errors.append("顶层字段不完整或含未知字段")
    if payload.get("protocol") != "visual-multimedia-anime-avatar-render-plan":
        errors.append(
            "protocol 必须是 visual-multimedia-anime-avatar-render-plan"
        )
    if payload.get("version") != 3:
        errors.append("version 必须是 3；v2 计划已退出活动渲染路径")
    if payload.get("status") not in {"ready", "rejected"}:
        errors.append("status 必须是 ready 或 rejected")
    inputs = payload.get("inputs")
    expected_input_keys = {
        "avatar_project",
        "media_sources",
        "avatar_library_package",
        "avatar_library_media_sources",
        "motion_source",
        "audio_source",
        "renderer_script",
        "motion_planner_script",
        "join_blender_script",
        "shared_avatar_runtime_script",
        "visual_viseme_library",
        "speech_timeline",
    }
    if not isinstance(inputs, dict) or not inputs:
        errors.append("inputs 必须是非空对象")
    else:
        if set(inputs) != expected_input_keys:
            errors.append("inputs 没有完整绑定全部生产输入与算法代码")
        for key, record in inputs.items():
            if (
                not isinstance(record, dict)
                or set(record) != {"locator", "sha256"}
                or not isinstance(record.get("locator"), str)
                or not record["locator"].startswith(("project://", "skill://"))
                or not isinstance(record.get("sha256"), str)
                or len(record["sha256"]) != 64
                or any(
                    character not in "0123456789abcdef"
                    for character in record["sha256"]
                )
            ):
                errors.append(f"inputs.{key} 必须包含 portable locator 与 sha256")
    library_capabilities = payload.get("library_capabilities")
    if (
        not isinstance(library_capabilities, dict)
        or set(library_capabilities) != {"resource", "facts"}
        or not isinstance(library_capabilities.get("resource"), dict)
        or set(library_capabilities["resource"]) != {"id", "version"}
        or not isinstance(library_capabilities.get("facts"), dict)
    ):
        errors.append("library_capabilities 必须绑定角色版本和能力事实")
    def valid_artifact(record: Any) -> bool:
        return (
            isinstance(record, dict)
            and set(record) == {"locator", "sha256"}
            and isinstance(record.get("locator"), str)
            and record["locator"].startswith(("project://", "skill://"))
            and isinstance(record.get("sha256"), str)
            and len(record["sha256"]) == 64
        )

    master = payload.get("master")
    if not isinstance(master, dict) or not all(
        key in master
        for key in (
            "cache_key",
            "content_sha256",
            "manifest_sha256",
            "width",
            "height",
            "fps",
        )
    ):
        errors.append("master 必须绑定共享母版键、内容哈希、尺寸和帧率")
    units = payload.get("units")
    if not isinstance(units, list) or not units:
        errors.append("units 必须是非空数组")
        units = []
    expected_start = 0
    ids: set[str] = set()
    for index, unit in enumerate(units):
        if not isinstance(unit, dict):
            errors.append(f"units[{index}] 必须是对象")
            continue
        unit_id = unit.get("id")
        start = unit.get("start_frame")
        end = unit.get("end_frame_exclusive")
        if not isinstance(unit_id, str) or not unit_id or unit_id in ids:
            errors.append(f"units[{index}].id 缺失或重复")
        else:
            ids.add(unit_id)
        if start != expected_start or not isinstance(end, int) or end <= expected_start:
            errors.append(f"units[{index}] 必须连续覆盖时间线")
            continue
        if unit.get("frame_count") != end - start:
            errors.append(f"units[{index}].frame_count 与边界不一致")
        expected_start = end
        for field in ("schedule", "diagnostics"):
            if not valid_artifact(unit.get(field)):
                errors.append(f"units[{index}].{field} 必须绑定计划内制品和哈希")
        instructions_sha256 = unit.get("render_instructions_sha256")
        if (
            not isinstance(instructions_sha256, str)
            or len(instructions_sha256) != 64
        ):
            errors.append(
                f"units[{index}].render_instructions_sha256 必须是 sha256"
            )
        render_schedule_sha256 = unit.get("render_schedule_sha256")
        if (
            not isinstance(render_schedule_sha256, str)
            or len(render_schedule_sha256) != 64
        ):
            errors.append(
                f"units[{index}].render_schedule_sha256 必须是 sha256"
            )
        internal_seams = unit.get("internal_seams")
        if (
            not isinstance(internal_seams, dict)
            or internal_seams.get("rejected") != 0
        ):
            errors.append(f"units[{index}] 含有未通过的内部接缝")
    execution = payload.get("execution")
    if isinstance(execution, dict) and units:
        fps = execution.get("internal_fps")
        duration = execution.get("duration_seconds")
        if (
            not isinstance(fps, int)
            or not isinstance(duration, (int, float))
            or expected_start != int(math.ceil(float(duration) * fps - 1e-9))
        ):
            errors.append("units 没有覆盖 execution 声明的完整帧范围")
    seams = payload.get("seams")
    if not isinstance(seams, list) or len(seams) != max(0, len(units) - 1):
        errors.append("seams 数量必须等于 units 数量减一")
        seams = []
    for index, seam in enumerate(seams):
        if (
            not isinstance(seam, dict)
            or seam.get("status") != "ready"
            or not valid_artifact(seam.get("artifact"))
        ):
            errors.append(f"seams[{index}] 尚未通过或制品无效")
            continue
        if index < len(units) - 1 and (
            seam.get("left_unit_id") != units[index].get("id")
            or seam.get("right_unit_id") != units[index + 1].get("id")
            or seam.get("boundary_frame")
            != units[index].get("end_frame_exclusive")
        ):
            errors.append(f"seams[{index}] 与相邻单元边界不一致")
    approval = payload.get("approval")
    if not isinstance(approval, dict):
        errors.append("approval 必须是对象")
    elif approval.get("status") not in {"pending", "confirmed"}:
        errors.append("approval.status 必须是 pending 或 confirmed")
    elif require_confirmed:
        if payload.get("status") != "ready":
            errors.append("被拒绝的接缝计划不能用于渲染")
        if approval.get("status") != "confirmed":
            errors.append("render-plan.json 尚未确认")
        else:
            approved_sha256 = approval.get("approved_plan_sha256")
            actual_sha256 = immutable_render_plan_sha256(payload)
            if approved_sha256 != actual_sha256:
                errors.append("render-plan.json 在确认后被修改")
    if errors:
        raise ValueError("render-plan.json 无效：\n- " + "\n- ".join(errors))


def confirm_render_plan(args: argparse.Namespace) -> dict[str, Any]:
    _, paths = load_project(Path(args.project))
    plan_id = validate_task_id(args.plan_id)
    plan_path = resolve_project_path(
        paths["root"],
        Path("plans") / "anime-avatar" / plan_id / "render-plan.json",
        "角色计划",
    )
    payload = read_json(plan_path)
    validate_render_plan_payload(payload, require_confirmed=False)
    if payload["status"] != "ready":
        raise ValueError("存在被拒绝接缝的计划不能确认，请先回到素材库或校准视频层处理")
    approval = payload["approval"]
    if approval.get("status") == "confirmed":
        raise ValueError("render-plan.json 已经确认，不会重复改写")
    approval.update(
        {
            "status": "confirmed",
            "confirmed_at": datetime.now(timezone.utc).isoformat(),
            "approved_plan_sha256": immutable_render_plan_sha256(payload),
        }
    )
    write_json(plan_path, payload)
    validate_render_plan_payload(payload, require_confirmed=True)
    return {
        "ok": True,
        "render_plan": str(plan_path),
        "status": "confirmed",
        "approved_plan_sha256": approval["approved_plan_sha256"],
        "next": "使用 render 子命令消费这份已确认计划；任一输入或代码变化都会使计划失效。",
    }


def validate_task_id(value: str) -> str:
    if (
        not value
        or len(value) > 120
        or any(
            character
            not in "abcdefghijklmnopqrstuvwxyz"
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
            for character in value
        )
        or value in {".", ".."}
        or value.startswith(".")
    ):
        raise ValueError(
            "task-id 只能使用 1 至 120 个字母、数字、点、横线或下划线，"
            "且不能以点开头"
        )
    return value


def normalized_boundaries(
    boundaries: list[int],
    frame_count: int,
) -> list[int]:
    values = [int(value) for value in boundaries]
    if values != sorted(set(values)):
        raise RuntimeError("规划器返回的接缝必须严格递增且不能重复")
    for boundary in values:
        if boundary < 1 or boundary >= frame_count:
            raise RuntimeError(f"规划器返回越界接缝：{boundary}")
    crowded = [
        [first, second]
        for first, second in zip(values, values[1:])
        if second - first < 3
    ]
    if crowded:
        raise RuntimeError(
            "规划器返回的接缝窗口相互重叠："
            + json.dumps(crowded, ensure_ascii=False)
        )
    return values


def preflight_output_resolution_join_windows(
    sampler: SourceFrameSampler,
    source_positions: np.ndarray,
    boundaries: list[int],
    cache: dict[tuple[int, ...], dict[str, Any]],
) -> list[dict[str, Any]]:
    positions = sampler.validate_positions(source_positions)
    values = normalized_boundaries(boundaries, len(positions))
    reports: list[dict[str, Any]] = []
    for input_index, boundary in enumerate(values):
        if boundary < 2 or boundary + 1 >= len(positions):
            raise RuntimeError(
                f"接缝 {boundary} 没有完整的前后自然动作上下文"
            )
        window_start = boundary - 2
        window_end = boundary + 2
        local_boundary = boundary - window_start
        key = tuple(
            int(value)
            for value in np.asarray(
                positions[window_start:window_end],
                dtype=np.float32,
            ).view(np.uint32)
        )
        cached = cache.get(key)
        cache_hit = cached is not None
        if cached is None:
            window = [
                sampler.sample(float(positions[frame_index]))
                for frame_index in range(window_start, window_end)
            ]
            local_report = blend_compatible_join_window_in_place(
                window,
                local_boundary,
            )
            cached = {
                "local_report": copy.deepcopy(local_report),
                "blended_window_sha256": (
                    [frame_sha256(frame) for frame in window]
                    if local_report.get("applied") is True
                    else None
                ),
            }
            cache[key] = cached
        report = copy.deepcopy(cached["local_report"])
        local_output_indices = [
            int(value)
            for value in report.get("output_frame_indices") or []
        ]
        if report.get("applied") is True and not local_output_indices:
            raise RuntimeError(
                f"接缝 {boundary} 已应用，但 blend 未声明写回帧"
            )
        if any(
            value < 0 or value >= window_end - window_start
            for value in local_output_indices
        ):
            raise RuntimeError(
                f"接缝 {boundary} 的 blend 写回位置越出小窗口"
            )
        global_output_indices = [
            window_start + value for value in local_output_indices
        ]
        report.update(
            {
                "input_index": input_index,
                "boundary": boundary,
                "window": [boundary - 1, boundary],
                "blend_input_window": [window_start, window_end],
                "blend_input_frame_indices": list(
                    range(window_start, window_end)
                ),
                "local_boundary": local_boundary,
                "local_output_frame_indices": local_output_indices,
                "output_frame_indices": global_output_indices,
                "preflight_output_resolution_join_window": True,
                "preflight_cache_hit": cache_hit,
            }
        )
        if report.get("applied") is True:
            report["preflight_blended_window_sha256"] = list(
                cached["blended_window_sha256"]
            )
            report["preflight_output_frame_sha256"] = [
                report["preflight_blended_window_sha256"][index]
                for index in local_output_indices
            ]
        reports.append(report)

    accepted = [
        report for report in reports if report.get("applied") is True
    ]
    for index, first in enumerate(accepted):
        first_outputs = set(first["output_frame_indices"])
        for second in accepted[index + 1 :]:
            second_outputs = set(second["output_frame_indices"])
            second_input = set(second["blend_input_frame_indices"])
            first_input = set(first["blend_input_frame_indices"])
            if (
                first_outputs & second_outputs
                or first_outputs & second_input
                or second_outputs & first_input
            ):
                raise RuntimeError(
                    "相邻接缝的小窗口写回范围相互影响，无法独立预检并"
                    "确定性流式复现："
                    + json.dumps(
                        [
                            int(first["boundary"]),
                            int(second["boundary"]),
                        ],
                        ensure_ascii=False,
                    )
                )
    return reports


def write_raw_frame(stream: Any, frame: np.ndarray) -> None:
    contiguous = np.ascontiguousarray(frame)
    stream.write(memoryview(contiguous).cast("B"))


def encode_silent_stream(
    ffmpeg: str,
    sampler: SourceFrameSampler,
    source_positions: np.ndarray,
    boundaries: list[int],
    join_reports: list[dict[str, Any]],
    fps: int,
    destination: Path,
) -> dict[str, Any]:
    positions = sampler.validate_positions(source_positions)
    values = normalized_boundaries(boundaries, len(positions))
    if len(join_reports) != len(values):
        raise RuntimeError("流式编码前的接缝报告数量与最终接缝数量不一致")
    report_by_boundary = {
        int(report["boundary"]): report for report in join_reports
    }
    if sorted(report_by_boundary) != values:
        raise RuntimeError("流式编码前的接缝报告与最终接缝位置不一致")
    if any(report.get("applied") is not True for report in join_reports):
        raise RuntimeError("存在未通过完整分辨率预检的接缝，拒绝开始编码")
    operations = sorted(
        join_reports,
        key=lambda report: min(report["output_frame_indices"]),
    )
    if any(not report["output_frame_indices"] for report in operations):
        raise RuntimeError("接缝报告没有声明需要流式写回的画面帧")

    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s:v",
        f"{sampler.width}x{sampler.height}",
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
    frames_written = 0
    reproduced_joins = 0
    maximum_resident_output_frames = 1
    try:
        frame_index = 0
        operation_index = 0
        pending_frames: dict[int, np.ndarray] = {}
        while frame_index < len(positions):
            while operation_index < len(operations):
                expected = operations[operation_index]
                output_indices = [
                    int(value)
                    for value in expected["output_frame_indices"]
                ]
                first_output = min(output_indices)
                if first_output > frame_index:
                    break
                if first_output < frame_index:
                    raise RuntimeError(
                        "接缝流式复现启动过晚："
                        f"boundary={expected['boundary']}, "
                        f"first_output={first_output}, current={frame_index}"
                    )
                window_start, window_end = [
                    int(value) for value in expected["blend_input_window"]
                ]
                window = [
                    sampler.sample(float(positions[index]))
                    for index in range(window_start, window_end)
                ]
                maximum_resident_output_frames = max(
                    maximum_resident_output_frames,
                    len(window) + len(pending_frames),
                )
                local_boundary = int(expected["local_boundary"])
                stream_report = blend_compatible_join_window_in_place(
                    window,
                    local_boundary,
                )
                if stream_report.get("applied") is not True:
                    raise RuntimeError(
                        "接缝通过预检后在流式复现阶段失败："
                        + json.dumps(
                            {
                                "boundary": expected["boundary"],
                                "reason": stream_report.get("reason"),
                                "failed_checks": stream_report.get(
                                    "failed_checks"
                                ),
                            },
                            ensure_ascii=False,
                        )
                    )
                window_hashes = [frame_sha256(frame) for frame in window]
                expected_window_hashes = expected.get(
                    "preflight_blended_window_sha256"
                )
                if window_hashes != expected_window_hashes:
                    raise RuntimeError(
                        f"接缝 {expected['boundary']} 的流式小窗口结果"
                        "与预检结果不一致"
                    )
                local_output_indices = [
                    int(value)
                    for value in expected["local_output_frame_indices"]
                ]
                stream_output_indices = [
                    int(value)
                    for value in stream_report.get(
                        "output_frame_indices"
                    )
                    or []
                ]
                if stream_output_indices != local_output_indices:
                    raise RuntimeError(
                        f"接缝 {expected['boundary']} 的流式写回范围"
                        "与预检不一致"
                    )
                output_hashes = [
                    frame_sha256(window[index])
                    for index in local_output_indices
                ]
                if output_hashes != expected.get(
                    "preflight_output_frame_sha256"
                ):
                    raise RuntimeError(
                        f"接缝 {expected['boundary']} 的流式写回帧"
                        "与预检不一致"
                    )
                for local_index, output_index in zip(
                    local_output_indices,
                    output_indices,
                    strict=True,
                ):
                    if output_index in pending_frames:
                        raise RuntimeError(
                            f"多个接缝尝试写回同一帧：{output_index}"
                        )
                    pending_frames[output_index] = window[local_index]
                expected[
                    "stream_reproduction_verified"
                ] = True
                expected["stream_blended_window_sha256"] = window_hashes
                expected["stream_output_frame_sha256"] = output_hashes
                reproduced_joins += 1
                operation_index += 1
            frame = pending_frames.pop(frame_index, None)
            if frame is None:
                frame = sampler.sample(float(positions[frame_index]))
            write_raw_frame(process.stdin, frame)
            frames_written += 1
            frame_index += 1
        if operation_index != len(operations) or pending_frames:
            raise RuntimeError(
                "流式编码结束时仍有接缝操作或写回帧未消费"
            )
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
    except BaseException:
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        if process.stderr is not None:
            process.stderr.read()
        process.wait()
        raise
    if return_code != 0:
        raise RuntimeError(
            "FFmpeg 无法编码无声视频："
            + stderr.decode("utf-8", errors="replace")
        )
    if frames_written != len(positions):
        raise RuntimeError(
            f"流式编码帧数不一致：写入 {frames_written}，"
            f"计划 {len(positions)}"
        )
    if reproduced_joins != len(values):
        raise RuntimeError(
            f"流式复现接缝数不一致：复现 {reproduced_joins}，"
            f"预检 {len(values)}"
        )
    return {
        "frames_written": frames_written,
        "preflight_join_count": len(values),
        "stream_reproduced_join_count": reproduced_joins,
        "all_join_hashes_reproduced": True,
        "maximum_resident_output_frames": maximum_resident_output_frames,
        "maximum_resident_cached_source_frames": (
            sampler.maximum_resident_cached_frames
        ),
        "source_cache_capacity_frames": sampler.cache_size,
    }


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
        "-n",
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
        "-n",
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


def review_thumbnail(frame: np.ndarray, max_dimension: int = 320) -> Any:
    height, width = frame.shape[:2]
    scale = min(1.0, max_dimension / max(width, height))
    if scale < 1.0:
        frame = cv2.resize(
            frame,
            (
                max(1, int(round(width * scale))),
                max(1, int(round(height * scale))),
            ),
            interpolation=cv2.INTER_AREA,
        )
    return bgr_to_pil(frame)


def write_review_pages_from_video(
    video: Path,
    records: list[tuple[int, str]],
    destination: Path,
    *,
    expected_fps: float,
    filename_prefix: str,
    page_size: int,
    columns: int,
    cell_width: int,
    cell_height: int,
) -> tuple[list[str], int, float]:
    if page_size < 1:
        raise ValueError("review page_size 必须大于 0")
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"无法打开最终视频生成审核图：{video}")
    actual_fps = float(capture.get(cv2.CAP_PROP_FPS))
    declared_count = int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    if actual_fps <= 0:
        capture.release()
        raise RuntimeError("最终视频没有可读取帧率")
    if abs(actual_fps - expected_fps) > 0.05:
        capture.release()
        raise RuntimeError(
            f"审核视频帧率不一致：预期 {expected_fps:.6f}，"
            f"实际 {actual_fps:.6f}"
        )
    if declared_count <= 0:
        capture.release()
        raise RuntimeError("最终视频没有可读取画面帧")
    if not records:
        capture.release()
        return [], declared_count, actual_fps
    delivery_indices = [index for index, _ in records]
    if delivery_indices != sorted(delivery_indices):
        capture.release()
        raise RuntimeError("审核抽帧记录必须按最终视频帧号递增")
    if min(delivery_indices) < 0 or max(delivery_indices) >= declared_count:
        capture.release()
        raise RuntimeError(
            "审核抽帧位置越界："
            f"范围 {min(delivery_indices)}..{max(delivery_indices)}，"
            f"视频共 {declared_count} 帧"
        )

    records_by_frame: dict[int, list[str]] = {}
    for frame_index, label in records:
        records_by_frame.setdefault(frame_index, []).append(label)
    last_requested = max(records_by_frame)
    outputs: list[str] = []
    page: list[tuple[Any, str]] = []
    consumed_records = 0
    page_index = 1
    frame_index = 0
    try:
        while frame_index <= last_requested:
            ok, frame = capture.read()
            if not ok:
                break
            for label in records_by_frame.get(frame_index, []):
                page.append((review_thumbnail(frame), label))
                consumed_records += 1
                if len(page) == page_size:
                    output = (
                        destination
                        / f"{filename_prefix}-{page_index:02d}.jpg"
                    )
                    contact_sheet(
                        page,
                        output,
                        columns=columns,
                        cell_width=cell_width,
                        cell_height=cell_height,
                    )
                    outputs.append(str(output))
                    for image, _ in page:
                        image.close()
                    page.clear()
                    page_index += 1
            frame_index += 1
    finally:
        capture.release()
    if consumed_records != len(records):
        for image, _ in page:
            image.close()
        raise RuntimeError(
            "最终视频审核抽帧不完整："
            f"预期 {len(records)} 条，实际 {consumed_records} 条"
        )
    if page:
        output = destination / f"{filename_prefix}-{page_index:02d}.jpg"
        contact_sheet(
            page,
            output,
            columns=columns,
            cell_width=cell_width,
            cell_height=cell_height,
        )
        outputs.append(str(output))
        for image, _ in page:
            image.close()
    return outputs, declared_count, actual_fps


def save_render_review_from_video(
    destination: Path,
    video: Path,
    source_positions: np.ndarray,
    boundaries: list[int],
    target_labels: list[str],
    target_levels: np.ndarray,
    source_labels: list[str],
    source_levels: np.ndarray,
    internal_fps: int,
    delivery_fps: int,
) -> list[str]:
    if destination.exists():
        existing = list(destination.iterdir())
        if existing:
            raise FileExistsError(
                "审核目录已有内容，不会覆盖旧报告或审核图："
                f"{destination}"
            )
    else:
        destination.mkdir(parents=True, exist_ok=False)
    outputs: list[str] = []
    frame_count = len(source_positions)
    contact_indices = sorted(
        set(
            list(range(0, frame_count, max(1, internal_fps // 2)))
            + boundaries
            + [max(0, boundary - 1) for boundary in boundaries]
            + [frame_count - 1]
        )
    )
    boundary_records = [
        (boundary, index)
        for boundary in boundaries
        for index in range(
            max(0, boundary - 2),
            min(frame_count, boundary + 3),
        )
    ]
    requested_internal_indices = set(contact_indices) | {
        index for _, index in boundary_records
    }
    internal_to_delivery = {
        index: int(round(index / internal_fps * delivery_fps))
        for index in requested_internal_indices
    }
    contact_records: list[tuple[int, str]] = []
    for index in contact_indices:
        source_position = float(source_positions[index])
        source_index = int(
            np.clip(
                round(source_position),
                0,
                len(source_labels) - 1,
            )
        )
        contact_records.append(
            (
                internal_to_delivery[index],
                (
                    f"o{index} {index / internal_fps:.3f}s "
                    f"T={target_labels[index]}{target_levels[index]:.1f} "
                    f"S={source_position:.2f}/{source_labels[source_index]}"
                    f"{source_levels[source_index]:.1f}"
                ),
            )
        )
    contact_outputs, delivery_frame_count, actual_delivery_fps = (
        write_review_pages_from_video(
            video,
            contact_records,
            destination,
            expected_fps=float(delivery_fps),
            filename_prefix="final-contact-sheet",
            page_size=30,
            columns=5,
            cell_width=260,
            cell_height=260,
        )
    )
    outputs.extend(contact_outputs)

    boundary_page_records = [
        (
            internal_to_delivery[index],
            (
                f"cut@{boundary} o{index} "
                f"src{float(source_positions[index]):.2f}"
            ),
        )
        for boundary, index in boundary_records
    ]
    boundary_outputs, boundary_delivery_count, boundary_delivery_fps = (
        write_review_pages_from_video(
            video,
            boundary_page_records,
            destination,
            expected_fps=float(delivery_fps),
            filename_prefix="boundary-strips",
            page_size=50,
            columns=5,
            cell_width=240,
            cell_height=240,
        )
    )
    if (
        boundary_delivery_count != delivery_frame_count
        or abs(boundary_delivery_fps - actual_delivery_fps) > 1e-9
    ):
        raise RuntimeError("两轮最终视频审核抽帧读取到不一致的媒体属性")
    outputs.extend(boundary_outputs)
    extraction_manifest = destination / "review-frame-source.json"
    write_json(
        extraction_manifest,
        {
            "protocol": "visual-multimedia-avatar-render-review-source",
            "version": 1,
            "source_video": str(video),
            "source_is_final_encoded_delivery": True,
            "internal_fps": internal_fps,
            "delivery_fps": round(actual_delivery_fps, 6),
            "delivery_frame_count": delivery_frame_count,
            "internal_to_delivery_frame": {
                str(index): delivery_index
                for index, delivery_index in sorted(
                    internal_to_delivery.items()
                )
            },
            "full_resolution_frames_retained": 0,
            "thumbnail_maximum_dimension": 320,
            "maximum_resident_thumbnail_count": 50,
            "thumbnail_image_memory_complexity": "O(1)",
        },
    )
    outputs.append(str(extraction_manifest))
    return outputs

MASTER_CACHE_VERSION = "anime-avatar-medium-master-v1"
UNIT_CACHE_VERSION = "anime-avatar-segment-cache-v1"


def canonical_json_sha256(payload: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def archive_cache_entry(cache_root: Path, entry: Path, label: str) -> Path:
    archive_root = cache_root / "archive" / label
    archive_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = archive_root / f"{entry.name}.{timestamp}"
    shutil.move(str(entry), str(destination))
    return destination


def ensure_medium_master(
    ffmpeg: str,
    ffprobe: str,
    motion_path: Path,
    crop: tuple[int, int, int, int],
    master_size: tuple[int, int],
    fps: int,
) -> dict[str, Any]:
    cache_root = resolve_media_cache_root()
    specification = {
        "version": MASTER_CACHE_VERSION,
        "motion_source_sha256": file_sha256(motion_path),
        "crop_xywh": list(crop),
        "master_size": list(master_size),
        "fps": fps,
        "codec": "libx264-crf10-yuv420p",
        "scale": "lanczos",
    }
    cache_key = canonical_json_sha256(specification)
    entry = cache_root / "anime-avatar-masters" / "v1" / cache_key
    master_path = entry / "master.mp4"
    manifest_path = entry / "manifest.json"

    def inspect_existing() -> dict[str, Any] | None:
        if not entry.exists():
            return None
        try:
            manifest = read_json(manifest_path)
            if (
                manifest.get("protocol")
                != "visual-multimedia-anime-avatar-master-cache"
                or manifest.get("version") != 1
                or manifest.get("cache_key") != cache_key
                or manifest.get("specification") != specification
                or not master_path.is_file()
                or manifest.get("content_sha256") != file_sha256(master_path)
            ):
                raise ValueError("共享母版缓存清单或内容哈希不一致")
            probe = probe_video(master_path, ffprobe)
            if (
                probe["width"] != master_size[0]
                or probe["height"] != master_size[1]
                or abs(float(probe["fps"]) - fps) > 0.02
            ):
                raise ValueError("共享母版缓存的尺寸或帧率不一致")
            return {
                "path": master_path,
                "manifest_path": manifest_path,
                "manifest_sha256": file_sha256(manifest_path),
                "content_sha256": manifest["content_sha256"],
                "cache_key": cache_key,
                "probe": probe,
                "status": "reused",
            }
        except (FileNotFoundError, ValueError, RuntimeError, OSError):
            archive_cache_entry(cache_root, entry, "anime-avatar-masters")
            return None

    existing = inspect_existing()
    if existing is not None:
        return existing
    entry.mkdir(parents=True, exist_ok=False)
    pending = entry / f"master.pending.{uuid.uuid4().hex}.mp4"
    x, y, width, height = crop
    output_width, output_height = master_size
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-i",
        str(motion_path),
        "-vf",
        (
            f"crop={width}:{height}:{x}:{y},"
            f"scale={output_width}:{output_height}:flags=lanczos,"
            f"fps={fps}"
        ),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "10",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(pending),
    ]
    result = subprocess.run(command, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "无法生成中等尺寸角色共享母版："
            + result.stderr.decode("utf-8", errors="replace")
        )
    pending.replace(master_path)
    probe = probe_video(master_path, ffprobe)
    if (
        probe["width"] != output_width
        or probe["height"] != output_height
        or abs(float(probe["fps"]) - fps) > 0.02
    ):
        raise RuntimeError("生成的共享母版尺寸或帧率与合同不一致")
    manifest = {
        "protocol": "visual-multimedia-anime-avatar-master-cache",
        "version": 1,
        "cache_key": cache_key,
        "specification": specification,
        "file": "master.mp4",
        "content_sha256": file_sha256(master_path),
        "probe": probe,
    }
    write_json(manifest_path, manifest)
    return {
        "path": master_path,
        "manifest_path": manifest_path,
        "manifest_sha256": file_sha256(manifest_path),
        "content_sha256": manifest["content_sha256"],
        "cache_key": cache_key,
        "probe": probe,
        "status": "generated",
    }


def scaled_mouth_crop(
    mouth_crop: tuple[int, int, int, int],
    source_crop: tuple[int, int, int, int],
    master_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    scale_x = master_size[0] / source_crop[2]
    scale_y = master_size[1] / source_crop[3]
    x, y, width, height = mouth_crop
    scaled = (
        max(0, int(round(x * scale_x))),
        max(0, int(round(y * scale_y))),
        max(1, int(round(width * scale_x))),
        max(1, int(round(height * scale_y))),
    )
    right = min(master_size[0], scaled[0] + scaled[2])
    bottom = min(master_size[1], scaled[1] + scaled[3])
    return scaled[0], scaled[1], right - scaled[0], bottom - scaled[1]


def local_speech_units(
    units: list[SpeechUnit],
    start_frame: int,
    end_frame: int,
    fps: int,
) -> list[SpeechUnit]:
    start_seconds = start_frame / fps
    end_seconds = end_frame / fps
    values = []
    for unit in units:
        center = (unit.start + unit.end) * 0.5
        if center < start_seconds or center >= end_seconds:
            continue
        local_start = max(unit.start, start_seconds) - start_seconds
        local_end = min(unit.end, end_seconds) - start_seconds
        if local_end <= local_start:
            raise RuntimeError("逐字时间区间在帧边界量化后消失")
        values.append(
            SpeechUnit(
                unit.text,
                local_start,
                local_end,
            )
        )
    return values


def plan_selection_gate(selection: dict[str, Any]) -> dict[str, Any]:
    failures: dict[str, Any] = {}
    minimums = {
        "planned_annotation_stable_pause_closed_match_rate": 1.0,
        "planned_annotation_silence_dynamic_rate": 1.0,
    }
    for key, minimum in minimums.items():
        observed = selection.get(key)
        if not isinstance(observed, (int, float)) or float(observed) + 1e-9 < minimum:
            failures[key] = {"observed": observed, "minimum": minimum}
    for value_key, limit_key in (
        (
            "planned_annotation_maximum_continuous_source_speed",
            "planned_annotation_source_speed_limit",
        ),
        (
            "planned_annotation_maximum_continuous_source_acceleration",
            "planned_annotation_source_acceleration_limit",
        ),
    ):
        observed = selection.get(value_key)
        maximum = selection.get(limit_key)
        if (
            not isinstance(observed, (int, float))
            or not isinstance(maximum, (int, float))
            or float(observed) > float(maximum) + 1e-9
        ):
            failures[value_key] = {"observed": observed, "maximum": maximum}
    if (
        selection.get("planned_annotation_diversity_enforcement_mode")
        != "continuity-first-fallback"
        and selection.get("planned_annotation_motion_diversity_contract_satisfied")
        is not True
    ):
        failures["motion_diversity"] = {
            "observed": selection.get(
                "planned_annotation_motion_diversity_contract_satisfied"
            ),
            "required": True,
        }
    result = {"passed": not failures, "failures": failures}
    if failures:
        raise RuntimeError(
            "角色单元动作规划没有达到动态待机和连续运动机器门："
            + json.dumps(failures, ensure_ascii=False)
        )
    return result


def write_schedule_artifact(
    path: Path,
    *,
    source_positions: np.ndarray,
    boundaries: list[int],
    target_labels: list[str],
    target_levels: np.ndarray,
    energy: np.ndarray,
    anchors: list[str | None],
    roles: list[str],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        source_positions=np.asarray(source_positions, dtype=np.float32),
        boundaries=np.asarray(boundaries, dtype=np.int32),
        target_labels=np.asarray(target_labels, dtype="U8"),
        target_levels=np.asarray(target_levels, dtype=np.float32),
        energy=np.asarray(energy, dtype=np.float32),
        anchors=np.asarray([value or "" for value in anchors], dtype="U8"),
        roles=np.asarray(roles, dtype="U32"),
    )


def load_schedule_artifact(
    record: dict[str, Any], project_root: Path
) -> dict[str, Any]:
    path = resolve_portable_locator(record["locator"], project_root)
    if file_sha256(path) != record["sha256"]:
        raise RuntimeError(f"角色计划制品哈希不一致：{path}")
    with np.load(path, allow_pickle=False) as payload:
        return {key: payload[key].copy() for key in payload.files}


def artifact_record(path: Path, project_root: Path) -> dict[str, str]:
    return {
        "locator": portable_locator(path, project_root),
        "sha256": file_sha256(path),
    }


def join_records(
    selection: dict[str, Any],
    reports: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    report_by_boundary = {int(item["boundary"]): item for item in reports}
    records = []
    for transition in selection["planned_annotation_selected_clip_transitions"]:
        record = copy.deepcopy(transition)
        if transition["boundary"]:
            boundary = int(transition["output_frame"])
            preflight = report_by_boundary.get(boundary)
            if preflight is None:
                raise RuntimeError(f"接缝 {boundary} 缺少四帧预检")
            record["preflight"] = copy.deepcopy(preflight)
            record["category"] = (
                "ready" if preflight.get("applied") is True else "rejected"
            )
        else:
            record["preflight"] = None
            record["category"] = "original_source_continuity"
        records.append(record)
    return records


def shifted_join_reports(
    reports: list[dict[str, Any]], offset: int
) -> list[dict[str, Any]]:
    shifted = []
    scalar_fields = ("boundary", "local_boundary")
    range_fields = (
        "window",
        "blend_input_window",
        "blend_input_frame_indices",
        "output_frame_indices",
    )
    for report in reports:
        value = copy.deepcopy(report)
        for field in scalar_fields:
            if field == "local_boundary":
                continue
            if isinstance(value.get(field), int):
                value[field] -= offset
        for field in range_fields:
            if isinstance(value.get(field), list):
                value[field] = [int(item) - offset for item in value[field]]
        shifted.append(value)
    return shifted


def render_join_instruction_records(
    joins: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    fields = (
        "boundary",
        "blend_input_window",
        "blend_input_frame_indices",
        "output_frame_indices",
        "applied",
        "local_boundary",
        "preflight_blended_window_sha256",
        "local_output_frame_indices",
        "preflight_output_frame_sha256",
    )
    return [
        {field: copy.deepcopy(item["preflight"].get(field)) for field in fields}
        for item in joins
        if item.get("category") == "ready"
    ]


def encode_frame_sequence(
    ffmpeg: str,
    frames: list[np.ndarray],
    fps: int,
    destination: Path,
) -> None:
    if not frames:
        raise ValueError("不能编码空角色帧序列")
    height, width = frames[0].shape[:2]
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
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
            write_raw_frame(process.stdin, frame)
        process.stdin.close()
        stderr = process.stderr.read() if process.stderr is not None else b""
        return_code = process.wait()
    except BaseException:
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        process.wait()
        raise
    if return_code != 0:
        raise RuntimeError(
            "FFmpeg 无法编码角色接缝桥："
            + stderr.decode("utf-8", errors="replace")
        )


def cached_segment(
    cache_root: Path,
    kind: str,
    cache_key: str,
    ffprobe: str,
    width: int,
    height: int,
    fps: int,
    frame_count: int,
) -> dict[str, Any] | None:
    entry = cache_root / kind / cache_key[:24]
    video = entry / "video.mp4"
    manifest_path = entry / "manifest.json"
    if not entry.exists():
        return None
    try:
        manifest = read_json(manifest_path)
        if (
            manifest.get("protocol")
            != "visual-multimedia-anime-avatar-segment-cache"
            or manifest.get("version") != 1
            or manifest.get("cache_key") != cache_key
            or manifest.get("frame_count") != frame_count
            or not video.is_file()
            or manifest.get("content_sha256") != file_sha256(video)
        ):
            raise ValueError("角色分段缓存清单或哈希不一致")
        probe = probe_video(video, ffprobe)
        if (
            probe["width"] != width
            or probe["height"] != height
            or abs(float(probe["fps"]) - fps) > 0.02
            or int(probe["declared_frame_count"]) != frame_count
        ):
            raise ValueError("角色分段缓存的尺寸、帧率或帧数不一致")
        return {
            "entry": entry,
            "video": video,
            "manifest": manifest_path,
            "content_sha256": manifest["content_sha256"],
            "status": "reused",
        }
    except (FileNotFoundError, ValueError, RuntimeError, OSError):
        archive_cache_entry(cache_root, entry, f"anime-avatar-{kind}")
        return None


def commit_segment_cache(
    cache_root: Path,
    kind: str,
    cache_key: str,
    pending_video: Path,
    frame_count: int,
) -> dict[str, Any]:
    entry = cache_root / kind / cache_key[:24]
    entry.mkdir(parents=True, exist_ok=False)
    video = entry / "video.mp4"
    shutil.move(str(pending_video), str(video))
    manifest_path = entry / "manifest.json"
    manifest = {
        "protocol": "visual-multimedia-anime-avatar-segment-cache",
        "version": 1,
        "cache_key": cache_key,
        "frame_count": frame_count,
        "file": "video.mp4",
        "content_sha256": file_sha256(video),
    }
    write_json(manifest_path, manifest)
    return {
        "entry": entry,
        "video": video,
        "manifest": manifest_path,
        "content_sha256": manifest["content_sha256"],
        "status": "rendered",
    }


def concat_segments(
    ffmpeg: str,
    segments: list[Path],
    list_path: Path,
    destination: Path,
) -> None:
    for segment in segments:
        if "'" in str(segment):
            raise ValueError("FFmpeg 分段路径不能包含单引号")
    list_path.write_text(
        "".join(f"file '{segment.as_posix()}'\n" for segment in segments),
        encoding="utf-8",
    )
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-an",
        "-c:v",
        "copy",
        str(destination),
    ]
    result = subprocess.run(command, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "FFmpeg 无法无重编码装配角色分段："
            + result.stderr.decode("utf-8", errors="replace")
        )


def materialize_track_clip(source: Path, destination: Path) -> Path:
    if destination.exists():
        raise FileExistsError(f"不会覆盖角色交接片段：{destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    if file_sha256(source) != file_sha256(destination):
        raise RuntimeError(f"角色交接片段复制后哈希不一致：{destination}")
    return destination


def ensure_audio_master(
    ffmpeg: str,
    audio_path: Path,
    trim_start: float,
    trim_end: float | None,
    cache_root: Path,
) -> dict[str, Any]:
    specification = {
        "version": "anime-avatar-audio-master-v1",
        "audio_source_sha256": file_sha256(audio_path),
        "trim_start_seconds": round(trim_start, 9),
        "trim_end_seconds": round(trim_end, 9) if trim_end is not None else None,
        "sample_rate": 48000,
        "channels": 1,
        "codec": "pcm_s16le",
    }
    cache_key = canonical_json_sha256(specification)
    entry = cache_root / "audio" / cache_key[:24]
    audio = entry / "audio.wav"
    manifest_path = entry / "manifest.json"
    if entry.exists():
        try:
            manifest = read_json(manifest_path)
            if (
                manifest.get("protocol")
                != "visual-multimedia-anime-avatar-audio-cache"
                or manifest.get("version") != 1
                or manifest.get("cache_key") != cache_key
                or manifest.get("specification") != specification
                or not audio.is_file()
                or manifest.get("content_sha256") != file_sha256(audio)
            ):
                raise ValueError("连续音频母版缓存无效")
            with wave.open(str(audio), "rb") as source:
                duration = source.getnframes() / source.getframerate()
            return {
                "path": audio,
                "manifest": manifest_path,
                "cache_key": cache_key,
                "content_sha256": manifest["content_sha256"],
                "duration_seconds": duration,
                "status": "reused",
            }
        except (FileNotFoundError, ValueError, OSError):
            archive_cache_entry(cache_root, entry, "anime-avatar-audio")
    entry.mkdir(parents=True, exist_ok=False)
    pending = entry / "audio.pending.wav"
    duration = extract_audio(
        ffmpeg,
        audio_path,
        pending,
        trim_start,
        trim_end,
    )
    pending.replace(audio)
    manifest = {
        "protocol": "visual-multimedia-anime-avatar-audio-cache",
        "version": 1,
        "cache_key": cache_key,
        "specification": specification,
        "file": "audio.wav",
        "content_sha256": file_sha256(audio),
        "duration_seconds": round(duration, 9),
    }
    write_json(manifest_path, manifest)
    return {
        "path": audio,
        "manifest": manifest_path,
        "cache_key": cache_key,
        "content_sha256": manifest["content_sha256"],
        "duration_seconds": duration,
        "status": "generated",
    }


def cached_plan_bundle(
    cache_root: Path,
    kind: str,
    cache_key: str,
    files: tuple[str, ...],
) -> dict[str, Any] | None:
    entry = cache_root / "plans" / kind / cache_key[:24]
    manifest_path = entry / "manifest.json"
    if not entry.exists():
        return None
    try:
        manifest = read_json(manifest_path)
        if (
            manifest.get("protocol")
            != "visual-multimedia-anime-avatar-plan-cache"
            or manifest.get("version") != 1
            or manifest.get("cache_key") != cache_key
            or set(manifest.get("files") or {}) != set(files)
        ):
            raise ValueError("角色计划缓存清单不一致")
        resolved = {}
        for name in files:
            path = entry / name
            if (
                not path.is_file()
                or manifest["files"].get(name) != file_sha256(path)
            ):
                raise ValueError("角色计划缓存制品哈希不一致")
            resolved[name] = path
        return {"entry": entry, "files": resolved, "status": "reused"}
    except (FileNotFoundError, ValueError, OSError):
        archive_cache_entry(cache_root, entry, f"anime-avatar-plan-{kind}")
        return None


def commit_plan_bundle(
    cache_root: Path,
    kind: str,
    cache_key: str,
    sources: dict[str, Path],
) -> dict[str, Any]:
    entry = cache_root / "plans" / kind / cache_key[:24]
    entry.mkdir(parents=True, exist_ok=False)
    files = {}
    resolved = {}
    for name, source in sources.items():
        destination = entry / name
        shutil.copy2(source, destination)
        files[name] = file_sha256(destination)
        resolved[name] = destination
    write_json(
        entry / "manifest.json",
        {
            "protocol": "visual-multimedia-anime-avatar-plan-cache",
            "version": 1,
            "cache_key": cache_key,
            "files": files,
        },
    )
    return {"entry": entry, "files": resolved, "status": "generated"}


def run_segmented_avatar_pipeline(args: argparse.Namespace) -> dict[str, Any]:
    started_at = time.perf_counter()
    planning = args.command == "plan"
    project, paths = load_project(Path(args.project))
    plan_id = validate_task_id(args.plan_id)
    plan_path = resolve_project_path(
        paths["root"],
        Path("plans") / "anime-avatar" / plan_id / "render-plan.json",
        "角色计划",
    )
    if planning:
        if plan_path.exists():
            raise FileExistsError(f"不会覆盖已有 render-plan.json：{plan_path}")
        approved_plan = None
        task_id = plan_id
        timeline_path = Path(args.timeline).expanduser()
        if not timeline_path.is_absolute():
            timeline_path = paths["root"] / timeline_path
        timeline_path = timeline_path.resolve()
        working = paths["root"] / "working" / "anime-avatar-plans" / plan_id
        report_dir = None
        output = None
    else:
        approved_plan = read_json(plan_path)
        validate_render_plan_payload(approved_plan, require_confirmed=True)
        if approved_plan.get("plan_id") != plan_id:
            raise ValueError("--plan-id 与 render-plan.json 的 plan_id 不一致")
        task_id = validate_task_id(args.task_id or plan_id)
        timeline_path = resolve_portable_locator(
            approved_plan["inputs"]["speech_timeline"]["locator"],
            paths["root"],
        )
        working = paths["root"] / "working" / "anime-avatar" / task_id
        report_dir = paths["root"] / "reports" / "avatar-renders" / task_id
        output = resolve_project_path(paths["root"], args.output, "角色轨输出")
        if output.exists():
            raise FileExistsError(f"不会覆盖已有输出：{output}")
    for target, label in (
        (working, "working id"),
        *(([(report_dir, "report id")] if report_dir is not None else [])),
    ):
        if target.exists():
            raise FileExistsError(f"{label} 已存在，不会复用或覆盖：{target}")

    library_context = resolve_avatar_library(project, paths)
    package = library_context["package"]
    character = package["character"]
    motion_source = package["motion_source"]
    if package.get("status") != "registered":
        raise ValueError("项目内角色素材库尚未完成注册质量门，不能正式渲染")
    if character.get("master_status") != "confirmed":
        raise ValueError("角色母版尚未确认，不能正式渲染")
    if motion_source.get("status") != "accepted":
        raise ValueError("校准视频尚未通过检查，不能正式渲染")
    manifest = validate_media_manifest(paths["manifest"])
    timeline = read_json(timeline_path)
    speech_units = validate_timeline(timeline)
    _, audio_path = resolve_source(
        manifest,
        paths["root"],
        timeline.get("audio_source_id"),
        {"audio", "video", "generated"},
    )
    audio_record = next(
        item
        for item in manifest["sources"]
        if item["id"] == timeline["audio_source_id"]
    )
    if timeline["audio_sha256"] != audio_record["integrity"]["sha256"]:
        raise ValueError("speech timeline 的 audio_sha256 与素材账本不一致")

    render_config = project["render"]
    fps = int(render_config["internal_fps"])
    delivery_fps = int(render_config["delivery_fps"])
    if delivery_fps != fps:
        raise ValueError(
            "分段角色轨要求 delivery_fps 与 internal_fps 相同；"
            "最终成片帧率由通用视频时间线处理，角色轨不再整条补帧。"
        )
    master_size = tuple(int(value) for value in render_config["master_size"])
    width, height = master_size
    motion_path = library_context["motion_source_path"]
    crop = parse_xywh(
        motion_source.get("source_crop_xywh"),
        "motion_source.source_crop_xywh",
    )
    mouth_crop = parse_xywh(
        motion_source.get("mouth_review_crop_xywh"),
        "motion_source.mouth_review_crop_xywh",
    )
    ensure_crop(mouth_crop, crop[2], crop[3], "mouth_review_crop_xywh")
    ffmpeg = executable("ffmpeg", args.ffmpeg)
    ffprobe = executable("ffprobe", args.ffprobe)
    script_directory = Path(__file__).resolve().parent
    provenance_paths = {
        "avatar_project": paths["project"].resolve(),
        "media_sources": paths["manifest"].resolve(),
        "avatar_library_package": library_context["package_path"].resolve(),
        "avatar_library_media_sources": library_context["manifest_path"].resolve(),
        "motion_source": motion_path.resolve(),
        "audio_source": audio_path.resolve(),
        "renderer_script": script_directory / "render-anime-avatar.py",
        "motion_planner_script": script_directory / "anime_avatar_motion.py",
        "join_blender_script": script_directory / "anime_avatar_blend.py",
        "shared_avatar_runtime_script": script_directory / "anime_avatar_common.py",
        "visual_viseme_library": library_context["library_path"].resolve(),
        "speech_timeline": timeline_path,
    }
    provenance_sha256 = {
        key: file_sha256(path) for key, path in provenance_paths.items()
    }
    if approved_plan is not None:
        stale = {
            key: {
                "planned": approved_plan["inputs"].get(key, {}).get("sha256"),
                "current": digest,
            }
            for key, digest in provenance_sha256.items()
            if approved_plan["inputs"].get(key, {}).get("sha256") != digest
        }
        if stale:
            raise RuntimeError(
                "已确认 render-plan.json 的真实输入或生产代码已经变化："
                + json.dumps(stale, ensure_ascii=False)
            )

    working.mkdir(parents=True, exist_ok=False)
    if report_dir is not None:
        report_dir.mkdir(parents=True, exist_ok=False)
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
    project_cache = paths["root"] / "working" / "anime-avatar-cache" / "v1"
    project_cache.mkdir(parents=True, exist_ok=True)
    master = ensure_medium_master(
        ffmpeg,
        ffprobe,
        motion_path,
        crop,
        master_size,
        fps,
    )
    audio_master = ensure_audio_master(
        ffmpeg,
        audio_path,
        float(timeline["trim_start_seconds"]),
        (
            float(timeline["trim_end_seconds"])
            if timeline["trim_end_seconds"] is not None
            else None
        ),
        project_cache,
    )
    audio_duration = float(audio_master["duration_seconds"])
    if speech_units[-1].end > audio_duration + 0.08:
        raise ValueError("逐字时间轴越出连续音频母版")
    if planning:
        requested_duration = (
            float(args.duration_seconds)
            if args.duration_seconds is not None
            else audio_duration
        )
    else:
        requested_duration = float(approved_plan["execution"]["duration_seconds"])
        planned_master = approved_plan["master"]
        if (
            planned_master["cache_key"] != master["cache_key"]
            or planned_master["content_sha256"] != master["content_sha256"]
            or planned_master["manifest_sha256"] != master["manifest_sha256"]
        ):
            raise RuntimeError("已确认计划绑定的中等尺寸共享母版已经变化")
    if requested_duration <= 0 or requested_duration + 0.5 / fps < audio_duration:
        raise ValueError("目标角色轨时长必须覆盖完整连续音频母版")
    total_frames = int(math.ceil(requested_duration * fps - 1e-9))

    library = library_context["library"]
    expected_source_frame_count = int(library["source_frame_count"])
    source_labels, source_levels, source_takes = source_annotation(
        library,
        expected_source_frame_count,
    )
    source_frames = None
    sampler = None
    descriptors = None
    source_store_report = None

    def open_sampler() -> SourceFrameSampler:
        nonlocal source_frames, sampler, descriptors, source_store_report
        if sampler is not None:
            return sampler
        master_crop = (0, 0, width, height)
        master_mouth_crop = scaled_mouth_crop(mouth_crop, crop, master_size)
        source_frames, source_fps, descriptors, source_store_report = (
            build_disk_backed_source_store(
                master["path"],
                master_crop,
                master_mouth_crop,
                expected_source_frame_count,
                working / "source-frames-bgr-u8.bin",
            )
        )
        validation = validate_library_payload(
            library,
            source_id=motion_source["source_id"],
            source_fps=source_fps,
            source_frame_count=len(source_frames),
            source_crop=crop,
        )
        if not validation["ok"]:
            raise ValueError(
                "视觉口型库未通过共享母版消费者质量门：\n- "
                + "\n- ".join(validation["errors"])
            )
        sampler = SourceFrameSampler(source_frames, width, height)
        return sampler

    if planning:
        samples, sample_rate = read_wave(audio_master["path"])
        ranges = plan_unit_ranges(
            speech_units,
            total_frames,
            fps,
            float(render_config["target_unit_seconds"]),
            float(render_config["maximum_continuous_unit_seconds"]),
            float(render_config["split_silence_seconds"]),
        )
        plan_dir = plan_path.parent
        plan_dir.mkdir(parents=True, exist_ok=False)
        unit_payloads = []
        in_memory_schedules: list[dict[str, Any]] = []
        rejected_count = 0
        reused_unit_plan_count = 0
        generated_unit_plan_count = 0
        reused_seam_plan_count = 0
        generated_seam_plan_count = 0
        for index, (start_frame, end_frame) in enumerate(ranges, start=1):
            unit_id = f"avatar-{index:03d}"
            frame_count = end_frame - start_frame
            current_units = local_speech_units(
                speech_units,
                start_frame,
                end_frame,
                fps,
            )
            sample_start = int(round(start_frame * sample_rate / fps))
            sample_end = min(
                len(samples),
                int(round(end_frame * sample_rate / fps)),
            )
            current_samples = samples[sample_start:sample_end]
            events = build_phone_events(current_units)
            (
                target_labels,
                target_levels,
                energy,
                anchors,
                roles,
                phone_report,
            ) = build_target_timeline(
                current_units,
                events,
                current_samples,
                sample_rate,
                frame_count / fps,
                fps,
                frame_count,
            )
            local_input = {
                "start_frame": start_frame,
                "end_frame_exclusive": end_frame,
                "speech": [
                    {
                        "text": item.text,
                        "start_seconds": round(item.start, 9),
                        "end_seconds": round(item.end, 9),
                    }
                    for item in current_units
                ],
                "audio_pcm_sha256": hashlib.sha256(
                    np.asarray(current_samples, dtype=np.float32).tobytes()
                ).hexdigest(),
            }
            local_input_sha256 = canonical_json_sha256(local_input)
            target_timeline_sha256 = canonical_json_sha256(
                {
                    "target_labels": list(target_labels),
                    "target_levels": np.asarray(
                        target_levels,
                        dtype=np.float32,
                    ).tolist(),
                    "energy": np.asarray(energy, dtype=np.float32).tolist(),
                    "anchors": list(anchors),
                    "roles": list(roles),
                }
            )
            unit_dir = plan_dir / "units" / unit_id
            schedule_path = unit_dir / "schedule.npz"
            diagnostics_path = unit_dir / "diagnostics.json"
            plan_cache_key = canonical_json_sha256(
                {
                    "version": "anime-avatar-unit-plan-v2",
                    "target_timeline_sha256": target_timeline_sha256,
                    "master_sha256": master["content_sha256"],
                    "library_sha256": provenance_sha256[
                        "visual_viseme_library"
                    ],
                    "motion_planner_sha256": provenance_sha256[
                        "motion_planner_script"
                    ],
                    "fps": fps,
                }
            )
            cached_plan = cached_plan_bundle(
                project_cache,
                "units",
                plan_cache_key,
                ("schedule.npz", "diagnostics.json"),
            )
            unit_dir.mkdir(parents=True, exist_ok=False)
            if cached_plan is not None:
                reused_unit_plan_count += 1
                shutil.copy2(
                    cached_plan["files"]["schedule.npz"], schedule_path
                )
                schedule_payload = load_schedule_artifact(
                    artifact_record(schedule_path, paths["root"]),
                    paths["root"],
                )
                source_positions = schedule_payload["source_positions"]
                boundaries = [
                    int(value) for value in schedule_payload["boundaries"].tolist()
                ]
                target_labels = [
                    str(value) for value in schedule_payload["target_labels"].tolist()
                ]
                target_levels = schedule_payload["target_levels"]
                energy = schedule_payload["energy"]
                anchors = [
                    str(value) if str(value) else None
                    for value in schedule_payload["anchors"].tolist()
                ]
                roles = [
                    str(value) for value in schedule_payload["roles"].tolist()
                ]
                diagnostic_payload = read_json(
                    cached_plan["files"]["diagnostics.json"]
                )
                selection = diagnostic_payload["selection"]
                joins = diagnostic_payload["joins"]
                machine_gate = diagnostic_payload["machine_gate"]
                write_json(
                    diagnostics_path,
                    {
                        "protocol": (
                            "visual-multimedia-anime-avatar-unit-diagnostics"
                        ),
                        "version": 1,
                        "unit_id": unit_id,
                        "local_input": local_input,
                        "phone_events": phone_report,
                        "selection": selection,
                        "joins": joins,
                        "machine_gate": machine_gate,
                    },
                )
            else:
                generated_unit_plan_count += 1
                plan_sampler = open_sampler()
                assert descriptors is not None
                (
                    source_positions,
                    boundaries,
                    selection,
                ) = plan_gesture_motion(
                    library,
                    source_labels,
                    source_levels,
                    source_takes,
                    descriptors,
                    target_labels,
                    target_levels,
                    anchors,
                    roles,
                    fps=fps,
                    sequence_seed=int(target_timeline_sha256[:8], 16),
                )
                machine_gate = plan_selection_gate(selection)
                preflight = preflight_output_resolution_join_windows(
                    plan_sampler,
                    source_positions,
                    boundaries,
                    {},
                )
                joins = join_records(selection, preflight)
                write_schedule_artifact(
                    schedule_path,
                    source_positions=source_positions,
                    boundaries=boundaries,
                    target_labels=target_labels,
                    target_levels=target_levels,
                    energy=energy,
                    anchors=anchors,
                    roles=roles,
                )
                write_json(
                    diagnostics_path,
                    {
                        "protocol": (
                            "visual-multimedia-anime-avatar-unit-diagnostics"
                        ),
                        "version": 1,
                        "unit_id": unit_id,
                        "local_input": local_input,
                        "phone_events": phone_report,
                        "selection": selection,
                        "joins": joins,
                        "machine_gate": machine_gate,
                    },
                )
                commit_plan_bundle(
                    project_cache,
                    "units",
                    plan_cache_key,
                    {
                        "schedule.npz": schedule_path,
                        "diagnostics.json": diagnostics_path,
                    },
                )
            rejected = sum(item["category"] == "rejected" for item in joins)
            rejected_count += rejected
            schedule_record = artifact_record(schedule_path, paths["root"])
            diagnostics_record = artifact_record(diagnostics_path, paths["root"])
            render_instructions_sha256 = canonical_json_sha256(
                {
                    "joins": render_join_instruction_records(joins),
                }
            )
            render_schedule_sha256 = canonical_json_sha256(
                {
                    "source_positions": np.asarray(
                        source_positions,
                        dtype=np.float32,
                    ).tolist(),
                    "boundaries": [int(value) for value in boundaries],
                }
            )
            cache_key = canonical_json_sha256(
                {
                    "version": UNIT_CACHE_VERSION,
                    "kind": "unit-core",
                    "master_sha256": master["content_sha256"],
                    "render_schedule_sha256": render_schedule_sha256,
                    "render_instructions_sha256": (
                        render_instructions_sha256
                    ),
                    "fps": fps,
                    "master_size": list(master_size),
                }
            )
            unit_payloads.append(
                {
                    "id": unit_id,
                    "order": index,
                    "start_frame": start_frame,
                    "end_frame_exclusive": end_frame,
                    "frame_count": frame_count,
                    "local_input_sha256": local_input_sha256,
                    "render_instructions_sha256": (
                        render_instructions_sha256
                    ),
                    "render_schedule_sha256": render_schedule_sha256,
                    "schedule": schedule_record,
                    "diagnostics": diagnostics_record,
                    "internal_seams": {
                        "count": len(boundaries),
                        "rejected": rejected,
                    },
                    "cache_key": cache_key,
                }
            )
            in_memory_schedules.append(
                {
                    "positions": np.asarray(source_positions, dtype=np.float32),
                    "target_labels": target_labels,
                    "target_levels": target_levels,
                    "energy": energy,
                    "anchors": anchors,
                    "roles": roles,
                    "boundaries": boundaries,
                }
            )
        seam_payloads = []
        for index in range(len(unit_payloads) - 1):
            left = unit_payloads[index]
            right = unit_payloads[index + 1]
            seam_id = f"{left['id']}--{right['id']}"
            seam_path = plan_dir / "seams" / f"{seam_id}.json"
            seam_plan_key = canonical_json_sha256(
                {
                    "version": "anime-avatar-seam-plan-v1",
                    "master_sha256": master["content_sha256"],
                    "left_schedule_sha256": left["schedule"]["sha256"],
                    "right_schedule_sha256": right["schedule"]["sha256"],
                    "join_blender_sha256": provenance_sha256[
                        "join_blender_script"
                    ],
                    "fps": fps,
                }
            )
            cached_seam = cached_plan_bundle(
                project_cache,
                "seams",
                seam_plan_key,
                ("seam.json",),
            )
            seam_path.parent.mkdir(parents=True, exist_ok=True)
            if cached_seam is not None:
                reused_seam_plan_count += 1
                shutil.copy2(cached_seam["files"]["seam.json"], seam_path)
                report = read_json(seam_path)["report"]
            else:
                generated_seam_plan_count += 1
                combined = np.concatenate(
                    [
                        in_memory_schedules[index]["positions"][-2:],
                        in_memory_schedules[index + 1]["positions"][:2],
                    ]
                )
                report = preflight_output_resolution_join_windows(
                    open_sampler(),
                    combined,
                    [2],
                    {},
                )[0]
                write_json(
                    seam_path,
                    {
                        "protocol": "visual-multimedia-anime-avatar-unit-seam",
                        "version": 1,
                        "id": seam_id,
                        "report": report,
                    },
                )
                commit_plan_bundle(
                    project_cache,
                    "seams",
                    seam_plan_key,
                    {"seam.json": seam_path},
                )
            status = "ready" if report.get("applied") is True else "rejected"
            if status == "rejected":
                rejected_count += 1
            seam_record = artifact_record(seam_path, paths["root"])
            seam_payloads.append(
                {
                    "id": seam_id,
                    "left_unit_id": left["id"],
                    "right_unit_id": right["id"],
                    "boundary_frame": left["end_frame_exclusive"],
                    "artifact": seam_record,
                    "cache_key": canonical_json_sha256(
                        {
                            "version": UNIT_CACHE_VERSION,
                            "kind": "seam-bridge",
                            "master_sha256": master["content_sha256"],
                            "left_schedule_sha256": left["schedule"]["sha256"],
                            "right_schedule_sha256": right["schedule"]["sha256"],
                            "artifact_sha256": seam_record["sha256"],
                            "fps": fps,
                            "master_size": list(master_size),
                        }
                    ),
                    "status": status,
                }
            )
        plan_status = "ready" if rejected_count == 0 else "rejected"
        render_plan = {
            "protocol": "visual-multimedia-anime-avatar-render-plan",
            "version": 3,
            "status": plan_status,
            "plan_id": plan_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "inputs": {
                key: {
                    "locator": portable_locator(path, paths["root"]),
                    "sha256": provenance_sha256[key],
                }
                for key, path in provenance_paths.items()
            },
            "library_capabilities": {
                "resource": {
                    "id": package["id"],
                    "version": package["library_version"],
                },
                "facts": {
                    "dynamic_closed_idle": package["capabilities"][
                        "dynamic_closed_idle"
                    ],
                    "whole_frame": package["capabilities"]["whole_frame"],
                    "visemes": package["capabilities"]["visemes"],
                },
            },
            "execution": {
                "duration_seconds": round(requested_duration, 9),
                "audio_duration_seconds": round(audio_duration, 9),
                "internal_fps": fps,
                "delivery_fps": delivery_fps,
                "master_size": list(master_size),
            },
            "master": {
                "cache_key": master["cache_key"],
                "content_sha256": master["content_sha256"],
                "manifest_sha256": master["manifest_sha256"],
                "width": width,
                "height": height,
                "fps": float(master["probe"]["fps"]),
            },
            "units": unit_payloads,
            "seams": seam_payloads,
            "summary": {
                "unit_count": len(unit_payloads),
                "seam_bridge_count": len(seam_payloads),
                "rejected_seam_count": rejected_count,
                "generated_unit_plan_count": generated_unit_plan_count,
                "reused_unit_plan_count": reused_unit_plan_count,
                "generated_seam_plan_count": generated_seam_plan_count,
                "reused_seam_plan_count": reused_seam_plan_count,
                "target_unit_seconds": float(
                    render_config["target_unit_seconds"]
                ),
                "maximum_continuous_unit_seconds": float(
                    render_config["maximum_continuous_unit_seconds"]
                ),
                "split_silence_seconds": float(
                    render_config["split_silence_seconds"]
                ),
                "speech_safe_boundaries_only": True,
                "per_frame_arrays_externalized": True,
                "local_invalidation": (
                    "changed unit core plus adjacent two-frame seam bridges"
                ),
            },
            "approval": {
                "status": "pending",
                "confirmed_at": None,
                "approved_plan_sha256": None,
            },
        }
        write_json(plan_path, render_plan)
        if sampler is not None:
            sampler.close()
        validate_render_plan_payload(render_plan, require_confirmed=False)
        if plan_status == "rejected":
            raise RuntimeError(
                f"分段角色计划含 {rejected_count} 个未通过接缝，不能确认"
            )
        return {
            "ok": True,
            "status": "ready",
            "plan_id": plan_id,
            "render_plan": str(plan_path),
            "master": {
                "size": list(master_size),
                "status": master["status"],
                "cache_key": master["cache_key"],
            },
            "unit_count": len(unit_payloads),
            "seam_bridge_count": len(seam_payloads),
            "generated_unit_plans": generated_unit_plan_count,
            "reused_unit_plans": reused_unit_plan_count,
            "generated_seam_plans": generated_seam_plan_count,
            "reused_seam_plans": reused_seam_plan_count,
            "plan_seconds": round(time.perf_counter() - started_at, 3),
            "next": "检查分段摘要和接缝制品，确认后运行 confirm-plan。",
        }

    assert approved_plan is not None
    assert output is not None
    assert report_dir is not None
    units = approved_plan["units"]
    schedules = [
        load_schedule_artifact(unit["schedule"], paths["root"])
        for unit in units
    ]
    diagnostics = []
    for unit in units:
        diagnostics_path = resolve_portable_locator(
            unit["diagnostics"]["locator"], paths["root"]
        )
        if file_sha256(diagnostics_path) != unit["diagnostics"]["sha256"]:
            raise RuntimeError(f"角色诊断制品哈希不一致：{diagnostics_path}")
        diagnostics.append(read_json(diagnostics_path))
    seam_artifacts = []
    for seam in approved_plan["seams"]:
        seam_path = resolve_portable_locator(
            seam["artifact"]["locator"], paths["root"]
        )
        if file_sha256(seam_path) != seam["artifact"]["sha256"]:
            raise RuntimeError(f"角色接缝制品哈希不一致：{seam_path}")
        seam_artifacts.append(read_json(seam_path))

    core_results: list[dict[str, Any] | None] = []
    for index, unit in enumerate(units):
        frame_count = unit["frame_count"] - (1 if index else 0) - (
            1 if index < len(units) - 1 else 0
        )
        core_results.append(
            cached_segment(
                project_cache,
                "units",
                unit["cache_key"],
                ffprobe,
                width,
                height,
                fps,
                frame_count,
            )
        )
    seam_results: list[dict[str, Any] | None] = []
    for seam in approved_plan["seams"]:
        seam_results.append(
            cached_segment(
                project_cache,
                "seams",
                seam["cache_key"],
                ffprobe,
                width,
                height,
                fps,
                2,
            )
        )
    cache_inspected_at = time.perf_counter()
    if any(item is None for item in core_results + seam_results):
        render_sampler = open_sampler()
        for index, (unit, schedule, diagnostic) in enumerate(
            zip(units, schedules, diagnostics, strict=True)
        ):
            if core_results[index] is not None:
                continue
            trim_left = 1 if index else 0
            trim_right = 1 if index < len(units) - 1 else 0
            positions = np.asarray(schedule["source_positions"], dtype=np.float32)
            end = len(positions) - trim_right if trim_right else len(positions)
            core_positions = positions[trim_left:end]
            original_boundaries = [
                int(value) for value in schedule["boundaries"].tolist()
            ]
            boundaries = [
                value - trim_left
                for value in original_boundaries
                if trim_left < value < end
            ]
            reports = [
                copy.deepcopy(item["preflight"])
                for item in diagnostic["joins"]
                if item["category"] == "ready"
                and trim_left < int(item["output_frame"]) < end
            ]
            reports = shifted_join_reports(reports, trim_left)
            if any(
                boundary < 2 or boundary + 1 >= len(core_positions)
                for boundary in boundaries
            ):
                raise RuntimeError(
                    f"{unit['id']} 的内部接缝贴近分段桥；请调整分段边界"
                )
            pending = working / f"{unit['id']}.core.mp4"
            encode_silent_stream(
                ffmpeg,
                render_sampler,
                core_positions,
                boundaries,
                reports,
                fps,
                pending,
            )
            core_results[index] = commit_segment_cache(
                project_cache,
                "units",
                unit["cache_key"],
                pending,
                len(core_positions),
            )
        for index, seam in enumerate(approved_plan["seams"]):
            if seam_results[index] is not None:
                continue
            combined = np.concatenate(
                [
                    schedules[index]["source_positions"][-2:],
                    schedules[index + 1]["source_positions"][:2],
                ]
            ).astype(np.float32)
            frames = [
                render_sampler.sample(float(position)) for position in combined
            ]
            report = blend_compatible_join_window_in_place(frames, 2)
            planned_report = seam_artifacts[index]["report"]
            if (
                report.get("applied") is not True
                or [frame_sha256(frame) for frame in frames]
                != planned_report.get("preflight_blended_window_sha256")
            ):
                raise RuntimeError(f"{seam['id']} 无法复现已确认的两帧接缝桥")
            bridge_frames = [frames[1], frames[2]]
            pending = working / f"{seam['id']}.bridge.mp4"
            encode_frame_sequence(ffmpeg, bridge_frames, fps, pending)
            seam_results[index] = commit_segment_cache(
                project_cache,
                "seams",
                seam["cache_key"],
                pending,
                2,
            )
    if sampler is not None:
        sampler.close()
    completed_cores = [item for item in core_results if item is not None]
    completed_seams = [item for item in seam_results if item is not None]
    if len(completed_cores) != len(units) or len(completed_seams) != len(
        approved_plan["seams"]
    ):
        raise RuntimeError("角色分段缓存构建没有完整闭合")
    segments: list[Path] = []
    for index, item in enumerate(completed_cores):
        segments.append(item["video"])
        if index < len(completed_seams):
            segments.append(completed_seams[index]["video"])
    silent_assembled = working / "avatar-track-silent.mp4"
    concat_segments(
        ffmpeg,
        segments,
        working / "segments.ffconcat",
        silent_assembled,
    )
    video_duration = total_frames / fps
    mux_audio(
        ffmpeg,
        silent_assembled,
        audio_master["path"],
        output,
        video_duration,
    )
    output_probe = probe_video(output, ffprobe)
    if (
        output_probe["width"] != width
        or output_probe["height"] != height
        or abs(float(output_probe["fps"]) - fps) > 0.02
        or int(output_probe["declared_frame_count"]) != total_frames
    ):
        raise RuntimeError("最终角色轨尺寸、帧率或帧数与确认计划不一致")
    global_positions = np.concatenate(
        [schedule["source_positions"] for schedule in schedules]
    ).astype(np.float32)
    global_labels = [
        str(value)
        for schedule in schedules
        for value in schedule["target_labels"].tolist()
    ]
    global_levels = np.concatenate(
        [schedule["target_levels"] for schedule in schedules]
    ).astype(np.float32)
    global_boundaries = []
    for unit, schedule in zip(units, schedules, strict=True):
        global_boundaries.extend(
            unit["start_frame"] + int(value)
            for value in schedule["boundaries"].tolist()
        )
    global_boundaries.extend(
        int(seam["boundary_frame"]) for seam in approved_plan["seams"]
    )
    review_outputs = save_render_review_from_video(
        report_dir,
        output,
        global_positions,
        sorted(set(global_boundaries)),
        global_labels,
        global_levels,
        source_labels,
        source_levels,
        fps,
        delivery_fps,
    )
    unit_results = []
    for index, (unit, result) in enumerate(zip(units, completed_cores, strict=True)):
        unit_results.append(
            {
                "id": unit["id"],
                "start_frame": unit["start_frame"],
                "end_frame_exclusive": unit["end_frame_exclusive"],
                "cache_key": unit["cache_key"],
                "status": result["status"],
                "content_sha256": result["content_sha256"],
                "adjacent_seam_ids": [
                    seam["id"]
                    for seam in approved_plan["seams"]
                    if seam["left_unit_id"] == unit["id"]
                    or seam["right_unit_id"] == unit["id"]
                ],
            }
        )
    clip_records = []
    track_clip_root = report_dir / "track-clips"
    for index, (unit, result) in enumerate(
        zip(units, completed_cores, strict=True)
    ):
        start_frame = unit["start_frame"] + (1 if index else 0)
        duration_frames = unit["frame_count"] - (1 if index else 0) - (
            1 if index < len(units) - 1 else 0
        )
        core_file = materialize_track_clip(
            result["video"],
            track_clip_root / f"{unit['id']}-core.mp4",
        )
        clip_records.append(
            {
                "id": f"{unit['id']}-core",
                "kind": "unit-core",
                "timeline_start_frame": start_frame,
                "duration_frames": duration_frames,
                "file": core_file.resolve().relative_to(paths["root"]).as_posix(),
                "sha256": result["content_sha256"],
            }
        )
        if index < len(completed_seams):
            seam = approved_plan["seams"][index]
            seam_result = completed_seams[index]
            seam_file = materialize_track_clip(
                seam_result["video"],
                track_clip_root / f"{seam['id']}.mp4",
            )
            clip_records.append(
                {
                    "id": seam["id"],
                    "kind": "seam-bridge",
                    "timeline_start_frame": seam["boundary_frame"] - 1,
                    "duration_frames": 2,
                    "file": seam_file.resolve().relative_to(
                        paths["root"]
                    ).as_posix(),
                    "sha256": seam_result["content_sha256"],
                }
            )
    expected_cursor = 0
    for record in sorted(
        clip_records, key=lambda item: item["timeline_start_frame"]
    ):
        if record["timeline_start_frame"] != expected_cursor:
            raise RuntimeError("角色分段交接清单没有连续覆盖完整时间线")
        expected_cursor += record["duration_frames"]
    if expected_cursor != total_frames:
        raise RuntimeError("角色分段交接清单的总帧数与计划不一致")
    track_audio = materialize_track_clip(
        audio_master["path"],
        track_clip_root / "continuous-audio.wav",
    )
    track_clips_path = report_dir / "avatar-track-clips.json"
    write_json(
        track_clips_path,
        {
            "protocol": "visual-multimedia-anime-avatar-track-clips",
            "version": 1,
            "fps": fps,
            "width": width,
            "height": height,
            "duration_frames": total_frames,
            "clips": sorted(
                clip_records, key=lambda item: item["timeline_start_frame"]
            ),
            "audio": {
                "timeline_start_frame": 0,
                "duration_frames": total_frames,
                "file": track_audio.resolve().relative_to(paths["root"]).as_posix(),
                "sha256": audio_master["content_sha256"],
            },
        },
    )
    report = {
        "protocol": "visual-multimedia-anime-avatar-render",
        "version": 4,
        "task_id": task_id,
        "run_id": uuid.uuid4().hex,
        "approved_render_plan": {
            "path": str(plan_path),
            "approved_plan_sha256": approved_plan["approval"][
                "approved_plan_sha256"
            ],
            "input_hashes_revalidated": True,
            "runtime_replanning": False,
        },
        "master": {
            "size": list(master_size),
            "cache_key": master["cache_key"],
            "status": master["status"],
            "content_sha256": master["content_sha256"],
        },
        "continuous_audio_master": {
            "cache_key": audio_master["cache_key"],
            "status": audio_master["status"],
            "content_sha256": audio_master["content_sha256"],
            "mux_count": 1,
        },
        "track_clips": {
            "path": str(track_clips_path),
            "sha256": file_sha256(track_clips_path),
            "consumer_boundary": (
                "ordinary video and interview video timelines import each clip "
                "as a normal aligned visual asset"
            ),
        },
        "units": unit_results,
        "seams": [
            {
                "id": seam["id"],
                "cache_key": seam["cache_key"],
                "status": result["status"],
                "content_sha256": result["content_sha256"],
                "frame_count": 2,
            }
            for seam, result in zip(
                approved_plan["seams"], completed_seams, strict=True
            )
        ],
        "assembly": {
            "visual_strategy": "stream-copy ordered unit cores and two-frame seam bridges",
            "audio_strategy": "one continuous master mux",
            "output": str(output),
            "output_sha256": file_sha256(output),
            "probe": output_probe,
        },
        "performance": {
            "cache_inspection_seconds": round(cache_inspected_at - started_at, 3),
            "total_seconds": round(time.perf_counter() - started_at, 3),
            "rendered_unit_count": sum(
                item["status"] == "rendered" for item in completed_cores
            ),
            "reused_unit_count": sum(
                item["status"] == "reused" for item in completed_cores
            ),
            "rendered_seam_count": sum(
                item["status"] == "rendered" for item in completed_seams
            ),
            "reused_seam_count": sum(
                item["status"] == "reused" for item in completed_seams
            ),
        },
        "review_artifacts": review_outputs,
        "human_full_review": {
            "required": True,
            "completed": False,
            "checks": [
                "完整观看口型、闭嘴待机和单元接缝",
                "确认长静音没有机械重启同一段动作",
                "确认角色身份、头发、耳朵、饰品和肩部连续",
            ],
        },
    }
    report_path = report_dir / "render-report.json"
    write_json(report_path, report)
    return {
        "ok": True,
        "task_id": task_id,
        "output": str(output),
        "report": str(report_path),
        "master_size": list(master_size),
        "unit_count": len(units),
        "rendered_units": report["performance"]["rendered_unit_count"],
        "reused_units": report["performance"]["reused_unit_count"],
        "total_seconds": report["performance"]["total_seconds"],
        "review_artifacts": review_outputs,
        "next": "验收联系表和完整角色轨后，再作为普通视频时间线的分段覆盖轨使用。",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "先生成并确认显式接缝计划，再从该唯一计划合成普通话"
            "二次元口播视频。"
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser(
        "plan",
        help="一次性规划动作路线并预检全部接缝，写出 render-plan.json",
    )
    plan_parser.add_argument("--project", required=True)
    plan_parser.add_argument("--timeline", required=True)
    plan_parser.add_argument("--plan-id", required=True)
    plan_parser.add_argument(
        "--duration-seconds",
        type=float,
        help=(
            "最终角色轨时长；省略时匹配裁切音频。长于音频的实际时间线按无声区间动态待机，不自动添加固定尾段"
        ),
    )
    plan_parser.add_argument("--ffmpeg")
    plan_parser.add_argument("--ffprobe")

    confirm_parser = subparsers.add_parser(
        "confirm-plan",
        help="确认已经检查过且没有拒绝接缝的 render-plan.json",
    )
    confirm_parser.add_argument("--project", required=True)
    confirm_parser.add_argument("--plan-id", required=True)

    render_parser = subparsers.add_parser(
        "render",
        help="只消费已确认且输入哈希仍有效的 render-plan.json 进行编码",
    )
    render_parser.add_argument("--project", required=True)
    render_parser.add_argument("--plan-id", required=True)
    render_parser.add_argument("--output", required=True)
    render_parser.add_argument("--task-id")
    render_parser.add_argument("--ffmpeg")
    render_parser.add_argument("--ffprobe")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = (
        confirm_render_plan(args)
        if args.command == "confirm-plan"
        else run_segmented_avatar_pipeline(args)
    )
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

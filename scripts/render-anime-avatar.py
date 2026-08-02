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
    resolve_source,
    validate_library_payload,
    validate_media_manifest,
    write_json,
)
from anime_avatar_motion import plan_gesture_motion


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
        "target_timeline",
        "source_schedule",
        "selection",
        "joins",
        "deterministic_seam_plan",
        "approval",
    }
    if set(payload) != expected_fields:
        errors.append("顶层字段不完整或含未知字段")
    if payload.get("protocol") != "visual-multimedia-anime-avatar-render-plan":
        errors.append(
            "protocol 必须是 visual-multimedia-anime-avatar-render-plan"
        )
    if payload.get("version") != 2:
        errors.append("version 必须是 2")
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
    source_schedule = payload.get("source_schedule")
    if not isinstance(source_schedule, dict):
        errors.append("source_schedule 必须是对象")
        source_schedule = {}
    positions = source_schedule.get("source_position_by_internal_frame")
    boundaries = source_schedule.get("boundaries")
    if (
        not isinstance(positions, list)
        or not positions
        or any(
            isinstance(value, bool) or not isinstance(value, (int, float))
            for value in positions
        )
    ):
        errors.append(
            "source_schedule.source_position_by_internal_frame 必须是非空数字数组"
        )
    if (
        not isinstance(boundaries, list)
        or any(
            isinstance(value, bool) or not isinstance(value, int)
            for value in boundaries
        )
    ):
        errors.append("source_schedule.boundaries 必须是整数数组")
        boundaries = []
    joins = payload.get("joins")
    if not isinstance(joins, list):
        errors.append("joins 必须是数组")
        joins = []
    allowed_categories = {
        "original_source_continuity",
        "strict_optical_flow",
        "micro_optical_flow",
        "rejected",
    }
    categories = [
        item.get("category")
        for item in joins
        if isinstance(item, dict)
    ]
    if (
        len(categories) != len(joins)
        or any(category not in allowed_categories for category in categories)
    ):
        errors.append("joins.category 存在未知接缝类型")
    boundary_join_frames = sorted(
        int(item["output_frame"])
        for item in joins
        if (
            isinstance(item, dict)
            and item.get("category") != "original_source_continuity"
            and isinstance(item.get("output_frame"), int)
        )
    )
    if sorted(boundaries) != boundary_join_frames:
        errors.append("joins 中的非原片连续接缝与 source_schedule.boundaries 不一致")
    deterministic = payload.get("deterministic_seam_plan")
    if not isinstance(deterministic, dict):
        errors.append("deterministic_seam_plan 必须是对象")
    else:
        expected_counts = {
            "original_source_continuity_count": categories.count(
                "original_source_continuity"
            ),
            "strict_optical_flow_join_count": categories.count(
                "strict_optical_flow"
            ),
            "micro_optical_flow_transition_count": categories.count(
                "micro_optical_flow"
            ),
            "rejected_join_count": categories.count("rejected"),
        }
        for key, expected in expected_counts.items():
            if deterministic.get(key) != expected:
                errors.append(f"deterministic_seam_plan.{key} 计数不一致")
        if deterministic.get("route_retry_count") != 0:
            errors.append("deterministic_seam_plan.route_retry_count 必须是 0")
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
    plan_path = Path(args.render_plan).expanduser().resolve()
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


def run_avatar_pipeline(args: argparse.Namespace) -> dict[str, Any]:
    planning = args.command == "plan"
    approved_plan: dict[str, Any] | None = None
    render_plan_path = Path(args.render_plan).expanduser().resolve()
    if planning:
        if render_plan_path.exists():
            raise FileExistsError(
                f"不会覆盖已有 render-plan.json：{render_plan_path}"
            )
        project_argument = Path(args.project)
        plan_id = validate_task_id(args.plan_id or render_plan_path.parent.name)
        task_id = plan_id
    else:
        approved_plan = read_json(render_plan_path)
        validate_render_plan_payload(approved_plan, require_confirmed=True)
        project_argument = Path(args.project)
        task_id = validate_task_id(
            args.task_id or str(approved_plan["plan_id"])
        )

    project, paths = load_project(project_argument)
    if planning:
        timeline_path = Path(args.timeline).expanduser()
        if not timeline_path.is_absolute():
            timeline_path = paths["root"] / timeline_path
        timeline_path = timeline_path.resolve()
    else:
        assert approved_plan is not None
        timeline_record = approved_plan["inputs"]["speech_timeline"]
        timeline_path = resolve_portable_locator(
            timeline_record["locator"],
            paths["root"],
        )
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
    if planning:
        working = (
            paths["root"] / "working" / "anime-avatar-plans" / task_id
        )
        report_dir = None
        output = None
        immutable_directories = ((working, "planning plan-id"),)
    else:
        working = paths["root"] / "working" / "anime-avatar" / task_id
        report_dir = (
            paths["root"] / "reports" / "avatar-renders" / task_id
        )
        output = Path(args.output).expanduser().resolve()
        if output.exists():
            raise FileExistsError(f"不会覆盖已有输出：{output}")
        immutable_directories = (
            (working, "working task-id"),
            (report_dir, "report task-id"),
        )
    for immutable_directory, label in immutable_directories:
        if immutable_directory.exists():
            raise FileExistsError(
                f"{label} 已存在，不会复用或覆盖：{immutable_directory}；"
                "请使用新的 id"
            )

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

    library_file = library_context["library_path"]
    library = library_context["library"]
    raw_source_frame_count = library.get("source_frame_count")
    if (
        isinstance(raw_source_frame_count, bool)
        or not isinstance(raw_source_frame_count, int)
        or raw_source_frame_count <= 0
    ):
        raise ValueError("视觉口型库 source_frame_count 必须是正整数")
    expected_source_frame_count = int(raw_source_frame_count)

    render_config = project["render"]
    fps = int(render_config["internal_fps"])
    delivery_fps = int(render_config["delivery_fps"])
    width, height = [int(value) for value in render_config["output_size"]]

    timeline = read_json(timeline_path)
    units = validate_timeline(timeline)
    audio_record, audio_path = resolve_source(
        manifest,
        paths["root"],
        timeline.get("audio_source_id"),
        {"audio", "video", "generated"},
    )
    if timeline["audio_sha256"] != audio_record["integrity"]["sha256"]:
        raise ValueError(
            "speech timeline 的 audio_sha256 与项目素材账本中的真实音频不一致"
        )
    ffmpeg = executable("ffmpeg", args.ffmpeg)
    ffprobe = executable("ffprobe", args.ffprobe)

    run_id = uuid.uuid4().hex
    trimmed_audio = working / "trimmed-audio.wav"
    source_frame_store_file = working / "source-frames-bgr-u8.bin"
    silent_video = working / "motion-match-silent.mp4"
    motion_match_video = working / "motion-match-with-audio.mp4"
    script_directory = Path(__file__).resolve().parent
    provenance_paths = {
        "avatar_project": paths["project"].resolve(),
        "media_sources": paths["manifest"].resolve(),
        "avatar_library_package": library_context["package_path"].resolve(),
        "avatar_library_media_sources": (
            library_context["manifest_path"].resolve()
        ),
        "motion_source": motion_path.resolve(),
        "audio_source": audio_path.resolve(),
        "renderer_script": script_directory / "render-anime-avatar.py",
        "motion_planner_script": script_directory / "anime_avatar_motion.py",
        "join_blender_script": script_directory / "anime_avatar_blend.py",
        "shared_avatar_runtime_script": (
            script_directory / "anime_avatar_common.py"
        ),
        "visual_viseme_library": library_file.resolve(),
        "speech_timeline": timeline_path,
    }
    provenance_sha256 = {
        key: file_sha256(path) for key, path in provenance_paths.items()
    }
    if approved_plan is not None:
        stale_inputs = {}
        planned_inputs = approved_plan.get("inputs") or {}
        for key, current_sha256 in provenance_sha256.items():
            planned = planned_inputs.get(key)
            planned_sha256 = (
                planned.get("sha256") if isinstance(planned, dict) else None
            )
            if planned_sha256 != current_sha256:
                stale_inputs[key] = {
                    "planned_sha256": planned_sha256,
                    "current_sha256": current_sha256,
                }
        if stale_inputs:
            raise RuntimeError(
                "已确认 render-plan.json 已失效；以下输入或代码在规划后发生变化："
                + json.dumps(stale_inputs, ensure_ascii=False)
            )
        provenance_paths["approved_render_plan"] = render_plan_path
        provenance_sha256["approved_render_plan"] = file_sha256(
            render_plan_path
        )
    working.mkdir(parents=True, exist_ok=False)
    if report_dir is not None:
        report_dir.mkdir(parents=True, exist_ok=False)
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)

    source_frames, source_fps, descriptors, source_store_report = (
        build_disk_backed_source_store(
            motion_path,
            crop,
            mouth_crop,
            expected_source_frame_count,
            source_frame_store_file,
        )
    )
    library_validation = validate_library_payload(
        library,
        source_id=motion_source["source_id"],
        source_fps=source_fps,
        source_frame_count=len(source_frames),
        source_crop=crop,
    )
    if not library_validation["ok"]:
        raise ValueError(
            "视觉口型库未通过质量门：\n- "
            + "\n- ".join(library_validation["errors"])
        )
    if abs(source_fps - fps) > 0.02:
        raise ValueError(
            f"校准视频为 {source_fps:.6f} fps，但项目 internal_fps={fps}。"
            "先统一帧率和标注边界，不能在运行时静默换算帧号。"
        )

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
    if planning:
        requested_duration = (
            float(args.duration_seconds)
            if args.duration_seconds is not None
            else audio_duration
        )
    else:
        assert approved_plan is not None
        requested_duration = float(
            approved_plan["execution"]["duration_seconds"]
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
    if planning:
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
    else:
        assert approved_plan is not None
        planned_target = approved_plan["target_timeline"]
        target_labels = list(planned_target["visemes"])
        target_levels = np.asarray(
            planned_target["intensities"],
            dtype=np.float32,
        )
        energy = np.asarray(planned_target["energy"], dtype=np.float32)
        anchors = list(planned_target["anchors"])
        roles = list(planned_target["roles"])
        phone_report = list(planned_target["phone_events"])
        target_lengths = {
            len(target_labels),
            len(target_levels),
            len(energy),
            len(anchors),
            len(roles),
        }
        if target_lengths != {requested_internal_frames}:
            raise ValueError(
                "render-plan.json 的目标时间线数组长度与计划时长不一致"
            )

    source_labels, source_levels, source_takes = source_annotation(
        library,
        len(source_frames),
    )
    silent_intervals = [
        {
            "start_frame": start,
            "end_frame_exclusive": end,
            "start_seconds": round(start / fps, 6),
            "end_seconds": round(end / fps, 6),
            "behavior": "continuous closed-mouth source motion",
        }
        for start, end, role in label_runs(roles)
        if role == "silence"
    ]
    join_preflight_cache: dict[tuple[int, ...], dict[str, Any]] = {}
    sampler = SourceFrameSampler(source_frames, width, height)

    def plan_and_validate_selection() -> tuple[
        np.ndarray,
        list[int],
        dict[str, Any],
    ]:
        source_positions, boundaries, selection = plan_gesture_motion(
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
        )
        selection["total_internal_frames"] = len(source_positions)
        selection["silent_intervals"] = silent_intervals

        minimum_machine_gate = {
            "planned_annotation_stable_pause_closed_match_rate": 1.0,
            "planned_annotation_silence_dynamic_rate": 1.0,
        }
        failed_quality = {
            key: {
                "observed": float(selection.get(key, -1.0)),
                "required_minimum": minimum,
            }
            for key, minimum in minimum_machine_gate.items()
            if float(selection.get(key, -1.0)) + 1e-9 < minimum
        }
        source_speed = selection.get(
            "planned_annotation_maximum_continuous_source_speed"
        )
        source_speed_limit = selection.get(
            "planned_annotation_source_speed_limit"
        )
        source_acceleration = selection.get(
            "planned_annotation_maximum_continuous_source_acceleration"
        )
        source_acceleration_limit = selection.get(
            "planned_annotation_source_acceleration_limit"
        )
        boundary_count = selection.get(
            "planned_annotation_boundary_count"
        )
        minimum_boundary_gap = selection.get(
            "planned_annotation_minimum_boundary_gap"
        )
        required_boundary_gap = selection.get(
            "planned_annotation_required_minimum_boundary_gap"
        )
        upper_bound_checks = {
            "planned_annotation_maximum_continuous_source_speed": (
                source_speed,
                source_speed_limit,
            ),
            "planned_annotation_maximum_continuous_source_acceleration": (
                source_acceleration,
                source_acceleration_limit,
            ),
            "planned_annotation_realized_strength_mean_absolute_error": (
                selection.get(
                    "planned_annotation_realized_strength_mean_absolute_error"
                ),
                1.25,
            ),
            "planned_annotation_realized_strength_p95_absolute_error": (
                selection.get(
                    "planned_annotation_realized_strength_p95_absolute_error"
                ),
                1.75,
            ),
        }
        for key, (observed, maximum) in upper_bound_checks.items():
            if (
                not isinstance(observed, (int, float))
                or not isinstance(maximum, (int, float))
                or float(observed) > float(maximum) + 1e-9
            ):
                failed_quality[key] = {
                    "observed": observed,
                    "required_maximum": maximum,
                }
        if (
            not isinstance(boundary_count, int)
            or not isinstance(required_boundary_gap, int)
            or (
                boundary_count >= 2
                and (
                    not isinstance(minimum_boundary_gap, int)
                    or minimum_boundary_gap < required_boundary_gap
                )
            )
        ):
            failed_quality["planned_annotation_minimum_boundary_gap"] = {
                "observed": minimum_boundary_gap,
                "required_minimum": required_boundary_gap,
                "boundary_count": boundary_count,
            }

        accounting_fields = (
            "planned_annotation_original_anchor_count",
            "planned_annotation_realized_anchor_count",
            "planned_annotation_absorbed_or_unrealized_anchor_count",
            "planned_annotation_original_vowel_anchor_count",
            "planned_annotation_realized_vowel_anchor_count",
            "planned_annotation_absorbed_vowel_anchor_count",
        )
        accounting_values = {
            key: selection.get(key) for key in accounting_fields
        }
        accounting_consistent = all(
            isinstance(value, int) and value >= 0
            for value in accounting_values.values()
        )
        if accounting_consistent:
            accounting_consistent = (
                accounting_values[
                    "planned_annotation_original_anchor_count"
                ]
                == accounting_values[
                    "planned_annotation_realized_anchor_count"
                ]
                + accounting_values[
                    "planned_annotation_absorbed_or_unrealized_anchor_count"
                ]
                and accounting_values[
                    "planned_annotation_original_vowel_anchor_count"
                ]
                == accounting_values[
                    "planned_annotation_realized_vowel_anchor_count"
                ]
                + accounting_values[
                    "planned_annotation_absorbed_vowel_anchor_count"
                ]
            )
        coverage_pairs = (
            (
                "planned_annotation_original_anchor_count",
                "planned_annotation_realized_anchor_count",
                "planned_annotation_realized_anchor_coverage_rate",
            ),
            (
                "planned_annotation_original_vowel_anchor_count",
                "planned_annotation_realized_vowel_anchor_count",
                "planned_annotation_realized_vowel_anchor_coverage_rate",
            ),
        )
        for original_key, realized_key, coverage_key in coverage_pairs:
            original = accounting_values.get(original_key)
            realized = accounting_values.get(realized_key)
            observed_coverage = selection.get(coverage_key)
            expected_coverage = (
                realized / original
                if isinstance(original, int)
                and original > 0
                and isinstance(realized, int)
                else 1.0
            )
            if (
                not isinstance(observed_coverage, (int, float))
                or abs(float(observed_coverage) - expected_coverage) > 1e-6
            ):
                accounting_consistent = False
        clusters = selection.get(
            "planned_annotation_coarticulation_clusters"
        )
        if not isinstance(clusters, list):
            accounting_consistent = False
        minimum_realized_event_gap = selection.get(
            "planned_annotation_minimum_realized_event_gap"
        )
        required_event_gap = selection.get(
            "planned_annotation_required_minimum_event_gap"
        )
        realized_vowel_count = accounting_values.get(
            "planned_annotation_realized_vowel_anchor_count"
        )
        if (
            not isinstance(required_event_gap, int)
            or not isinstance(realized_vowel_count, int)
            or (
                realized_vowel_count >= 2
                and (
                    not isinstance(minimum_realized_event_gap, int)
                    or minimum_realized_event_gap < required_event_gap
                )
            )
        ):
            accounting_consistent = False
        if not accounting_consistent:
            failed_quality["coarticulation_anchor_accounting"] = {
                "counts": accounting_values,
                "clusters_present": isinstance(clusters, list),
                "minimum_realized_event_gap": (
                    minimum_realized_event_gap
                ),
                "required_minimum_event_gap": required_event_gap,
                "realized_anchor_coverage_rate": selection.get(
                    "planned_annotation_realized_anchor_coverage_rate"
                ),
                "realized_vowel_anchor_coverage_rate": selection.get(
                    "planned_annotation_realized_vowel_anchor_coverage_rate"
                ),
            }
        gesture_block_count = selection.get(
            "planned_annotation_gesture_block_count"
        )
        selected_gesture_take_count = selection.get(
            "planned_annotation_selected_gesture_take_count"
        )
        unique_gesture_clip_count = selection.get(
            "planned_annotation_unique_gesture_clip_count"
        )
        maximum_recent_same_clip = selection.get(
            "planned_annotation_maximum_same_gesture_clip_occurrences_in_recent_5"
        )
        required_unique_clips = selection.get(
            "planned_annotation_required_unique_gesture_clip_count"
        )
        required_unique_takes = selection.get(
            "planned_annotation_required_unique_gesture_take_count"
        )
        required_maximum_recent_same_clip = selection.get(
            "planned_annotation_required_maximum_same_gesture_clip_occurrences_in_recent_5"
        )
        diversity_contract_satisfied = selection.get(
            "planned_annotation_gesture_diversity_contract_satisfied"
        )
        diversity_contract = selection.get(
            "planned_annotation_gesture_diversity_contract"
        )
        diversity_enforcement_mode = selection.get(
            "planned_annotation_diversity_enforcement_mode"
        )
        idle_block_count = selection.get(
            "planned_annotation_idle_block_count"
        )
        unique_idle_clip_count = selection.get(
            "planned_annotation_unique_idle_clip_count"
        )
        maximum_recent_same_idle_clip = selection.get(
            "planned_annotation_maximum_same_idle_clip_occurrences_in_recent_5"
        )
        required_unique_idle_clips = selection.get(
            "planned_annotation_required_unique_idle_clip_count"
        )
        required_maximum_recent_same_idle_clip = selection.get(
            "planned_annotation_required_maximum_same_idle_clip_occurrences_in_recent_5"
        )
        idle_diversity_contract_satisfied = selection.get(
            "planned_annotation_idle_diversity_contract_satisfied"
        )
        idle_diversity_contract = selection.get(
            "planned_annotation_idle_diversity_contract"
        )
        motion_diversity_contract_satisfied = selection.get(
            "planned_annotation_motion_diversity_contract_satisfied"
        )
        diversity_is_hard = (
            diversity_enforcement_mode != "continuity-first-fallback"
        )
        if not all(
            isinstance(value, int)
            and not isinstance(value, bool)
            and value >= 0
            for value in (
                gesture_block_count,
                selected_gesture_take_count,
                unique_gesture_clip_count,
                maximum_recent_same_clip,
                required_unique_clips,
                required_unique_takes,
                required_maximum_recent_same_clip,
            )
        ) or not isinstance(diversity_contract, dict):
            failed_quality["gesture_diversity_accounting"] = {
                "gesture_block_count": gesture_block_count,
                "selected_gesture_take_count": selected_gesture_take_count,
                "unique_gesture_clip_count": unique_gesture_clip_count,
                "maximum_same_clip_in_recent_5": maximum_recent_same_clip,
                "required_unique_gesture_clip_count": required_unique_clips,
                "required_unique_gesture_take_count": required_unique_takes,
                "required_maximum_same_clip_in_recent_5": (
                    required_maximum_recent_same_clip
                ),
                "contract": diversity_contract,
            }
        else:
            diversity_failures = {}
            if selected_gesture_take_count < required_unique_takes:
                diversity_failures["selected_gesture_take_count"] = {
                    "observed": selected_gesture_take_count,
                    "required_minimum": required_unique_takes,
                }
            if unique_gesture_clip_count < required_unique_clips:
                diversity_failures["unique_gesture_clip_count"] = {
                    "observed": unique_gesture_clip_count,
                    "required_minimum": required_unique_clips,
                }
            if (
                maximum_recent_same_clip
                > required_maximum_recent_same_clip
            ):
                diversity_failures[
                    "maximum_same_gesture_clip_occurrences_in_recent_5"
                ] = {
                    "observed": maximum_recent_same_clip,
                    "required_maximum": required_maximum_recent_same_clip,
                }
            if diversity_contract_satisfied is not True:
                diversity_failures["planner_contract_satisfied"] = {
                    "observed": diversity_contract_satisfied,
                    "required": True,
                }
            contract_global = diversity_contract.get("global")
            if (
                not isinstance(contract_global, dict)
                or contract_global.get("satisfied") is not True
                or diversity_contract.get("satisfied") is not True
            ):
                diversity_failures["reported_contract"] = diversity_contract
            if diversity_failures and diversity_is_hard:
                failed_quality["gesture_diversity"] = diversity_failures
        if not all(
            isinstance(value, int)
            and not isinstance(value, bool)
            and value >= 0
            for value in (
                idle_block_count,
                unique_idle_clip_count,
                maximum_recent_same_idle_clip,
                required_unique_idle_clips,
                required_maximum_recent_same_idle_clip,
            )
        ) or not isinstance(idle_diversity_contract, dict):
            failed_quality["idle_diversity_accounting"] = {
                "idle_block_count": idle_block_count,
                "unique_idle_clip_count": unique_idle_clip_count,
                "maximum_same_clip_in_recent_5": (
                    maximum_recent_same_idle_clip
                ),
                "required_unique_idle_clip_count": (
                    required_unique_idle_clips
                ),
                "required_maximum_same_clip_in_recent_5": (
                    required_maximum_recent_same_idle_clip
                ),
                "contract": idle_diversity_contract,
            }
        else:
            idle_diversity_failures = {}
            if unique_idle_clip_count < required_unique_idle_clips:
                idle_diversity_failures["unique_idle_clip_count"] = {
                    "observed": unique_idle_clip_count,
                    "required_minimum": required_unique_idle_clips,
                }
            if (
                maximum_recent_same_idle_clip
                > required_maximum_recent_same_idle_clip
            ):
                idle_diversity_failures[
                    "maximum_same_idle_clip_occurrences_in_recent_5"
                ] = {
                    "observed": maximum_recent_same_idle_clip,
                    "required_maximum": (
                        required_maximum_recent_same_idle_clip
                    ),
                }
            if idle_diversity_contract_satisfied is not True:
                idle_diversity_failures["planner_contract_satisfied"] = {
                    "observed": idle_diversity_contract_satisfied,
                    "required": True,
                }
            if (
                idle_diversity_contract.get("satisfied") is not True
            ):
                idle_diversity_failures["reported_contract"] = (
                    idle_diversity_contract
                )
            if idle_diversity_failures and diversity_is_hard:
                failed_quality["idle_diversity"] = idle_diversity_failures
        if (
            motion_diversity_contract_satisfied is not True
            and diversity_is_hard
        ):
            failed_quality["motion_diversity"] = {
                "observed": motion_diversity_contract_satisfied,
                "required": True,
            }
        selection["machine_plan_gate"] = {
            "minimum_thresholds": minimum_machine_gate,
            "maximum_thresholds": {
                key: maximum
                for key, (_, maximum) in upper_bound_checks.items()
            },
            "minimum_boundary_gap": required_boundary_gap,
            "coarticulation_anchor_accounting": {
                "counts": accounting_values,
                "consistent": accounting_consistent,
                "minimum_realized_event_gap": (
                    minimum_realized_event_gap
                ),
                "required_minimum_event_gap": required_event_gap,
                "realized_anchor_coverage_rate": selection.get(
                    "planned_annotation_realized_anchor_coverage_rate"
                ),
                "realized_vowel_anchor_coverage_rate": selection.get(
                    "planned_annotation_realized_vowel_anchor_coverage_rate"
                ),
            },
            "gesture_diversity": {
                "enforcement_mode": diversity_enforcement_mode,
                "gesture_block_count": gesture_block_count,
                "selected_gesture_take_count": selected_gesture_take_count,
                "unique_gesture_clip_count": unique_gesture_clip_count,
                "maximum_same_clip_in_recent_5": maximum_recent_same_clip,
                "required_unique_gesture_clip_count": required_unique_clips,
                "required_unique_gesture_take_count": required_unique_takes,
                "required_maximum_same_clip_in_recent_5": (
                    required_maximum_recent_same_clip
                ),
                "planner_contract_satisfied": diversity_contract_satisfied,
                "contract": diversity_contract,
            },
            "idle_diversity": {
                "enforcement_mode": diversity_enforcement_mode,
                "idle_block_count": idle_block_count,
                "unique_idle_clip_count": unique_idle_clip_count,
                "maximum_same_clip_in_recent_5": (
                    maximum_recent_same_idle_clip
                ),
                "required_unique_idle_clip_count": (
                    required_unique_idle_clips
                ),
                "required_maximum_same_clip_in_recent_5": (
                    required_maximum_recent_same_idle_clip
                ),
                "planner_contract_satisfied": (
                    idle_diversity_contract_satisfied
                ),
                "contract": idle_diversity_contract,
            },
            "motion_diversity_contract_satisfied": (
                motion_diversity_contract_satisfied
            ),
            "passed": not failed_quality,
            "failures": failed_quality,
        }
        selection["lip_sync_indicators"] = {
            "speech_viseme_match_rate": selection.get(
                "planned_annotation_speech_viseme_match_rate"
            ),
            "large_mouth_realized_core_coverage_rate": selection.get(
                "planned_annotation_large_mouth_realized_core_coverage_rate"
            ),
            "realized_anchor_coverage_rate": selection.get(
                "planned_annotation_realized_anchor_coverage_rate"
            ),
            "realized_vowel_anchor_coverage_rate": selection.get(
                "planned_annotation_realized_vowel_anchor_coverage_rate"
            ),
            "machine_acceptance": "not-assessed",
            "visual_acceptance": "requires-agent-full-view-and-user-review",
        }
        if failed_quality:
            raise RuntimeError(
                "动作片段规划没有达到结构与动态待机机器门："
                + json.dumps(failed_quality, ensure_ascii=False)
            )
        return source_positions, boundaries, selection

    if planning:
        source_positions, boundaries, selection = (
            plan_and_validate_selection()
        )
        join_smoothing = preflight_output_resolution_join_windows(
            sampler,
            source_positions,
            boundaries,
            join_preflight_cache,
        )
        report_by_boundary = {
            int(item["boundary"]): item for item in join_smoothing
        }
        join_records = []
        for transition in selection[
            "planned_annotation_selected_clip_transitions"
        ]:
            record = copy.deepcopy(transition)
            if transition["boundary"]:
                boundary = int(transition["output_frame"])
                preflight = report_by_boundary.get(boundary)
                if preflight is None:
                    raise RuntimeError(
                        f"接缝 {boundary} 没有对应的四帧预检结果"
                    )
                mode = preflight.get("transition_mode")
                if preflight.get("applied") is not True:
                    category = "rejected"
                elif mode == "strict_optical_flow":
                    category = "strict_optical_flow"
                elif mode == "micro_optical_flow_luma_fallback":
                    category = "micro_optical_flow"
                else:
                    raise RuntimeError(
                        f"接缝 {boundary} 返回未知过渡模式：{mode}"
                    )
                record["preflight"] = copy.deepcopy(preflight)
            else:
                category = "original_source_continuity"
                record["preflight"] = None
            record["category"] = category
            join_records.append(record)

        category_counts = {
            category: sum(
                item["category"] == category for item in join_records
            )
            for category in (
                "original_source_continuity",
                "strict_optical_flow",
                "micro_optical_flow",
                "rejected",
            )
        }
        deterministic_seam_plan = {
            "planning_pass_count": 1,
            "selected_transition_count": len(join_records),
            "boundary_count": len(boundaries),
            "original_source_continuity_count": category_counts[
                "original_source_continuity"
            ],
            "strict_optical_flow_join_count": category_counts[
                "strict_optical_flow"
            ],
            "micro_optical_flow_transition_count": category_counts[
                "micro_optical_flow"
            ],
            "rejected_join_count": category_counts["rejected"],
            "micro_transition_internal_frames": 2,
            "micro_transition_seconds": round(2 / fps, 6),
            "cached_exact_join_windows": len(join_preflight_cache),
            "all_boundaries_preflighted_before_encoding": True,
            "all_accepted_boundaries_smoothed": True,
            "route_retry_count": 0,
        }
        selection["deterministic_seam_plan"] = deterministic_seam_plan
        plan_status = (
            "rejected"
            if category_counts["rejected"]
            else "ready"
        )
        render_plan_payload = {
            "protocol": "visual-multimedia-anime-avatar-render-plan",
            "version": 2,
            "status": plan_status,
            "plan_id": task_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "inputs": {
                key: {
                    "locator": portable_locator(
                        provenance_paths[key],
                        paths["root"],
                    ),
                    "sha256": provenance_sha256[key],
                }
                for key in provenance_paths
            },
            "library_capabilities": {
                "resource": {
                    "id": package["id"],
                    "version": package["library_version"],
                },
                "facts": library_validation["capability_facts"],
            },
            "execution": {
                "duration_seconds": round(requested_duration, 9),
                "audio_duration_seconds": round(audio_duration, 9),
                "internal_fps": fps,
                "delivery_fps": delivery_fps,
                "output_size": [width, height],
            },
            "target_timeline": {
                "visemes": target_labels,
                "intensities": [
                    float(value) for value in target_levels
                ],
                "energy": [float(value) for value in energy],
                "anchors": anchors,
                "roles": roles,
                "phone_events": phone_report,
            },
            "source_schedule": {
                "source_position_by_internal_frame": [
                    float(value) for value in source_positions
                ],
                "boundaries": [int(value) for value in boundaries],
            },
            "selection": selection,
            "joins": join_records,
            "deterministic_seam_plan": deterministic_seam_plan,
            "approval": {
                "status": "pending",
                "confirmed_at": None,
                "approved_plan_sha256": None,
            },
        }
        validate_render_plan_payload(
            render_plan_payload,
            require_confirmed=False,
        )
        render_plan_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(render_plan_path, render_plan_payload)
        sampler.close()
        del sampler
        del source_frames
        gc.collect()
        if plan_status == "rejected":
            failed_details = [
                {
                    "boundary": int(item["output_frame"]),
                    "reason": item["preflight"].get("reason"),
                    "failed_checks": item["preflight"].get(
                        "failed_checks"
                    ),
                }
                for item in join_records
                if item["category"] == "rejected"
            ]
            raise RuntimeError(
                "接缝计划已写出，但人物结构或运动不兼容，不能确认或编码："
                + json.dumps(
                    {
                        "render_plan": str(render_plan_path),
                        "rejected": failed_details,
                    },
                    ensure_ascii=False,
                )
            )
        return {
            "ok": True,
            "status": "ready",
            "plan_id": task_id,
            "render_plan": str(render_plan_path),
            "library_capabilities": library_validation["capability_facts"],
            "deterministic_seam_plan": deterministic_seam_plan,
            "next": (
                "检查 render-plan.json 中的全部原片连续、严格光流和微过渡"
                "接缝；确认后运行 confirm-plan，再由 render 消费。"
            ),
        }

    assert approved_plan is not None
    source_positions = np.asarray(
        approved_plan["source_schedule"][
            "source_position_by_internal_frame"
        ],
        dtype=np.float32,
    )
    boundaries = [
        int(value)
        for value in approved_plan["source_schedule"]["boundaries"]
    ]
    selection = copy.deepcopy(approved_plan["selection"])
    join_smoothing = [
        copy.deepcopy(item["preflight"])
        for item in approved_plan["joins"]
        if item["category"]
        in {"strict_optical_flow", "micro_optical_flow"}
    ]
    if len(source_positions) != requested_internal_frames:
        raise ValueError(
            "render-plan.json 的源帧计划长度与计划时长不一致"
        )
    print(
        "已载入并验证已确认接缝计划："
        f"boundaries={len(boundaries)}, "
        "strict="
        f"{selection['deterministic_seam_plan']['strict_optical_flow_join_count']}, "
        "micro="
        f"{selection['deterministic_seam_plan']['micro_optical_flow_transition_count']}",
        flush=True,
    )
    assert output is not None
    assert report_dir is not None
    streaming_result = encode_silent_stream(
        ffmpeg,
        sampler,
        source_positions,
        boundaries,
        join_smoothing,
        fps,
        silent_video,
    )
    sampler.close()
    del sampler
    del source_frames
    gc.collect()

    video_duration = len(source_positions) / fps
    mux_audio(
        ffmpeg,
        silent_video,
        trimmed_audio,
        motion_match_video,
        video_duration,
    )
    if delivery_fps == fps:
        with motion_match_video.open("rb") as source_video:
            with output.open("xb") as destination_video:
                shutil.copyfileobj(
                    source_video,
                    destination_video,
                    length=1024 * 1024,
                )
    else:
        interpolate_delivery(
            ffmpeg,
            motion_match_video,
            output,
            delivery_fps,
            video_duration,
        )

    nearest_source_indices = np.clip(
        np.rint(source_positions).astype(np.int32),
        0,
        len(source_labels) - 1,
    )
    output_probe = probe_video(output, ffprobe)
    duration_tolerance = max(0.002, 0.5 / delivery_fps)
    if abs(output_probe["video_duration_seconds"] - video_duration) > duration_tolerance:
        raise RuntimeError(
            "交付视频画面时长与内部帧时间线不一致："
            f"预期 {video_duration:.6f}s，"
            f"实际 {output_probe['video_duration_seconds']:.6f}s"
        )
    final_provenance_sha256 = {
        key: file_sha256(path) for key, path in provenance_paths.items()
    }
    if final_provenance_sha256 != provenance_sha256:
        raise RuntimeError(
            "渲染期间脚本、口型库或时间线发生变化，拒绝写出混合版本报告"
        )
    review_outputs = save_render_review_from_video(
        report_dir,
        output,
        source_positions,
        boundaries,
        target_labels,
        target_levels,
        source_labels,
        source_levels,
        fps,
        delivery_fps,
    )
    report = {
        "protocol": "visual-multimedia-anime-avatar-render",
        "version": 3,
        "task_id": task_id,
        "run_id": run_id,
        "immutable_run_directories": {
            "working": str(working),
            "report": str(report_dir),
            "task_id_reuse_rejected": True,
        },
        "input_provenance": {
            key: {
                "path": str(provenance_paths[key]),
                "sha256": provenance_sha256[key],
            }
            for key in provenance_paths
        },
        "approved_render_plan": {
            "path": str(render_plan_path),
            "plan_id": approved_plan["plan_id"],
            "approved_plan_sha256": approved_plan["approval"][
                "approved_plan_sha256"
            ],
            "full_render_consumed_plan_without_replanning": True,
            "input_hashes_revalidated_before_encoding": True,
        },
        "library_capabilities": copy.deepcopy(
            approved_plan["library_capabilities"]
        ),
        "character_id": character["id"],
        "motion_source_id": motion_source["source_id"],
        "audio_source_id": timeline["audio_source_id"],
        "speech_timeline": str(timeline_path),
        "text": timeline["text"],
        "audio_trim": {
            "start_seconds": timeline["trim_start_seconds"],
            "end_seconds": timeline["trim_end_seconds"],
            "rendered_duration_seconds": round(audio_duration, 6),
        },
        "output_timing": {
            "requested_duration_seconds": round(
                requested_duration,
                6,
            ),
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
            "whole-frame gesture/idle clip scheduler -> directed natural chains "
            "or compatibility-gated low-mouth endpoints -> bounded monotonic "
            "source-time mapping -> immutable confirmed render-plan.json with "
            "input/code hashes and every original/strict/micro join -> "
            "no runtime route planning -> deterministic two-frame optical-flow "
            "writeback while streaming directly into FFmpeg -> "
            "motion-compensated delivery"
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
            for index in range(len(source_positions))
        ],
        "source_position_by_internal_frame": [
            round(float(value), 6) for value in source_positions
        ],
        "selected_annotation_by_internal_frame": [
            {
                "source_position": round(
                    float(source_positions[output_index]),
                    6,
                ),
                "nearest_source_frame": int(source_index),
                "viseme": source_labels[source_index],
                "intensity": round(float(source_levels[source_index]), 4),
                "take": int(source_takes[source_index]),
            }
            for output_index, source_index in enumerate(
                nearest_source_indices
            )
        ],
        "selection": selection,
        "join_smoothing": join_smoothing,
        "speed_configuration": {
            "internal_fps": fps,
            "delivery_fps": delivery_fps,
            "planner_source_speed_limit": selection.get(
                "planned_annotation_source_speed_limit"
            ),
            "planner_source_acceleration_limit": selection.get(
                "planned_annotation_source_acceleration_limit"
            ),
            "observed_minimum_continuous_source_speed": selection.get(
                "planned_annotation_minimum_continuous_source_speed"
            ),
            "observed_maximum_continuous_source_speed": selection.get(
                "planned_annotation_maximum_continuous_source_speed"
            ),
            "observed_maximum_continuous_source_acceleration": selection.get(
                "planned_annotation_maximum_continuous_source_acceleration"
            ),
            "required_minimum_boundary_gap": selection.get(
                "planned_annotation_required_minimum_boundary_gap"
            ),
            "delivery_motion_interpolation": (
                "disabled"
                if delivery_fps == fps
                else (
                    "FFmpeg minterpolate mci/aobmc/bidir/vsbmc=1 "
                    f"to {delivery_fps} fps"
                )
            ),
        },
        "technical_result": {
            "output": str(output),
            "internal_fps": fps,
            "internal_frame_count": len(source_positions),
            "delivery_probe": output_probe,
            "fixed_source_crop_xywh": list(crop),
            "output_size": [width, height],
            "fixed_anchor_policy": (
                "one source crop for every frame; no per-frame landmark or accessory tracking"
            ),
            "streaming_memory_policy": {
                "source_frame_store": source_store_report,
                "source_frame_store_is_disk_backed": True,
                "full_resolution_source_frames_held_in_python_list": 0,
                "target_duration_full_resolution_frames_retained": 0,
                "maximum_resident_output_frames": streaming_result[
                    "maximum_resident_output_frames"
                ],
                "maximum_resident_cached_source_frames": streaming_result[
                    "maximum_resident_cached_source_frames"
                ],
                "source_cache_capacity_frames": streaming_result[
                    "source_cache_capacity_frames"
                ],
                "full_resolution_image_heap_complexity": "O(1)",
                "timeline_metadata_memory_complexity": "O(target_frames)",
                "final_video_copy_uses_bounded_buffer": delivery_fps == fps,
                "review_frames_read_from_final_encoded_delivery": True,
                "review_full_resolution_frames_retained": 0,
            },
            "streaming_result": streaming_result,
        },
        "review_artifacts": review_outputs,
        "human_full_review": {
            "required": True,
            "completed": False,
            "checks": [
                "watch the complete output with sound",
                "inspect every smoothed two-frame boundary strip",
                "confirm motion remains continuous across speech and silence rather than restarting per interval",
                "confirm bounded clip time-stretch does not make head, hair, ears or shoulders move unnaturally fast",
                "confirm no unsmoothed hard cut remains at any planned source transition",
                "confirm no rapid meaningless open-close",
                "confirm large openings appear on sufficiently strong vowel nuclei",
                "confirm late sections keep varied continuous motion rather than mechanically repeating one take",
                "confirm every silent interval uses moving closed-mouth source frames rather than a frozen frame",
                "confirm no fixed post-speech tail was added beyond the requested timeline",
                "confirm identity, chin, hair, ears, accessories and shoulders stay coherent",
            ],
        },
    }
    report_path = report_dir / "render-report.json"
    write_json(report_path, report)
    return {
        "ok": True,
        "task_id": task_id,
        "run_id": run_id,
        "output": str(output),
        "report": str(report_path),
        "audio_duration_seconds": round(audio_duration, 6),
        "internal_frames": len(source_positions),
        "delivery_fps": delivery_fps,
        "selection": selection,
        "review_artifacts": review_outputs,
        "next": (
            "完整观看输出并查看 boundary strips；确认后再进入常规视频时间线做圆形或方形窗口合成。"
        ),
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
    plan_parser.add_argument("--render-plan", required=True)
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
    confirm_parser.add_argument("--render-plan", required=True)

    render_parser = subparsers.add_parser(
        "render",
        help="只消费已确认且输入哈希仍有效的 render-plan.json 进行编码",
    )
    render_parser.add_argument("--project", required=True)
    render_parser.add_argument("--render-plan", required=True)
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
        else run_avatar_pipeline(args)
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

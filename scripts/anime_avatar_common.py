#!/usr/bin/env python3
"""Shared contracts for the no-rig anime-avatar production scripts."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


SKILL_ROOT = Path(__file__).resolve().parent.parent
VISEMES = ("CLOSED", "A", "I", "U", "E", "O")
VOWEL_VISEMES = ("A", "I", "U", "E", "O")


def read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FileNotFoundError(f"文件不存在：{path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"JSON 无法解析：{path}\n{error}") from error
    if not isinstance(payload, dict):
        raise ValueError(f"JSON 根节点必须是对象：{path}")
    return payload


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def executable(name: str, override: str | None = None) -> str:
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.exists():
            raise FileNotFoundError(f"{name} 不存在：{candidate}")
        return str(candidate)
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(
            f"找不到 {name}。请把已有工具加入 PATH 或显式传入路径；脚本不会自动安装。"
        )
    return found


def run(
    command: list[str],
    *,
    capture: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        check=False,
        capture_output=capture,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detail = ""
        if capture:
            detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(
            f"命令执行失败（{result.returncode}）：{' '.join(command)}"
            + (f"\n{detail}" if detail else "")
        )
    return result


def probe_video(source: Path, ffprobe: str) -> dict[str, Any]:
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration,size",
            "-show_entries",
            (
                "stream=index,codec_type,codec_name,width,height,avg_frame_rate,"
                "r_frame_rate,nb_frames,duration,sample_rate,channels"
            ),
            "-of",
            "json",
            str(source),
        ]
    )
    payload = json.loads(result.stdout)
    streams = [
        stream
        for stream in payload.get("streams", [])
        if stream.get("codec_type") == "video"
    ]
    if not streams:
        raise ValueError(f"视频没有可读取画面轨：{source}")
    stream = streams[0]
    audio_streams = [
        item
        for item in payload.get("streams", [])
        if item.get("codec_type") == "audio"
    ]
    rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"
    numerator, denominator = rate.split("/", 1)
    fps = float(numerator) / max(float(denominator), 1.0)
    declared_frame_count = (
        int(stream["nb_frames"])
        if str(stream.get("nb_frames") or "").isdigit()
        else None
    )
    stream_duration = float(stream.get("duration") or 0.0)
    if stream_duration <= 0 and declared_frame_count and fps > 0:
        stream_duration = declared_frame_count / fps
    container_duration = float(payload.get("format", {}).get("duration") or 0.0)
    duration = stream_duration or container_duration
    audio_duration = max(
        [float(item.get("duration") or 0.0) for item in audio_streams],
        default=0.0,
    )
    return {
        "path": str(source),
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "fps": fps,
        "duration_seconds": duration,
        "video_duration_seconds": duration,
        "audio_duration_seconds": audio_duration if audio_streams else None,
        "container_duration_seconds": container_duration or duration,
        "declared_frame_count": declared_frame_count,
        "codec": stream.get("codec_name"),
        "has_audio": bool(audio_streams),
        "audio_codec": audio_streams[0].get("codec_name") if audio_streams else None,
        "bytes": int(payload.get("format", {}).get("size") or source.stat().st_size),
    }


def project_paths(project_root: Path) -> dict[str, Path]:
    root = project_root.expanduser().resolve()
    return {
        "root": root,
        "project": root / "avatar-project.json",
        "manifest": root / "media-sources.json",
        "library_default": root / "visual-viseme-library.json",
    }


def load_project(project_root: Path) -> tuple[dict[str, Any], dict[str, Path]]:
    paths = project_paths(project_root)
    project = read_json(paths["project"])
    errors: list[str] = []
    if project.get("protocol") != "visual-multimedia-anime-avatar-project":
        errors.append("protocol 必须是 visual-multimedia-anime-avatar-project")
    if project.get("version") != 1:
        errors.append("version 必须是 1")
    character = project.get("character")
    if not isinstance(character, dict):
        errors.append("character 必须是对象")
    motion = project.get("motion_source")
    if not isinstance(motion, dict):
        errors.append("motion_source 必须是对象")
    render = project.get("render")
    if not isinstance(render, dict):
        errors.append("render 必须是对象")
    if errors:
        raise ValueError("avatar-project.json 无效：\n- " + "\n- ".join(errors))
    return project, paths


def validate_media_manifest(manifest_path: Path) -> dict[str, Any]:
    validator = SKILL_ROOT / "scripts" / "validate-media-sources.mjs"
    node = executable("node")
    result = run([node, str(validator), str(manifest_path), "--json"])
    report = json.loads(result.stdout)
    if not report.get("ok"):
        raise ValueError(
            "media-sources.json 未通过校验：\n- "
            + "\n- ".join(report.get("errors", []))
        )
    return read_json(manifest_path)


def resolve_source(
    manifest: dict[str, Any],
    project_root: Path,
    source_id: str | None,
    expected_types: set[str] | None = None,
) -> tuple[dict[str, Any], Path]:
    if not source_id:
        raise ValueError("项目尚未填写所需 source id")
    matches = [
        item for item in manifest.get("sources", []) if item.get("id") == source_id
    ]
    if len(matches) != 1:
        raise ValueError(f"素材账本中无法唯一解析 source id：{source_id}")
    source = matches[0]
    if expected_types and source.get("media_type") not in expected_types:
        raise ValueError(
            f"素材 {source_id} 类型为 {source.get('media_type')}，"
            f"预期 {sorted(expected_types)}"
        )
    path = (project_root / source["file"]).resolve()
    try:
        path.relative_to(project_root.resolve())
    except ValueError as error:
        raise ValueError(f"素材路径越出项目目录：{path}") from error
    if not path.is_file():
        raise FileNotFoundError(f"素材文件不存在：{path}")
    return source, path


def parse_xywh(value: Any, field: str) -> tuple[int, int, int, int]:
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(not isinstance(item, int) for item in value)
    ):
        raise ValueError(f"{field} 必须是四个整数 [x, y, width, height]")
    x, y, width, height = value
    if x < 0 or y < 0 or width <= 0 or height <= 0:
        raise ValueError(f"{field} 必须使用非负坐标和正尺寸")
    return x, y, width, height


def ensure_crop(
    crop: tuple[int, int, int, int],
    frame_width: int,
    frame_height: int,
    field: str,
) -> None:
    x, y, width, height = crop
    if x + width > frame_width or y + height > frame_height:
        raise ValueError(
            f"{field} {crop} 超出画面 {frame_width}x{frame_height}"
        )


def load_cropped_frames(
    source: Path,
    crop: tuple[int, int, int, int],
) -> tuple[list[np.ndarray], float]:
    capture = cv2.VideoCapture(str(source))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ensure_crop(crop, frame_width, frame_height, "source_crop_xywh")
    x, y, width, height = crop
    frames: list[np.ndarray] = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame[y : y + height, x : x + width].copy())
    capture.release()
    if fps <= 0 or not frames:
        raise ValueError(f"无法读取有效视频帧：{source}")
    return frames, fps


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def bgr_to_pil(frame: np.ndarray) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))


def fit_image(image: Image.Image, width: int, height: int) -> Image.Image:
    copy = image.copy()
    copy.thumbnail((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (width, height), "#ffffff")
    canvas.paste(copy, ((width - copy.width) // 2, (height - copy.height) // 2))
    return canvas


def contact_sheet(
    cells: list[tuple[Image.Image, str]],
    destination: Path,
    *,
    columns: int = 5,
    cell_width: int = 300,
    cell_height: int = 300,
    label_height: int = 42,
    background: str = "#151515",
) -> None:
    if not cells:
        raise ValueError("联系表没有可绘制的单元格")
    rows = math.ceil(len(cells) / columns)
    gutter = 10
    margin = 16
    canvas_width = (
        margin * 2 + columns * cell_width + (columns - 1) * gutter
    )
    canvas_height = (
        margin * 2 + rows * (cell_height + label_height) + (rows - 1) * gutter
    )
    canvas = Image.new("RGB", (canvas_width, canvas_height), background)
    draw = ImageDraw.Draw(canvas)
    label_font = font(19, bold=True)
    for index, (image, label) in enumerate(cells):
        row, column = divmod(index, columns)
        left = margin + column * (cell_width + gutter)
        top = margin + row * (cell_height + label_height + gutter)
        canvas.paste(fit_image(image.convert("RGB"), cell_width, cell_height), (left, top))
        draw.rectangle(
            (left, top + cell_height, left + cell_width, top + cell_height + label_height),
            fill="#242424",
        )
        draw.text(
            (left + 8, top + cell_height + 8),
            label,
            fill="#ffffff",
            font=label_font,
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, quality=92)


def sampled_indices(frame_count: int, fps: float, samples_per_second: float) -> list[int]:
    if samples_per_second <= 0:
        raise ValueError("抽样频率必须大于 0")
    step = fps / samples_per_second
    values: list[int] = []
    position = 0.0
    while round(position) < frame_count:
        frame_index = min(frame_count - 1, int(round(position)))
        if not values or values[-1] != frame_index:
            values.append(frame_index)
        position += step
    if values[-1] != frame_count - 1:
        values.append(frame_count - 1)
    return values


def paginate(values: list[int], page_size: int) -> list[list[int]]:
    return [values[index : index + page_size] for index in range(0, len(values), page_size)]


def frame_cells(
    frames: list[np.ndarray],
    indices: list[int],
    fps: float,
    *,
    local_crop: tuple[int, int, int, int] | None = None,
) -> list[tuple[Image.Image, str]]:
    cells: list[tuple[Image.Image, str]] = []
    for frame_index in indices:
        frame = frames[frame_index]
        if local_crop is not None:
            x, y, width, height = local_crop
            frame = frame[y : y + height, x : x + width]
        cells.append(
            (
                bgr_to_pil(frame),
                f"f{frame_index:04d}  {frame_index / fps:06.3f}s",
            )
        )
    return cells


def library_path(project: dict[str, Any], paths: dict[str, Path]) -> Path:
    relative = project.get("library_file")
    if not isinstance(relative, str) or not relative:
        raise ValueError("avatar-project.json 缺少 library_file")
    candidate = (paths["root"] / relative).resolve()
    try:
        candidate.relative_to(paths["root"])
    except ValueError as error:
        raise ValueError(f"library_file 越出项目目录：{candidate}") from error
    return candidate


def span_bounds(item: dict[str, Any], label: str) -> tuple[int, int]:
    start = item.get("start_frame")
    end = item.get("end_frame_exclusive")
    if (
        not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
    ):
        raise ValueError(f"{label} 缺少整数帧边界")
    if start < 0 or end <= start:
        raise ValueError(f"{label} 帧边界无效：[{start}, {end})")
    return start, end


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _compressed_states(
    runtime_records: list[dict[str, Any]],
    start: int,
    end: int,
) -> list[str]:
    states: list[str] = []
    for record in runtime_records:
        if record["end"] <= start or record["start"] >= end:
            continue
        state = record["viseme"]
        if not states or states[-1] != state:
            states.append(state)
    return states


def _directed_reachability(
    node_ids: list[str],
    edges: list[tuple[str, str]],
) -> dict[str, list[str]]:
    adjacency = {node_id: set() for node_id in node_ids}
    for source, target in edges:
        if source in adjacency and target in adjacency:
            adjacency[source].add(target)
    reachable: dict[str, list[str]] = {}
    for source in node_ids:
        seen = {source}
        pending = list(adjacency[source])
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            pending.extend(adjacency[current] - seen)
        reachable[source] = sorted(seen - {source})
    return reachable


def validate_library_payload(
    library: dict[str, Any],
    *,
    source_id: str,
    source_fps: float,
    source_frame_count: int,
    source_crop: tuple[int, int, int, int],
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if library.get("protocol") != "visual-multimedia-visual-viseme-library":
        errors.append("protocol 必须是 visual-multimedia-visual-viseme-library")
    if library.get("version") != 1:
        errors.append("version 必须是 1")
    if library.get("source_id") != source_id:
        errors.append("source_id 与 avatar-project.json 不一致")
    if abs(float(library.get("source_fps") or 0.0) - source_fps) > 0.02:
        errors.append(
            f"source_fps {library.get('source_fps')} 与真实 {source_fps:.6f} 不一致"
        )
    if library.get("source_frame_count") != source_frame_count:
        errors.append(
            f"source_frame_count {library.get('source_frame_count')} "
            f"与真实 {source_frame_count} 不一致"
        )
    if library.get("source_crop_xywh") != list(source_crop):
        errors.append("source_crop_xywh 与 avatar-project.json 不一致")
    annotation = library.get("annotation")
    if not isinstance(annotation, dict) or annotation.get("method") != "ai-visual-review":
        errors.append("annotation.method 必须是 ai-visual-review")
    elif not annotation.get("reviewed_contact_sheets"):
        errors.append("annotation.reviewed_contact_sheets 不能为空")

    runtime_spans = library.get("runtime_state_spans")
    if not isinstance(runtime_spans, list) or not runtime_spans:
        errors.append("runtime_state_spans 必须是非空数组")
        runtime_spans = []
    coverage = np.zeros(source_frame_count, dtype=np.int16)
    clip_ids: set[str] = set()
    runtime_records: list[dict[str, Any]] = []
    runtime_by_clip_id: dict[str, list[dict[str, Any]]] = {}
    for index, span in enumerate(runtime_spans):
        if not isinstance(span, dict):
            errors.append(f"runtime_state_spans[{index}] 必须是对象")
            continue
        viseme = span.get("viseme")
        if viseme not in VISEMES:
            errors.append(f"runtime_state_spans[{index}].viseme 无效")
        try:
            start, end = span_bounds(span, f"runtime_state_spans[{index}]")
        except ValueError as error:
            errors.append(str(error))
            continue
        take = span.get("take")
        if not _positive_int(take):
            errors.append(f"runtime_state_spans[{index}].take 必须是正整数")
        if end > source_frame_count:
            errors.append(f"runtime_state_spans[{index}] 超出源帧")
        else:
            coverage[start:end] += 1
        record = {
            "index": index,
            "viseme": viseme,
            "take": take,
            "start": start,
            "end": end,
            "clip_id": span.get("clip_id"),
        }
        runtime_records.append(record)
        if viseme != "CLOSED":
            clip_id = span.get("clip_id")
            if not isinstance(clip_id, str) or not clip_id:
                errors.append(f"runtime_state_spans[{index}] 缺少 clip_id")
            else:
                clip_ids.add(clip_id)
                runtime_by_clip_id.setdefault(clip_id, []).append(record)
    runtime_records.sort(key=lambda item: (item["start"], item["end"]))
    if len(coverage):
        gaps = np.where(coverage == 0)[0]
        overlaps = np.where(coverage > 1)[0]
        if len(gaps):
            errors.append(
                f"runtime_state_spans 未覆盖 {len(gaps)} 帧，首帧 {int(gaps[0])}"
            )
        if len(overlaps):
            errors.append(
                f"runtime_state_spans 重叠 {len(overlaps)} 帧，首帧 {int(overlaps[0])}"
            )

    closed_clips = library.get("closed_motion_clips")
    if not isinstance(closed_clips, list):
        closed_clips = []
        errors.append("closed_motion_clips 必须是数组")
    if len(closed_clips) < 3:
        errors.append("closed_motion_clips 至少需要开头、中间、结尾三段")
    closed_records: list[dict[str, Any]] = []
    closed_ids: set[str] = set()
    for index, clip in enumerate(closed_clips):
        if not isinstance(clip, dict):
            errors.append(f"closed_motion_clips[{index}] 必须是对象")
            continue
        clip_id = clip.get("id")
        if not isinstance(clip_id, str) or not clip_id:
            errors.append(f"closed_motion_clips[{index}].id 缺失")
        elif clip_id in closed_ids:
            errors.append(f"closed motion clip id 重复：{clip_id}")
        else:
            closed_ids.add(clip_id)
        try:
            start, end = span_bounds(clip, f"closed_motion_clips[{index}]")
            if end > source_frame_count:
                errors.append(f"closed_motion_clips[{index}] 超出源帧")
        except ValueError as error:
            errors.append(str(error))
            continue
        matching_runtime = [
            record
            for record in runtime_records
            if record["viseme"] == "CLOSED"
            and record["start"] <= start
            and end <= record["end"]
        ]
        if len(matching_runtime) != 1:
            errors.append(
                f"closed_motion_clips[{index}] 必须完整落在唯一一条 CLOSED "
                "runtime_state_span 内"
            )
            take = None
        else:
            take = matching_runtime[0]["take"]
        closed_records.append(
            {
                "id": clip_id,
                "node_id": f"CLOSED:{clip_id}",
                "viseme": "CLOSED",
                "take": take,
                "start": start,
                "end": end,
                "low_entry_frame": start,
                "low_exit_frame": end - 1,
            }
        )

    gestures = library.get("gesture_clips")
    if not isinstance(gestures, list):
        gestures = []
        errors.append("gesture_clips 必须是数组")
    ids: set[str] = set()
    counts = {viseme: 0 for viseme in VOWEL_VISEMES}
    peak_strength_records = {viseme: [] for viseme in VOWEL_VISEMES}
    gesture_records: list[dict[str, Any]] = []
    gesture_by_state_take: dict[tuple[str, int], dict[str, Any]] = {}
    gesture_by_id: dict[str, dict[str, Any]] = {}
    for index, clip in enumerate(gestures):
        if not isinstance(clip, dict):
            errors.append(f"gesture_clips[{index}] 必须是对象")
            continue
        clip_id = clip.get("id")
        if not isinstance(clip_id, str) or not clip_id:
            errors.append(f"gesture_clips[{index}].id 缺失")
        elif clip_id in ids:
            errors.append(f"gesture clip id 重复：{clip_id}")
        else:
            ids.add(clip_id)
        viseme = clip.get("viseme")
        if viseme not in VOWEL_VISEMES:
            errors.append(f"gesture_clips[{index}].viseme 无效")
        else:
            counts[viseme] += 1
        take = clip.get("take")
        if not _positive_int(take):
            errors.append(f"gesture_clips[{index}].take 必须是正整数")
        peak_strength = clip.get("peak_strength_level")
        peak_strength_valid = (
            isinstance(peak_strength, (int, float))
            and not isinstance(peak_strength, bool)
            and math.isfinite(float(peak_strength))
            and 1.0 <= float(peak_strength) <= 4.0
        )
        if not peak_strength_valid:
            errors.append(
                f"gesture_clips[{index}].peak_strength_level "
                "必须是 1.0..4.0 的有限数字"
            )
        try:
            start, end = span_bounds(clip, f"gesture_clips[{index}]")
        except ValueError as error:
            errors.append(str(error))
            continue
        if end > source_frame_count:
            errors.append(f"gesture_clips[{index}] 超出源帧")
        intensity_fields: dict[str, list[int]] = {}
        for field in (
            "rise_frames_by_intensity",
            "fall_frames_by_intensity",
            "representative_frames_by_intensity",
        ):
            values = clip.get(field)
            if (
                not isinstance(values, list)
                or len(values) != 5
                or any(
                    not isinstance(value, int) or isinstance(value, bool)
                    for value in values
                )
            ):
                errors.append(f"gesture_clips[{index}].{field} 必须有五个整数帧")
                continue
            intensity_fields[field] = values
            outside = [value for value in values if value < start or value >= end]
            if outside:
                errors.append(
                    f"gesture_clips[{index}].{field} 有帧越出 [{start}, {end})"
                )
        peak = clip.get("peak_frame_range_inclusive")
        peak_valid = not (
            not isinstance(peak, list)
            or len(peak) != 2
            or any(
                not isinstance(value, int) or isinstance(value, bool)
                for value in peak
            )
            or peak[0] > peak[1]
            or peak[0] < start
            or peak[1] >= end
        )
        if not peak_valid:
            errors.append(
                f"gesture_clips[{index}].peak_frame_range_inclusive 无效"
            )
        rise = intensity_fields.get("rise_frames_by_intensity")
        fall = intensity_fields.get("fall_frames_by_intensity")
        representatives = intensity_fields.get(
            "representative_frames_by_intensity"
        )
        endpoints_valid = bool(
            rise and fall and peak_valid and peak_strength_valid
        )
        if rise:
            if rise != sorted(rise) or len(set(rise)) != len(rise):
                errors.append(
                    f"gesture_clips[{index}].rise_frames_by_intensity "
                    "必须按时间严格正向递增"
                )
                endpoints_valid = False
            if rise[0] != start:
                errors.append(
                    f"gesture_clips[{index}] 缺少显式低口型入口："
                    "rise_frames_by_intensity[0] 必须等于 start_frame"
                )
                endpoints_valid = False
        if fall:
            if fall != sorted(fall, reverse=True) or len(set(fall)) != len(fall):
                errors.append(
                    f"gesture_clips[{index}].fall_frames_by_intensity "
                    "按强度记录时必须对应严格反向时间顺序"
                )
                endpoints_valid = False
            if fall[0] != end - 1:
                errors.append(
                    f"gesture_clips[{index}] 缺少显式低口型出口："
                    "fall_frames_by_intensity[0] 必须严格等于 "
                    "end_frame_exclusive - 1"
                )
                endpoints_valid = False
        if rise and fall and peak_valid:
            if rise[0] >= peak[0] or fall[0] <= peak[1]:
                errors.append(
                    f"gesture_clips[{index}] 的低口型入口、峰值和低口型出口"
                    "没有形成正向 rise→peak→fall"
                )
                endpoints_valid = False
            peak_samples = [
                rise[4],
                fall[4],
                representatives[4] if representatives else None,
            ]
            if any(
                value is None or value < peak[0] or value > peak[1]
                for value in peak_samples
            ):
                errors.append(
                    f"gesture_clips[{index}] 的强度 4 帧必须落在"
                    " peak_frame_range_inclusive 内"
                )
                endpoints_valid = False
        if (
            isinstance(clip_id, str)
            and clip_id
            and viseme in VOWEL_VISEMES
            and _positive_int(take)
        ):
            if peak_strength_valid:
                peak_strength_records[viseme].append(
                    {
                        "clip_id": clip_id,
                        "take": take,
                        "peak_strength_level": float(peak_strength),
                    }
                )
            key = (viseme, take)
            if key in gesture_by_state_take:
                errors.append(
                    f"gesture take 重复：{viseme} take {take}"
                )
            else:
                record = {
                    "id": clip_id,
                    "node_id": clip_id,
                    "viseme": viseme,
                    "take": take,
                    "start": start,
                    "end": end,
                    "low_entry_frame": rise[0] if rise else None,
                    "low_exit_frame": fall[0] if fall else None,
                    "peak_frame_range_inclusive": peak if peak_valid else None,
                    "peak_strength_level": (
                        float(peak_strength) if peak_strength_valid else None
                    ),
                    "has_schedulable_low_endpoints": endpoints_valid,
                }
                gesture_by_state_take[key] = record
                gesture_by_id[clip_id] = record
                gesture_records.append(record)
    missing_clip_ids = sorted(clip_ids - ids)
    if missing_clip_ids:
        errors.append(
            "runtime_state_spans 引用了不存在的 clip_id："
            + ", ".join(missing_clip_ids)
        )
    for clip_id, matching_runtime in sorted(runtime_by_clip_id.items()):
        gesture = gesture_by_id.get(clip_id)
        if gesture is None:
            continue
        if len(matching_runtime) != 1:
            errors.append(
                f"gesture clip {clip_id} 必须由唯一一条 runtime_state_span 引用"
            )
            continue
        runtime = matching_runtime[0]
        if (
            runtime["viseme"] != gesture["viseme"]
            or runtime["take"] != gesture["take"]
        ):
            errors.append(
                f"runtime_state_span 与 gesture clip {clip_id} 的 "
                "viseme/take 不一致"
            )
    unreferenced_gestures = sorted(ids - clip_ids)
    if unreferenced_gestures:
        errors.append(
            "gesture_clips 未被 runtime_state_spans 引用："
            + ", ".join(unreferenced_gestures)
        )
    for viseme, count in counts.items():
        if count < 2:
            errors.append(f"{viseme} 只有 {count} 条 take，质量门要求至少 2 条")
    peak_strengths_by_viseme = {}
    for viseme in VOWEL_VISEMES:
        takes = sorted(
            peak_strength_records[viseme],
            key=lambda item: (item["take"], item["clip_id"]),
        )
        available_strengths = sorted(
            {item["peak_strength_level"] for item in takes}
        )
        peak_strengths_by_viseme[viseme] = {
            "takes": takes,
            "available_strength_levels": available_strengths,
            "has_strength_variation": len(available_strengths) > 1,
        }
        if len(takes) >= 2 and len(available_strengths) == 1:
            warnings.append(
                f"{viseme} 的 {len(takes)} 条 take 都是绝对峰值强度 "
                f"{available_strengths[0]:g}；它们只是不同动作 take，"
                "不能当成强弱两档素材"
            )

    visual_identity = library.get("visual_identity")
    if not isinstance(visual_identity, dict):
        errors.append("visual_identity 必须是对象")
    else:
        for viseme in VISEMES:
            if not isinstance(visual_identity.get(viseme), str) or not visual_identity[viseme]:
                errors.append(f"visual_identity.{viseme} 缺失")

    natural_transition_spans = library.get("natural_transition_spans")
    if not isinstance(natural_transition_spans, list):
        errors.append("natural_transition_spans 必须是数组")
        natural_transition_spans = []
    elif not natural_transition_spans:
        warnings.append("natural_transition_spans 为空；仍可渲染，但过渡选择更受限")

    valid_natural_transition_spans = 0
    natural_edges: list[dict[str, Any]] = []
    for index, span in enumerate(natural_transition_spans):
        label = f"natural_transition_spans[{index}]"
        if not isinstance(span, dict):
            errors.append(f"{label} 必须是对象")
            continue

        from_viseme = span.get("from")
        to_viseme = span.get("to")
        if from_viseme not in VOWEL_VISEMES:
            errors.append(f"{label}.from 必须是 A/I/U/E/O")
        if to_viseme not in VOWEL_VISEMES:
            errors.append(f"{label}.to 必须是 A/I/U/E/O")
        if (
            from_viseme in VOWEL_VISEMES
            and to_viseme in VOWEL_VISEMES
            and from_viseme == to_viseme
        ):
            errors.append(f"{label}.from 与 .to 不能相同")

        take = span.get("take")
        if not _positive_int(take):
            errors.append(f"{label}.take 必须是正整数")

        bounds_valid = True
        try:
            start, end = span_bounds(span, label)
        except ValueError as error:
            errors.append(str(error))
            bounds_valid = False
        if bounds_valid:
            if end > source_frame_count:
                errors.append(f"{label} 超出源帧")
                bounds_valid = False
            if end - start < 4:
                errors.append(f"{label} 至少需要连续 4 帧")
                bounds_valid = False

        endpoint_gestures: dict[str, dict[str, Any]] = {}
        endpoint_actions_exist = (
            from_viseme in VOWEL_VISEMES
            and to_viseme in VOWEL_VISEMES
        )
        if _positive_int(take) and endpoint_actions_exist:
            for endpoint_name, endpoint_viseme in (
                ("from", from_viseme),
                ("to", to_viseme),
            ):
                gesture = gesture_by_state_take.get((endpoint_viseme, take))
                if gesture is None:
                    errors.append(
                        f"{label}.{endpoint_name}={endpoint_viseme} "
                        f"take {take} 没有对应 gesture clip"
                    )
                    endpoint_actions_exist = False
                else:
                    endpoint_gestures[endpoint_name] = gesture

        transition_valid = (
            from_viseme in VOWEL_VISEMES
            and to_viseme in VOWEL_VISEMES
            and from_viseme != to_viseme
            and _positive_int(take)
            and bounds_valid
            and endpoint_actions_exist
        )
        endpoint_records: tuple[dict[str, Any], dict[str, Any]] | None = None
        if transition_valid:
            entry_records = [
                record
                for record in runtime_records
                if record["start"] <= start < record["end"]
            ]
            exit_records = [
                record
                for record in runtime_records
                if record["start"] <= end - 1 < record["end"]
            ]
            if len(entry_records) != 1 or len(exit_records) != 1:
                errors.append(
                    f"{label} 的入口或出口无法唯一映射到 runtime_state_spans"
                )
                transition_valid = False
            else:
                entry_record = entry_records[0]
                exit_record = exit_records[0]
                endpoint_records = (entry_record, exit_record)
                state_path = _compressed_states(runtime_records, start, end)
                if (
                    entry_record["viseme"] != from_viseme
                    or exit_record["viseme"] != to_viseme
                    or state_path != [from_viseme, to_viseme]
                ):
                    errors.append(
                        f"{label} 方向与 runtime_state_spans 不一致："
                        f"声明 {from_viseme}→{to_viseme}，"
                        f"区间正向状态为 {'→'.join(state_path) or '空'}"
                    )
                    transition_valid = False
                mismatched_runtime_takes = [
                    f"{name}={record['take']}"
                    for name, record in (
                        ("from", entry_record),
                        ("to", exit_record),
                    )
                    if record["take"] != take
                ]
                if mismatched_runtime_takes:
                    errors.append(
                        f"{label}.take={take} 与元音端点的 runtime take "
                        f"不一致：{', '.join(mismatched_runtime_takes)}"
                    )
                    transition_valid = False

        endpoint_nodes: list[str] = []
        if transition_valid and endpoint_records is not None:
            for endpoint_name, endpoint_viseme in (
                ("from", from_viseme),
                ("to", to_viseme),
            ):
                gesture = endpoint_gestures[endpoint_name]
                endpoint_frame = (
                    start if endpoint_name == "from" else end - 1
                )
                if not (
                    gesture["start"]
                    <= endpoint_frame
                    < gesture["end"]
                ):
                    errors.append(
                        f"{label}.{endpoint_name} 对应 gesture clip "
                        f"{gesture['id']} 不包含端点帧 f{endpoint_frame}"
                    )
                    transition_valid = False
                endpoint_nodes.append(gesture["node_id"])

        if transition_valid and len(endpoint_nodes) == 2:
            valid_natural_transition_spans += 1
            natural_edges.append(
                {
                    "from_node": endpoint_nodes[0],
                    "to_node": endpoint_nodes[1],
                    "from_state": from_viseme,
                    "to_state": to_viseme,
                    "take": take,
                    "start_frame": start,
                    "end_frame_exclusive": end,
                    "direction": "source-frame-forward",
                }
            )

    scheduler_nodes: list[dict[str, Any]] = [
        {
            **record,
            "kind": "closed_idle",
            "has_schedulable_low_endpoints": True,
        }
        for record in closed_records
        if isinstance(record.get("id"), str) and record["id"]
    ] + [
        {
            **record,
            "kind": "gesture",
        }
        for record in gesture_records
    ]
    scheduler_node_ids = [record["node_id"] for record in scheduler_nodes]
    nodes_without_low_ports = sorted(
        record["node_id"]
        for record in scheduler_nodes
        if not record.get("has_schedulable_low_endpoints")
        or not isinstance(record.get("low_entry_frame"), int)
        or not isinstance(record.get("low_exit_frame"), int)
    )
    present_states = {record["viseme"] for record in scheduler_nodes}
    missing_scheduler_states = sorted(set(VISEMES) - present_states)
    compatible_seam_ready = (
        bool(closed_records)
        and not nodes_without_low_ports
        and not missing_scheduler_states
        and all(count >= 2 for count in counts.values())
    )
    natural_edge_pairs = [
        (edge["from_node"], edge["to_node"]) for edge in natural_edges
    ]
    natural_node_ids = [
        record["node_id"]
        for record in gesture_records
        if isinstance(record.get("id"), str) and record["id"]
    ]
    natural_reachability = _directed_reachability(
        natural_node_ids,
        natural_edge_pairs,
    )
    node_state_by_id = {
        record["node_id"]: record["viseme"] for record in gesture_records
    }
    natural_adjacency = {node_id: set() for node_id in natural_node_ids}
    for source_node, target_node in natural_edge_pairs:
        if source_node in natural_adjacency:
            natural_adjacency[source_node].add(target_node)
    missing_natural_clip_edges_by_source = {
        source_node: sorted(
            target_node
            for target_node in natural_node_ids
            if node_state_by_id[target_node] != node_state_by_id[source_node]
            and target_node not in natural_adjacency[source_node]
        )
        for source_node in natural_node_ids
    }
    unique_natural_state_edges = sorted(
        {
            f"{edge['from_state']}->{edge['to_state']}"
            for edge in natural_edges
        }
    )
    expected_state_edges = [
        f"{source}->{target}"
        for source in VOWEL_VISEMES
        for target in VOWEL_VISEMES
        if source != target
    ]
    missing_natural_state_edges = sorted(
        set(expected_state_edges) - set(unique_natural_state_edges)
    )
    if missing_natural_state_edges:
        warnings.append(
            "natural transition 有向图并不完整；缺少 "
            f"{len(missing_natural_state_edges)} 条状态边。"
            "这些边只能作为低口型兼容接缝候选，不能标成自然连续边。"
        )
    if not compatible_seam_ready:
        errors.append(
            "并非所有 CLOSED/元音动作都具有可供调度的显式低口型入口和出口"
        )

    quality_ready = not errors
    return {
        "ok": quality_ready,
        "quality_ready": quality_ready,
        "errors": errors,
        "warnings": warnings,
        "source": {
            "id": source_id,
            "fps": round(source_fps, 6),
            "frame_count": source_frame_count,
            "crop_xywh": list(source_crop),
        },
        "counts": {
            "runtime_state_spans": len(runtime_spans),
            "closed_motion_clips": len(closed_clips),
            "gesture_clips": len(gestures),
            "takes_by_viseme": counts,
            "natural_transition_spans": len(natural_transition_spans),
            "valid_natural_transition_spans": valid_natural_transition_spans,
        },
        "gesture_peak_strengths_by_viseme": peak_strengths_by_viseme,
        "clip_directed_reachability": {
            "nodes": scheduler_nodes,
            "natural_directed_edges": natural_edges,
            "natural_adjacency": {
                node_id: sorted(targets)
                for node_id, targets in natural_adjacency.items()
            },
            "natural_reachable_from": natural_reachability,
            "missing_natural_clip_edges_by_source": (
                missing_natural_clip_edges_by_source
            ),
            "natural_state_edges": unique_natural_state_edges,
            "missing_natural_state_edges": missing_natural_state_edges,
            "natural_graph_is_strongly_connected": bool(natural_node_ids)
            and all(
                len(reachable) == len(natural_node_ids) - 1
                for reachable in natural_reachability.values()
            ),
            "compatible_seam_scheduler": {
                "ready": compatible_seam_ready,
                "all_nodes_have_explicit_low_endpoints": (
                    not nodes_without_low_ports
                ),
                "nodes_without_explicit_low_endpoints": nodes_without_low_ports,
                "missing_states": missing_scheduler_states,
                "candidate_adjacency": {
                    node_id: [
                        target
                        for target in scheduler_node_ids
                        if target != node_id
                    ]
                    for node_id in scheduler_node_ids
                },
                "edge_semantics": (
                    "候选边只表示两端都有 AI 标注的低口型端点；"
                    "运行时仍须通过画面与运动兼容门。它不是 natural 连续边。"
                ),
            },
        },
        "classification_boundary": {
            "ai_decides": [
                "A/I/U/E/O/CLOSED",
                "gesture 内部 rise/fall/representative 的相对 0-4 阶段",
                "每条 gesture 的绝对峰值 peak_strength_level 1.0-4.0",
                "gesture spans",
                "natural transition visual continuity",
            ],
            "code_decides": [
                "file existence",
                "source identity",
                "frame bounds",
                "coverage",
                "overlap",
                "required counts",
                "peak_strength_level 类型、范围及各元音实际强度差异报告",
                "gesture clip/take 与 runtime_state_span 对应关系",
                "显式低口型入口、峰值、低口型出口的正向顺序",
                "natural transition 的正向状态路径、take 与动作对应关系",
                "clip 级 natural 有向可达性与缺边清单",
            ],
        },
    }

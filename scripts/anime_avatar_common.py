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
    if not isinstance(start, int) or not isinstance(end, int):
        raise ValueError(f"{label} 缺少整数帧边界")
    if start < 0 or end <= start:
        raise ValueError(f"{label} 帧边界无效：[{start}, {end})")
    return start, end


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
        if end > source_frame_count:
            errors.append(f"runtime_state_spans[{index}] 超出源帧")
        else:
            coverage[start:end] += 1
        if viseme != "CLOSED":
            clip_id = span.get("clip_id")
            if not isinstance(clip_id, str) or not clip_id:
                errors.append(f"runtime_state_spans[{index}] 缺少 clip_id")
            else:
                clip_ids.add(clip_id)
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
    for index, clip in enumerate(closed_clips):
        if not isinstance(clip, dict):
            errors.append(f"closed_motion_clips[{index}] 必须是对象")
            continue
        try:
            _, end = span_bounds(clip, f"closed_motion_clips[{index}]")
            if end > source_frame_count:
                errors.append(f"closed_motion_clips[{index}] 超出源帧")
        except ValueError as error:
            errors.append(str(error))

    gestures = library.get("gesture_clips")
    if not isinstance(gestures, list):
        gestures = []
        errors.append("gesture_clips 必须是数组")
    ids: set[str] = set()
    counts = {viseme: 0 for viseme in VOWEL_VISEMES}
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
        try:
            start, end = span_bounds(clip, f"gesture_clips[{index}]")
        except ValueError as error:
            errors.append(str(error))
            continue
        if end > source_frame_count:
            errors.append(f"gesture_clips[{index}] 超出源帧")
        for field in (
            "rise_frames_by_intensity",
            "fall_frames_by_intensity",
            "representative_frames_by_intensity",
        ):
            values = clip.get(field)
            if (
                not isinstance(values, list)
                or len(values) != 5
                or any(not isinstance(value, int) for value in values)
            ):
                errors.append(f"gesture_clips[{index}].{field} 必须有五个整数帧")
                continue
            maximum = end if field in {
                "rise_frames_by_intensity",
                "fall_frames_by_intensity",
            } else end - 1
            outside = [value for value in values if value < start or value > maximum]
            if outside:
                errors.append(
                    f"gesture_clips[{index}].{field} 有帧越出 [{start}, {end})"
                )
        peak = clip.get("peak_frame_range_inclusive")
        if (
            not isinstance(peak, list)
            or len(peak) != 2
            or any(not isinstance(value, int) for value in peak)
            or peak[0] > peak[1]
            or peak[0] < start
            or peak[1] >= end
        ):
            errors.append(
                f"gesture_clips[{index}].peak_frame_range_inclusive 无效"
            )
    missing_clip_ids = sorted(clip_ids - ids)
    if missing_clip_ids:
        errors.append(
            "runtime_state_spans 引用了不存在的 clip_id："
            + ", ".join(missing_clip_ids)
        )
    for viseme, count in counts.items():
        if count < 2:
            errors.append(f"{viseme} 只有 {count} 条 take，质量门要求至少 2 条")

    visual_identity = library.get("visual_identity")
    if not isinstance(visual_identity, dict):
        errors.append("visual_identity 必须是对象")
    else:
        for viseme in VISEMES:
            if not isinstance(visual_identity.get(viseme), str) or not visual_identity[viseme]:
                errors.append(f"visual_identity.{viseme} 缺失")

    if not library.get("natural_transition_spans"):
        warnings.append("没有记录 natural_transition_spans；仍可渲染，但过渡选择更受限")
    return {
        "ok": not errors,
        "quality_ready": not errors,
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
        },
        "classification_boundary": {
            "ai_decides": ["A/I/U/E/O/CLOSED", "0-4 intensity", "gesture spans"],
            "code_decides": [
                "file existence",
                "source identity",
                "frame bounds",
                "coverage",
                "overlap",
                "required counts",
            ],
        },
    }

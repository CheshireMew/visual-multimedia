#!/usr/bin/env python3
"""Shared media and provenance primitives for the active anime-avatar workflow."""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any

from media_task_workspace import assert_skill_task_path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


SKILL_ROOT = Path(__file__).resolve().parent.parent


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FileNotFoundError(f"文件不存在：{path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"JSON 无法解析：{path}\n{error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"JSON 根节点必须是对象：{path}")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def executable(name: str, override: str | None = None) -> str:
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.is_file():
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
        detail = result.stderr.strip() or result.stdout.strip() if capture else ""
        raise RuntimeError(
            f"命令执行失败（{result.returncode}）：{' '.join(command)}"
            + (f"\n{detail}" if detail else "")
        )
    return result


def probe_media(source: Path, ffprobe: str) -> dict[str, Any]:
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
    streams = payload.get("streams", [])
    video_streams = [
        item for item in streams if item.get("codec_type") == "video"
    ]
    audio_streams = [
        item for item in streams if item.get("codec_type") == "audio"
    ]
    container_duration = float(payload.get("format", {}).get("duration") or 0.0)
    result_payload: dict[str, Any] = {
        "path": str(source),
        "duration_seconds": container_duration,
        "container_duration_seconds": container_duration,
        "bytes": int(payload.get("format", {}).get("size") or source.stat().st_size),
        "has_video": bool(video_streams),
        "has_audio": bool(audio_streams),
        "audio_codec": audio_streams[0].get("codec_name") if audio_streams else None,
        "audio_duration_seconds": None,
    }
    if audio_streams:
        audio_duration = max(
            [float(item.get("duration") or 0.0) for item in audio_streams],
            default=0.0,
        )
        result_payload["audio_duration_seconds"] = audio_duration or container_duration
    if video_streams:
        stream = video_streams[0]
        rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"
        numerator, denominator = rate.split("/", 1)
        fps = float(numerator) / max(float(denominator), 1.0)
        declared_frames = (
            int(stream["nb_frames"])
            if str(stream.get("nb_frames") or "").isdigit()
            else None
        )
        video_duration = float(stream.get("duration") or 0.0)
        if video_duration <= 0 and declared_frames and fps > 0:
            video_duration = declared_frames / fps
        video_duration = video_duration or container_duration
        result_payload.update(
            {
                "width": int(stream.get("width") or 0),
                "height": int(stream.get("height") or 0),
                "fps": fps,
                "duration_seconds": video_duration or container_duration,
                "video_duration_seconds": video_duration,
                "declared_frame_count": declared_frames,
                "codec": stream.get("codec_name"),
            }
        )
    return result_payload


def probe_video(source: Path, ffprobe: str) -> dict[str, Any]:
    probe = probe_media(source, ffprobe)
    if not probe["has_video"]:
        raise ValueError(f"视频没有可读取画面轨：{source}")
    return probe


def ensure_skill_task_project(project: str | Path) -> Path:
    root = assert_skill_task_path(project, "角色源素材项目")
    if not root.is_dir():
        raise FileNotFoundError(f"媒体项目目录不存在：{root}")
    manifest = root / "media-sources.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"项目目录缺少 media-sources.json：{root}")
    return root


def validate_media_manifest(manifest_path: Path) -> dict[str, Any]:
    validator = SKILL_ROOT / "scripts" / "validate-media-sources.mjs"
    result = run(
        [
            executable("node"),
            str(validator),
            str(manifest_path),
            "--json",
        ]
    )
    report = json.loads(result.stdout)
    if not report.get("ok"):
        raise ValueError(
            "media-sources.json 未通过校验：\n- "
            + "\n- ".join(report.get("errors", []))
        )
    manifest = read_json(manifest_path)
    if manifest.get("protocol") != "visual-multimedia-media-sources":
        raise ValueError("media-sources.json protocol 不正确")
    if manifest.get("version") != 3:
        raise ValueError("活动二次元角色流程只接受 media-sources v3")
    return manifest


def resolve_source(
    manifest: dict[str, Any],
    source_root: Path,
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
    record = matches[0]
    if expected_types and record.get("media_type") not in expected_types:
        raise ValueError(
            f"素材 {source_id} 类型为 {record.get('media_type')}，"
            f"预期 {sorted(expected_types)}"
        )
    path = (source_root / record["file"]).resolve()
    try:
        path.relative_to(source_root.resolve())
    except ValueError as error:
        raise ValueError(f"素材路径越出所属资源目录：{path}") from error
    if not path.is_file():
        raise FileNotFoundError(f"素材文件不存在：{path}")
    integrity = record.get("integrity") or {}
    expected_hash = integrity.get("sha256")
    if not expected_hash or file_sha256(path) != expected_hash:
        raise ValueError(f"素材 {source_id} 的真实哈希与账本不一致")
    return record, path


def parse_xywh(value: Any, field: str) -> tuple[int, int, int, int]:
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(isinstance(item, bool) or not isinstance(item, int) for item in value)
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
        raise ValueError(f"{field} {crop} 超出画面 {frame_width}x{frame_height}")


def load_cropped_frames(
    source: Path,
    crop: tuple[int, int, int, int],
) -> tuple[list[np.ndarray], float]:
    capture = cv2.VideoCapture(str(source))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    ensure_crop(crop, frame_width, frame_height, "calibration.source_crop_xywh")
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


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def _fit_image(image: Image.Image, width: int, height: int) -> Image.Image:
    copy = image.copy()
    copy.thumbnail((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (width, height), "#ffffff")
    canvas.paste(copy, ((width - copy.width) // 2, (height - copy.height) // 2))
    return canvas


def sampled_indices(
    frame_count: int,
    fps: float,
    samples_per_second: float,
) -> list[int]:
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


def contact_sheet(
    frames: list[np.ndarray],
    indices: list[int],
    fps: float,
    destination: Path,
    *,
    local_crop: tuple[int, int, int, int] | None = None,
    columns: int = 5,
) -> None:
    if not indices:
        raise ValueError("联系表没有可绘制的帧")
    cell_width = 260
    cell_height = 260
    label_height = 40
    gutter = 10
    margin = 16
    rows = math.ceil(len(indices) / columns)
    canvas = Image.new(
        "RGB",
        (
            margin * 2 + columns * cell_width + (columns - 1) * gutter,
            margin * 2
            + rows * (cell_height + label_height)
            + (rows - 1) * gutter,
        ),
        "#151515",
    )
    draw = ImageDraw.Draw(canvas)
    label_font = _font(18, bold=True)
    for cell_index, frame_index in enumerate(indices):
        frame = frames[frame_index]
        if local_crop is not None:
            x, y, width, height = local_crop
            ensure_crop(local_crop, frame.shape[1], frame.shape[0], "mouth_review_crop")
            frame = frame[y : y + height, x : x + width]
        image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        row, column = divmod(cell_index, columns)
        left = margin + column * (cell_width + gutter)
        top = margin + row * (cell_height + label_height + gutter)
        canvas.paste(_fit_image(image, cell_width, cell_height), (left, top))
        draw.rectangle(
            (left, top + cell_height, left + cell_width, top + cell_height + label_height),
            fill="#242424",
        )
        draw.text(
            (left + 8, top + cell_height + 7),
            f"f{frame_index:04d}  {frame_index / fps:06.3f}s",
            fill="#ffffff",
            font=label_font,
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, quality=92)

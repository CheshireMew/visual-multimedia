#!/usr/bin/env python3
"""Validate and render a fixed inset from an already validated avatar track."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageColor, ImageDraw, ImageFilter

from anime_avatar_media import (
    ensure_crop,
    executable,
    parse_xywh,
    probe_video,
    read_json,
    resolve_source,
    run,
    validate_media_manifest,
    write_json,
)


PROTOCOL = "visual-multimedia-anime-avatar-inset"
VERSION = 1
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
HEX_COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")


def number(value: Any, field: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} 必须是数字")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field} 必须是有限数字")
    if minimum is not None and result < minimum:
        raise ValueError(f"{field} 不能小于 {minimum}")
    return result


def integer(
    value: Any,
    field: str,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} 必须是整数")
    if minimum is not None and value < minimum:
        raise ValueError(f"{field} 不能小于 {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{field} 不能大于 {maximum}")
    return value


def object_with_keys(
    value: Any,
    field: str,
    required: set[str],
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} 必须是对象")
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required)
    if missing:
        raise ValueError(f"{field} 缺少字段：{', '.join(missing)}")
    if unknown:
        raise ValueError(f"{field} 含未知字段：{', '.join(unknown)}")
    return value


def color(value: Any, field: str) -> str:
    if not isinstance(value, str) or not HEX_COLOR_PATTERN.fullmatch(value):
        raise ValueError(f"{field} 必须是六位十六进制颜色，例如 #FFFFFF")
    return value.upper()


def stable_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ValueError(f"{field} 必须是稳定的小写 source id")
    return value


def project_root(value: str) -> Path:
    root = Path(value).expanduser().resolve()
    manifest = root / "media-sources.json"
    if not root.is_dir() or not manifest.is_file():
        raise FileNotFoundError(f"项目目录缺少 media-sources.json：{root}")
    return root


def path_in_project(root: Path, value: str | None, default: Path) -> Path:
    candidate = (
        Path(value).expanduser()
        if value
        else default
    )
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"配置文件必须位于项目目录内：{candidate}") from error
    return candidate


def load_sources(
    root: Path,
    job: dict[str, Any],
    ffprobe: str,
) -> dict[str, Any]:
    manifest = validate_media_manifest(root / "media-sources.json")
    _, base_path = resolve_source(
        manifest,
        root,
        job.get("base_source_id"),
        {"video"},
    )
    _, avatar_path = resolve_source(
        manifest,
        root,
        job.get("avatar_source_id"),
        {"video"},
    )
    return {
        "manifest": manifest,
        "base_path": base_path,
        "avatar_path": avatar_path,
        "base_probe": probe_video(base_path, ffprobe),
        "avatar_probe": probe_video(avatar_path, ffprobe),
    }


def validate_job(
    payload: dict[str, Any],
    sources: dict[str, Any],
) -> dict[str, Any]:
    required_root = {
        "protocol",
        "version",
        "job_id",
        "base_source_id",
        "avatar_source_id",
        "timing",
        "window",
        "audio",
    }
    object_with_keys(payload, "任务", required_root)
    if payload.get("protocol") != PROTOCOL:
        raise ValueError(f"protocol 必须是 {PROTOCOL}")
    if payload.get("version") != VERSION:
        raise ValueError("version 必须是 1")
    job_id = stable_id(payload.get("job_id"), "job_id")
    stable_id(payload.get("base_source_id"), "base_source_id")
    stable_id(payload.get("avatar_source_id"), "avatar_source_id")

    timing = object_with_keys(
        payload.get("timing"),
        "timing",
        {
            "timeline_start_seconds",
            "avatar_start_seconds",
            "duration_seconds",
            "end_behavior",
        },
    )
    timeline_start = number(
        timing.get("timeline_start_seconds"),
        "timing.timeline_start_seconds",
        minimum=0,
    )
    avatar_start = number(
        timing.get("avatar_start_seconds"),
        "timing.avatar_start_seconds",
        minimum=0,
    )
    requested_duration = timing.get("duration_seconds")
    if requested_duration is not None:
        requested_duration = number(
            requested_duration,
            "timing.duration_seconds",
        )
        if requested_duration <= 0:
            raise ValueError("timing.duration_seconds 必须大于 0")
    end_behavior = timing.get("end_behavior")
    if end_behavior not in {"require-full-track", "hide"}:
        raise ValueError(
            "timing.end_behavior 必须是 require-full-track 或 hide"
        )

    window = object_with_keys(
        payload.get("window"),
        "window",
        {"shape", "x", "y", "size", "avatar_crop_xywh", "border", "shadow"},
    )
    shape = window.get("shape")
    if shape not in {"circle", "square"}:
        raise ValueError("window.shape 必须是 circle 或 square")
    x = integer(window.get("x"), "window.x", minimum=0)
    y = integer(window.get("y"), "window.y", minimum=0)
    size = integer(window.get("size"), "window.size", minimum=64, maximum=4096)
    crop = parse_xywh(window.get("avatar_crop_xywh"), "window.avatar_crop_xywh")
    if crop[2] != crop[3]:
        raise ValueError("window.avatar_crop_xywh 必须是正方形，避免人物被拉伸")

    border = object_with_keys(
        window.get("border"),
        "window.border",
        {"width", "color"},
    )
    border_width = integer(
        border.get("width"),
        "window.border.width",
        minimum=0,
        maximum=64,
    )
    border_color = color(border.get("color"), "window.border.color")
    if border_width * 2 >= size:
        raise ValueError("边框宽度必须小于窗口尺寸的一半")

    shadow = object_with_keys(
        window.get("shadow"),
        "window.shadow",
        {"enabled", "offset_x", "offset_y", "blur_radius", "color", "opacity"},
    )
    if not isinstance(shadow.get("enabled"), bool):
        raise ValueError("window.shadow.enabled 必须是布尔值")
    shadow_offset_x = integer(
        shadow.get("offset_x"),
        "window.shadow.offset_x",
        minimum=-128,
        maximum=128,
    )
    shadow_offset_y = integer(
        shadow.get("offset_y"),
        "window.shadow.offset_y",
        minimum=-128,
        maximum=128,
    )
    shadow_blur = integer(
        shadow.get("blur_radius"),
        "window.shadow.blur_radius",
        minimum=0,
        maximum=128,
    )
    shadow_color = color(shadow.get("color"), "window.shadow.color")
    shadow_opacity = number(
        shadow.get("opacity"),
        "window.shadow.opacity",
        minimum=0,
    )
    if shadow_opacity > 1:
        raise ValueError("window.shadow.opacity 不能大于 1")

    audio = object_with_keys(
        payload.get("audio"),
        "audio",
        {"source", "base_gain_db", "avatar_gain_db"},
    )
    audio_source = audio.get("source")
    if audio_source not in {"avatar", "base", "mix", "none"}:
        raise ValueError("audio.source 必须是 avatar、base、mix 或 none")
    base_gain = number(audio.get("base_gain_db"), "audio.base_gain_db")
    avatar_gain = number(audio.get("avatar_gain_db"), "audio.avatar_gain_db")
    if not -60 <= base_gain <= 12 or not -60 <= avatar_gain <= 12:
        raise ValueError("audio 增益必须位于 -60 到 12 dB")

    base_probe = sources["base_probe"]
    avatar_probe = sources["avatar_probe"]
    if base_probe["width"] % 2 or base_probe["height"] % 2:
        raise ValueError("底片宽高必须是偶数，才能稳定输出 H.264 yuv420p")
    if x + size > base_probe["width"] or y + size > base_probe["height"]:
        raise ValueError(
            f"窗口 [{x}, {y}, {size}, {size}] 超出底片 "
            f"{base_probe['width']}x{base_probe['height']}"
        )
    ensure_crop(
        crop,
        avatar_probe["width"],
        avatar_probe["height"],
        "window.avatar_crop_xywh",
    )
    if timeline_start >= base_probe["duration_seconds"]:
        raise ValueError("timing.timeline_start_seconds 已超过底片时长")
    if avatar_start >= avatar_probe["duration_seconds"]:
        raise ValueError("timing.avatar_start_seconds 已超过角色轨时长")

    available_base = base_probe["video_duration_seconds"] - timeline_start
    available_avatar_video = (
        avatar_probe["video_duration_seconds"] - avatar_start
    )
    audio_tail = 0.0
    audio_duration = avatar_probe.get("audio_duration_seconds")
    if audio_duration is not None:
        available_avatar_audio = max(0.0, float(audio_duration) - avatar_start)
        audio_tail = max(0.0, available_avatar_audio - available_avatar_video)
    requested_window_duration = (
        available_base
        if requested_duration is None
        else requested_duration
    )
    if requested_window_duration > available_base + 0.01:
        raise ValueError("timing.duration_seconds 超过底片剩余时长")
    if requested_duration is None:
        active_duration = requested_window_duration
    else:
        active_duration = requested_window_duration
    if end_behavior == "hide":
        active_duration = min(active_duration, available_avatar_video)
    else:
        allowed_boundary_gap = 1.0 / avatar_probe["fps"] + 0.001
        if available_avatar_video + allowed_boundary_gap < active_duration:
            raise ValueError(
                "角色轨短于角色窗持续时间："
                f"需要 {active_duration:.6f}s，"
                f"画面只有 {available_avatar_video:.6f}s。"
                "角色窗入口不会拉长、冻结或重写角色轨；"
                "请提供已经完整覆盖该区间并通过观看确认的动态角色轨"
            )
    if active_duration <= 0:
        raise ValueError("角色窗没有可渲染时长")
    boundary_pad = max(0.0, active_duration - available_avatar_video)

    if audio_source in {"base", "mix"} and not base_probe["has_audio"]:
        raise ValueError(f"audio.source={audio_source}，但底片没有音轨")
    if audio_source in {"avatar", "mix"} and not avatar_probe["has_audio"]:
        raise ValueError(f"audio.source={audio_source}，但角色轨没有音轨")

    return {
        "job_id": job_id,
        "timeline_start_seconds": timeline_start,
        "avatar_start_seconds": avatar_start,
        "active_duration_seconds": active_duration,
        "timeline_end_seconds": timeline_start + active_duration,
        "requested_window_duration_seconds": requested_window_duration,
        "end_behavior": end_behavior,
        "boundary_pad_seconds": boundary_pad,
        "source_audio_tail_seconds": audio_tail,
        "shape": shape,
        "x": x,
        "y": y,
        "size": size,
        "inner_size": size - 2 * border_width,
        "crop": crop,
        "border_width": border_width,
        "border_color": border_color,
        "shadow_enabled": shadow["enabled"],
        "shadow_offset_x": shadow_offset_x,
        "shadow_offset_y": shadow_offset_y,
        "shadow_blur": shadow_blur,
        "shadow_color": shadow_color,
        "shadow_opacity": shadow_opacity,
        "audio_source": audio_source,
        "base_gain_db": base_gain,
        "avatar_gain_db": avatar_gain,
    }


def shape_mask(size: int, shape: str, *, supersample: int = 4) -> Image.Image:
    if shape == "square":
        return Image.new("L", (size, size), 255)
    large_size = size * supersample
    mask = Image.new("L", (large_size, large_size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((1, 1, large_size - 2, large_size - 2), fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def make_visual_assets(
    destination: Path,
    values: dict[str, Any],
) -> dict[str, Any]:
    destination.mkdir(parents=True, exist_ok=True)
    mask_path = destination / "avatar-mask.png"
    shape_mask(values["inner_size"], values["shape"]).save(mask_path)
    assets: dict[str, Any] = {"mask": mask_path}

    if values["border_width"] > 0:
        border_path = destination / "border.png"
        border_mask = shape_mask(values["size"], values["shape"])
        border = Image.new(
            "RGBA",
            (values["size"], values["size"]),
            ImageColor.getrgb(values["border_color"]) + (0,),
        )
        border.putalpha(border_mask)
        border.save(border_path)
        assets["border"] = border_path

    if values["shadow_enabled"] and values["shadow_opacity"] > 0:
        blur = values["shadow_blur"]
        offset_x = values["shadow_offset_x"]
        offset_y = values["shadow_offset_y"]
        padding = max(
            2,
            int(math.ceil(blur * 3 + max(abs(offset_x), abs(offset_y)) + 2)),
        )
        canvas_size = values["size"] + padding * 2
        alpha = Image.new("L", (canvas_size, canvas_size), 0)
        source_mask = shape_mask(values["size"], values["shape"])
        alpha.paste(
            source_mask,
            (padding + offset_x, padding + offset_y),
        )
        if blur:
            alpha = alpha.filter(ImageFilter.GaussianBlur(radius=blur))
        opacity = values["shadow_opacity"]
        alpha = alpha.point(lambda value: int(round(value * opacity)))
        shadow = Image.new(
            "RGBA",
            (canvas_size, canvas_size),
            ImageColor.getrgb(values["shadow_color"]) + (0,),
        )
        shadow.putalpha(alpha)
        shadow_path = destination / "shadow.png"
        shadow.save(shadow_path)
        assets.update({"shadow": shadow_path, "shadow_padding": padding})
    return assets


def escape_between(start: float, end: float) -> str:
    return f"between(t\\,{start:.6f}\\,{end:.6f})"


def render_video(
    *,
    job: dict[str, Any],
    values: dict[str, Any],
    sources: dict[str, Any],
    assets: dict[str, Any],
    output: Path,
    ffmpeg: str,
) -> list[str]:
    base_probe = sources["base_probe"]
    fps = base_probe["fps"]
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(sources["base_path"]),
        "-i",
        str(sources["avatar_path"]),
        "-loop",
        "1",
        "-framerate",
        f"{fps:.9f}",
        "-i",
        str(assets["mask"]),
    ]
    mask_index = 2
    next_index = 3
    shadow_index: int | None = None
    border_index: int | None = None
    if "shadow" in assets:
        shadow_index = next_index
        next_index += 1
        command.extend(
            [
                "-loop",
                "1",
                "-framerate",
                f"{fps:.9f}",
                "-i",
                str(assets["shadow"]),
            ]
        )
    if "border" in assets:
        border_index = next_index
        command.extend(
            [
                "-loop",
                "1",
                "-framerate",
                f"{fps:.9f}",
                "-i",
                str(assets["border"]),
            ]
        )

    crop_x, crop_y, crop_width, crop_height = values["crop"]
    start = values["timeline_start_seconds"]
    end = values["timeline_end_seconds"]
    active_duration = values["active_duration_seconds"]
    inner = values["inner_size"]
    enable = escape_between(start, end)
    filters = [
        "[0:v]setpts=PTS-STARTPTS,format=rgba[basev]",
        (
            f"[1:v]trim=start={values['avatar_start_seconds']:.6f},"
            "setpts=PTS-STARTPTS,"
            f"tpad=stop_mode=clone:stop_duration="
            f"{values['boundary_pad_seconds'] + 2.0 / sources['avatar_probe']['fps']:.6f},"
            f"trim=duration={active_duration:.6f},"
            f"crop={crop_width}:{crop_height}:{crop_x}:{crop_y},"
            f"scale={inner}:{inner}:flags=lanczos,setsar=1,format=rgba[avatarv]"
        ),
        (
            f"[{mask_index}:v]scale={inner}:{inner}:flags=lanczos,"
            "format=gray,setpts=PTS-STARTPTS[maskv]"
        ),
        (
            f"[avatarv][maskv]alphamerge=shortest=1,"
            f"setpts=PTS+{start:.6f}/TB[avataralpha]"
        ),
    ]
    current = "basev"
    layer_index = 0
    if shadow_index is not None:
        padding = assets["shadow_padding"]
        next_label = f"layer{layer_index}"
        filters.append(
            f"[{current}][{shadow_index}:v]overlay="
            f"x={values['x'] - padding}:y={values['y'] - padding}:"
            f"enable={enable}:eof_action=pass:shortest=0[{next_label}]"
        )
        current = next_label
        layer_index += 1
    if border_index is not None:
        next_label = f"layer{layer_index}"
        filters.append(
            f"[{current}][{border_index}:v]overlay="
            f"x={values['x']}:y={values['y']}:"
            f"enable={enable}:eof_action=pass:shortest=0[{next_label}]"
        )
        current = next_label
        layer_index += 1
    avatar_x = values["x"] + values["border_width"]
    avatar_y = values["y"] + values["border_width"]
    filters.append(
        f"[{current}][avataralpha]overlay=x={avatar_x}:y={avatar_y}:"
        f"enable={enable}:eof_action=pass:shortest=0,"
        f"fps={fps:.9f},format=yuv420p[vout]"
    )

    audio_source = values["audio_source"]
    if audio_source == "base":
        filters.append(
            f"[0:a:0]asetpts=PTS-STARTPTS,"
            f"volume={values['base_gain_db']:.3f}dB,"
            f"apad=pad_dur={base_probe['duration_seconds']:.6f},"
            f"atrim=duration={base_probe['duration_seconds']:.6f}[aout]"
        )
    elif audio_source == "avatar":
        delay_ms = int(round(start * 1000))
        filters.append(
            f"[1:a:0]atrim=start={values['avatar_start_seconds']:.6f}:"
            f"duration={active_duration:.6f},asetpts=PTS-STARTPTS,"
            f"volume={values['avatar_gain_db']:.3f}dB,"
            f"adelay={delay_ms}:all=1,"
            f"apad=pad_dur={base_probe['duration_seconds']:.6f},"
            f"atrim=duration={base_probe['duration_seconds']:.6f}[aout]"
        )
    elif audio_source == "mix":
        delay_ms = int(round(start * 1000))
        filters.extend(
            [
                (
                    f"[0:a:0]asetpts=PTS-STARTPTS,"
                    f"volume={values['base_gain_db']:.3f}dB,"
                    f"apad=pad_dur={base_probe['duration_seconds']:.6f},"
                    f"atrim=duration={base_probe['duration_seconds']:.6f}[basea]"
                ),
                (
                    f"[1:a:0]atrim=start={values['avatar_start_seconds']:.6f}:"
                    f"duration={active_duration:.6f},asetpts=PTS-STARTPTS,"
                    f"volume={values['avatar_gain_db']:.3f}dB,"
                    f"adelay={delay_ms}:all=1,"
                    f"apad=pad_dur={base_probe['duration_seconds']:.6f},"
                    f"atrim=duration={base_probe['duration_seconds']:.6f}[avatara]"
                ),
                (
                    "[basea][avatara]amix=inputs=2:duration=longest:"
                    "dropout_transition=0:normalize=0,"
                    f"atrim=duration={base_probe['duration_seconds']:.6f}[aout]"
                ),
            ]
        )

    command.extend(["-filter_complex", ";".join(filters), "-map", "[vout]"])
    if audio_source == "none":
        command.append("-an")
    else:
        command.extend(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"])
    command.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "15",
            "-tune",
            "animation",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "cfr",
            "-t",
            f"{base_probe['duration_seconds']:.6f}",
            "-movflags",
            "+faststart",
            "-n",
            str(output),
        ]
    )
    run(command)
    return command


def make_contact_sheet(
    source: Path,
    destination: Path,
    *,
    ffmpeg: str,
    ffprobe: str,
) -> None:
    script = Path(__file__).resolve().parent / "make-video-contact-sheet.py"
    run(
        [
            sys.executable,
            str(script),
            str(source),
            str(destination),
            "--frames",
            "12",
            "--cols",
            "4",
            "--ffmpeg",
            ffmpeg,
            "--ffprobe",
            ffprobe,
        ]
    )


def init_command(args: argparse.Namespace) -> int:
    root = project_root(args.project)
    ffprobe = executable("ffprobe", args.ffprobe)
    crop = [int(part.strip()) for part in args.avatar_crop.split(",")]
    if len(crop) != 4:
        raise ValueError("--avatar-crop 使用 x,y,width,height 四个整数")
    job = {
        "protocol": PROTOCOL,
        "version": VERSION,
        "job_id": args.job_id,
        "base_source_id": args.base_source_id,
        "avatar_source_id": args.avatar_source_id,
        "timing": {
            "timeline_start_seconds": args.timeline_start,
            "avatar_start_seconds": args.avatar_start,
            "duration_seconds": args.duration,
            "end_behavior": args.end_behavior,
        },
        "window": {
            "shape": args.shape,
            "x": args.x,
            "y": args.y,
            "size": args.size,
            "avatar_crop_xywh": crop,
            "border": {
                "width": args.border_width,
                "color": args.border_color,
            },
            "shadow": {
                "enabled": args.shadow,
                "offset_x": args.shadow_offset_x,
                "offset_y": args.shadow_offset_y,
                "blur_radius": args.shadow_blur,
                "color": args.shadow_color,
                "opacity": args.shadow_opacity,
            },
        },
        "audio": {
            "source": args.audio_source,
            "base_gain_db": args.base_gain_db,
            "avatar_gain_db": args.avatar_gain_db,
        },
    }
    sources = load_sources(root, job, ffprobe)
    values = validate_job(job, sources)
    destination = path_in_project(
        root,
        args.job,
        root / "avatar-insets" / f"{values['job_id']}.json",
    )
    if destination.exists():
        raise FileExistsError(f"不会覆盖已有角色窗任务：{destination}")
    write_json(destination, job)
    print(
        json.dumps(
            {
                "job": str(destination),
                "base": sources["base_probe"],
                "avatar": sources["avatar_probe"],
                "resolved": values,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def validate_command(args: argparse.Namespace) -> int:
    root = project_root(args.project)
    ffprobe = executable("ffprobe", args.ffprobe)
    job_path = path_in_project(root, args.job, root / "avatar-insets" / "unset.json")
    job = read_json(job_path)
    sources = load_sources(root, job, ffprobe)
    values = validate_job(job, sources)
    print(
        json.dumps(
            {
                "job": str(job_path),
                "sources": {
                    "base": {
                        "path": str(sources["base_path"]),
                        "probe": sources["base_probe"],
                    },
                    "avatar": {
                        "path": str(sources["avatar_path"]),
                        "probe": sources["avatar_probe"],
                    },
                },
                "resolved": values,
                "checks": {
                    "media_sources_v3_valid": True,
                    "real_source_files_resolved": True,
                    "fixed_crop_inside_avatar_frame": True,
                    "fixed_window_inside_base_frame": True,
                    "avatar_track_covers_requested_window": True,
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def render_command(args: argparse.Namespace) -> int:
    root = project_root(args.project)
    ffmpeg = executable("ffmpeg", args.ffmpeg)
    ffprobe = executable("ffprobe", args.ffprobe)
    job_path = path_in_project(root, args.job, root / "avatar-insets" / "unset.json")
    job = read_json(job_path)
    sources = load_sources(root, job, ffprobe)
    values = validate_job(job, sources)
    output = Path(args.output).expanduser()
    if not output.is_absolute():
        output = root / output
    output = output.resolve()
    try:
        output.relative_to(root)
    except ValueError as error:
        raise ValueError(f"输出必须位于项目目录内：{output}") from error
    if output.exists():
        raise FileExistsError(f"不会覆盖已有输出：{output}")
    output.parent.mkdir(parents=True, exist_ok=True)

    working = root / "working" / "avatar-insets" / values["job_id"]
    reports = root / "reports" / "avatar-insets" / values["job_id"]
    assets = make_visual_assets(working, values)
    command = render_video(
        job=job,
        values=values,
        sources=sources,
        assets=assets,
        output=output,
        ffmpeg=ffmpeg,
    )
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("FFmpeg 没有生成可用角色窗视频")
    output_probe = probe_video(output, ffprobe)
    contact_sheet_path = reports / "contact-sheet.jpg"
    make_contact_sheet(
        output,
        contact_sheet_path,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
    )
    report = {
        "protocol": "visual-multimedia-anime-avatar-inset-render",
        "version": 1,
        "job_file": str(job_path.relative_to(root)).replace("\\", "/"),
        "output_file": str(output.relative_to(root)).replace("\\", "/"),
        "source_ids": {
            "base": job["base_source_id"],
            "avatar": job["avatar_source_id"],
        },
        "source_probes": {
            "base": sources["base_probe"],
            "avatar": sources["avatar_probe"],
        },
        "resolved_timing": {
            "timeline_start_seconds": values["timeline_start_seconds"],
            "avatar_start_seconds": values["avatar_start_seconds"],
            "active_duration_seconds": values["active_duration_seconds"],
            "end_behavior": values["end_behavior"],
            "boundary_pad_seconds": values["boundary_pad_seconds"],
            "output_duration_seconds": output_probe["duration_seconds"],
        },
        "fixed_geometry": {
            "shape": values["shape"],
            "outer_xywh": [
                values["x"],
                values["y"],
                values["size"],
                values["size"],
            ],
            "avatar_crop_xywh": list(values["crop"]),
            "inner_size": values["inner_size"],
            "border_width": values["border_width"],
            "shadow_enabled": values["shadow_enabled"],
        },
        "audio_source": values["audio_source"],
        "output_probe": output_probe,
        "contact_sheet": str(contact_sheet_path.relative_to(root)).replace("\\", "/"),
        "automatic_checks": {
            "media_sources_valid": True,
            "fixed_crop_for_every_frame": True,
            "fixed_window_position_for_every_frame": True,
            "avatar_and_decoration_share_one_time_range": True,
            "avatar_track_covers_window_duration": True,
            "window_inside_base_frame": True,
            "output_readable": True,
        },
        "human_review": {
            "status": "pending",
            "checks": [
                "完整观看角色在圆形或方形窗口内全程没有整体漂移",
                "检查头顶、耳朵、呆毛和发梢处于窗口安全区",
                "检查肩部和衣服覆盖窗口底部，圆弧内没有白色楔形或黑角",
                "检查窗口大小与底片信息层级匹配，没有多余空白",
                "若角色轨包含说话，检查选定音轨、原角色轨口型和底片同步",
                "检查角色在所有要求出现的区间都持续存在，没有空白圆框或静态冻结",
            ],
        },
        "ffmpeg_command": command,
    }
    report_path = reports / "render-report.json"
    write_json(report_path, report)
    print(
        json.dumps(
            {
                "output": str(output),
                "report": str(report_path),
                "contact_sheet": str(contact_sheet_path),
                "probe": output_probe,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "用一次固定裁切和固定坐标，把已完成并经观看确认的二次元角色轨"
            "放进底片的圆形或方形窗口。本入口不生成或修复角色动作。"
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="建立并验证角色窗任务")
    init_parser.add_argument("--project", required=True, help="媒体项目目录")
    init_parser.add_argument("--job-id", required=True, help="稳定任务 id")
    init_parser.add_argument("--job", help="任务 JSON；默认 avatar-insets/<job-id>.json")
    init_parser.add_argument("--base-source-id", required=True, help="底片 source id")
    init_parser.add_argument("--avatar-source-id", required=True, help="口播形象轨 source id")
    init_parser.add_argument(
        "--avatar-crop",
        required=True,
        help="角色轨固定正方形裁切 x,y,width,height",
    )
    init_parser.add_argument("--shape", choices=["circle", "square"], default="circle")
    init_parser.add_argument("--x", type=int, required=True, help="外框左上角 x")
    init_parser.add_argument("--y", type=int, required=True, help="外框左上角 y")
    init_parser.add_argument("--size", type=int, required=True, help="外框直径或边长")
    init_parser.add_argument("--border-width", type=int, default=0)
    init_parser.add_argument("--border-color", default="#FFFFFF")
    init_parser.add_argument("--shadow", action="store_true", help="启用固定阴影")
    init_parser.add_argument("--shadow-offset-x", type=int, default=0)
    init_parser.add_argument("--shadow-offset-y", type=int, default=6)
    init_parser.add_argument("--shadow-blur", type=int, default=12)
    init_parser.add_argument("--shadow-color", default="#000000")
    init_parser.add_argument("--shadow-opacity", type=float, default=0.18)
    init_parser.add_argument("--timeline-start", type=float, default=0.0)
    init_parser.add_argument("--avatar-start", type=float, default=0.0)
    init_parser.add_argument(
        "--duration",
        type=float,
        help="角色窗持续秒数；省略时持续到底片结束",
    )
    init_parser.add_argument(
        "--end-behavior",
        choices=["require-full-track", "hide"],
        default="require-full-track",
        help="默认要求动态角色轨覆盖完整角色窗；只有明确选择 hide 才提前隐藏",
    )
    init_parser.add_argument(
        "--audio-source",
        choices=["avatar", "base", "mix", "none"],
        default="avatar",
    )
    init_parser.add_argument("--base-gain-db", type=float, default=-12.0)
    init_parser.add_argument("--avatar-gain-db", type=float, default=0.0)
    init_parser.add_argument("--ffprobe", help="已有 ffprobe 可执行文件路径")
    init_parser.set_defaults(handler=init_command)

    validate_parser = subparsers.add_parser(
        "validate",
        help="解析真实素材并验证角色窗任务，不编码视频",
    )
    validate_parser.add_argument("--project", required=True, help="媒体项目目录")
    validate_parser.add_argument("--job", required=True, help="项目内角色窗任务 JSON")
    validate_parser.add_argument("--ffprobe", help="已有 ffprobe 可执行文件路径")
    validate_parser.set_defaults(handler=validate_command)

    render_parser = subparsers.add_parser("render", help="渲染角色窗并生成审查资料")
    render_parser.add_argument("--project", required=True, help="媒体项目目录")
    render_parser.add_argument("--job", required=True, help="项目内角色窗任务 JSON")
    render_parser.add_argument("--output", required=True, help="项目内输出 MP4")
    render_parser.add_argument("--ffmpeg", help="已有 ffmpeg 可执行文件路径")
    render_parser.add_argument("--ffprobe", help="已有 ffprobe 可执行文件路径")
    render_parser.set_defaults(handler=render_command)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.handler(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        FileExistsError,
        FileNotFoundError,
        ValueError,
        RuntimeError,
        json.JSONDecodeError,
    ) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

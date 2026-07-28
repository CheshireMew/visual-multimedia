#!/usr/bin/env python3
"""Probe a video and render a sparse, deterministic contact sheet with FFmpeg."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path


def command_path(name: str, override: str | None) -> str:
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.exists():
            raise FileNotFoundError(f"{name} 不存在：{candidate}")
        return str(candidate)
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(
            f"找不到 {name}。请把现有工具加入 PATH，或使用 --{name} 指定路径；脚本不会自动安装。"
        )
    return found


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"命令执行失败（{result.returncode}）：\n{detail}")
    return result


def probe_video(ffprobe: str, source: Path) -> dict:
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=filename,duration,size",
            "-show_entries",
            "stream=index,codec_type,codec_name,width,height,r_frame_rate,duration",
            "-of",
            "json",
            str(source),
        ]
    )
    payload = json.loads(result.stdout)
    video_streams = [
        stream for stream in payload.get("streams", []) if stream.get("codec_type") == "video"
    ]
    if not video_streams:
        raise RuntimeError("输入文件没有可读取的视频轨")
    stream = video_streams[0]
    duration = float(payload.get("format", {}).get("duration") or stream.get("duration") or 0)
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if duration <= 0 or width <= 0 or height <= 0:
        raise RuntimeError("无法从输入文件得到有效时长或画面尺寸")
    return {
        "format": payload.get("format", {}),
        "stream": stream,
        "duration": duration,
        "width": width,
        "height": height,
    }


def even(value: float) -> int:
    rounded = max(2, int(round(value)))
    return rounded if rounded % 2 == 0 else rounded + 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="用 FFprobe 检查视频，并用 FFmpeg 生成均匀抽样的稀疏联系表。"
    )
    parser.add_argument("input", help="输入视频")
    parser.add_argument("output", help="输出联系表（.jpg、.png 或 .webp）")
    parser.add_argument("--frames", type=int, default=12, help="抽取帧数，默认 12")
    parser.add_argument("--cols", type=int, default=4, help="列数，默认 4")
    parser.add_argument("--start", type=float, default=0.0, help="开始秒数，默认 0")
    parser.add_argument("--duration", type=float, help="检查窗口时长；默认到视频结束")
    parser.add_argument("--cell-width", type=int, default=360, help="单格宽度，默认 360")
    parser.add_argument("--padding", type=int, default=10, help="格间距，默认 10")
    parser.add_argument("--margin", type=int, default=16, help="外边距，默认 16")
    parser.add_argument("--metadata", help="JSON 检查记录路径；默认与联系表同名并加 .json")
    parser.add_argument("--ffmpeg", help="已有 ffmpeg 可执行文件路径")
    parser.add_argument("--ffprobe", help="已有 ffprobe 可执行文件路径")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not source.exists() or not source.is_file():
        raise FileNotFoundError(f"输入视频不存在：{source}")
    if args.frames < 2:
        raise ValueError("--frames 至少为 2")
    if args.cols < 1:
        raise ValueError("--cols 至少为 1")
    if args.cell_width < 64:
        raise ValueError("--cell-width 至少为 64")
    if args.start < 0:
        raise ValueError("--start 不能小于 0")

    ffmpeg = command_path("ffmpeg", args.ffmpeg)
    ffprobe = command_path("ffprobe", args.ffprobe)
    probe = probe_video(ffprobe, source)
    source_duration = probe["duration"]
    if args.start >= source_duration:
        raise ValueError(
            f"--start {args.start:.3f}s 超过视频时长 {source_duration:.3f}s"
        )
    available = source_duration - args.start
    window_duration = available if args.duration is None else min(args.duration, available)
    if window_duration <= 0:
        raise ValueError("检查窗口时长必须大于 0")

    rows = math.ceil(args.frames / args.cols)
    cell_width = even(args.cell_width)
    cell_height = even(cell_width * probe["height"] / probe["width"])
    frame_rate = args.frames / window_duration
    output.parent.mkdir(parents=True, exist_ok=True)

    filter_chain = (
        f"fps={frame_rate:.12f},"
        f"scale={cell_width}:{cell_height}:force_original_aspect_ratio=decrease,"
        f"pad={cell_width}:{cell_height}:(ow-iw)/2:(oh-ih)/2:color=0x161616,"
        f"tile={args.cols}x{rows}:nb_frames={args.frames}:"
        f"padding={args.padding}:margin={args.margin}:color=0x0c0c0c"
    )
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{args.start:.6f}",
        "-i",
        str(source),
        "-t",
        f"{window_duration:.6f}",
        "-vf",
        filter_chain,
        "-frames:v",
        "1",
        "-y",
        str(output),
    ]
    run(command)
    if not output.exists() or output.stat().st_size == 0:
        raise RuntimeError("FFmpeg 没有生成可用联系表")

    sample_times = [
        args.start + min(window_duration, (index + 0.5) / frame_rate)
        for index in range(args.frames)
    ]
    metadata_path = (
        Path(args.metadata).expanduser().resolve()
        if args.metadata
        else output.with_suffix(f"{output.suffix}.json")
    )
    record = {
        "source": str(source),
        "output": str(output),
        "source_probe": probe,
        "window": {
            "start_seconds": args.start,
            "duration_seconds": window_duration,
            "end_seconds": args.start + window_duration,
        },
        "sheet": {
            "frames": args.frames,
            "columns": args.cols,
            "rows": rows,
            "cell_width": cell_width,
            "cell_height": cell_height,
            "sample_times_seconds": sample_times,
        },
    }
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)


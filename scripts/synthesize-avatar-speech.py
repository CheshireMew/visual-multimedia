#!/usr/bin/env python3
"""Generate EdgeTTS audio and a reviewable Mandarin character timeline."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any

import edge_tts
import numpy as np

from anime_avatar_media import executable, file_sha256, write_json


def chinese_characters(text: str) -> str:
    return "".join(character for character in text if "\u4e00" <= character <= "\u9fff")


async def synthesize(
    *,
    text: str,
    voice: str,
    rate: str,
    volume: str,
    pitch: str,
) -> tuple[bytes, list[dict[str, Any]]]:
    communicate = edge_tts.Communicate(
        text,
        voice,
        rate=rate,
        volume=volume,
        pitch=pitch,
        boundary="WordBoundary",
    )
    audio = bytearray()
    boundaries: list[dict[str, Any]] = []
    async for chunk in communicate.stream():
        chunk_type = chunk.get("type")
        if chunk_type == "audio":
            audio.extend(chunk["data"])
        elif chunk_type == "WordBoundary":
            boundaries.append(
                {
                    "text": str(chunk.get("text") or ""),
                    "offset_100ns": int(chunk.get("offset") or 0),
                    "duration_100ns": int(chunk.get("duration") or 0),
                }
            )
    if not audio:
        raise RuntimeError("EdgeTTS 没有返回音频")
    if not boundaries:
        raise RuntimeError("EdgeTTS 没有返回 WordBoundary，无法建立口型时间轴")
    return bytes(audio), boundaries


def decode_pcm(ffmpeg: str, audio: Path, sample_rate: int = 16000) -> np.ndarray:
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(audio),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "s16le",
            "-",
        ],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "无法解码 TTS 音频："
            + result.stderr.decode("utf-8", errors="replace")
        )
    return np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def local_rms(samples: np.ndarray, sample_rate: int, seconds: float) -> float:
    center = int(round(seconds * sample_rate))
    radius = max(1, int(round(0.008 * sample_rate)))
    window = samples[max(0, center - radius) : min(len(samples), center + radius)]
    if not len(window):
        return math.inf
    return float(np.sqrt(np.mean(window * window)))


def subdivide_boundary(
    text: str,
    start: float,
    end: float,
    samples: np.ndarray,
    sample_rate: int,
) -> list[dict[str, float | str]]:
    characters = list(chinese_characters(text))
    if not characters:
        return []
    if len(characters) == 1:
        return [
            {
                "text": characters[0],
                "start_seconds": start,
                "end_seconds": end,
            }
        ]
    duration = end - start
    if duration <= 0:
        raise ValueError(f"供应方边界时长无效：{text} [{start}, {end}]")
    internal: list[float] = []
    previous = start
    unit = duration / len(characters)
    for index in range(1, len(characters)):
        expected = start + unit * index
        radius = min(0.055, unit * 0.32)
        lower = max(previous + 0.025, expected - radius)
        upper = min(end - 0.025 * (len(characters) - index), expected + radius)
        if upper <= lower:
            boundary = expected
        else:
            candidates = np.linspace(lower, upper, 41)
            boundary = float(
                min(
                    candidates,
                    key=lambda value: local_rms(
                        samples,
                        sample_rate,
                        float(value),
                    ),
                )
            )
        internal.append(boundary)
        previous = boundary
    points = [start] + internal + [end]
    return [
        {
            "text": character,
            "start_seconds": round(points[index], 6),
            "end_seconds": round(points[index + 1], 6),
        }
        for index, character in enumerate(characters)
    ]


def build_timeline(
    *,
    text: str,
    audio_source_id: str,
    audio_sha256: str,
    boundaries: list[dict[str, Any]],
    samples: np.ndarray,
    sample_rate: int,
    voice: str,
) -> dict[str, Any]:
    units: list[dict[str, Any]] = []
    for boundary in boundaries:
        start = float(boundary["offset_100ns"]) / 10_000_000.0
        duration = float(boundary["duration_100ns"]) / 10_000_000.0
        units.extend(
            subdivide_boundary(
                str(boundary["text"]),
                start,
                start + duration,
                samples,
                sample_rate,
            )
        )
    expected = chinese_characters(text)
    actual = "".join(str(unit["text"]) for unit in units)
    if actual != expected:
        raise ValueError(
            "EdgeTTS boundary 的汉字序列与输入文本不一致，不能静默生成时间轴。\n"
            f"输入：{expected}\n边界：{actual}"
        )
    return {
        "protocol": "visual-multimedia-speech-timeline",
        "version": 2,
        "language": "zh-CN",
        "audio_source_id": audio_source_id,
        "audio_sha256": audio_sha256,
        "text": text,
        "trim_start_seconds": 0,
        "trim_end_seconds": None,
        "time_origin": "trimmed-audio-start",
        "timing": {
            "method": "provider-boundary",
            "reviewed": False,
            "notes": (
                f"EdgeTTS voice={voice} 的 WordBoundary；多汉字边界在供应方"
                "区间内按真实音频低能量点细分。正式渲染前必须试听并改为 reviewed=true。"
            ),
        },
        "units": units,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "用已有 EdgeTTS 生成普通话音频、保存供应方 WordBoundary，"
            "并建立待试听确认的逐字 speech-timeline.json。"
        )
    )
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--audio-source-id", required=True)
    parser.add_argument("--output-audio", required=True)
    parser.add_argument("--output-timeline", required=True)
    parser.add_argument("--output-boundaries")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--volume", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--ffmpeg")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    text_path = Path(args.text_file).expanduser().resolve()
    if not text_path.is_file():
        raise FileNotFoundError(f"合成文本不存在：{text_path}")
    text = text_path.read_text(encoding="utf-8").strip()
    if not chinese_characters(text):
        raise ValueError("当前二次元口型时间轴至少需要一个普通话汉字")
    output_audio = Path(args.output_audio).expanduser().resolve()
    output_timeline = Path(args.output_timeline).expanduser().resolve()
    output_boundaries = (
        Path(args.output_boundaries).expanduser().resolve()
        if args.output_boundaries
        else output_timeline.with_name(output_timeline.stem + "-provider-boundaries.json")
    )
    for output in (output_audio, output_timeline, output_boundaries):
        if output.exists():
            raise FileExistsError(f"不会覆盖已有输出：{output}")
        output.parent.mkdir(parents=True, exist_ok=True)

    audio, boundaries = asyncio.run(
        synthesize(
            text=text,
            voice=args.voice,
            rate=args.rate,
            volume=args.volume,
            pitch=args.pitch,
        )
    )
    output_audio.write_bytes(audio)
    ffmpeg = executable("ffmpeg", args.ffmpeg)
    sample_rate = 16000
    samples = decode_pcm(ffmpeg, output_audio, sample_rate)
    timeline = build_timeline(
        text=text,
        audio_source_id=args.audio_source_id,
        audio_sha256=file_sha256(output_audio),
        boundaries=boundaries,
        samples=samples,
        sample_rate=sample_rate,
        voice=args.voice,
    )
    raw_report = {
        "protocol": "visual-multimedia-speech-provider-boundaries",
        "version": 1,
        "provider": "EdgeTTS",
        "voice": args.voice,
        "rate": args.rate,
        "volume": args.volume,
        "pitch": args.pitch,
        "text": text,
        "boundaries": boundaries,
    }
    write_json(output_boundaries, raw_report)
    write_json(output_timeline, timeline)
    print(
        json.dumps(
            {
                "ok": True,
                "audio": str(output_audio),
                "provider_boundaries": str(output_boundaries),
                "speech_timeline": str(output_timeline),
                "character_units": len(timeline["units"]),
                "reviewed": False,
                "next": (
                    "试听音频并检查逐字边界；确认后把 timing.reviewed 改为 true，"
                    "再将音频以 --id "
                    f"{args.audio_source_id} 导入项目 media-sources.json。"
                ),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
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

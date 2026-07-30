#!/usr/bin/env python3
"""Validate a reviewed Mandarin speech timeline against its real audio source."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from anime_avatar_media import (
    ensure_external_project,
    executable,
    file_sha256,
    probe_media,
    read_json,
    resolve_source,
    validate_media_manifest,
    write_json,
)


PROTOCOL = "visual-multimedia-speech-timeline"


def chinese_characters(text: str) -> str:
    return "".join(character for character in text if "\u4e00" <= character <= "\u9fff")


def finite_number(value: Any, field: str, *, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} 必须是数字")
    number = float(value)
    if not math.isfinite(number) or number < minimum:
        raise ValueError(f"{field} 必须是不小于 {minimum} 的有限数字")
    return number


def validate_timeline(
    timeline: dict[str, Any],
    *,
    root: Path,
    ffprobe: str,
    require_reviewed: bool,
) -> dict[str, Any]:
    required = {
        "protocol",
        "version",
        "language",
        "audio_source_id",
        "audio_sha256",
        "text",
        "trim_start_seconds",
        "trim_end_seconds",
        "time_origin",
        "timing",
        "units",
    }
    if set(timeline) != required:
        raise ValueError("speech timeline 字段不完整或含未知字段")
    if timeline.get("protocol") != PROTOCOL or timeline.get("version") != 2:
        raise ValueError("speech timeline 协议或版本不正确")
    if timeline.get("time_origin") != "trimmed-audio-start":
        raise ValueError("time_origin 必须是 trimmed-audio-start")
    if timeline.get("language") != "zh-CN":
        raise ValueError("当前角色语音时间轴只接受 zh-CN")
    text = timeline.get("text")
    if not isinstance(text, str) or not chinese_characters(text):
        raise ValueError("speech timeline 缺少可核对的普通话汉字文本")
    if not isinstance(timeline.get("audio_source_id"), str):
        raise ValueError("audio_source_id 必须是素材账本 source id")

    timing = timeline.get("timing")
    if not isinstance(timing, dict) or set(timing) != {"method", "reviewed", "notes"}:
        raise ValueError("timing 字段不正确")
    if timing.get("method") not in {
        "provider-boundary",
        "forced-alignment",
        "manual-confirmed",
    }:
        raise ValueError("timing.method 不受支持")
    if not isinstance(timing.get("reviewed"), bool):
        raise ValueError("timing.reviewed 必须是布尔值")
    if require_reviewed and not timing["reviewed"]:
        raise ValueError("语音时间轴尚未经过实际听音复核")

    manifest = validate_media_manifest(root / "media-sources.json")
    audio_record, audio_path = resolve_source(
        manifest,
        root,
        timeline["audio_source_id"],
        {"audio", "video", "generated"},
    )
    audio_probe = probe_media(audio_path, ffprobe)
    if not audio_probe["has_audio"]:
        raise ValueError("audio_source_id 指向的真实文件没有音轨")
    audio_duration = float(
        audio_probe.get("audio_duration_seconds")
        or audio_probe.get("duration_seconds")
        or 0.0
    )
    if audio_duration <= 0:
        raise ValueError("无法取得真实音频时长")
    actual_audio_sha256 = audio_record["integrity"]["sha256"]
    if timeline.get("audio_sha256") != actual_audio_sha256:
        raise ValueError("speech timeline 绑定的 audio_sha256 与真实素材不一致")

    trim_start = finite_number(timeline.get("trim_start_seconds"), "trim_start_seconds")
    trim_end_value = timeline.get("trim_end_seconds")
    trim_end = (
        audio_duration
        if trim_end_value is None
        else finite_number(trim_end_value, "trim_end_seconds")
    )
    if trim_end <= trim_start or trim_end > audio_duration + 0.02:
        raise ValueError("静音裁切边界超出真实音频或形成空区间")

    units = timeline.get("units")
    if not isinstance(units, list) or not units:
        raise ValueError("units 必须是非空逐字边界数组")
    actual_characters: list[str] = []
    trimmed_duration = trim_end - trim_start
    previous_end = 0.0
    for index, unit in enumerate(units):
        if not isinstance(unit, dict) or set(unit) != {
            "text",
            "start_seconds",
            "end_seconds",
        }:
            raise ValueError(f"units[{index}] 字段不正确")
        character = unit.get("text")
        if (
            not isinstance(character, str)
            or len(character) != 1
            or not chinese_characters(character)
        ):
            raise ValueError(f"units[{index}].text 必须是一个普通话汉字")
        start = finite_number(unit.get("start_seconds"), f"units[{index}].start_seconds")
        end = finite_number(unit.get("end_seconds"), f"units[{index}].end_seconds")
        if end <= start:
            raise ValueError(f"units[{index}] 结束时间必须晚于开始时间")
        if start + 0.001 < previous_end:
            raise ValueError(f"units[{index}] 与前一逐字边界重叠或倒序")
        if start < -0.001 or end > trimmed_duration + 0.02:
            raise ValueError(
                f"units[{index}] 越出以裁切后音频起点为零的时间范围"
            )
        previous_end = end
        actual_characters.append(character)
    expected = chinese_characters(text)
    actual = "".join(actual_characters)
    if actual != expected:
        raise ValueError(
            "逐字时间轴与确认文本的汉字序列不一致："
            f"\n文本：{expected}\n时间轴：{actual}"
        )
    return {
        "timeline_protocol": PROTOCOL,
        "timeline_version": 2,
        "time_origin": "trimmed-audio-start",
        "reviewed": timing["reviewed"],
        "timing_method": timing["method"],
        "audio_source_id": timeline["audio_source_id"],
        "audio_file": str(audio_path),
        "audio_sha256": actual_audio_sha256,
        "audio_duration_seconds": audio_duration,
        "trim_start_seconds": trim_start,
        "trim_end_seconds": trim_end,
        "trimmed_duration_seconds": trimmed_duration,
        "unit_count": len(units),
        "text_character_count": len(expected),
        "text_matches_units": True,
        "boundaries_monotonic": True,
        "boundaries_inside_trimmed_audio": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "把逐字普通话时间轴与 v3 素材账本中的真实音频、哈希和时长一起验证。"
            "本脚本不规划口型，也不改写时间轴。"
        )
    )
    parser.add_argument("--project", required=True)
    parser.add_argument("--timeline", required=True)
    parser.add_argument("--require-reviewed", action="store_true")
    parser.add_argument("--output-report")
    parser.add_argument("--ffprobe")
    args = parser.parse_args()
    root = ensure_external_project(args.project)
    timeline_path = Path(args.timeline).expanduser()
    if not timeline_path.is_absolute():
        timeline_path = root / timeline_path
    timeline_path = timeline_path.resolve()
    try:
        timeline_path.relative_to(root)
    except ValueError as error:
        raise ValueError("speech timeline 必须位于媒体项目目录内") from error
    timeline = read_json(timeline_path)
    result = validate_timeline(
        timeline,
        root=root,
        ffprobe=executable("ffprobe", args.ffprobe),
        require_reviewed=args.require_reviewed,
    )
    report = {
        "protocol": "visual-multimedia-speech-timeline-validation",
        "version": 2,
        "timeline_file": str(timeline_path.relative_to(root)).replace("\\", "/"),
        "timeline_sha256": file_sha256(timeline_path),
        "checks": result,
        "consumer_boundary": (
            "时间轴在真实听音复核后成为不可变角色渲染计划的输入；"
            "逐字边界统一以裁切后音频起点为零。"
        ),
    }
    if args.output_report:
        output = Path(args.output_report).expanduser()
        if not output.is_absolute():
            output = root / output
        output = output.resolve()
        try:
            output.relative_to(root)
        except ValueError as error:
            raise ValueError("验证报告必须位于媒体项目目录内") from error
        if output.exists():
            raise FileExistsError(f"不会覆盖已有报告：{output}")
        write_json(output, report)
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
        json.JSONDecodeError,
    ) as error:
        print(f"错误：{error}")
        raise SystemExit(1)

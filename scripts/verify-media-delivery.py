#!/usr/bin/env python3
"""Verify a media delivery contract and write an evidence-bearing JSON report."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROTOCOL = "visual-multimedia-delivery"
VERSION = 1
PROFILES = {"preview", "review", "final"}
REVIEW_STATUSES = {"pending", "passed", "failed"}
RIGHTS_STATUSES = {"confirmed", "not-required"}


class DeliveryError(RuntimeError):
    """Raised when the delivery contract cannot be evaluated."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "读取 media-delivery.json，检查真实音视频、素材来源和人工审核状态，"
            "并生成 media-delivery-report.json。"
        )
    )
    parser.add_argument("spec", help="交付合同 media-delivery.json")
    parser.add_argument("--ffmpeg", help="已有 ffmpeg 可执行文件路径")
    parser.add_argument("--ffprobe", help="已有 ffprobe 可执行文件路径")
    parser.add_argument("--node", help="已有 Node.js 可执行文件路径")
    parser.add_argument(
        "--require-delivery-ready",
        action="store_true",
        help="除技术检查外，同时要求人工完整审看和权利审核已通过",
    )
    return parser.parse_args()


def command_path(name: str, override: str | None) -> str:
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.exists() or not candidate.is_file():
            raise DeliveryError(f"{name} 不存在：{candidate}")
        return str(candidate)
    found = shutil.which(name)
    if not found:
        raise DeliveryError(
            f"找不到 {name}。请把已有工具加入 PATH，或使用 --{name} 指定路径；"
            "脚本不会自动安装。"
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
        raise DeliveryError(f"命令执行失败（{result.returncode}）：\n{detail}")
    return result


def read_json(file_path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(file_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise DeliveryError(f"{label}不存在：{file_path}") from error
    except json.JSONDecodeError as error:
        raise DeliveryError(f"{label}不是有效 JSON：{file_path}（{error}）") from error
    if not isinstance(value, dict):
        raise DeliveryError(f"{label}根节点必须是对象：{file_path}")
    return value


def contract_object(
    value: Any,
    label: str,
    required: set[str],
    allowed: set[str],
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DeliveryError(f"{label}必须是对象")
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - allowed)
    if missing:
        raise DeliveryError(f"{label}缺少字段：{', '.join(missing)}")
    if unknown:
        raise DeliveryError(f"{label}包含未知字段：{', '.join(unknown)}")
    return value


def validate_ranges(value: Any, label: str) -> None:
    if not isinstance(value, list):
        raise DeliveryError(f"{label}必须是数组")
    for index, item in enumerate(value):
        item_label = f"{label}[{index}]"
        record = contract_object(
            item,
            item_label,
            {"start_seconds", "end_seconds", "reason"},
            {"start_seconds", "end_seconds", "reason"},
        )
        start = finite_number(record["start_seconds"])
        end = finite_number(record["end_seconds"])
        if start is None or end is None or start < 0 or end <= start:
            raise DeliveryError(f"{item_label}不是有效时间范围")
        if not isinstance(record["reason"], str) or not record["reason"]:
            raise DeliveryError(f"{item_label}.reason 必须说明允许原因")


def validate_spec_contract(spec: dict[str, Any]) -> None:
    contract_object(
        spec,
        "交付合同",
        {
            "protocol",
            "version",
            "profile",
            "output",
            "media_sources",
            "clip_selections",
            "adopted_source_ids",
            "expected",
            "analysis",
            "evidence",
            "report",
        },
        {
            "protocol",
            "version",
            "profile",
            "output",
            "media_sources",
            "clip_selections",
            "adopted_source_ids",
            "expected",
            "analysis",
            "evidence",
            "report",
        },
    )
    output = contract_object(
        spec["output"], "output", {"file"}, {"file"}
    )
    if not isinstance(output["file"], str) or not output["file"]:
        raise DeliveryError("output.file 必须是非空字符串")
    if not isinstance(spec["media_sources"], str) or not spec["media_sources"]:
        raise DeliveryError("media_sources 必须是非空字符串")
    if spec["clip_selections"] is not None and (
        not isinstance(spec["clip_selections"], str)
        or not spec["clip_selections"]
    ):
        raise DeliveryError("clip_selections 必须是非空字符串或 null")
    if (
        not isinstance(spec["adopted_source_ids"], list)
        or any(not isinstance(item, str) or not item for item in spec["adopted_source_ids"])
        or len(set(spec["adopted_source_ids"])) != len(spec["adopted_source_ids"])
    ):
        raise DeliveryError("adopted_source_ids 必须是不重复的非空字符串数组")
    expected = contract_object(
        spec["expected"],
        "expected",
        {"media_kind", "audio_required"},
        {
            "media_kind",
            "audio_required",
            "duration_seconds",
            "duration_tolerance_seconds",
            "width",
            "height",
            "frame_rate",
            "frame_rate_tolerance",
        },
    )
    if expected["media_kind"] not in {"video", "audio"}:
        raise DeliveryError("expected.media_kind 必须是 video 或 audio")
    if not isinstance(expected["audio_required"], bool):
        raise DeliveryError("expected.audio_required 必须是布尔值")
    for field in ["duration_seconds", "width", "height", "frame_rate"]:
        value = expected.get(field)
        if value is not None and (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or value <= 0
        ):
            raise DeliveryError(f"expected.{field} 必须是正数或 null")
    for field in ["width", "height"]:
        value = expected.get(field)
        if value is not None and not isinstance(value, int):
            raise DeliveryError(f"expected.{field} 必须是正整数或 null")
    for field in ["duration_tolerance_seconds", "frame_rate_tolerance"]:
        value = expected.get(field)
        if value is not None and (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or value < 0
        ):
            raise DeliveryError(f"expected.{field} 必须是非负数")
    analysis = contract_object(
        spec["analysis"],
        "analysis",
        {"loudness", "silence", "black_frames"},
        {"loudness", "silence", "black_frames"},
    )
    loudness = contract_object(
        analysis["loudness"],
        "analysis.loudness",
        {"target_lufs", "tolerance_lu", "true_peak_ceiling_dbfs"},
        {"target_lufs", "tolerance_lu", "true_peak_ceiling_dbfs"},
    )
    for field in ["target_lufs", "tolerance_lu", "true_peak_ceiling_dbfs"]:
        value = loudness[field]
        if value is not None and (
            not isinstance(value, (int, float)) or isinstance(value, bool)
        ):
            raise DeliveryError(f"analysis.loudness.{field} 必须是数字或 null")
    if loudness["tolerance_lu"] is not None and loudness["tolerance_lu"] < 0:
        raise DeliveryError("analysis.loudness.tolerance_lu 不能小于 0")
    silence = contract_object(
        analysis["silence"],
        "analysis.silence",
        {
            "noise_db",
            "minimum_duration_seconds",
            "maximum_unacknowledged_seconds",
            "allowed_ranges",
        },
        {
            "noise_db",
            "minimum_duration_seconds",
            "maximum_unacknowledged_seconds",
            "allowed_ranges",
        },
    )
    if (
        not isinstance(silence["noise_db"], (int, float))
        or isinstance(silence["noise_db"], bool)
    ):
        raise DeliveryError("analysis.silence.noise_db 必须是数字")
    if (
        not isinstance(silence["minimum_duration_seconds"], (int, float))
        or isinstance(silence["minimum_duration_seconds"], bool)
        or silence["minimum_duration_seconds"] <= 0
    ):
        raise DeliveryError("analysis.silence.minimum_duration_seconds 必须是正数")
    if silence["maximum_unacknowledged_seconds"] is not None and (
        not isinstance(
            silence["maximum_unacknowledged_seconds"], (int, float)
        )
        or isinstance(silence["maximum_unacknowledged_seconds"], bool)
        or silence["maximum_unacknowledged_seconds"] < 0
    ):
        raise DeliveryError(
            "analysis.silence.maximum_unacknowledged_seconds 必须是非负数或 null"
        )
    validate_ranges(silence["allowed_ranges"], "analysis.silence.allowed_ranges")
    black = contract_object(
        analysis["black_frames"],
        "analysis.black_frames",
        {
            "picture_black_ratio",
            "pixel_threshold",
            "minimum_duration_seconds",
            "maximum_unacknowledged_seconds",
            "allowed_ranges",
        },
        {
            "picture_black_ratio",
            "pixel_threshold",
            "minimum_duration_seconds",
            "maximum_unacknowledged_seconds",
            "allowed_ranges",
        },
    )
    for field in ["picture_black_ratio", "pixel_threshold"]:
        value = black[field]
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or value < 0
            or value > 1
        ):
            raise DeliveryError(f"analysis.black_frames.{field} 必须在 0–1 范围")
    if (
        not isinstance(black["minimum_duration_seconds"], (int, float))
        or isinstance(black["minimum_duration_seconds"], bool)
        or black["minimum_duration_seconds"] <= 0
    ):
        raise DeliveryError("analysis.black_frames.minimum_duration_seconds 必须是正数")
    if black["maximum_unacknowledged_seconds"] is not None and (
        not isinstance(black["maximum_unacknowledged_seconds"], (int, float))
        or isinstance(black["maximum_unacknowledged_seconds"], bool)
        or black["maximum_unacknowledged_seconds"] < 0
    ):
        raise DeliveryError(
            "analysis.black_frames.maximum_unacknowledged_seconds "
            "必须是非负数或 null"
        )
    validate_ranges(black["allowed_ranges"], "analysis.black_frames.allowed_ranges")
    evidence = contract_object(
        spec["evidence"],
        "evidence",
        {"captions", "contact_sheet", "human_review", "rights_review"},
        {"captions", "contact_sheet", "human_review", "rights_review"},
    )
    captions = contract_object(
        evidence["captions"],
        "evidence.captions",
        {"required", "file", "font_status"},
        {"required", "file", "font_status"},
    )
    if not isinstance(captions["required"], bool):
        raise DeliveryError("evidence.captions.required 必须是布尔值")
    if not isinstance(captions["file"], str):
        raise DeliveryError("evidence.captions.file 必须是字符串")
    if captions["required"] and not captions["file"]:
        raise DeliveryError("要求字幕时 evidence.captions.file 不能为空")
    if captions["font_status"] not in {
        "not-applicable",
        "pending",
        "verified",
    }:
        raise DeliveryError("evidence.captions.font_status 无效")
    contact = contract_object(
        evidence["contact_sheet"],
        "evidence.contact_sheet",
        {"file", "frames", "columns"},
        {"file", "frames", "columns"},
    )
    if not isinstance(contact["file"], str):
        raise DeliveryError("evidence.contact_sheet.file 必须是字符串")
    if (
        not isinstance(contact["frames"], int)
        or isinstance(contact["frames"], bool)
        or contact["frames"] < 2
    ):
        raise DeliveryError("evidence.contact_sheet.frames 必须是至少为 2 的整数")
    if (
        not isinstance(contact["columns"], int)
        or isinstance(contact["columns"], bool)
        or contact["columns"] < 1
    ):
        raise DeliveryError("evidence.contact_sheet.columns 必须是正整数")
    for key in ["human_review", "rights_review"]:
        review = contract_object(
            evidence[key],
            f"evidence.{key}",
            {"status", "notes"},
            {"status", "notes"},
        )
        if review["status"] not in REVIEW_STATUSES:
            raise DeliveryError(f"evidence.{key}.status 无效")
        if not isinstance(review["notes"], str):
            raise DeliveryError(f"evidence.{key}.notes 必须是字符串")
    if not isinstance(spec["report"], str) or not spec["report"]:
        raise DeliveryError("report 必须是非空字符串")


def project_path(project_root: Path, value: str, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise DeliveryError(f"{label}必须是非空项目相对路径")
    candidate = (project_root / value).resolve()
    try:
        candidate.relative_to(project_root)
    except ValueError as error:
        raise DeliveryError(f"{label}不能离开项目目录：{value}") from error
    return candidate


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fraction(value: Any) -> float | None:
    if value in (None, "", "0/0"):
        return None
    text = str(value)
    if "/" in text:
        numerator, denominator = text.split("/", 1)
        denominator_value = float(denominator)
        if denominator_value == 0:
            return None
        return float(numerator) / denominator_value
    return float(text)


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def add_check(
    checks: list[dict[str, Any]],
    check_id: str,
    passed: bool,
    summary: str,
    details: Any = None,
    *,
    required: bool = True,
) -> None:
    checks.append(
        {
            "id": check_id,
            "status": "passed" if passed else ("failed" if required else "informational"),
            "required": required,
            "summary": summary,
            "details": details,
        }
    )


def probe_media(ffprobe: str, output_path: Path) -> dict[str, Any]:
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(output_path),
        ]
    )
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video_streams = [
        stream for stream in streams if stream.get("codec_type") == "video"
    ]
    audio_streams = [
        stream for stream in streams if stream.get("codec_type") == "audio"
    ]
    format_info = payload.get("format", {})
    duration = finite_number(format_info.get("duration"))
    if duration is None:
        durations = [
            finite_number(stream.get("duration"))
            for stream in streams
            if finite_number(stream.get("duration")) is not None
        ]
        duration = max(durations) if durations else None
    return {
        "format": format_info,
        "streams": streams,
        "video_streams": video_streams,
        "audio_streams": audio_streams,
        "duration_seconds": duration,
    }


def check_decode(ffmpeg: str, output_path: Path) -> None:
    run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-xerror",
            "-i",
            str(output_path),
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-f",
            "null",
            "-",
        ]
    )


def measure_loudness(ffmpeg: str, output_path: Path) -> dict[str, float | None]:
    result = run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostats",
            "-i",
            str(output_path),
            "-vn",
            "-af",
            "loudnorm=I=-24:TP=-2:LRA=7:print_format=json",
            "-f",
            "null",
            "-",
        ]
    )
    blocks = re.findall(r"\{\s*\"input_i\"[\s\S]*?\}", result.stderr)
    if not blocks:
        raise DeliveryError("FFmpeg 没有返回可解析的响度测量")
    payload = json.loads(blocks[-1])
    return {
        "integrated_lufs": finite_number(payload.get("input_i")),
        "true_peak_dbfs": finite_number(payload.get("input_tp")),
        "loudness_range_lu": finite_number(payload.get("input_lra")),
        "threshold_lufs": finite_number(payload.get("input_thresh")),
    }


def detect_silence(
    ffmpeg: str,
    output_path: Path,
    noise_db: float,
    minimum_duration: float,
) -> list[dict[str, float]]:
    result = run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostats",
            "-i",
            str(output_path),
            "-vn",
            "-af",
            f"silencedetect=noise={noise_db}dB:d={minimum_duration}",
            "-f",
            "null",
            "-",
        ]
    )
    starts = [
        float(value)
        for value in re.findall(r"silence_start:\s*([0-9.]+)", result.stderr)
    ]
    ends = [
        (float(end), float(duration))
        for end, duration in re.findall(
            r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)",
            result.stderr,
        )
    ]
    intervals: list[dict[str, float]] = []
    for index, start in enumerate(starts):
        if index < len(ends):
            end, duration = ends[index]
            intervals.append(
                {
                    "start_seconds": start,
                    "end_seconds": end,
                    "duration_seconds": duration,
                }
            )
    return intervals


def detect_black(
    ffmpeg: str,
    output_path: Path,
    picture_ratio: float,
    pixel_threshold: float,
    minimum_duration: float,
) -> list[dict[str, float]]:
    result = run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostats",
            "-i",
            str(output_path),
            "-an",
            "-vf",
            (
                f"blackdetect=d={minimum_duration}:"
                f"pic_th={picture_ratio}:pix_th={pixel_threshold}"
            ),
            "-f",
            "null",
            "-",
        ]
    )
    return [
        {
            "start_seconds": float(start),
            "end_seconds": float(end),
            "duration_seconds": float(duration),
        }
        for start, end, duration in re.findall(
            r"black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)",
            result.stderr,
        )
    ]


def fully_acknowledged(
    interval: dict[str, float], ranges: list[dict[str, Any]], tolerance: float = 0.03
) -> bool:
    for allowed in ranges:
        start = finite_number(allowed.get("start_seconds"))
        end = finite_number(allowed.get("end_seconds"))
        if start is None or end is None:
            continue
        if (
            interval["start_seconds"] >= start - tolerance
            and interval["end_seconds"] <= end + tolerance
        ):
            return True
    return False


def source_evidence(
    project_root: Path,
    spec: dict[str, Any],
    checks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    manifest_path = project_path(
        project_root,
        spec.get("media_sources", ""),
        "media_sources",
    )
    manifest = read_json(manifest_path, "素材账本")
    manifest_ok = (
        manifest.get("protocol") == "visual-multimedia-media-sources"
        and manifest.get("version") == 2
        and isinstance(manifest.get("sources"), list)
    )
    add_check(
        checks,
        "media-sources-contract",
        manifest_ok,
        "素材账本使用唯一的 v2 合同"
        if manifest_ok
        else "素材账本不是 visual-multimedia media-sources v2",
        {"file": str(manifest_path)},
    )
    if not manifest_ok:
        return []
    by_id = {
        source.get("id"): source
        for source in manifest["sources"]
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    adopted = spec.get("adopted_source_ids")
    if not isinstance(adopted, list) or any(
        not isinstance(source_id, str) for source_id in adopted
    ):
        add_check(
            checks,
            "adopted-sources",
            False,
            "adopted_source_ids 必须是字符串数组",
        )
        return []
    evidence: list[dict[str, Any]] = []
    all_present = True
    all_integrity = True
    all_rights = True
    for source_id in adopted:
        source = by_id.get(source_id)
        if source is None:
            all_present = False
            evidence.append(
                {
                    "id": source_id,
                    "present": False,
                    "integrity_verified": False,
                    "rights_status": "missing",
                }
            )
            continue
        source_file_value = str(source.get("file", "")).split("#", 1)[0]
        source_file = (manifest_path.parent / source_file_value).resolve()
        integrity = source.get("integrity")
        generated_in_project = (
            source.get("acquisition", {}).get("method") == "generated-in-project"
        )
        integrity_verified = generated_in_project
        if not generated_in_project:
            if (
                source_file.exists()
                and source_file.is_file()
                and isinstance(integrity, dict)
            ):
                integrity_verified = (
                    source_file.stat().st_size == integrity.get("bytes")
                    and sha256_file(source_file) == integrity.get("sha256")
                )
            else:
                integrity_verified = False
        all_integrity = all_integrity and integrity_verified
        rights_status = source.get("rights", {}).get("status")
        rights_eligible = rights_status in RIGHTS_STATUSES
        all_rights = all_rights and rights_eligible
        evidence.append(
            {
                "id": source_id,
                "present": True,
                "file": str(source_file),
                "sha256": integrity.get("sha256")
                if isinstance(integrity, dict)
                else None,
                "integrity_verified": integrity_verified,
                "rights_status": rights_status,
                "rights_eligible": rights_eligible,
            }
        )
    add_check(
        checks,
        "adopted-sources",
        all_present,
        "所有已采用 source id 都能在素材账本中找到"
        if all_present
        else "至少一个已采用 source id 不存在",
        {"ids": adopted},
    )
    add_check(
        checks,
        "source-integrity",
        all_integrity,
        "所有已采用独立素材的文件、字节数和哈希一致"
        if all_integrity
        else "至少一个已采用素材缺失或哈希不一致",
        evidence,
    )
    add_check(
        checks,
        "source-rights",
        all_rights,
        "所有已采用素材均已确认权利或无需外部许可"
        if all_rights
        else "至少一个已采用素材的权利状态仍是 pending 或缺失",
        evidence,
        required=False,
    )
    return evidence


def clip_selection_evidence(
    project_root: Path,
    spec: dict[str, Any],
    node: str,
    ffprobe: str,
    checks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    value = spec.get("clip_selections")
    if value is None:
        add_check(
            checks,
            "clip-selections",
            True,
            "当前交付没有声明源片段选择",
            None,
            required=False,
        )
        return None
    selections_path = project_path(
        project_root, value, "clip_selections"
    )
    validator = Path(__file__).resolve().parent / "validate-clip-selections.mjs"
    result = subprocess.run(
        [
            node,
            str(validator),
            str(selections_path),
            "--ffprobe",
            ffprobe,
            "--json",
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        report = {
            "ok": False,
            "file": str(selections_path),
            "errors": [result.stderr.strip() or result.stdout.strip()],
        }
    same_manifest = False
    try:
        selections = read_json(selections_path, "片段选择合同")
        selections_manifest = project_path(
            project_root,
            selections.get("media_sources", ""),
            "clip_selections.media_sources",
        )
        delivery_manifest = project_path(
            project_root,
            spec["media_sources"],
            "media_sources",
        )
        same_manifest = selections_manifest == delivery_manifest
    except DeliveryError as error:
        report.setdefault("errors", []).append(str(error))
    passed = result.returncode == 0 and report.get("ok") is True and same_manifest
    if not same_manifest:
        report.setdefault("errors", []).append(
            "片段选择与交付合同没有引用同一个 media-sources.json"
        )
    add_check(
        checks,
        "clip-selections",
        passed,
        "真实片段范围、数量、去重和完整语义审核已通过"
        if passed
        else "片段选择合同未通过",
        report,
    )
    return report


def expected_checks(
    spec: dict[str, Any],
    probe: dict[str, Any],
    checks: list[dict[str, Any]],
) -> None:
    expected = spec.get("expected", {})
    if not isinstance(expected, dict):
        add_check(checks, "expected-contract", False, "expected 必须是对象")
        return
    media_kind = expected.get("media_kind")
    if media_kind not in {"video", "audio"}:
        add_check(
            checks,
            "media-kind",
            False,
            "expected.media_kind 必须是 video 或 audio",
        )
        return
    stream_ok = bool(
        probe["video_streams"] if media_kind == "video" else probe["audio_streams"]
    )
    add_check(
        checks,
        "media-kind",
        stream_ok,
        f"输出包含 {media_kind} 主媒体轨"
        if stream_ok
        else f"输出缺少 {media_kind} 主媒体轨",
    )
    duration = probe.get("duration_seconds")
    add_check(
        checks,
        "positive-duration",
        duration is not None and duration > 0,
        "实际时长大于 0" if duration is not None and duration > 0 else "无法得到有效时长",
        {"actual_seconds": duration},
    )
    expected_duration = finite_number(expected.get("duration_seconds"))
    if expected_duration is not None:
        tolerance = finite_number(expected.get("duration_tolerance_seconds"))
        tolerance = 0.25 if tolerance is None else tolerance
        passed = duration is not None and abs(duration - expected_duration) <= tolerance
        add_check(
            checks,
            "expected-duration",
            passed,
            "实际时长符合合同" if passed else "实际时长超出合同容差",
            {
                "actual_seconds": duration,
                "expected_seconds": expected_duration,
                "tolerance_seconds": tolerance,
            },
        )
    if media_kind == "video" and probe["video_streams"]:
        stream = probe["video_streams"][0]
        for field in ["width", "height"]:
            expected_value = expected.get(field)
            if expected_value is not None:
                actual_value = stream.get(field)
                add_check(
                    checks,
                    f"expected-{field}",
                    actual_value == expected_value,
                    f"实际 {field} 符合合同"
                    if actual_value == expected_value
                    else f"实际 {field} 与合同不符",
                    {"actual": actual_value, "expected": expected_value},
                )
        expected_fps = finite_number(expected.get("frame_rate"))
        if expected_fps is not None:
            actual_fps = fraction(
                stream.get("avg_frame_rate") or stream.get("r_frame_rate")
            )
            tolerance = finite_number(expected.get("frame_rate_tolerance"))
            tolerance = 0.02 if tolerance is None else tolerance
            passed = actual_fps is not None and abs(actual_fps - expected_fps) <= tolerance
            add_check(
                checks,
                "expected-frame-rate",
                passed,
                "实际帧率符合合同" if passed else "实际帧率与合同不符",
                {
                    "actual": actual_fps,
                    "expected": expected_fps,
                    "tolerance": tolerance,
                },
            )
    if expected.get("audio_required") is True:
        add_check(
            checks,
            "audio-required",
            bool(probe["audio_streams"]),
            "输出包含必需音轨" if probe["audio_streams"] else "输出缺少必需音轨",
        )


def review_evidence(
    project_root: Path,
    spec: dict[str, Any],
    checks: list[dict[str, Any]],
) -> dict[str, Any]:
    evidence = spec.get("evidence", {})
    if not isinstance(evidence, dict):
        add_check(checks, "evidence-contract", False, "evidence 必须是对象")
        return {}
    result: dict[str, Any] = {}
    captions = evidence.get("captions", {})
    if not isinstance(captions, dict):
        add_check(checks, "captions", False, "evidence.captions 必须是对象")
    else:
        required = captions.get("required") is True
        caption_file = captions.get("file", "")
        caption_path = (
            project_path(project_root, caption_file, "evidence.captions.file")
            if caption_file
            else None
        )
        file_ok = (
            caption_path is not None
            and caption_path.exists()
            and caption_path.is_file()
            and caption_path.stat().st_size > 0
        )
        font_status = captions.get("font_status")
        caption_ok = not required or (file_ok and font_status == "verified")
        add_check(
            checks,
            "captions",
            caption_ok,
            "必需字幕与字体状态已验证"
            if caption_ok and required
            else (
                "当前交付不要求字幕"
                if caption_ok
                else "必需字幕缺失、为空或字体状态未验证"
            ),
            {
                "required": required,
                "file": str(caption_path) if caption_path else None,
                "font_status": font_status,
            },
        )
        result["captions"] = {
            "required": required,
            "file": str(caption_path) if caption_path else None,
            "font_status": font_status,
        }
    for key, label in [
        ("human_review", "人工完整审看"),
        ("rights_review", "素材权利复核"),
    ]:
        review = evidence.get(key, {})
        status = review.get("status") if isinstance(review, dict) else None
        notes = review.get("notes", "") if isinstance(review, dict) else ""
        valid = status in REVIEW_STATUSES
        add_check(
            checks,
            f"{key}-contract",
            valid,
            f"{label}状态已记录" if valid else f"{label}状态无效",
            {"status": status, "notes": notes},
        )
        result[key] = {"status": status, "notes": notes}
    return result


def create_contact_sheet(
    project_root: Path,
    spec_path: Path,
    spec: dict[str, Any],
    output_path: Path,
    ffmpeg: str,
    ffprobe: str,
    checks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    evidence = spec.get("evidence", {})
    contact = evidence.get("contact_sheet", {}) if isinstance(evidence, dict) else {}
    if not isinstance(contact, dict) or not contact.get("file"):
        add_check(
            checks,
            "contact-sheet",
            False,
            "review/final 视频必须在合同中声明联系表路径",
        )
        return None
    contact_path = project_path(
        project_root, contact["file"], "evidence.contact_sheet.file"
    )
    frames = int(contact.get("frames") or (8 if spec["profile"] == "review" else 12))
    columns = int(contact.get("columns") or 4)
    helper = Path(__file__).resolve().parent / "make-video-contact-sheet.py"
    metadata_path = contact_path.with_suffix(f"{contact_path.suffix}.json")
    command = [
        sys.executable,
        str(helper),
        str(output_path),
        str(contact_path),
        "--frames",
        str(frames),
        "--cols",
        str(columns),
        "--metadata",
        str(metadata_path),
        "--ffmpeg",
        ffmpeg,
        "--ffprobe",
        ffprobe,
    ]
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(spec_path.parent),
    )
    passed = (
        result.returncode == 0
        and contact_path.exists()
        and contact_path.stat().st_size > 0
        and metadata_path.exists()
    )
    add_check(
        checks,
        "contact-sheet",
        passed,
        "已从最终视频生成联系表" if passed else "最终视频联系表生成失败",
        {
            "file": str(contact_path),
            "metadata": str(metadata_path),
            "frames": frames,
            "error": None if passed else (result.stderr.strip() or result.stdout.strip()),
        },
    )
    return {
        "file": str(contact_path),
        "metadata": str(metadata_path),
        "frames": frames,
    }


def main() -> int:
    args = parse_args()
    spec_path = Path(args.spec).expanduser().resolve()
    project_root = spec_path.parent
    spec = read_json(spec_path, "交付合同")
    validate_spec_contract(spec)
    if spec.get("protocol") != PROTOCOL or spec.get("version") != VERSION:
        raise DeliveryError(
            f"交付合同必须使用 protocol={PROTOCOL}、version={VERSION}"
        )
    profile = spec.get("profile")
    if profile not in PROFILES:
        raise DeliveryError("profile 必须是 preview、review 或 final")
    output_path = project_path(
        project_root,
        spec.get("output", {}).get("file", "")
        if isinstance(spec.get("output"), dict)
        else "",
        "output.file",
    )
    report_path = project_path(
        project_root, spec.get("report", ""), "report"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = command_path("ffmpeg", args.ffmpeg)
    ffprobe = command_path("ffprobe", args.ffprobe)
    node = command_path("node", args.node)
    checks: list[dict[str, Any]] = []
    if not output_path.exists() or not output_path.is_file():
        add_check(checks, "output-exists", False, "交付文件不存在")
        probe: dict[str, Any] = {
            "format": {},
            "streams": [],
            "video_streams": [],
            "audio_streams": [],
            "duration_seconds": None,
        }
    else:
        add_check(
            checks,
            "output-exists",
            output_path.stat().st_size > 0,
            "交付文件存在且非空"
            if output_path.stat().st_size > 0
            else "交付文件为空",
            {
                "file": str(output_path),
                "bytes": output_path.stat().st_size,
                "sha256": sha256_file(output_path),
            },
        )
        try:
            probe = probe_media(ffprobe, output_path)
            add_check(
                checks,
                "probe",
                bool(probe["streams"]),
                "FFprobe 已读取真实媒体流"
                if probe["streams"]
                else "FFprobe 没有读取到媒体流",
            )
        except DeliveryError as error:
            probe = {
                "format": {},
                "streams": [],
                "video_streams": [],
                "audio_streams": [],
                "duration_seconds": None,
            }
            add_check(checks, "probe", False, "FFprobe 读取失败", str(error))
    expected_checks(spec, probe, checks)
    if output_path.exists() and output_path.is_file():
        try:
            check_decode(ffmpeg, output_path)
            add_check(checks, "decode", True, "FFmpeg 已完整解码交付文件")
        except DeliveryError as error:
            add_check(checks, "decode", False, "完整解码失败", str(error))

    adopted_sources = source_evidence(project_root, spec, checks)
    clip_selections = clip_selection_evidence(
        project_root, spec, node, ffprobe, checks
    )
    evidence = review_evidence(project_root, spec, checks)
    contact_sheet = None
    media_kind = spec.get("expected", {}).get("media_kind")
    if profile in {"review", "final"} and media_kind == "video" and output_path.exists():
        contact_sheet = create_contact_sheet(
            project_root,
            spec_path,
            spec,
            output_path,
            ffmpeg,
            ffprobe,
            checks,
        )

    analysis_config = spec.get("analysis", {})
    if not isinstance(analysis_config, dict):
        analysis_config = {}
        add_check(checks, "analysis-contract", False, "analysis 必须是对象")
    if (
        profile in {"review", "final"}
        and probe["audio_streams"]
        and output_path.exists()
    ):
        loudness_config = analysis_config.get("loudness", {})
        if not isinstance(loudness_config, dict):
            loudness_config = {}
        try:
            loudness = measure_loudness(ffmpeg, output_path)
            target = finite_number(loudness_config.get("target_lufs"))
            tolerance = finite_number(loudness_config.get("tolerance_lu"))
            peak_ceiling = finite_number(
                loudness_config.get("true_peak_ceiling_dbfs")
            )
            within_target = (
                True
                if target is None or tolerance is None
                else loudness["integrated_lufs"] is not None
                and abs(loudness["integrated_lufs"] - target) <= tolerance
            )
            within_peak = (
                True
                if peak_ceiling is None
                else loudness["true_peak_dbfs"] is not None
                and loudness["true_peak_dbfs"] <= peak_ceiling
            )
            add_check(
                checks,
                "loudness",
                within_target and within_peak,
                "响度已经测量并符合合同"
                if within_target and within_peak
                else "实际响度或真峰值不符合合同",
                {
                    **loudness,
                    "target_lufs": target,
                    "tolerance_lu": tolerance,
                    "true_peak_ceiling_dbfs": peak_ceiling,
                },
            )
        except DeliveryError as error:
            add_check(checks, "loudness", False, "响度测量失败", str(error))

        silence_config = analysis_config.get("silence", {})
        if not isinstance(silence_config, dict):
            silence_config = {}
        noise_db = finite_number(silence_config.get("noise_db"))
        noise_db = -50.0 if noise_db is None else noise_db
        minimum_duration = finite_number(
            silence_config.get("minimum_duration_seconds")
        )
        minimum_duration = 0.5 if minimum_duration is None else minimum_duration
        allowed_ranges = silence_config.get("allowed_ranges", [])
        if not isinstance(allowed_ranges, list):
            allowed_ranges = []
        try:
            intervals = detect_silence(
                ffmpeg, output_path, noise_db, minimum_duration
            )
            unacknowledged = [
                interval
                for interval in intervals
                if not fully_acknowledged(interval, allowed_ranges)
            ]
            maximum = finite_number(
                silence_config.get("maximum_unacknowledged_seconds")
            )
            passed = (
                True
                if maximum is None
                else all(
                    interval["duration_seconds"] <= maximum
                    for interval in unacknowledged
                )
            )
            add_check(
                checks,
                "silence",
                passed,
                "异常静音扫描完成且符合合同"
                if passed
                else "存在超过合同上限的未确认静音",
                {
                    "noise_db": noise_db,
                    "minimum_duration_seconds": minimum_duration,
                    "maximum_unacknowledged_seconds": maximum,
                    "detected": intervals,
                    "unacknowledged": unacknowledged,
                },
            )
        except DeliveryError as error:
            add_check(checks, "silence", False, "静音扫描失败", str(error))

    if (
        profile == "final"
        and media_kind == "video"
        and probe["video_streams"]
        and output_path.exists()
    ):
        black_config = analysis_config.get("black_frames", {})
        if not isinstance(black_config, dict):
            black_config = {}
        picture_ratio = finite_number(black_config.get("picture_black_ratio"))
        picture_ratio = 0.98 if picture_ratio is None else picture_ratio
        pixel_threshold = finite_number(black_config.get("pixel_threshold"))
        pixel_threshold = 0.10 if pixel_threshold is None else pixel_threshold
        minimum_duration = finite_number(
            black_config.get("minimum_duration_seconds")
        )
        minimum_duration = 0.10 if minimum_duration is None else minimum_duration
        allowed_ranges = black_config.get("allowed_ranges", [])
        if not isinstance(allowed_ranges, list):
            allowed_ranges = []
        try:
            intervals = detect_black(
                ffmpeg,
                output_path,
                picture_ratio,
                pixel_threshold,
                minimum_duration,
            )
            unacknowledged = [
                interval
                for interval in intervals
                if not fully_acknowledged(interval, allowed_ranges)
            ]
            maximum = finite_number(
                black_config.get("maximum_unacknowledged_seconds")
            )
            maximum = 0.10 if maximum is None else maximum
            passed = all(
                interval["duration_seconds"] <= maximum
                for interval in unacknowledged
            )
            add_check(
                checks,
                "black-frames",
                passed,
                "全片黑场扫描完成且符合合同"
                if passed
                else "存在超过合同上限的未确认黑场",
                {
                    "picture_black_ratio": picture_ratio,
                    "pixel_threshold": pixel_threshold,
                    "minimum_duration_seconds": minimum_duration,
                    "maximum_unacknowledged_seconds": maximum,
                    "detected": intervals,
                    "unacknowledged": unacknowledged,
                },
            )
        except DeliveryError as error:
            add_check(checks, "black-frames", False, "黑场扫描失败", str(error))

    failed_required = [
        item for item in checks if item["required"] and item["status"] == "failed"
    ]
    technical_ready = len(failed_required) == 0
    human_status = evidence.get("human_review", {}).get("status")
    rights_status = evidence.get("rights_review", {}).get("status")
    adopted_rights_ready = all(
        item.get("rights_eligible") is True for item in adopted_sources
    )
    delivery_ready = (
        technical_ready
        and human_status == "passed"
        and rights_status == "passed"
        and adopted_rights_ready
    )
    report = {
        "protocol": "visual-multimedia-delivery-report",
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "spec": str(spec_path),
        "profile": profile,
        "output": {
            "file": str(output_path),
            "exists": output_path.exists(),
            "bytes": output_path.stat().st_size if output_path.exists() else None,
            "sha256": sha256_file(output_path) if output_path.exists() else None,
        },
        "probe": probe,
        "adopted_sources": adopted_sources,
        "evidence": {
            **evidence,
            "clip_selections": clip_selections,
            "contact_sheet": contact_sheet,
        },
        "checks": checks,
        "summary": {
            "required_checks": sum(1 for item in checks if item["required"]),
            "passed_required_checks": sum(
                1
                for item in checks
                if item["required"] and item["status"] == "passed"
            ),
            "failed_required_check_ids": [
                item["id"] for item in failed_required
            ],
            "technical_ready": technical_ready,
            "human_review_passed": human_status == "passed",
            "rights_review_passed": rights_status == "passed"
            and adopted_rights_ready,
            "delivery_ready": delivery_ready,
        },
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(f"交付报告：{report_path}")
    if not technical_ready:
        return 1
    if args.require_delivery_ready and not delivery_ready:
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (DeliveryError, OSError, ValueError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

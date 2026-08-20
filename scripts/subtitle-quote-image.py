#!/usr/bin/env python3
"""Build transcript-bound, natural-height quote collages from videos without baked subtitles."""

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

from PIL import Image, ImageColor, ImageDraw, ImageFont, ImageOps

from media_task_workspace import assert_skill_task_path


SKILL_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = SKILL_ROOT / "schemas" / "subtitle-quote-image.v1.schema.json"
REVIEW_SCHEMA_PATH = SKILL_ROOT / "schemas" / "subtitle-quote-image-review.v1.schema.json"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SHA_RE = re.compile(r"^[a-f0-9]{64}$")


def fail(message: str) -> None:
    raise ValueError(message)


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FileNotFoundError(f"文件不存在：{path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"JSON 无法解析：{path}（{error}）") from error
    if not isinstance(value, dict):
        fail(f"JSON 根节点必须是对象：{path}")
    return value


def write_json_new(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def command_path(name: str, override: str | None) -> str:
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.is_file():
            raise FileNotFoundError(f"{name} 不存在：{candidate}")
        return str(candidate)
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(
            f"找不到 {name}；请用 --{name} 指向已有程序，本脚本不会安装依赖"
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


def project_relative(project: Path, value: str, label: str) -> Path:
    raw = Path(value)
    if raw.is_absolute():
        fail(f"{label} 必须是项目相对路径")
    resolved = (project / raw).resolve()
    try:
        resolved.relative_to(project)
    except ValueError as error:
        raise ValueError(f"{label} 不能离开项目目录：{value}") from error
    return resolved


def new_output_directory(project: Path, value: str) -> Path:
    output = project_relative(project, value, "--output")
    if output.exists():
        fail(f"输出目录已存在，未覆盖：{output}")
    output.mkdir(parents=True, exist_ok=False)
    return output


def probe_video(ffprobe: str, source: Path) -> dict[str, Any]:
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
    videos = [item for item in payload.get("streams", []) if item.get("codec_type") == "video"]
    if not videos:
        fail("输入素材没有可读取的视频轨")
    stream = videos[0]
    duration = float(payload.get("format", {}).get("duration") or stream.get("duration") or 0)
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if duration <= 0 or width <= 0 or height <= 0:
        fail("无法读取有效的视频时长或画面尺寸")
    return {
        "duration_seconds": duration,
        "width": width,
        "height": height,
        "video_codec": stream.get("codec_name"),
        "audio_streams": sum(1 for item in payload.get("streams", []) if item.get("codec_type") == "audio"),
        "subtitle_streams": sum(1 for item in payload.get("streams", []) if item.get("codec_type") == "subtitle"),
    }


def grab_frame(ffmpeg: str, source: Path, seconds: float, output: Path) -> None:
    if output.exists():
        fail(f"取帧输出已存在，未覆盖：{output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    preseek = max(0.0, seconds - 2.0)
    offset = seconds - preseek
    run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{preseek:.6f}",
            "-i",
            str(source),
            "-ss",
            f"{offset:.6f}",
            "-frames:v",
            "1",
            "-n",
            str(output),
        ]
    )
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"FFmpeg 未生成可用画面：{seconds:.3f}s")


def expect_keys(value: dict[str, Any], required: set[str], allowed: set[str], label: str) -> None:
    missing = sorted(required - value.keys())
    extra = sorted(value.keys() - allowed)
    if missing:
        fail(f"{label} 缺少字段：{', '.join(missing)}")
    if extra:
        fail(f"{label} 包含未知字段：{', '.join(extra)}")


def load_project(project_value: str) -> Path:
    return assert_skill_task_path(Path(project_value).expanduser().resolve(), "--project")


def load_contracts(project: Path, source_id: str | None = None) -> dict[str, Any]:
    manifest_path = project / "media-sources.json"
    transcript_path = project / "transcript.json"
    manifest = read_json(manifest_path)
    transcript = read_json(transcript_path)
    if manifest.get("protocol") != "visual-multimedia-media-sources" or manifest.get("version") != 3:
        fail("media-sources.json 必须是 visual-multimedia media-sources v3")
    sources = manifest.get("sources")
    if not isinstance(sources, list):
        fail("media-sources.json.sources 必须是数组")
    active_id = source_id or transcript.get("source_id")
    source = next((item for item in sources if item.get("id") == active_id), None)
    if not source:
        fail(f"素材账本中不存在 source id：{active_id}")
    if source.get("media_type") != "video" or source.get("representation", {}).get("kind") != "source":
        fail("视频字幕金句拼图必须绑定原始 video source")
    integrity = source.get("integrity") or {}
    source_sha = integrity.get("sha256")
    if not isinstance(source_sha, str) or not SHA_RE.fullmatch(source_sha):
        fail("原片素材缺少有效 SHA-256")
    source_file = project_relative(project, str(source.get("file") or ""), "source.file")
    if not source_file.is_file() or sha256_file(source_file) != source_sha:
        fail("原片文件不存在或与素材账本哈希不一致")
    if transcript.get("protocol") != "visual-multimedia-media-transcript" or transcript.get("version") != 1:
        fail("transcript.json 必须是 visual-multimedia media-transcript v1")
    if transcript.get("media_sources") != "media-sources.json":
        fail("transcript.json 必须引用当前 media-sources.json")
    if transcript.get("source_id") != active_id or transcript.get("source_sha256") != source_sha:
        fail("transcript.json 没有绑定同一原片 source id 与哈希")
    segments = transcript.get("segments")
    if not isinstance(segments, list) or not segments:
        fail("transcript.json 没有可用 segments")
    segment_index: dict[str, dict[str, Any]] = {}
    for segment in segments:
        segment_id = segment.get("id")
        if not isinstance(segment_id, str) or not ID_RE.fullmatch(segment_id):
            fail("转写 segment id 无效")
        if segment_id in segment_index:
            fail(f"转写 segment id 重复：{segment_id}")
        start = segment.get("start_seconds")
        end = segment.get("end_seconds")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or start < 0 or end <= start:
            fail(f"转写时间范围无效：{segment_id}")
        if not str(segment.get("text") or "").strip():
            fail(f"转写文字为空：{segment_id}")
        segment_index[segment_id] = segment
    return {
        "manifest_path": manifest_path,
        "manifest": manifest,
        "transcript_path": transcript_path,
        "transcript": transcript,
        "transcript_sha256": sha256_file(transcript_path),
        "source": source,
        "source_file": source_file,
        "source_sha256": source_sha,
        "segment_index": segment_index,
    }


def validate_spec(project: Path, spec_path: Path, ffprobe: str) -> dict[str, Any]:
    spec = read_json(spec_path)
    top_keys = {
        "protocol", "version", "media_sources", "transcript", "source_id",
        "source_sha256", "transcript_sha256", "source_text", "source_frame", "content_units", "canvas",
        "typography", "review", "output", "items",
    }
    expect_keys(spec, top_keys, top_keys, "规格")
    if spec.get("protocol") != "visual-multimedia-subtitle-quote-image" or spec.get("version") != 1:
        fail("规格 protocol/version 必须是 subtitle-quote-image v1")
    if spec.get("media_sources") != "media-sources.json" or spec.get("transcript") != "transcript.json":
        fail("规格必须引用项目唯一的 media-sources.json 与 transcript.json")
    contracts = load_contracts(project, str(spec.get("source_id") or ""))
    if spec.get("source_sha256") != contracts["source_sha256"]:
        fail("规格 source_sha256 与原片不一致")
    if spec.get("transcript_sha256") != contracts["transcript_sha256"]:
        fail("规格 transcript_sha256 与当前转写不一致")
    source_text = spec.get("source_text")
    if not isinstance(source_text, dict):
        fail("source_text 必须是对象")
    expect_keys(
        source_text,
        {"baked_subtitles_expected", "baked_subtitles_observed", "existing_text_handling", "notes"},
        {"baked_subtitles_expected", "baked_subtitles_observed", "existing_text_handling", "notes"},
        "source_text",
    )
    if source_text.get("baked_subtitles_expected") is not False:
        fail("默认源视频不带烧录字幕；baked_subtitles_expected 必须为 false")
    if not isinstance(source_text.get("baked_subtitles_observed"), bool):
        fail("source_text.baked_subtitles_observed 必须是布尔值")
    expected_handling = "cover" if source_text["baked_subtitles_observed"] else "not-needed"
    if source_text.get("existing_text_handling") != expected_handling:
        fail(f"source_text.existing_text_handling 必须是 {expected_handling}")
    source_frame = spec.get("source_frame")
    if not isinstance(source_frame, dict):
        fail("source_frame 必须是对象")
    source_frame_keys = {"seconds", "focus_x", "focus_y", "review_status"}
    expect_keys(source_frame, source_frame_keys, source_frame_keys, "source_frame")
    if not isinstance(source_frame.get("seconds"), (int, float)) or source_frame["seconds"] < 0:
        fail("source_frame.seconds 必须是非负数")
    for focus_key in ("focus_x", "focus_y"):
        focus = source_frame.get(focus_key)
        if not isinstance(focus, (int, float)) or not 0 <= focus <= 1:
            fail(f"source_frame.{focus_key} 必须在 0–1 之间")
    if source_frame.get("review_status") not in {"pending", "passed", "failed"}:
        fail("source_frame.review_status 无效")
    content_units = spec.get("content_units")
    if not isinstance(content_units, list) or not content_units:
        fail("content_units 必须至少包含一个完整观点单元")
    content_unit_index: dict[str, dict[str, Any]] = {}
    content_unit_segment_owner: dict[str, str] = {}
    previous_unit_start = -1.0
    for index, unit in enumerate(content_units):
        if not isinstance(unit, dict):
            fail(f"content_units[{index}] 必须是对象")
        unit_keys = {"id", "transcript_segment_ids"}
        expect_keys(unit, unit_keys, unit_keys, f"content_units[{index}]")
        unit_id = unit.get("id")
        if not isinstance(unit_id, str) or not ID_RE.fullmatch(unit_id) or unit_id in content_unit_index:
            fail(f"content_units[{index}].id 无效或重复")
        segment_ids = unit.get("transcript_segment_ids")
        if not isinstance(segment_ids, list) or not segment_ids or len(segment_ids) != len(set(segment_ids)):
            fail(f"{unit_id} 必须引用至少一个且不重复的 transcript segment")
        starts = []
        for segment_id in segment_ids:
            segment = contracts["segment_index"].get(segment_id)
            if not segment:
                fail(f"{unit_id} 引用了不存在的转写段：{segment_id}")
            if segment_id in content_unit_segment_owner:
                fail(f"转写段 {segment_id} 已属于观点单元 {content_unit_segment_owner[segment_id]}")
            content_unit_segment_owner[segment_id] = unit_id
            starts.append(float(segment["start_seconds"]))
        if starts != sorted(starts):
            fail(f"{unit_id}.transcript_segment_ids 必须按原片时间排列")
        if min(starts) <= previous_unit_start:
            fail("content_units 必须按原片时间严格递增")
        previous_unit_start = min(starts)
        content_unit_index[unit_id] = unit
    canvas = spec.get("canvas")
    if not isinstance(canvas, dict):
        fail("canvas 必须是对象")
    canvas_keys = {"width", "height", "background", "margin", "gap", "hero_source_top", "hero_source_bottom", "strip_source_center_y"}
    expect_keys(canvas, canvas_keys, canvas_keys, "canvas")
    if not isinstance(canvas.get("width"), int) or not 720 <= canvas["width"] <= 2160:
        fail("canvas.width 必须在 720–2160 之间")
    if canvas.get("height") != "auto":
        fail("canvas.height 必须为 auto；成品高度只能由主画面和各条实际文字高度累加得出")
    for key, minimum, maximum in (("margin", 0, 0), ("gap", 0, 0)):
        value = canvas.get(key)
        if not isinstance(value, int) or not minimum <= value <= maximum:
            fail(f"canvas.{key} 必须在 {minimum}–{maximum} 之间")
    hero_source_top = canvas.get("hero_source_top")
    hero_source_bottom = canvas.get("hero_source_bottom")
    strip_source_center_y = canvas.get("strip_source_center_y")
    if any(not isinstance(value, (int, float)) for value in (hero_source_top, hero_source_bottom, strip_source_center_y)):
        fail("canvas.hero_source_top/hero_source_bottom/strip_source_center_y 必须是数字")
    if not 0 <= float(hero_source_top) < float(hero_source_bottom) <= 1:
        fail("主画面裁切必须满足 0 <= hero_source_top < hero_source_bottom <= 1")
    if not 0 <= float(strip_source_center_y) <= 1:
        fail("canvas.strip_source_center_y 必须在 0–1 之间")
    ImageColor.getrgb(str(canvas.get("background")))
    typography = spec.get("typography")
    if not isinstance(typography, dict):
        fail("typography 必须是对象")
    typography_keys = {
        "font_file", "primary_color", "secondary_color", "overlay_color",
        "primary_px", "secondary_px", "horizontal_padding_px", "vertical_padding_px",
    }
    expect_keys(typography, typography_keys, typography_keys, "typography")
    for key in ("primary_color", "secondary_color"):
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(typography.get(key) or "")):
            fail(f"typography.{key} 必须是 #RRGGBB")
    if not re.fullmatch(r"#[0-9a-fA-F]{8}", str(typography.get("overlay_color") or "")):
        fail("typography.overlay_color 必须是 #RRGGBBAA")
    for key, minimum, maximum in (
        ("primary_px", 24, 72),
        ("secondary_px", 18, 48),
        ("horizontal_padding_px", 24, 96),
        ("vertical_padding_px", 4, 24),
    ):
        value = typography.get(key)
        if not isinstance(value, int) or not minimum <= value <= maximum:
            fail(f"typography.{key} 必须在 {minimum}–{maximum} 之间")
    review = spec.get("review")
    review_keys = {"quote_audio_reviewed", "translation_reviewed", "reviewed_at", "notes"}
    if not isinstance(review, dict):
        fail("review 必须是对象")
    expect_keys(review, review_keys, review_keys, "review")
    if not isinstance(review.get("quote_audio_reviewed"), bool) or not isinstance(review.get("translation_reviewed"), bool):
        fail("review 的核对状态必须是布尔值")
    output = spec.get("output")
    if not isinstance(output, dict) or output.get("format") not in {"jpg", "png"}:
        fail("output.format 必须是 jpg 或 png")
    if not isinstance(output.get("jpeg_quality"), int) or not 80 <= output["jpeg_quality"] <= 100:
        fail("output.jpeg_quality 必须在 80–100 之间")
    items = spec.get("items")
    if not isinstance(items, list) or len(items) < 2:
        fail("字幕拼图至少需要一个 hero 和一个 strip；显示行数由真实内容决定")
    ids: set[str] = set()
    used_segment_ids: set[str] = set()
    translation_needed = False
    previous_item_start = -1.0
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            fail(f"items[{index}] 必须是对象")
        item_keys = {"id", "role", "content_unit_id", "transcript_segment_ids", "primary_text", "secondary_text"}
        expect_keys(item, item_keys, item_keys, f"items[{index}]")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not ID_RE.fullmatch(item_id) or item_id in ids:
            fail(f"items[{index}].id 无效或重复")
        ids.add(item_id)
        expected_role = "hero" if index == 0 else "strip"
        if item.get("role") != expected_role:
            fail("第一项必须是 hero，后续项必须全部是 strip")
        content_unit_id = item.get("content_unit_id")
        content_unit = content_unit_index.get(content_unit_id)
        if not content_unit:
            fail(f"{item_id}.content_unit_id 引用了不存在的完整观点单元：{content_unit_id}")
        allowed_unit_segments = set(content_unit["transcript_segment_ids"])
        segment_ids = item.get("transcript_segment_ids")
        if not isinstance(segment_ids, list) or not segment_ids or len(segment_ids) != len(set(segment_ids)):
            fail(f"{item_id} 必须引用至少一个且不重复的 transcript segment")
        referenced = []
        for segment_id in segment_ids:
            segment = contracts["segment_index"].get(segment_id)
            if not segment:
                fail(f"{item_id} 引用了不存在的转写段：{segment_id}")
            if segment_id not in allowed_unit_segments:
                fail(f"{item_id} 的转写段 {segment_id} 不属于观点单元 {content_unit_id}")
            if segment_id in used_segment_ids:
                fail(f"转写段 {segment_id} 已被其它 item 使用；不能把同一小段重复拆开来增加格数")
            used_segment_ids.add(segment_id)
            referenced.append(segment)
        starts = [float(segment["start_seconds"]) for segment in referenced]
        if starts != sorted(starts):
            fail(f"{item_id}.transcript_segment_ids 必须按原片时间排列")
        item_start = min(starts)
        if item_start <= previous_item_start:
            fail("items 必须按转写时间严格递增，不能打乱论述顺序")
        previous_item_start = item_start
        if index == 0:
            lower = item_start - 0.25
            upper = max(float(segment["end_seconds"]) for segment in referenced) + 0.25
            if not lower <= float(source_frame["seconds"]) <= upper:
                fail("source_frame.seconds 必须落在第一条字幕引用的转写时间范围内")
        if not str(item.get("primary_text") or "").strip():
            fail(f"{item_id}.primary_text 不能为空")
        if not str(item.get("secondary_text") or "").strip():
            fail(f"{item_id}.secondary_text 不能为空；参考版式要求中文主字幕下方保留小号英文副字幕")
        transcript_text = " ".join(str(segment["text"]).strip() for segment in referenced)
        transcript_text = re.sub(
            r"^(?:[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}|Speaker\s+\d+):\s*",
            "",
            transcript_text,
        ).strip()
        normalized_secondary = re.sub(r"\s+", " ", str(item["secondary_text"])).strip()
        normalized_transcript = re.sub(r"\s+", " ", transcript_text).strip()
        if normalized_secondary != normalized_transcript:
            fail(f"{item_id}.secondary_text 必须完整保留所引用转写原文（可去掉开头说话人标签），不能只摘半句")
        translation_needed = True
    if used_segment_ids != set(content_unit_segment_owner):
        missing = sorted(set(content_unit_segment_owner) - used_segment_ids)
        fail(f"content_units 中存在未进入任何显示行的转写段：{', '.join(missing)}")
    used_content_units = {item["content_unit_id"] for item in items}
    if used_content_units != set(content_unit_index):
        missing = sorted(set(content_unit_index) - used_content_units)
        fail(f"存在没有显示行的完整观点单元：{', '.join(missing)}")
    video_probe = probe_video(ffprobe, contracts["source_file"])
    if float(source_frame["seconds"]) >= video_probe["duration_seconds"]:
        fail("source_frame.seconds 超过视频时长")
    production_ready = (
        source_frame["review_status"] == "passed"
        and review["quote_audio_reviewed"] is True
        and (not translation_needed or review["translation_reviewed"] is True)
    )
    return {
        "spec": spec,
        "spec_path": spec_path,
        "spec_sha256": sha256_file(spec_path),
        "contracts": contracts,
        "video_probe": video_probe,
        "translation_needed": translation_needed,
        "production_ready": production_ready,
        "content_unit_index": content_unit_index,
    }


def resolve_font(project: Path, configured: str | None) -> Path:
    if configured:
        candidate = Path(configured).expanduser()
        if not candidate.is_absolute():
            candidate = project_relative(project, configured, "typography.font_file")
        candidate = candidate.resolve()
        if not candidate.is_file():
            raise FileNotFoundError(f"字体文件不存在：{candidate}")
        return candidate
    candidates = [
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError("找不到可用系统字体；请在规格 typography.font_file 中明确指定")


def load_font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size=size)


def split_token(token: str, draw: ImageDraw.ImageDraw, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    parts: list[str] = []
    current = ""
    for character in token:
        candidate = current + character
        if current and draw.textlength(candidate, font=font) > width:
            parts.append(current)
            current = character
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


def wrap_text(text: str, draw: ImageDraw.ImageDraw, font: ImageFont.FreeTypeFont, width: int, max_lines: int, label: str) -> list[str]:
    paragraphs = str(text).strip().splitlines() or [""]
    lines: list[str] = []
    for paragraph in paragraphs:
        tokens = re.findall(r"\S+\s*", paragraph) if re.search(r"\s", paragraph) else list(paragraph)
        current = ""
        for token in tokens:
            pieces = [token]
            if draw.textlength(token, font=font) > width:
                pieces = split_token(token, draw, font, width)
            for piece in pieces:
                candidate = current + piece
                if current and draw.textlength(candidate.rstrip(), font=font) > width:
                    lines.append(current.rstrip())
                    current = piece.lstrip()
                else:
                    current = candidate
        if current.strip():
            lines.append(current.rstrip())
    if len(lines) > max_lines:
        fail(f"{label} 在当前字号下需要 {len(lines)} 行，超过允许的 {max_lines} 行；请压缩展示文本或调整规格")
    return lines


def text_line_height(font: ImageFont.FreeTypeFont) -> int:
    box = font.getbbox("Ag国")
    return box[3] - box[1]


def fit_cover(image: Image.Image, size: tuple[int, int], focus_x: float, focus_y: float) -> Image.Image:
    return ImageOps.fit(
        image.convert("RGB"),
        size,
        method=Image.Resampling.LANCZOS,
        centering=(focus_x, focus_y),
    )


def measure_item_text(
    item: dict[str, Any],
    width: int,
    typography: dict[str, Any],
    font_path: Path,
) -> dict[str, Any]:
    primary_font = load_font(font_path, int(typography["primary_px"]))
    secondary_font = load_font(font_path, int(typography["secondary_px"]))
    horizontal_padding = int(typography["horizontal_padding_px"])
    max_width = width - horizontal_padding * 2
    if max_width <= 0:
        fail("字幕水平内边距超过当前输出宽度")
    probe = Image.new("RGB", (width, 1), "#000000")
    draw = ImageDraw.Draw(probe)
    primary_lines = wrap_text(item["primary_text"], draw, primary_font, max_width, 2, f"{item['id']} primary_text")
    secondary_lines = wrap_text(item["secondary_text"], draw, secondary_font, max_width, 2, f"{item['id']} secondary_text")
    primary_height = text_line_height(primary_font)
    secondary_height = text_line_height(secondary_font)
    primary_gap = 5
    secondary_gap = 3
    language_gap = 8
    group_height = len(primary_lines) * (primary_height + primary_gap) - primary_gap
    group_height += language_gap + len(secondary_lines) * (secondary_height + secondary_gap) - secondary_gap
    return {
        "primary_font": primary_font,
        "secondary_font": secondary_font,
        "primary_lines": primary_lines,
        "secondary_lines": secondary_lines,
        "primary_height": primary_height,
        "secondary_height": secondary_height,
        "primary_gap": primary_gap,
        "secondary_gap": secondary_gap,
        "language_gap": language_gap,
        "group_height": group_height,
        "horizontal_padding": horizontal_padding,
        "vertical_padding": int(typography["vertical_padding_px"]),
    }


def render_item(
    frame: Image.Image,
    item: dict[str, Any],
    size: tuple[int, int],
    typography: dict[str, Any],
    font_path: Path,
    cover_existing_text: bool,
    source_y0: int,
    source_y1: int,
    focus_x: float,
    focus_y: float,
) -> Image.Image:
    hero = item["role"] == "hero"
    source_y0 = max(0, min(frame.height - 1, source_y0))
    source_y1 = max(source_y0 + 1, min(frame.height, source_y1))
    source = frame.crop((0, source_y0, frame.width, source_y1))
    image = ImageOps.fit(
        source.convert("RGB"),
        size,
        method=Image.Resampling.LANCZOS,
        centering=(focus_x, focus_y),
    ).convert("RGBA")
    layout = measure_item_text(item, size[0], typography, font_path)
    primary_font = layout["primary_font"]
    secondary_font = layout["secondary_font"]
    primary_lines = layout["primary_lines"]
    secondary_lines = layout["secondary_lines"]
    primary_height = layout["primary_height"]
    secondary_height = layout["secondary_height"]
    primary_gap = layout["primary_gap"]
    secondary_gap = layout["secondary_gap"]
    language_gap = layout["language_gap"]
    group_height = layout["group_height"]
    pad_y = layout["vertical_padding"]
    band_height = group_height + pad_y * 2
    if band_height > size[1]:
        fail(f"{item['id']} 的双语字幕超过当前画面条")
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    rgba = ImageColor.getcolor(typography["overlay_color"], "RGBA")
    top = size[1] - band_height
    if cover_existing_text:
        cover_top = top if hero else round(size[1] * 0.38)
        overlay_draw.rectangle((0, cover_top, size[0], size[1]), fill=(0, 0, 0, 255))
    overlay_draw.rectangle((0, top, size[0], size[1]), fill=rgba)
    image = Image.alpha_composite(image, overlay)
    draw = ImageDraw.Draw(image)
    y = top + (band_height - group_height) // 2
    primary_color = ImageColor.getrgb(typography["primary_color"])
    secondary_color = ImageColor.getrgb(typography["secondary_color"])
    for line in primary_lines:
        line_width = draw.textlength(line, font=primary_font)
        draw.text(((size[0] - line_width) / 2, y), line, font=primary_font, fill=primary_color, stroke_width=2, stroke_fill=(0, 0, 0))
        y += primary_height + primary_gap
    y += language_gap - primary_gap
    for line in secondary_lines:
        line_width = draw.textlength(line, font=secondary_font)
        draw.text(((size[0] - line_width) / 2, y), line, font=secondary_font, fill=secondary_color, stroke_width=1, stroke_fill=(0, 0, 0))
        y += secondary_height + secondary_gap
    return image.convert("RGB")


def save_image_new(image: Image.Image, path: Path, quality: int = 94) -> None:
    if path.exists():
        fail(f"图片已存在，未覆盖：{path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        image.save(path, "JPEG", quality=quality, subsampling=0, optimize=True)
    else:
        image.save(path, "PNG", optimize=True)


def timecode(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    return f"{total // 60:02d}:{total % 60:02d}"


def candidate_sheet(frames: list[dict[str, Any]], output: Path, font_path: Path, page_size: int) -> list[Path]:
    columns = 3
    cell_width = 440
    frame_height = 248
    label_height = 142
    gap = 16
    margin = 20
    pages: list[Path] = []
    title_font = load_font(font_path, 20)
    text_font = load_font(font_path, 17)
    for page_index in range(math.ceil(len(frames) / page_size)):
        current = frames[page_index * page_size:(page_index + 1) * page_size]
        rows = math.ceil(len(current) / columns)
        sheet = Image.new(
            "RGB",
            (margin * 2 + columns * cell_width + (columns - 1) * gap, margin * 2 + rows * (frame_height + label_height) + (rows - 1) * gap),
            "#111111",
        )
        draw = ImageDraw.Draw(sheet)
        for index, record in enumerate(current):
            row, column = divmod(index, columns)
            x = margin + column * (cell_width + gap)
            y = margin + row * (frame_height + label_height + gap)
            with Image.open(record["frame_path"]) as source:
                contained = ImageOps.contain(source.convert("RGB"), (cell_width, frame_height), Image.Resampling.LANCZOS)
            frame_box = Image.new("RGB", (cell_width, frame_height), "#050505")
            frame_box.paste(contained, ((cell_width - contained.width) // 2, (frame_height - contained.height) // 2))
            sheet.paste(frame_box, (x, y))
            draw.rectangle((x, y + frame_height, x + cell_width, y + frame_height + label_height), fill="#202020")
            draw.text((x + 12, y + frame_height + 10), f"{record['segment_id']} · {timecode(record['frame_seconds'])}", font=title_font, fill="#ffffff")
            lines = wrap_text(record["text"], draw, text_font, cell_width - 24, 4, record["segment_id"])
            ty = y + frame_height + 42
            for line in lines:
                draw.text((x + 12, ty), line, font=text_font, fill="#d7d7d7")
                ty += text_line_height(text_font) + 4
        page = output / f"candidate-sheet-{page_index + 1:02d}.jpg"
        save_image_new(sheet, page, quality=92)
        pages.append(page)
    return pages


def candidates_command(args: argparse.Namespace) -> dict[str, Any]:
    project = load_project(args.project)
    contracts = load_contracts(project, args.source_id)
    ffmpeg = command_path("ffmpeg", args.ffmpeg)
    ffprobe = command_path("ffprobe", args.ffprobe)
    probe = probe_video(ffprobe, contracts["source_file"])
    segment = contracts["segment_index"].get(args.segment_id)
    if not segment:
        fail(f"第一条字幕 segment 不存在：{args.segment_id}")
    start = float(segment["start_seconds"])
    end = float(segment["end_seconds"])
    if args.samples == 1:
        sample_seconds = [(start + end) / 2]
    else:
        sample_seconds = [start + (end - start) * (index + 1) / (args.samples + 1) for index in range(args.samples)]
    output = new_output_directory(project, args.output)
    font_path = resolve_font(project, None)
    records: list[dict[str, Any]] = []
    for index, frame_seconds in enumerate(sample_seconds):
        frame_seconds = min(frame_seconds, probe["duration_seconds"] - 0.001)
        frame_path = output / "frames" / f"{index + 1:03d}-{segment['id']}.png"
        grab_frame(ffmpeg, contracts["source_file"], frame_seconds, frame_path)
        records.append({
            "segment_id": segment["id"],
            "candidate_index": index + 1,
            "start_seconds": segment["start_seconds"],
            "end_seconds": segment["end_seconds"],
            "frame_seconds": frame_seconds,
            "text": segment["text"],
            "frame": frame_path.relative_to(output).as_posix(),
            "frame_path": frame_path,
            "frame_sha256": sha256_file(frame_path),
        })
    sheets = candidate_sheet(records, output, font_path, min(5, args.samples))
    manifest = {
        "protocol": "visual-multimedia-subtitle-quote-candidates",
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_id": args.source_id,
        "source_sha256": contracts["source_sha256"],
        "transcript_sha256": contracts["transcript_sha256"],
        "transcript_review_status": contracts["transcript"].get("review", {}).get("status"),
        "selection_method": "first-subtitle-segment-samples",
        "first_subtitle_segment_id": segment["id"],
        "video_probe": probe,
        "font": {"file": str(font_path), "sha256": sha256_file(font_path)},
        "sheets": [{"file": path.relative_to(output).as_posix(), "sha256": sha256_file(path)} for path in sheets],
        "items": [{key: value for key, value in record.items() if key != "frame_path"} for record in records],
    }
    write_json_new(output / "candidates.json", manifest)
    return {
        "output": str(output),
        "items": len(records),
        "sheets": [str(path) for path in sheets],
        "selection_method": "first-subtitle-segment-samples",
    }


def review_sheet(final_image: Image.Image, spec: dict[str, Any], output: Path, font_path: Path) -> Path:
    sheet = Image.new("RGB", (1120, 1020), "#101010")
    preview = ImageOps.contain(final_image, (720, 960), Image.Resampling.LANCZOS)
    sheet.paste(preview, (20, 30))
    draw = ImageDraw.Draw(sheet)
    title_font = load_font(font_path, 24)
    text_font = load_font(font_path, 18)
    draw.text((770, 32), f"共享首帧字幕拼图 · {timecode(float(spec['source_frame']['seconds']))}", font=title_font, fill="#ffffff")
    y = 78
    for item in spec["items"]:
        draw.text((770, y), item["id"], font=text_font, fill="#ffffff")
        y += 28
        lines = wrap_text(item["primary_text"], draw, text_font, 320, 4, item["id"])
        for line in lines:
            draw.text((770, y), line, font=text_font, fill="#cfcfcf")
            y += 24
        y += 18
    path = output / "review-contact-sheet.jpg"
    save_image_new(sheet, path, quality=92)
    return path


def render_command(args: argparse.Namespace) -> dict[str, Any]:
    project = load_project(args.project)
    spec_path = project_relative(project, args.spec, "--spec")
    ffmpeg = command_path("ffmpeg", args.ffmpeg)
    ffprobe = command_path("ffprobe", args.ffprobe)
    validation = validate_spec(project, spec_path, ffprobe)
    if args.require_production_reviewed and not validation["production_ready"]:
        fail("共享背景、原声或译文尚未核对，不能使用 --require-production-reviewed")
    output = new_output_directory(project, args.output)
    spec = validation["spec"]
    contracts = validation["contracts"]
    canvas = spec["canvas"]
    typography = spec["typography"]
    font_path = resolve_font(project, typography.get("font_file"))
    width = int(canvas["width"])
    margin, gap = int(canvas["margin"]), int(canvas["gap"])
    cell_width = width - margin * 2
    source_width = int(validation["video_probe"]["width"])
    source_height = int(validation["video_probe"]["height"])
    source_frame_spec = spec["source_frame"]
    hero_y0 = max(0, min(source_height - 1, round(source_height * float(canvas["hero_source_top"]))))
    hero_y1 = max(hero_y0 + 1, min(source_height, round(source_height * float(canvas["hero_source_bottom"]))))
    hero_height = max(1, round(cell_width * (hero_y1 - hero_y0) / source_width))
    text_layouts = [measure_item_text(item, cell_width, typography, font_path) for item in spec["items"]]
    strip_heights = [layout["group_height"] + layout["vertical_padding"] * 2 for layout in text_layouts[1:]]
    height = margin * 2 + hero_height + sum(strip_heights) + gap * (len(spec["items"]) - 1)
    final_image = Image.new("RGB", (width, height), canvas["background"])
    item_records: list[dict[str, Any]] = []
    raw_frame = output / "frames" / "shared-background.png"
    grab_frame(ffmpeg, contracts["source_file"], float(source_frame_spec["seconds"]), raw_frame)
    raw_frame_sha256 = sha256_file(raw_frame)
    with Image.open(raw_frame) as opened_frame:
        shared_frame = opened_frame.convert("RGB")
    y = margin
    for index, item in enumerate(spec["items"]):
        cell_height = hero_height if index == 0 else strip_heights[index - 1]
        if index == 0:
            source_y0, source_y1 = hero_y0, hero_y1
        else:
            desired_source_height = max(1, round(source_width * cell_height / cell_width))
            if desired_source_height > source_height:
                fail(f"{item['id']} 的文字高度超过原片可裁切高度")
            source_center = round(source_height * float(canvas["strip_source_center_y"]))
            source_y0 = source_center - desired_source_height // 2
            source_y0 = max(0, min(source_height - desired_source_height, source_y0))
            source_y1 = source_y0 + desired_source_height
        rendered = render_item(
            shared_frame,
            item,
            (cell_width, cell_height),
            typography,
            font_path,
            bool(spec["source_text"]["baked_subtitles_observed"]),
            source_y0,
            source_y1,
            float(source_frame_spec["focus_x"]),
            float(source_frame_spec["focus_y"]),
        )
        item_image = output / "items" / f"{index + 1:02d}-{item['id']}.jpg"
        save_image_new(rendered, item_image, quality=int(spec["output"]["jpeg_quality"]))
        final_image.paste(rendered, (margin, y))
        item_records.append({
            "id": item["id"],
            "role": item["role"],
            "content_unit_id": item["content_unit_id"],
            "transcript_segment_ids": item["transcript_segment_ids"],
            "background_frame": raw_frame.relative_to(output).as_posix(),
            "background_frame_sha256": raw_frame_sha256,
            "background_frame_reused": True,
            "rendered_item": item_image.relative_to(output).as_posix(),
            "rendered_item_sha256": sha256_file(item_image),
            "source_crop": {"top": source_y0, "bottom": source_y1},
            "text_layout": {
                "primary_lines": len(text_layouts[index]["primary_lines"]),
                "secondary_lines": len(text_layouts[index]["secondary_lines"]),
                "group_height": text_layouts[index]["group_height"],
                "vertical_padding": text_layouts[index]["vertical_padding"],
                "caption_band_height": text_layouts[index]["group_height"] + text_layouts[index]["vertical_padding"] * 2,
            },
            "bounds": {"x": margin, "y": y, "width": cell_width, "height": cell_height},
        })
        y += cell_height + (gap if index < len(spec["items"]) - 1 else 0)
    extension = spec["output"]["format"]
    final_path = output / f"subtitle-quote-collage.{extension}"
    save_image_new(final_image, final_path, quality=int(spec["output"]["jpeg_quality"]))
    review_path = review_sheet(final_image, spec, output, font_path)
    report = {
        "protocol": "visual-multimedia-subtitle-quote-image-render",
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "rendered",
        "technical_ready": True,
        "schema": SCHEMA_PATH.relative_to(SKILL_ROOT).as_posix(),
        "source": {
            "id": spec["source_id"],
            "file": contracts["source_file"].relative_to(project).as_posix(),
            "sha256": contracts["source_sha256"],
            "probe": validation["video_probe"],
            "baked_subtitles_expected": False,
            "baked_subtitles_observed": spec["source_text"]["baked_subtitles_observed"],
            "existing_text_handling": spec["source_text"]["existing_text_handling"],
            "background_frame": {
                "seconds": float(source_frame_spec["seconds"]),
                "focus_x": float(source_frame_spec["focus_x"]),
                "focus_y": float(source_frame_spec["focus_y"]),
                "file": raw_frame.relative_to(output).as_posix(),
                "sha256": raw_frame_sha256,
                "reuse": "all-items",
                "review_status": source_frame_spec["review_status"],
            },
        },
        "transcript": {
            "file": "transcript.json",
            "sha256": contracts["transcript_sha256"],
            "review_status": contracts["transcript"].get("review", {}).get("status"),
        },
        "spec": {"file": spec_path.relative_to(project).as_posix(), "sha256": validation["spec_sha256"]},
        "content_units": [
            {
                "id": unit["id"],
                "transcript_segment_ids": unit["transcript_segment_ids"],
                "item_ids": [item["id"] for item in spec["items"] if item["content_unit_id"] == unit["id"]],
            }
            for unit in spec["content_units"]
        ],
        "font": {"file": str(font_path), "sha256": sha256_file(font_path)},
        "review": {
            "production_ready": validation["production_ready"],
            "source_frame_reviewed": source_frame_spec["review_status"] == "passed",
            "quote_audio_reviewed": spec["review"]["quote_audio_reviewed"],
            "translation_needed": validation["translation_needed"],
            "translation_reviewed": spec["review"]["translation_reviewed"],
            "notes": spec["review"]["notes"],
        },
        "layout": {
            "width": width,
            "height": height,
            "height_mode": "auto",
            "hero_height": hero_height,
            "strip_height_mode": "content",
            "strip_heights": strip_heights,
            "item_count": len(spec["items"]),
            "background_frame_mode": "shared-first-item",
            "source_crop": {
                "hero_top": hero_y0,
                "hero_bottom": hero_y1,
                "strip_center_y": float(canvas["strip_source_center_y"]),
                "source_width": source_width,
                "source_height": source_height,
            },
            "typography": {
                "primary_px": int(typography["primary_px"]),
                "secondary_px": int(typography["secondary_px"]),
                "same_size_for_hero_and_strips": True,
            },
        },
        "items": item_records,
        "outputs": [
            {"role": "final", "file": final_path.relative_to(output).as_posix(), "sha256": sha256_file(final_path), "bytes": final_path.stat().st_size},
            {"role": "review-contact-sheet", "file": review_path.relative_to(output).as_posix(), "sha256": sha256_file(review_path), "bytes": review_path.stat().st_size},
        ],
    }
    write_json_new(output / "render-report.json", report)
    return {"output": str(output), "final": str(final_path), "review": str(review_path), "status": "rendered"}


def finalize_command(args: argparse.Namespace) -> dict[str, Any]:
    project = load_project(args.project)
    render_report_path = project_relative(project, args.render_report, "--render-report")
    review_path = project_relative(project, args.review, "--review")
    output_path = project_relative(project, args.output, "--output")
    if output_path.exists():
        fail(f"交付报告已存在，未覆盖：{output_path}")
    if output_path.suffix.lower() != ".json":
        fail("--output 必须是项目内全新的 JSON 文件")
    render_report = read_json(render_report_path)
    review = read_json(review_path)
    if render_report.get("protocol") != "visual-multimedia-subtitle-quote-image-render" or render_report.get("version") != 1:
        fail("--render-report 不是字幕金句拼图 render v1 报告")
    if review.get("protocol") != "visual-multimedia-subtitle-quote-image-review" or review.get("version") != 1:
        fail("--review 不是字幕金句拼图 review v1")
    review_keys = {
        "protocol", "version", "render_report", "render_report_sha256", "final", "final_sha256",
        "reviewed_at", "agent_review", "content_review", "user_confirmation",
    }
    expect_keys(review, review_keys, review_keys, "最终复核")
    expected_render_relative = render_report_path.relative_to(project).as_posix()
    if review.get("render_report") != expected_render_relative:
        fail("复核文件没有引用当前 render report")
    render_report_sha256 = sha256_file(render_report_path)
    if review.get("render_report_sha256") != render_report_sha256:
        fail("复核文件绑定的 render report 哈希不一致")
    final_path = project_relative(project, str(review.get("final") or ""), "review.final")
    if not final_path.is_file() or review.get("final_sha256") != sha256_file(final_path):
        fail("复核文件绑定的最终图片不存在或哈希不一致")
    final_output = next((item for item in render_report.get("outputs", []) if item.get("role") == "final"), None)
    if not final_output:
        fail("render report 缺少最终图片记录")
    reported_final = (render_report_path.parent / str(final_output.get("file") or "")).resolve()
    if reported_final != final_path or final_output.get("sha256") != review.get("final_sha256"):
        fail("render report 与最终复核没有绑定同一张图片")
    agent_review = review.get("agent_review")
    content_review = review.get("content_review")
    user_confirmation = review.get("user_confirmation")
    if not isinstance(agent_review, dict) or not isinstance(content_review, dict) or not isinstance(user_confirmation, dict):
        fail("最终复核缺少 Agent、内容或用户确认对象")
    expect_keys(
        agent_review,
        {"status", "opened_at_original_pixels", "notes"},
        {"status", "opened_at_original_pixels", "notes"},
        "agent_review",
    )
    expect_keys(content_review, {"status", "notes"}, {"status", "notes"}, "content_review")
    expect_keys(
        user_confirmation,
        {"required", "status", "confirmed_at", "evidence"},
        {"required", "status", "confirmed_at", "evidence"},
        "user_confirmation",
    )
    review_statuses = {"pending", "passed", "changes-requested", "failed"}
    if agent_review.get("status") not in review_statuses or not isinstance(agent_review.get("opened_at_original_pixels"), bool):
        fail("agent_review 状态或原始像素查看记录无效")
    if content_review.get("status") not in review_statuses:
        fail("content_review.status 无效")
    if not isinstance(user_confirmation.get("required"), bool) or user_confirmation.get("status") not in {"not-requested", "pending", "approved", "rejected"}:
        fail("user_confirmation 无效")
    if user_confirmation["required"] is False and user_confirmation["status"] != "not-requested":
        fail("用户确认不要求时 status 必须是 not-requested")
    if user_confirmation["required"] is True and user_confirmation["status"] == "not-requested":
        fail("用户确认被要求时 status 不能是 not-requested")
    if user_confirmation["status"] == "approved" and (
        not user_confirmation.get("confirmed_at") or not str(user_confirmation.get("evidence") or "").strip()
    ):
        fail("用户批准必须记录 confirmed_at 与 evidence")
    source_id = str(render_report.get("source", {}).get("id") or "")
    contracts = load_contracts(project, source_id)
    rights = contracts["source"].get("rights") or {}
    rights_status = rights.get("status")
    technical_ready = render_report.get("status") == "rendered" and render_report.get("technical_ready") is True
    production_ready = render_report.get("review", {}).get("production_ready") is True
    agent_review_passed = agent_review.get("status") == "passed" and agent_review.get("opened_at_original_pixels") is True
    content_review_passed = content_review.get("status") == "passed"
    user_confirmation_passed = (
        user_confirmation["status"] == "approved"
        if user_confirmation["required"]
        else user_confirmation["status"] == "not-requested"
    )
    rights_review_passed = rights_status in {"confirmed", "not-required"}
    delivery_ready = all([
        technical_ready,
        production_ready,
        agent_review_passed,
        content_review_passed,
        user_confirmation_passed,
        rights_review_passed,
    ])
    report = {
        "protocol": "visual-multimedia-subtitle-quote-image-delivery",
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "delivery-ready" if delivery_ready else "reviewed-not-delivery-ready",
        "delivery_ready": delivery_ready,
        "render_report": {"file": expected_render_relative, "sha256": render_report_sha256},
        "review": {
            "file": review_path.relative_to(project).as_posix(),
            "sha256": sha256_file(review_path),
            "schema": REVIEW_SCHEMA_PATH.relative_to(SKILL_ROOT).as_posix(),
        },
        "final": {
            "file": final_path.relative_to(project).as_posix(),
            "sha256": review["final_sha256"],
            "bytes": final_path.stat().st_size,
        },
        "source": {
            "id": source_id,
            "sha256": contracts["source_sha256"],
            "rights_status": rights_status,
            "rights_notes": rights.get("license", ""),
        },
        "checks": {
            "technical_ready": technical_ready,
            "production_review_ready": production_ready,
            "agent_review_passed": agent_review_passed,
            "content_review_passed": content_review_passed,
            "user_confirmation_passed": user_confirmation_passed,
            "rights_review_passed": rights_review_passed,
        },
    }
    write_json_new(output_path, report)
    if args.require_delivery_ready and not delivery_ready:
        fail(f"交付条件尚未全部通过；报告已写入：{output_path}")
    return {"report": str(output_path), "delivery_ready": delivery_ready, "checks": report["checks"]}


def validate_command(args: argparse.Namespace) -> dict[str, Any]:
    project = load_project(args.project)
    spec_path = project_relative(project, args.spec, "--spec")
    ffprobe = command_path("ffprobe", args.ffprobe)
    validation = validate_spec(project, spec_path, ffprobe)
    return {
        "valid": True,
        "schema": str(SCHEMA_PATH),
        "spec": str(spec_path),
        "spec_sha256": validation["spec_sha256"],
        "source_id": validation["spec"]["source_id"],
        "items": len(validation["spec"]["items"]),
        "content_units": len(validation["spec"]["content_units"]),
        "production_ready": validation["production_ready"],
        "video_probe": validation["video_probe"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    candidates = subparsers.add_parser("candidates", help="只在第一条字幕范围内生成共享背景候选")
    candidates.add_argument("--project", required=True)
    candidates.add_argument("--source-id", required=True)
    candidates.add_argument("--segment-id", required=True, help="第一条显示字幕引用的转写段")
    candidates.add_argument("--samples", type=int, default=3, choices=range(1, 6), help="只在该段内部取 1–5 张背景候选")
    candidates.add_argument("--output", required=True, help="项目内全新输出目录")
    candidates.add_argument("--ffmpeg")
    candidates.add_argument("--ffprobe")

    validate = subparsers.add_parser("validate", help="验证规格、素材、转写和时间绑定")
    validate.add_argument("--project", required=True)
    validate.add_argument("--spec", required=True, help="项目内规格路径")
    validate.add_argument("--ffprobe")

    render = subparsers.add_parser("render", help="取帧、统一字号，并按每条实际文字高度生成紧凑拼图")
    render.add_argument("--project", required=True)
    render.add_argument("--spec", required=True, help="项目内规格路径")
    render.add_argument("--output", required=True, help="项目内全新输出目录")
    render.add_argument("--require-production-reviewed", action="store_true", help="共享帧、原声或译文核对未完成时拒绝渲染")
    render.add_argument("--ffmpeg")
    render.add_argument("--ffprobe")

    finalize = subparsers.add_parser("finalize", help="把最终图片复核、用户确认和素材权利汇总为交付报告")
    finalize.add_argument("--project", required=True)
    finalize.add_argument("--render-report", required=True, help="项目内 render-report.json")
    finalize.add_argument("--review", required=True, help="项目内 subtitle quote image review v1")
    finalize.add_argument("--output", required=True, help="项目内全新交付报告 JSON")
    finalize.add_argument("--require-delivery-ready", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "candidates":
        result = candidates_command(args)
    elif args.command == "validate":
        result = validate_command(args)
    elif args.command == "render":
        result = render_command(args)
    else:
        result = finalize_command(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError, OSError, json.JSONDecodeError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

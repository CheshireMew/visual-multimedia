#!/usr/bin/env python3
"""Exercise the subtitle quote image producer with a generated no-subtitle video."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

from media_task_workspace import assert_skill_task_path


SCRIPT_ROOT = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_ROOT.parent


def executable(name: str, override: str | None) -> str:
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.is_file():
            raise FileNotFoundError(f"{name} 不存在：{candidate}")
        return str(candidate)
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"找不到 {name}")
    return found


def run(command: list[str], expect_success: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if expect_success and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    if not expect_success and result.returncode == 0:
        raise RuntimeError(f"命令本应拒绝却成功：{' '.join(command)}")
    return result


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="位于 artifacts/<task-id>/ 下的全新自测项目")
    parser.add_argument("--node")
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    args = parser.parse_args()
    project = assert_skill_task_path(Path(args.project).expanduser().resolve(), "--project")
    if project.exists():
        raise FileExistsError(f"自测项目已存在，未覆盖：{project}")
    project.mkdir(parents=True)
    node = executable("node", args.node)
    ffmpeg = executable("ffmpeg", args.ffmpeg)
    ffprobe = executable("ffprobe", args.ffprobe)
    python = sys.executable
    source = project / "synthetic-no-subtitles.mp4"
    run([
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=6",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-n", str(source),
    ])
    shutil.copy2(SKILL_ROOT / "assets" / "media-project-starter" / "media-sources.json", project / "media-sources.json")
    run([
        node, str(SCRIPT_ROOT / "import-media-asset.mjs"),
        "--project", str(project), "--input", str(source), "--id", "synthetic-video",
        "--media-type", "video", "--method", "project-owned", "--rights-status", "not-required",
        "--license", "generated self-test fixture", "--usage", "subtitle quote image producer self-test",
    ])
    srt = project / "synthetic.srt"
    srt.write_text(
        "1\n00:00:00,200 --> 00:00:01,000\nFirst verified quote.\n\n"
        "2\n00:00:01,100 --> 00:00:02,000\nSecond verified quote.\n\n"
        "3\n00:00:02,100 --> 00:00:03,000\nThird verified quote.\n\n"
        "4\n00:00:03,100 --> 00:00:04,000\nFourth verified quote.\n\n"
        "5\n00:00:04,100 --> 00:00:05,000\nFifth verified quote.\n\n"
        "6\n00:00:05,100 --> 00:00:05,800\nSixth verified quote.\n",
        encoding="utf-8",
        newline="\n",
    )
    run([
        node, str(SCRIPT_ROOT / "import-media-transcript.mjs"),
        "--project", str(project), "--source-id", "synthetic-video", "--input", str(srt),
        "--language", "en", "--kind", "asr",
    ])
    transcript = json.loads((project / "transcript.json").read_text(encoding="utf-8"))
    manifest = json.loads((project / "media-sources.json").read_text(encoding="utf-8"))
    source_record = next(item for item in manifest["sources"] if item["id"] == "synthetic-video")
    segment_ids = [item["id"] for item in transcript["segments"]]
    candidates_command = [
        python, str(SCRIPT_ROOT / "subtitle-quote-image.py"), "candidates",
        "--project", str(project), "--source-id", "synthetic-video",
        "--segment-id", segment_ids[0], "--samples", "3",
        "--output", "reports/candidates-v1", "--ffmpeg", ffmpeg, "--ffprobe", ffprobe,
    ]
    run(candidates_command)
    candidate_manifest = json.loads((project / "reports" / "candidates-v1" / "candidates.json").read_text(encoding="utf-8"))
    first_segment = transcript["segments"][0]
    if candidate_manifest.get("selection_method") != "first-subtitle-segment-samples" or len(candidate_manifest.get("items", [])) != 3:
        raise RuntimeError("共享背景候选没有限制在第一条字幕范围内")
    if any(
        item.get("segment_id") != segment_ids[0]
        or not first_segment["start_seconds"] < item.get("frame_seconds", -1) < first_segment["end_seconds"]
        for item in candidate_manifest["items"]
    ):
        raise RuntimeError("候选阶段仍然截取了后续字幕时间点")
    content_units = []
    for index in range(0, len(transcript["segments"]), 2):
        content_units.append({
            "id": f"thought-{index // 2 + 1}",
            "transcript_segment_ids": [segment["id"] for segment in transcript["segments"][index:index + 2]],
        })
    items = []
    for index, segment in enumerate(transcript["segments"]):
        items.append({
            "id": f"quote-{index + 1}",
            "role": "hero" if index == 0 else "strip",
            "content_unit_id": f"thought-{index // 2 + 1}",
            "transcript_segment_ids": [segment["id"]],
            "primary_text": f"第 {index + 1} 条测试中文字幕",
            "secondary_text": segment["text"],
        })
    spec = {
        "protocol": "visual-multimedia-subtitle-quote-image",
        "version": 1,
        "media_sources": "media-sources.json",
        "transcript": "transcript.json",
        "source_id": "synthetic-video",
        "source_sha256": source_record["integrity"]["sha256"],
        "transcript_sha256": sha256(project / "transcript.json"),
        "source_text": {"baked_subtitles_expected": False, "baked_subtitles_observed": False, "existing_text_handling": "not-needed", "notes": "确定性测试源没有文字图层"},
        "source_frame": {"seconds": 0.6, "focus_x": 0.5, "focus_y": 0.5, "review_status": "passed"},
        "content_units": content_units,
        "canvas": {
            "width": 1440, "height": "auto", "background": "#111111", "margin": 0, "gap": 0,
            "hero_source_top": 0.0, "hero_source_bottom": 0.96, "strip_source_center_y": 0.82,
        },
        "typography": {
            "font_file": None, "primary_color": "#FFFFFF", "secondary_color": "#FFFFFF",
            "overlay_color": "#000000C8", "primary_px": 42, "secondary_px": 24,
            "horizontal_padding_px": 48, "vertical_padding_px": 8,
        },
        "review": {"quote_audio_reviewed": True, "translation_reviewed": True, "reviewed_at": "2026-01-01T00:00:00Z", "notes": "合成固定样本只验证状态传播，不冒充真实项目人工审核"},
        "output": {"format": "jpg", "jpeg_quality": 92},
        "items": items,
    }
    write_json(project / "subtitle-quote-image.json", spec)
    base = [python, str(SCRIPT_ROOT / "subtitle-quote-image.py")]
    run(base + ["validate", "--project", str(project), "--spec", "subtitle-quote-image.json", "--ffprobe", ffprobe])
    invalid = json.loads(json.dumps(spec))
    invalid["items"][1]["transcript_segment_ids"] = invalid["items"][0]["transcript_segment_ids"]
    invalid["items"][1]["secondary_text"] = invalid["items"][0]["secondary_text"]
    write_json(project / "subtitle-quote-image.invalid-reused-segment.json", invalid)
    run(base + ["validate", "--project", str(project), "--spec", "subtitle-quote-image.invalid-reused-segment.json", "--ffprobe", ffprobe], expect_success=False)
    invalid_item_frame = json.loads(json.dumps(spec))
    invalid_item_frame["items"][1]["frame_seconds"] = 1.5
    write_json(project / "subtitle-quote-image.invalid-item-frame.json", invalid_item_frame)
    run(base + ["validate", "--project", str(project), "--spec", "subtitle-quote-image.invalid-item-frame.json", "--ffprobe", ffprobe], expect_success=False)
    invalid_content_unit = json.loads(json.dumps(spec))
    invalid_content_unit["items"][1]["content_unit_id"] = "thought-2"
    write_json(project / "subtitle-quote-image.invalid-content-unit.json", invalid_content_unit)
    run(base + ["validate", "--project", str(project), "--spec", "subtitle-quote-image.invalid-content-unit.json", "--ffprobe", ffprobe], expect_success=False)
    render_command = base + [
        "render", "--project", str(project), "--spec", "subtitle-quote-image.json",
        "--output", "renders/v1", "--ffmpeg", ffmpeg, "--ffprobe", ffprobe,
    ]
    run(render_command)
    final = project / "renders" / "v1" / "subtitle-quote-collage.jpg"
    report_path = project / "renders" / "v1" / "render-report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    probe = report["source"]["probe"]
    hero_y1 = round(probe["height"] * spec["canvas"]["hero_source_bottom"])
    hero_y0 = round(probe["height"] * spec["canvas"]["hero_source_top"])
    expected_hero_height = round(spec["canvas"]["width"] * (hero_y1 - hero_y0) / probe["width"])
    strip_heights = [item["text_layout"]["caption_band_height"] for item in report["items"][1:]]
    expected_height = expected_hero_height + sum(strip_heights)
    with Image.open(final) as image:
        if image.size != (1440, expected_height):
            raise RuntimeError(f"最终画布没有按原生裁切比例自动增长：{image.size} != {(1440, expected_height)}")
    if report.get("technical_ready") is not True or "delivery_ready" in report or len(report.get("items", [])) != 6:
        raise RuntimeError("渲染报告仍然在最终图片复核前冒充交付就绪")
    if len(report.get("content_units", [])) != 3 or any(len(unit.get("item_ids", [])) != 2 for unit in report["content_units"]):
        raise RuntimeError("渲染报告没有把完整观点与显示行分开记录")
    if report.get("layout") != {
        "width": 1440,
        "height": expected_height,
        "height_mode": "auto",
        "hero_height": expected_hero_height,
        "strip_height_mode": "content",
        "strip_heights": strip_heights,
        "item_count": 6,
        "background_frame_mode": "shared-first-item",
        "source_crop": {
            "hero_top": hero_y0,
            "hero_bottom": hero_y1,
            "strip_center_y": 0.82,
            "source_width": probe["width"],
            "source_height": probe["height"],
        },
        "typography": {
            "primary_px": 42,
            "secondary_px": 24,
            "same_size_for_hero_and_strips": True,
        },
    }:
        raise RuntimeError(f"渲染报告没有记录自动高度几何：{report.get('layout')}")
    frame_files = list((project / "renders" / "v1" / "frames").glob("*.png"))
    if len(frame_files) != 1 or frame_files[0].name != "shared-background.png":
        raise RuntimeError(f"渲染仍然逐条截取背景帧：{frame_files}")
    background = report["source"].get("background_frame")
    if background != {
        "seconds": 0.6,
        "focus_x": 0.5,
        "focus_y": 0.5,
        "file": "frames/shared-background.png",
        "sha256": sha256(frame_files[0]),
        "reuse": "all-items",
        "review_status": "passed",
    }:
        raise RuntimeError(f"渲染报告没有记录首条背景复用：{background}")
    if any(
        item.get("background_frame") != "frames/shared-background.png"
        or item.get("background_frame_sha256") != background["sha256"]
        or item.get("background_frame_reused") is not True
        for item in report["items"]
    ):
        raise RuntimeError("并非所有字幕条都复用了第一条背景帧")
    bounds = [item["bounds"] for item in report["items"]]
    if bounds[0] != {"x": 0, "y": 0, "width": 1440, "height": expected_hero_height}:
        raise RuntimeError(f"主画面没有无边距铺满顶部：{bounds[0]}")
    for item, bound in zip(report["items"][1:], bounds[1:]):
        if bound["height"] != item["text_layout"]["group_height"] + 2 * item["text_layout"]["vertical_padding"]:
            raise RuntimeError(f"字幕条仍包含文字之外的多余上下空间：{item}")
    if report["items"][0]["text_layout"]["caption_band_height"] >= expected_hero_height:
        raise RuntimeError("主画面字幕带不应占满主画面")
    for previous, current in zip(bounds, bounds[1:]):
        if current["x"] != 0 or current["width"] != 1440 or current["y"] != previous["y"] + previous["height"]:
            raise RuntimeError(f"字幕画面条没有连续满宽拼接：{bounds}")
    if any("citation" in item for item in spec["items"]):
        raise RuntimeError("字幕画面条不得恢复出处行")
    if "hero_primary_px" in spec["typography"] or "strip_primary_px" in spec["typography"]:
        raise RuntimeError("第一句和后续字幕不得使用两套字号")
    run(render_command, expect_success=False)
    pending_review = {
        "protocol": "visual-multimedia-subtitle-quote-image-review",
        "version": 1,
        "render_report": "renders/v1/render-report.json",
        "render_report_sha256": sha256(report_path),
        "final": "renders/v1/subtitle-quote-collage.jpg",
        "final_sha256": sha256(final),
        "reviewed_at": "2026-01-01T00:00:00Z",
        "agent_review": {"status": "passed", "opened_at_original_pixels": True, "notes": "确定性测试状态"},
        "content_review": {"status": "passed", "notes": "确定性测试状态"},
        "user_confirmation": {"required": True, "status": "pending", "confirmed_at": None, "evidence": ""},
    }
    write_json(project / "reports" / "review-pending.json", pending_review)
    finalize_base = base + [
        "finalize", "--project", str(project),
        "--render-report", "renders/v1/render-report.json",
        "--review", "reports/review-pending.json",
    ]
    run(finalize_base + ["--output", "reports/delivery-pending.json"])
    pending_delivery = json.loads((project / "reports" / "delivery-pending.json").read_text(encoding="utf-8"))
    if pending_delivery.get("delivery_ready") is not False or pending_delivery.get("checks", {}).get("user_confirmation_passed") is not False:
        raise RuntimeError("用户尚未确认时交付报告错误地变成就绪")
    approved_review = json.loads(json.dumps(pending_review))
    approved_review["user_confirmation"] = {
        "required": False,
        "status": "not-requested",
        "confirmed_at": None,
        "evidence": "",
    }
    write_json(project / "reports" / "review-complete.json", approved_review)
    run(base + [
        "finalize", "--project", str(project),
        "--render-report", "renders/v1/render-report.json",
        "--review", "reports/review-complete.json",
        "--output", "reports/delivery-complete.json",
        "--require-delivery-ready",
    ])
    completed_delivery = json.loads((project / "reports" / "delivery-complete.json").read_text(encoding="utf-8"))
    if completed_delivery.get("delivery_ready") is not True or not all(completed_delivery.get("checks", {}).values()):
        raise RuntimeError("完整复核和权利通过后仍未得到交付就绪")
    print(json.dumps({"status": "passed", "project": str(project), "final": str(final), "report": str(report_path), "delivery": str(project / "reports" / "delivery-complete.json")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, FileExistsError, RuntimeError, ValueError, OSError, json.JSONDecodeError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

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
        "strip_background": "shared-frame",
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
    black_spec = json.loads(json.dumps(spec))
    black_spec["canvas"]["strip_background"] = "black"
    black_spec["output"]["format"] = "png"
    write_json(project / "subtitle-quote-image.black.json", black_spec)
    run(base + [
        "render", "--project", str(project), "--spec", "subtitle-quote-image.black.json",
        "--output", "renders/black", "--ffmpeg", ffmpeg, "--ffprobe", ffprobe,
    ])
    black_report = json.loads((project / "renders" / "black" / "render-report.json").read_text(encoding="utf-8"))
    if black_report["items"][0]["rendered_item_sha256"] != report["items"][0]["rendered_item_sha256"]:
        raise RuntimeError("修改下方黑底时改变了主画面或第一条字幕")
    if black_report["source"]["background_frame"]["reuse"] != "hero-only":
        raise RuntimeError("纯黑字幕带仍然被报告为复用原图")
    with Image.open(project / "renders" / "black" / "subtitle-quote-collage.png") as black_image:
        if black_image.size != (1440, expected_height):
            raise RuntimeError("修改下方黑底时改变了画布尺寸")
        for original, black_item in zip(report["items"][1:], black_report["items"][1:]):
            if original["bounds"] != black_item["bounds"] or original["text_layout"] != black_item["text_layout"]:
                raise RuntimeError("修改下方黑底时改变了字幕排版")
            if black_item["background_mode"] != "black" or black_item["background_frame_reused"] or any(
                black_item[key] is not None for key in ("background_frame", "background_frame_sha256", "source_crop")
            ):
                raise RuntimeError("纯黑字幕带保留了不真实的原图裁切记录")
            bound = black_item["bounds"]
            edge = black_image.crop((0, bound["y"], 24, bound["y"] + bound["height"]))
            if edge.getbbox() is not None:
                raise RuntimeError("下方字幕背景没有渲染为纯黑")
            pad = black_item["text_layout"]["vertical_padding"]
            for y0, y1 in ((bound["y"], bound["y"] + pad), (bound["y"] + bound["height"] - pad, bound["y"] + bound["height"])):
                if black_image.crop((0, y0, 1440, y1)).getbbox() is not None:
                    raise RuntimeError("文字进入上下内边距，字形位置错误或英文下伸部分被截断")
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
    paged = json.loads(json.dumps(black_spec))
    first = paged["items"][0]
    cut = transcript["segments"][0]["text"].index("quote")
    first["transcript_spans"] = [{"segment_id": segment_ids[0], "start_char": 0, "end_char": cut}]
    first["secondary_text"] = transcript["segments"][0]["text"][:cut].strip()
    first["primary_text"] = "第一行\n第二行\n第三行"
    continuation = json.loads(json.dumps(first))
    continuation.update({"id": "quote-1-rest", "role": "strip", "primary_text": "原文同一时间段的下一句", "secondary_text": transcript["segments"][0]["text"][cut:]})
    continuation["transcript_spans"] = [{"segment_id": segment_ids[0], "start_char": cut, "end_char": len(transcript["segments"][0]["text"])}]
    paged["items"].insert(1, continuation)
    paged["items"][3]["role"] = "hero"
    paged["canvas"].update({"height": 1920, "hero_source_bottom": 1})
    paged["pages"] = [{"id": "page-1", "item_ids": [item["id"] for item in paged["items"][:3]]}, {"id": "page-2", "item_ids": [item["id"] for item in paged["items"][3:]]}]
    write_json(project / "subtitle-quote-image.paged.json", paged)
    measured = json.loads(run(base + ["validate", "--project", str(project), "--spec", "subtitle-quote-image.paged.json", "--ffprobe", ffprobe]).stdout)
    if len(measured["pages"]) != 2 or len(measured["pages"][0]["text_layouts"][0]["primary_lines"]) != 3:
        raise RuntimeError("分页或超过两行的字幕没有经过真实测量")
    for name, mutate in [
        ("overlap", lambda candidate: candidate["items"][1]["transcript_spans"][0].update({"start_char": cut - 1})),
        ("missing-page-item", lambda candidate: candidate["pages"][1]["item_ids"].pop()),
        ("overflow", lambda candidate: candidate["canvas"].update({"height": 800})),
    ]:
        candidate = json.loads(json.dumps(paged))
        mutate(candidate)
        relative = f"subtitle-quote-image.invalid-{name}.json"
        write_json(project / relative, candidate)
        run(base + ["validate", "--project", str(project), "--spec", relative, "--ffprobe", ffprobe], expect_success=False)
    run(base + ["render", "--project", str(project), "--spec", "subtitle-quote-image.paged.json", "--output", "renders/paged", "--ffmpeg", ffmpeg, "--ffprobe", ffprobe])
    paged_report_path = project / "renders/paged/render-report.json"
    paged_report = json.loads(paged_report_path.read_text(encoding="utf-8"))
    paged_finals = [entry for entry in paged_report["outputs"] if entry["role"] == "final"]
    if len(paged_finals) != 2 or len(list((project / "renders/paged/frames").glob("*.png"))) != 1:
        raise RuntimeError("多页没有完整输出或重复取帧")
    for entry in paged_finals:
        with Image.open(project / "renders/paged" / entry["file"]) as rendered:
            if rendered.size != (1440, 1920):
                raise RuntimeError("竖版页面尺寸不正确")
    for page in paged_report["pages"]:
        page_items = [item for item in paged_report["items"] if item["page_id"] == page["id"]]
        if sum(item["bounds"]["height"] for item in page_items) != page["content_height"] or page_items[0]["source_crop"] != {"top": 0, "bottom": 360}:
            raise RuntimeError("分页没有保留完整原画面或字幕几何不正确")
        if any(item["bounds"]["height"] != item["text_layout"]["caption_band_height"] for item in page_items[1:]):
            raise RuntimeError("固定画布余白仍被分摊到字幕组之间")
        with Image.open(project / "renders/paged" / next(entry["file"] for entry in paged_finals if entry["page_id"] == page["id"])) as rendered:
            footer = rendered.crop((0, page["content_height"], 1440, 1920)).convert("RGB")
            if footer.getcolors(1) != [(footer.width * footer.height, (17, 17, 17))]:
                raise RuntimeError("用户指定的固定画布余白没有保留在整张图底部")
        if any(item["background_frame"] is not None for item in page_items[1:]):
            raise RuntimeError("分页黑底错误地复用了原片")
    paged_review = {key: value for key, value in approved_review.items() if key not in {"final", "final_sha256"}}
    paged_review.update({"render_report": "renders/paged/render-report.json", "render_report_sha256": sha256(paged_report_path), "finals": [{"file": "renders/paged/" + entry["file"], "sha256": entry["sha256"]} for entry in paged_finals]})
    write_json(project / "reports/review-paged.json", paged_review)
    run(base + ["finalize", "--project", str(project), "--render-report", "renders/paged/render-report.json", "--review", "reports/review-paged.json", "--output", "reports/delivery-paged.json", "--require-delivery-ready"])
    for name in ("missing", "bad-hash"):
        candidate = json.loads(json.dumps(paged_review))
        if name == "missing":
            candidate["finals"].pop()
        else:
            candidate["finals"][1]["sha256"] = "0" * 64
        write_json(project / f"reports/review-paged-{name}.json", candidate)
        run(base + ["finalize", "--project", str(project), "--render-report", "renders/paged/render-report.json", "--review", f"reports/review-paged-{name}.json", "--output", f"reports/delivery-paged-{name}.json"], expect_success=False)
    print(json.dumps({"status": "passed", "project": str(project), "final": str(final), "portrait_pages": len(paged_finals), "delivery": str(project / "reports/delivery-paged.json")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, FileExistsError, RuntimeError, ValueError, OSError, json.JSONDecodeError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

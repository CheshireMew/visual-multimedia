#!/usr/bin/env python3
"""Initialize, inspect and validate a no-rig anime-avatar source library."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from anime_avatar_common import (
    AVATAR_LIBRARY_CATALOG,
    AVATAR_LIBRARY_ROOT,
    RESOURCE_ID_RE,
    RESOURCE_VERSION_RE,
    SKILL_ROOT,
    VOWEL_VISEMES,
    bgr_to_pil,
    contact_sheet,
    ensure_crop,
    ensure_external_media_project_root,
    executable,
    frame_cells,
    load_cropped_frames,
    load_project,
    paginate,
    parse_xywh,
    probe_video,
    project_paths,
    read_json,
    registered_library_records,
    resolve_avatar_library,
    resolve_avatar_package,
    resolve_avatar_package_container,
    resolve_registered_library_query,
    resolve_source,
    resolve_under,
    sampled_indices,
    validate_avatar_library_package,
    validate_library_payload,
    validate_media_manifest,
    write_json,
)


def _starter_manifest(destination: Path) -> None:
    starter = SKILL_ROOT / "assets" / "media-project-starter" / "media-sources.json"
    shutil.copyfile(starter, destination)


def _project_directories(root: Path) -> None:
    for directory in (
        root / "reports" / "avatar-source-review",
        root / "reports" / "avatar-library-review",
        root / "reports" / "avatar-renders",
        root / "working" / "anime-avatar",
        root / "working" / "anime-avatar-plans",
        root / "plans" / "anime-avatar",
        root / "renders",
    ):
        directory.mkdir(parents=True, exist_ok=True)


def _project_payload(library: dict) -> dict:
    return {
        "protocol": "visual-multimedia-anime-avatar-project",
        "version": 3,
        "library": library,
        "render": {
            "language": "zh-CN",
            "internal_fps": 24,
            "delivery_fps": 48,
            "output_size": [900, 900],
        },
    }


def _xywh_argument(value: str) -> list[int]:
    try:
        parts = [int(item.strip()) for item in value.split(",")]
        return list(parse_xywh(parts, "裁切参数"))
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(
            "必须使用 x,y,width,height 四个整数"
        ) from error


def init_project(args: argparse.Namespace) -> dict:
    paths = project_paths(ensure_external_media_project_root(Path(args.project)))
    root = paths["root"]
    root.mkdir(parents=True, exist_ok=True)
    if paths["project"].exists():
        raise FileExistsError(
            f"不会覆盖已有 avatar-project.json：{paths['project']}"
        )
    specification_path = Path(args.specification).expanduser().resolve()
    if not specification_path.is_file():
        raise FileNotFoundError(f"角色规格文件不存在：{specification_path}")
    specification = specification_path.read_text(encoding="utf-8").strip()
    if not specification:
        raise ValueError("角色规格文件不能为空")

    if not paths["manifest"].exists():
        _starter_manifest(paths["manifest"])

    prompts_dir = root / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    copied_prompts: list[str] = []
    for filename in ("master-image.md", "motion-source-video.md"):
        source = SKILL_ROOT / "assets" / "anime-avatar-prompts" / filename
        destination = prompts_dir / filename
        if destination.exists():
            raise FileExistsError(f"不会覆盖已有提示词：{destination}")
        shutil.copyfile(source, destination)
        copied_prompts.append(str(destination))

    library_root = root / "avatar-library"
    library_root.mkdir(parents=True, exist_ok=False)
    library_manifest = library_root / "media-sources.json"
    _starter_manifest(library_manifest)
    package = {
        "protocol": "visual-multimedia-anime-avatar-library-package",
        "version": 2,
        "id": args.character_id,
        "library_version": "0.1.0",
        "display_name": args.character_name,
        "status": "candidate",
        "character": {
            "id": args.character_id,
            "name": args.character_name,
            "origin": args.origin,
            "specification": specification,
            "master_source_id": None,
            "master_status": "missing",
        },
        "motion_source": {
            "source_id": None,
            "status": "missing",
            "source_crop_xywh": None,
            "mouth_review_crop_xywh": None,
        },
        "media_sources_file": "media-sources.json",
        "library_file": "visual-viseme-library.json",
        "capabilities": {
            "language": "zh-CN",
            "whole_frame": True,
            "visemes": ["CLOSED", "A", "I", "U", "E", "O"],
            "dynamic_closed_idle": True,
        },
        "parameter_provenance": {
            "protocol_invariants": [
                "library protocol and frame boundaries",
                "source id, fps, frame count and crop equality",
            ],
            "algorithm_defaults": [
                "render.internal_fps",
                "render.delivery_fps",
                "render.output_size",
            ],
            "asset_calibration": [
                "motion_source.source_crop_xywh",
                "motion_source.mouth_review_crop_xywh",
                "visual-viseme-library frame spans and strengths",
            ],
        },
        "validation": None,
        "provenance": {
            "registration_method": "new-character",
            "source_project_hint": None,
            "registered_at": None,
        },
    }
    validate_avatar_library_package(package, require_registered=False)
    package_path = library_root / "library-package.json"
    write_json(package_path, package)
    project = _project_payload(
        {
            "kind": "project",
            "package_file": "avatar-library/library-package.json",
        }
    )
    write_json(paths["project"], project)
    _project_directories(root)
    return {
        "ok": True,
        "project": str(root),
        "avatar_project": str(paths["project"]),
        "media_sources": str(paths["manifest"]),
        "avatar_library_package": str(package_path),
        "avatar_library_media_sources": str(library_manifest),
        "prompts": copied_prompts,
        "next": (
            "生成并确认母版和校准视频，将它们导入 avatar-library/"
            "media-sources.json，再填写 library-package.json 的角色、"
            "校准和注册状态。"
        ),
    }


def configure_source(args: argparse.Namespace) -> dict:
    project_root = ensure_external_media_project_root(Path(args.project))
    project, paths = load_project(project_root)
    if project["library"]["kind"] != "project":
        raise ValueError("configure-source 只修改 init 建立的项目内候选角色")
    context = resolve_avatar_package_container(project, paths)
    package = context["package"]
    manifest = validate_media_manifest(context["manifest_path"])
    resolve_source(
        manifest,
        context["root"],
        args.master_source_id,
        {"photo", "screenshot", "video-frame", "generated"},
    )
    resolve_source(
        manifest,
        context["root"],
        args.motion_source_id,
        {"video", "generated"},
    )
    source_crop = list(parse_xywh(args.source_crop, "--source-crop"))
    mouth_crop = list(
        parse_xywh(args.mouth_review_crop, "--mouth-review-crop")
    )
    package["character"]["master_source_id"] = args.master_source_id
    package["character"]["master_status"] = "confirmed"
    package["motion_source"] = {
        "source_id": args.motion_source_id,
        "status": "accepted",
        "source_crop_xywh": source_crop,
        "mouth_review_crop_xywh": mouth_crop,
    }
    validate_avatar_library_package(package, require_registered=False)
    write_json(context["package_path"], package)
    return {
        "ok": True,
        "project": str(project_root),
        "package": str(context["package_path"]),
        "master_source_id": args.master_source_id,
        "motion_source_id": args.motion_source_id,
        "source_crop_xywh": source_crop,
        "mouth_review_crop_xywh": mouth_crop,
        "next": (
            "运行 prepare-review，随后由 Agent 直接查看联系表并建立 "
            "visual-viseme-library.json。"
        ),
    }


def source_context(project_root: Path, *, require_library: bool = True):
    project, paths = load_project(project_root)
    library_context = (
        resolve_avatar_library(project, paths)
        if require_library
        else resolve_avatar_package(project, paths)
    )
    motion = library_context["package"]["motion_source"]
    source = library_context["motion_source"]
    source_path = library_context["motion_source_path"]
    crop = parse_xywh(motion.get("source_crop_xywh"), "motion_source.source_crop_xywh")
    return project, paths, library_context, source, source_path, crop


def prepare_review(args: argparse.Namespace) -> dict:
    project, paths, library_context, source, source_path, crop = source_context(
        Path(args.project),
        require_library=False,
    )
    ffprobe = executable("ffprobe", args.ffprobe)
    probe = probe_video(source_path, ffprobe)
    ensure_crop(crop, probe["width"], probe["height"], "source_crop_xywh")
    frames, fps = load_cropped_frames(source_path, crop)
    output_dir = paths["root"] / "reports" / "avatar-source-review"
    output_dir.mkdir(parents=True, exist_ok=True)

    outputs: list[str] = []
    overview_indices = sampled_indices(len(frames), fps, args.overview_fps)
    overview_path = output_dir / "overview.jpg"
    contact_sheet(
        frame_cells(frames, overview_indices, fps),
        overview_path,
        columns=5,
        cell_width=260,
        cell_height=260,
    )
    outputs.append(str(overview_path))

    full_indices = sampled_indices(len(frames), fps, args.full_fps)
    for page_index, page in enumerate(paginate(full_indices, args.page_size), start=1):
        destination = output_dir / f"full-{args.full_fps:g}fps-{page_index:02d}.jpg"
        contact_sheet(
            frame_cells(frames, page, fps),
            destination,
            columns=5,
            cell_width=260,
            cell_height=260,
        )
        outputs.append(str(destination))

    mouth_crop_value = library_context["package"]["motion_source"].get(
        "mouth_review_crop_xywh"
    )
    mouth_indices: list[int] = []
    if mouth_crop_value is not None:
        mouth_crop = parse_xywh(
            mouth_crop_value,
            "motion_source.mouth_review_crop_xywh",
        )
        ensure_crop(mouth_crop, crop[2], crop[3], "mouth_review_crop_xywh")
        mouth_indices = sampled_indices(len(frames), fps, args.mouth_fps)
        for page_index, page in enumerate(
            paginate(mouth_indices, args.page_size),
            start=1,
        ):
            destination = (
                output_dir / f"mouth-{args.mouth_fps:g}fps-{page_index:02d}.jpg"
            )
            contact_sheet(
                frame_cells(frames, page, fps, local_crop=mouth_crop),
                destination,
                columns=6,
                cell_width=220,
                cell_height=160,
            )
            outputs.append(str(destination))

    report = {
        "protocol": "visual-multimedia-anime-avatar-calibration-review",
        "version": 1,
        "source_id": source["id"],
        "source_file": source["file"],
        "source_probe": probe,
        "decoded_frame_count": len(frames),
        "decoded_fps": round(fps, 6),
        "source_crop_xywh": list(crop),
        "mouth_review_crop_xywh": mouth_crop_value,
        "sampling": {
            "overview": {
                "fps": args.overview_fps,
                "frames": overview_indices,
            },
            "full": {
                "fps": args.full_fps,
                "frames": full_indices,
            },
            "mouth": {
                "fps": args.mouth_fps if mouth_crop_value is not None else None,
                "frames": mouth_indices,
            },
        },
        "classification_boundary": {
            "script_did": [
                "probe source",
                "decode fixed crop",
                "sample indexed frames",
                "render contact sheets",
            ],
            "script_did_not": [
                "detect mouth",
                "classify A/I/U/E/O/CLOSED",
                "measure opening intensity",
                "infer gesture spans",
            ],
            "required_next_actor": "AI visual review of the generated sheets and original frames",
        },
        "outputs": outputs,
    }
    write_json(output_dir / "source-review.json", report)
    report["report"] = str(output_dir / "source-review.json")
    return report


def validate_library(args: argparse.Namespace) -> dict:
    project, paths, library_context, source, source_path, crop = source_context(
        Path(args.project)
    )
    frames, fps = load_cropped_frames(source_path, crop)
    library_file = library_context["library_path"]
    library = library_context["library"]
    report = validate_library_payload(
        library,
        source_id=source["id"],
        source_fps=fps,
        source_frame_count=len(frames),
        source_crop=crop,
    )
    output = paths["root"] / "reports" / "avatar-library-review" / "validation.json"
    write_json(output, report)
    report["report"] = str(output)
    if not report["ok"]:
        raise ValueError(
            "视觉口型库未通过质量门：\n- " + "\n- ".join(report["errors"])
        )
    return report


def library_frames(args: argparse.Namespace):
    project, paths, library_context, source, source_path, crop = source_context(
        Path(args.project)
    )
    frames, fps = load_cropped_frames(source_path, crop)
    library = library_context["library"]
    report = validate_library_payload(
        library,
        source_id=source["id"],
        source_fps=fps,
        source_frame_count=len(frames),
        source_crop=crop,
    )
    if not report["ok"]:
        raise ValueError(
            "视觉口型库未通过质量门：\n- " + "\n- ".join(report["errors"])
        )
    return project, paths, frames, fps, library, report


def render_library_review(args: argparse.Namespace) -> dict:
    _, paths, frames, fps, library, validation = library_frames(args)
    output_dir = paths["root"] / "reports" / "avatar-library-review"
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []

    level_cells = []
    for viseme in VOWEL_VISEMES:
        clips = [
            item for item in library["gesture_clips"] if item["viseme"] == viseme
        ]
        for clip in sorted(clips, key=lambda item: item["take"]):
            peak_strength = float(clip["peak_strength_level"])
            for level, frame_index in enumerate(
                clip["representative_frames_by_intensity"]
            ):
                level_cells.append(
                    (
                        bgr_to_pil(frames[frame_index]),
                        (
                            f"{viseme} rel-stage {level}/4 | "
                            f"peak {peak_strength:g} | "
                            f"{clip['id']} f{frame_index}"
                        ),
                    )
                )
    level_path = output_dir / "viseme-levels.jpg"
    contact_sheet(
        level_cells,
        level_path,
        columns=5,
        cell_width=250,
        cell_height=250,
    )
    outputs.append(str(level_path))

    eo_cells = []
    for viseme in ("E", "O"):
        for clip in sorted(
            [item for item in library["gesture_clips"] if item["viseme"] == viseme],
            key=lambda item: item["take"],
        ):
            peak_strength = float(clip["peak_strength_level"])
            for level, frame_index in enumerate(
                clip["representative_frames_by_intensity"]
            ):
                eo_cells.append(
                    (
                        bgr_to_pil(frames[frame_index]),
                        (
                            f"{viseme} rel-stage {level}/4 | "
                            f"peak {peak_strength:g} | "
                            f"{clip['id']} f{frame_index}"
                        ),
                    )
                )
    eo_path = output_dir / "E-vs-O-levels.jpg"
    contact_sheet(
        eo_cells,
        eo_path,
        columns=5,
        cell_width=280,
        cell_height=280,
    )
    outputs.append(str(eo_path))

    closed_cells = []
    for clip in library["closed_motion_clips"]:
        start = clip["start_frame"]
        end = clip["end_frame_exclusive"]
        indices = sorted({start, (start + end - 1) // 2, end - 1})
        for frame_index in indices:
            closed_cells.append(
                (
                    bgr_to_pil(frames[frame_index]),
                    f"CLOSED {clip['id']} f{frame_index}",
                )
            )
    closed_path = output_dir / "closed-motion.jpg"
    contact_sheet(
        closed_cells,
        closed_path,
        columns=3,
        cell_width=300,
        cell_height=300,
    )
    outputs.append(str(closed_path))

    gesture_reviews = []
    for clip_index, clip in enumerate(library["gesture_clips"], start=1):
        entry_frame = clip["rise_frames_by_intensity"][0]
        exit_frame = clip["fall_frames_by_intensity"][0]
        peak_start, peak_end = clip["peak_frame_range_inclusive"]
        peak_strength = float(clip["peak_strength_level"])
        sequence = (
            clip["rise_frames_by_intensity"]
            + list(range(
                peak_start,
                peak_end + 1,
            ))
            + list(reversed(clip["fall_frames_by_intensity"]))
        )
        selected = []
        for frame_index in sequence:
            if not selected or selected[-1] != frame_index:
                selected.append(frame_index)
        if len(selected) > 13:
            positions = [
                round(index * (len(selected) - 1) / 12)
                for index in range(13)
            ]
            selected = [selected[index] for index in positions]

        strip_cells = []
        for frame_index in selected:
            if frame_index == entry_frame:
                role = "ENTRY=consumer"
            elif frame_index == exit_frame:
                role = "EXIT=consumer"
            elif peak_start <= frame_index <= peak_end:
                role = "PEAK"
            else:
                role = "path"
            strip_cells.append(
                (
                    bgr_to_pil(frames[frame_index]),
                    (
                        f"{role} | peak {peak_strength:g} | "
                        f"f{frame_index}"
                    ),
                )
            )
        safe_clip_id = "".join(
            character
            if character.isalnum() or character in {"-", "_"}
            else "-"
            for character in clip["id"]
        )
        strip_path = output_dir / (
            f"gesture-{clip_index:02d}-{safe_clip_id}-continuity.jpg"
        )
        contact_sheet(
            strip_cells,
            strip_path,
            columns=min(13, len(strip_cells)),
            cell_width=125,
            cell_height=125,
            label_height=44,
        )
        outputs.append(str(strip_path))
        gesture_reviews.append(
            {
                "id": clip["id"],
                "viseme": clip["viseme"],
                "take": clip["take"],
                "start_frame": clip["start_frame"],
                "end_frame_exclusive": clip["end_frame_exclusive"],
                "peak_strength_level": peak_strength,
                "relative_stage_frames": {
                    "rise_0_to_4": clip["rise_frames_by_intensity"],
                    "fall_0_to_4": clip["fall_frames_by_intensity"],
                    "representative_0_to_4": (
                        clip["representative_frames_by_intensity"]
                    ),
                },
                "peak_frame_range_inclusive": [peak_start, peak_end],
                "consumer_and_review_entry_frame": entry_frame,
                "consumer_and_review_exit_frame": exit_frame,
                "reviewed_frame_sequence": selected,
                "review_file": str(strip_path),
                "ai_visual_checks": [
                    (
                        f"绝对峰值张口强度是 {peak_strength:g}；"
                        "相对阶段 4 只表示本动作的峰值阶段，"
                        "不能据此改写为绝对强度 4"
                    ),
                    (
                        f"审核入口与消费者入口同为 f{entry_frame}，"
                        f"审核出口与消费者出口同为 f{exit_frame}"
                    ),
                    "按低口型入口→峰值→低口型出口正序检查完整动作",
                ],
            }
        )

    natural_transition_reviews = []
    for span_index, span in enumerate(
        library["natural_transition_spans"],
        start=1,
    ):
        start = span["start_frame"]
        end = span["end_frame_exclusive"]
        context_start = max(0, start - 1)
        context_end = min(len(frames), end + 1)
        span_frames = list(range(start, end))
        span_length = len(span_frames)

        transition_cells = []
        for frame_index in range(context_start, context_end):
            if frame_index == start - 1:
                role = f"context before {span['from']}"
            elif frame_index == start:
                role = f"ENTRY {span['from']} ->"
            elif frame_index == end - 1:
                role = f"EXIT -> {span['to']}"
            elif frame_index == end:
                role = f"context after {span['to']}"
            else:
                role = f"path {frame_index - start + 1}/{span_length}"
            transition_cells.append(
                (
                    bgr_to_pil(frames[frame_index]),
                    f"f{frame_index} {role}",
                )
            )

        transition_path = output_dir / (
            f"natural-transition-{span_index:02d}-"
            f"{span['from'].lower()}-to-{span['to'].lower()}-"
            f"take-{span['take']}-f{start}-f{end - 1}.jpg"
        )
        contact_sheet(
            transition_cells,
            transition_path,
            columns=min(15, len(transition_cells)),
            cell_width=140,
            cell_height=140,
            label_height=34,
        )
        outputs.append(str(transition_path))
        natural_transition_reviews.append(
            {
                "from": span["from"],
                "to": span["to"],
                "take": span["take"],
                "start_frame": start,
                "end_frame_exclusive": end,
                "context_frame_range_inclusive": [
                    context_start,
                    context_end - 1,
                ],
                "directed_review": {
                    "entry": {
                        "frame": start,
                        "expected_state": span["from"],
                    },
                    "ordered_span_frames": span_frames,
                    "exit": {
                        "frame": end - 1,
                        "expected_state": span["to"],
                    },
                    "sequence": (
                        f"{span['from']}@f{start} -> "
                        f"every source frame in [{start}, {end}) -> "
                        f"{span['to']}@f{end - 1}"
                    ),
                    "consumer_entry_frame": start,
                    "consumer_exit_frame": end - 1,
                    "runtime_use": (
                        "只能按此正向完整连续区间审核；区间中间帧"
                        "不是任意入口，也不能反向播放。"
                    ),
                },
                "file": str(transition_path),
                "ai_visual_checks": [
                    (
                        f"入口 f{start} 必须仍属于 {span['from']}，"
                        f"出口 f{end - 1} 必须已经属于 {span['to']}"
                    ),
                    (
                        "按 entry→完整 span→exit 的源帧正序逐格检查，"
                        "不能跳帧、倒放或把中间帧当成另一个入口"
                    ),
                    "口型沿声明方向连续变化，类别由 AI 视觉判断",
                    "头部位置与运动速度方向连续，没有瞬间跳变",
                    "眨眼、眼神、头发、呆毛、耳朵和饰品运动方向连续",
                ],
            }
        )

    report = {
        "ok": True,
        "validation": validation,
        "outputs": outputs,
        "gesture_peak_strengths_by_viseme": validation[
            "gesture_peak_strengths_by_viseme"
        ],
        "gesture_review_files": [
            item["review_file"] for item in gesture_reviews
        ],
        "gesture_reviews": gesture_reviews,
        "natural_transition_review_files": [
            item["file"] for item in natural_transition_reviews
        ],
        "natural_transition_reviews": natural_transition_reviews,
        "required_human_or_ai_checks": [
            "A/I/U/E/O visual identity is correct",
            (
                "rise/fall/representative 的 0-4 是单条动作内的相对阶段；"
                "peak_strength_level 才是 1.0-4.0 的绝对峰值强度"
            ),
            (
                "按元音核对验证报告中的可用 peak strength 与"
                " has_strength_variation；同强度 take 不能冒充强弱素材"
            ),
            "每条动作标注的绝对峰值张口强度确实经过视觉审核",
            "E and O remain visually distinct",
            (
                "每条 gesture 审查图从消费者实际入口开始，"
                "经过峰值，并在消费者实际出口结束"
            ),
            "closed clips preserve natural secondary motion",
            (
                "每条 natural transition 必须按 entry→完整 span→exit 的"
                "源帧正序审核；from/to 只能是 A/I/U/E/O，"
                "中间帧不是任意入口，反向路径也不成立"
            ),
            (
                "由 AI 视觉确认 natural transition 的口型方向、头部速度、"
                "眨眼、头发和耳朵运动在完整区间内没有跳变"
            ),
            "代码只呈现带帧号的连续画面，不检测或推断口型",
        ],
    }
    write_json(output_dir / "library-review.json", report)
    report["report"] = str(output_dir / "library-review.json")
    return report


def list_libraries(_: argparse.Namespace) -> dict:
    records = registered_library_records()
    return {
        "ok": True,
        "catalog": str(AVATAR_LIBRARY_CATALOG),
        "default_library": next(
            (
                {"id": item["id"], "version": item["version"]}
                for item in records
                if item["is_default"]
            ),
            None,
        ),
        "libraries": records,
    }


def adopt_library(args: argparse.Namespace) -> dict:
    paths = project_paths(ensure_external_media_project_root(Path(args.project)))
    root = paths["root"]
    root.mkdir(parents=True, exist_ok=True)
    if paths["project"].exists():
        raise FileExistsError(
            f"不会覆盖已有 avatar-project.json：{paths['project']}"
        )
    record = resolve_registered_library_query(args.library, args.version)
    if record["status"] != "registered":
        raise ValueError(
            f"角色素材库尚未注册可用：{record['id']}@{record['version']}"
        )
    if not paths["manifest"].exists():
        _starter_manifest(paths["manifest"])
    project = _project_payload(
        {
            "kind": "registered",
            "id": record["id"],
            "version": record["version"],
        }
    )
    write_json(paths["project"], project)
    _project_directories(root)
    loaded_project, loaded_paths = load_project(root)
    library_context = resolve_avatar_library(loaded_project, loaded_paths)
    return {
        "ok": True,
        "project": str(root),
        "avatar_project": str(paths["project"]),
        "media_sources": str(paths["manifest"]),
        "library": {
            "id": library_context["package"]["id"],
            "version": library_context["package"]["library_version"],
            "display_name": library_context["package"]["display_name"],
            "package": str(library_context["package_path"]),
            "is_default": record["is_default"],
            "is_preferred": record["is_preferred"],
        },
        "next": (
            "把本次语音来源登记到项目 media-sources.json，"
            "再建立逐字时间轴；角色母版、校准视频和口型库保持只读复用。"
        ),
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _legacy_source(
    manifest: dict,
    source_id: str,
    root: Path,
) -> tuple[dict, Path]:
    matches = [
        item
        for item in manifest.get("sources", [])
        if item.get("id") == source_id
    ]
    if len(matches) != 1:
        raise ValueError(f"旧素材账本无法唯一解析 source id：{source_id}")
    source = copy.deepcopy(matches[0])
    source_path = resolve_under(root, source["file"], f"legacy source {source_id}")
    if not source_path.is_file():
        raise FileNotFoundError(f"旧素材不存在：{source_path}")
    integrity = source.get("integrity")
    if not isinstance(integrity, dict):
        raise ValueError(f"旧素材 {source_id} 缺少 integrity")
    actual_sha256 = _sha256(source_path)
    actual_bytes = source_path.stat().st_size
    if integrity.get("sha256") != actual_sha256:
        raise ValueError(f"旧素材 {source_id} 的 sha256 不一致")
    if integrity.get("bytes") != actual_bytes:
        raise ValueError(f"旧素材 {source_id} 的 bytes 不一致")
    source["representation"] = {
        "kind": "source",
        "source_id": None,
        "build": None,
        "verification": None,
    }
    return source, source_path


def _catalog_with_registration(
    catalog: dict,
    *,
    library_id: str,
    display_name: str,
    version: str,
    package_file: str,
) -> dict:
    updated = copy.deepcopy(catalog)
    entry = next(
        (item for item in updated["libraries"] if item["id"] == library_id),
        None,
    )
    if entry is None:
        entry = {
            "id": library_id,
            "display_name": display_name,
            "aliases": [display_name],
            "preferred_version": version,
            "versions": [],
        }
        updated["libraries"].append(entry)
    elif entry["display_name"] != display_name:
        raise ValueError(
            f"注册表中的 {library_id} display_name 已是 {entry['display_name']}"
        )
    if any(item["version"] == version for item in entry["versions"]):
        raise FileExistsError(f"角色素材库已注册：{library_id}@{version}")
    entry["versions"].append(
        {
            "version": version,
            "status": "registered",
            "package_file": package_file,
        }
    )
    entry["preferred_version"] = version
    entry["versions"].sort(key=lambda item: item["version"])
    updated["libraries"].sort(key=lambda item: item["id"])
    return updated


def _materialize_registered_library(
    *,
    library_id: str,
    display_name: str,
    version: str,
    character: dict,
    motion: dict,
    source_files: list[tuple[dict, Path]],
    library: dict,
    validation: dict,
    source_frame_count: int,
    source_fps: float,
    review_root: Path,
    parameter_provenance: dict,
    registration_method: str,
    source_project_hint: str,
) -> dict:
    if not RESOURCE_ID_RE.fullmatch(library_id):
        raise ValueError("角色素材库 id 无效")
    if not RESOURCE_VERSION_RE.fullmatch(version):
        raise ValueError("角色素材库 version 必须是 x.y.z")
    if not display_name.strip():
        raise ValueError("角色素材库 display_name 不能为空")
    if not validation["ok"]:
        raise ValueError(
            "视觉口型库未通过当前质量门：\n- "
            + "\n- ".join(validation["errors"])
        )
    annotation = library.get("annotation") or {}
    review_evidence_sources: list[tuple[str, Path]] = []
    for relative in annotation.get("reviewed_contact_sheets") or []:
        source = resolve_under(review_root, relative, "reviewed_contact_sheets")
        if not source.is_file():
            raise FileNotFoundError(f"AI 视觉审阅证据不存在：{source}")
        review_evidence_sources.append((relative, source))
    target_root = (AVATAR_LIBRARY_ROOT / library_id / version).resolve()
    if target_root.exists():
        raise FileExistsError(f"不会覆盖已有角色素材库目录：{target_root}")
    catalog = read_json(AVATAR_LIBRARY_CATALOG)
    package_relative = (
        Path(library_id) / version / "library-package.json"
    ).as_posix()
    updated_catalog = _catalog_with_registration(
        catalog,
        library_id=library_id,
        display_name=display_name,
        version=version,
        package_file=package_relative,
    )
    migrated_sources: list[dict] = []
    for original_source, source_path in source_files:
        source = copy.deepcopy(original_source)
        source["representation"] = {
            "kind": "source",
            "source_id": None,
            "build": None,
            "verification": None,
        }
        destination = resolve_under(
            target_root,
            source["file"],
            "registered source",
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
        migrated_sources.append(source)
    target_root.mkdir(parents=True, exist_ok=True)
    write_json(
        target_root / "media-sources.json",
        {
            "protocol": "visual-multimedia-media-sources",
            "version": 3,
            "sources": migrated_sources,
        },
    )
    registered_library = copy.deepcopy(library)
    registered_library["version"] = 3
    write_json(target_root / "visual-viseme-library.json", registered_library)
    copied_review_evidence: list[str] = []
    for relative, source in review_evidence_sources:
        destination = resolve_under(
            target_root,
            relative,
            "reviewed_contact_sheets",
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied_review_evidence.append(relative)
    package = {
        "protocol": "visual-multimedia-anime-avatar-library-package",
        "version": 2,
        "id": library_id,
        "library_version": version,
        "display_name": display_name,
        "status": "registered",
        "character": copy.deepcopy(character),
        "motion_source": copy.deepcopy(motion),
        "media_sources_file": "media-sources.json",
        "library_file": "visual-viseme-library.json",
        "capabilities": {
            "language": "zh-CN",
            "whole_frame": True,
            "visemes": ["CLOSED", "A", "I", "U", "E", "O"],
            "dynamic_closed_idle": True,
        },
        "parameter_provenance": copy.deepcopy(parameter_provenance),
        "validation": {
            "validated_at": datetime.now(timezone.utc).isoformat(),
            "source_frame_count": source_frame_count,
            "source_fps": round(source_fps, 6),
            "review_evidence_files": copied_review_evidence,
            "accepted_production_evidence_file": None,
            "library_sha256": _sha256(
                target_root / "visual-viseme-library.json"
            ),
        },
        "provenance": {
            "registration_method": registration_method,
            "source_project_hint": source_project_hint,
            "registered_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    validate_avatar_library_package(package, require_registered=True)
    write_json(target_root / "library-package.json", package)
    validate_media_manifest(target_root / "media-sources.json")
    write_json(AVATAR_LIBRARY_CATALOG, updated_catalog)
    registered = [
        item
        for item in registered_library_records()
        if item["id"] == library_id and item["version"] == version
    ]
    if len(registered) != 1:
        raise RuntimeError("注册完成后无法从活动注册表重新解析新资源")
    return {
        "ok": True,
        "library": registered[0],
        "package": str(target_root / "library-package.json"),
        "media_sources": str(target_root / "media-sources.json"),
        "visual_viseme_library": str(
            target_root / "visual-viseme-library.json"
        ),
        "review_evidence_count": len(copied_review_evidence),
        "default_changed": False,
        "source_project_preserved": source_project_hint,
    }


def register_library(args: argparse.Namespace) -> dict:
    project_root = Path(args.source_project).expanduser().resolve()
    project, paths = load_project(project_root)
    if project["library"]["kind"] != "project":
        raise ValueError(
            "register-library 只接受 init 建立的项目内候选素材库；"
            "已注册资源不重复注册"
        )
    context = resolve_avatar_library(project, paths)
    package = context["package"]
    motion = package["motion_source"]
    crop = parse_xywh(
        motion.get("source_crop_xywh"),
        "motion_source.source_crop_xywh",
    )
    frames, fps = load_cropped_frames(context["motion_source_path"], crop)
    validation = validate_library_payload(
        context["library"],
        source_id=context["motion_source"]["id"],
        source_fps=fps,
        source_frame_count=len(frames),
        source_crop=crop,
    )
    source_hint = str(project_root)
    try:
        source_hint = project_root.relative_to(SKILL_ROOT).as_posix()
    except ValueError:
        pass
    return _materialize_registered_library(
        library_id=package["id"],
        display_name=package["display_name"],
        version=args.version,
        character=package["character"],
        motion=motion,
        source_files=[
            (context["master_source"], context["master_source_path"]),
            (context["motion_source"], context["motion_source_path"]),
        ],
        library=context["library"],
        validation=validation,
        source_frame_count=len(frames),
        source_fps=fps,
        review_root=paths["root"],
        parameter_provenance=package["parameter_provenance"],
        registration_method="register-project-v3",
        source_project_hint=source_hint,
    )


def migrate_library(args: argparse.Namespace) -> dict:
    if not RESOURCE_ID_RE.fullmatch(args.library_id):
        raise ValueError("--library-id 无效")
    if not RESOURCE_VERSION_RE.fullmatch(args.version):
        raise ValueError("--version 必须是 x.y.z")
    if not args.display_name.strip():
        raise ValueError("--display-name 不能为空")
    legacy_root = Path(args.source_project).expanduser().resolve()
    legacy_project_path = legacy_root / "avatar-project.json"
    legacy_manifest_path = legacy_root / "media-sources.json"
    legacy_project = read_json(legacy_project_path)
    if (
        legacy_project.get("protocol")
        != "visual-multimedia-anime-avatar-project"
        or legacy_project.get("version") != 1
    ):
        raise ValueError("migrate-library 只接受明确的旧版 avatar project v1")
    if not isinstance(legacy_project.get("character"), dict):
        raise ValueError("旧项目 character 无效")
    if not isinstance(legacy_project.get("motion_source"), dict):
        raise ValueError("旧项目 motion_source 无效")
    legacy_manifest = read_json(legacy_manifest_path)
    if (
        legacy_manifest.get("protocol") != "visual-multimedia-media-sources"
        or legacy_manifest.get("version") not in {2, 3}
    ):
        raise ValueError("旧项目 media-sources.json 必须是 v2 或 v3")
    character = copy.deepcopy(legacy_project["character"])
    motion = copy.deepcopy(legacy_project["motion_source"])
    master_source, master_path = _legacy_source(
        legacy_manifest,
        character["master_source_id"],
        legacy_root,
    )
    motion_source, motion_path = _legacy_source(
        legacy_manifest,
        motion["source_id"],
        legacy_root,
    )
    crop = parse_xywh(
        motion.get("source_crop_xywh"),
        "motion_source.source_crop_xywh",
    )
    library_file = resolve_under(
        legacy_root,
        legacy_project.get("library_file"),
        "legacy library_file",
    )
    library = read_json(library_file)
    frames, fps = load_cropped_frames(motion_path, crop)
    if library.get("version") == 1:
        if not args.confirm_closed_motion_exhaustive_review:
            raise ValueError(
                "旧口型库 v1 没有闭嘴穷尽审阅合同。请完整查看源视频与"
                "嘴部联系表，确认 closed_motion_clips 已包含全部连续闭嘴区间后，"
                "再显式传入 --confirm-closed-motion-exhaustive-review。"
            )
        annotation = library.get("annotation")
        if not isinstance(annotation, dict):
            raise ValueError("旧口型库 annotation 无效")
        annotation["closed_motion_exhaustive_review"] = {
            "exhaustive": True,
            "reviewed_frame_range": [0, len(frames)],
            "decision": (
                "迁移前已完整复核源视频与嘴部联系表；"
                "所有视觉成立的连续闭嘴区间均已进入 closed_motion_clips。"
            ),
        }
    library["version"] = 3
    validation = validate_library_payload(
        library,
        source_id=motion_source["id"],
        source_fps=fps,
        source_frame_count=len(frames),
        source_crop=crop,
    )
    if not validation["ok"]:
        raise ValueError(
            "旧视觉口型库未通过当前质量门：\n- "
            + "\n- ".join(validation["errors"])
        )
    source_hint = str(legacy_root)
    try:
        source_hint = legacy_root.relative_to(SKILL_ROOT).as_posix()
    except ValueError:
        pass
    return _materialize_registered_library(
        library_id=args.library_id,
        display_name=args.display_name,
        version=args.version,
        character=character,
        motion=motion,
        source_files=[
            (master_source, master_path),
            (motion_source, motion_path),
        ],
        library=library,
        validation=validation,
        source_frame_count=len(frames),
        source_fps=fps,
        review_root=legacy_root,
        parameter_provenance={
            "protocol_invariants": [
                "library protocol and frame boundaries",
                "source id, fps, frame count and crop equality",
            ],
            "algorithm_defaults": [
                "project render.internal_fps",
                "project render.delivery_fps",
                "project render.output_size",
            ],
            "asset_calibration": [
                "motion_source.source_crop_xywh",
                "motion_source.mouth_review_crop_xywh",
                "visual-viseme-library frame spans and strengths",
            ],
        },
        registration_method="migrate-project-v1",
        source_project_hint=source_hint,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "建立、注册、采用、检查和验证无需 Live2D 的二次元口播形象项目。"
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser(
        "list-libraries",
        help="列出正式注册且可显式采用的角色素材库",
    )
    list_parser.set_defaults(handler=list_libraries)

    init_parser = subparsers.add_parser("init", help="初始化全新角色项目")
    init_parser.add_argument("--project", required=True)
    init_parser.add_argument("--character-id", required=True)
    init_parser.add_argument("--character-name", required=True)
    init_parser.add_argument(
        "--origin",
        choices=("reference-image", "description"),
        required=True,
    )
    init_parser.add_argument("--specification", required=True)
    init_parser.set_defaults(handler=init_project)

    source_parser = subparsers.add_parser(
        "configure-source",
        help="把已确认母版和唯一校准视频绑定到候选角色并写入固定裁切",
    )
    source_parser.add_argument("--project", required=True)
    source_parser.add_argument("--master-source-id", required=True)
    source_parser.add_argument("--motion-source-id", required=True)
    source_parser.add_argument(
        "--source-crop",
        required=True,
        type=_xywh_argument,
    )
    source_parser.add_argument(
        "--mouth-review-crop",
        required=True,
        type=_xywh_argument,
    )
    source_parser.set_defaults(handler=configure_source)

    adopt_parser = subparsers.add_parser(
        "adopt-library",
        help="在全新外部项目中按角色名、别名或 id 采用已注册角色素材库",
    )
    adopt_parser.add_argument("--project", required=True)
    adopt_parser.add_argument("--library", required=True)
    adopt_parser.add_argument("--version")
    adopt_parser.set_defaults(handler=adopt_library)

    register_parser = subparsers.add_parser(
        "register-library",
        help=(
            "把 init 建立并完成视觉标注的项目内候选素材库"
            "注册为版本化、非默认的共享资源"
        ),
    )
    register_parser.add_argument("--source-project", required=True)
    register_parser.add_argument("--version", required=True)
    register_parser.set_defaults(handler=register_library)

    migrate_parser = subparsers.add_parser(
        "migrate-library",
        help=(
            "把明确的旧版项目 v1 一次性迁移为已注册、版本化、"
            "非默认的共享角色素材库"
        ),
    )
    migrate_parser.add_argument("--source-project", required=True)
    migrate_parser.add_argument("--library-id", required=True)
    migrate_parser.add_argument("--display-name", required=True)
    migrate_parser.add_argument("--version", required=True)
    migrate_parser.add_argument(
        "--confirm-closed-motion-exhaustive-review",
        action="store_true",
        help=(
            "确认已经完整查看旧源视频和嘴部联系表，"
            "closed_motion_clips 不是达到三段门槛后提前停止"
        ),
    )
    migrate_parser.set_defaults(handler=migrate_library)

    review_parser = subparsers.add_parser(
        "prepare-review",
        help="生成供 AI 视觉标注使用的带索引联系表",
    )
    review_parser.add_argument("--project", required=True)
    review_parser.add_argument("--overview-fps", type=float, default=2.0)
    review_parser.add_argument("--full-fps", type=float, default=8.0)
    review_parser.add_argument("--mouth-fps", type=float, default=12.0)
    review_parser.add_argument("--page-size", type=int, default=30)
    review_parser.add_argument("--ffprobe")
    review_parser.set_defaults(handler=prepare_review)

    validate_parser = subparsers.add_parser(
        "validate-library",
        help=(
            "检查 AI 素材库的严格帧边界、绝对峰值强度、"
            "元音自然过渡和质量数量"
        ),
        description=(
            "严格验证每条 gesture 的 peak_strength_level、"
            "[start_frame, end_frame_exclusive) 内真实帧、"
            "fall[0] 唯一出口，以及仅限 A/I/U/E/O 的自然过渡。"
        ),
    )
    validate_parser.add_argument("--project", required=True)
    validate_parser.set_defaults(handler=validate_library)

    render_parser = subparsers.add_parser(
        "render-library-review",
        help=(
            "生成明确显示绝对峰值强度及消费者实际入口/出口的"
            "连续动作审查图"
        ),
        description=(
            "为每条动作生成低→峰→低联系表，并在图片和 JSON 中"
            "明确标出绝对峰值强度与消费者实际使用的入口、出口帧。"
        ),
    )
    render_parser.add_argument("--project", required=True)
    render_parser.set_defaults(handler=render_library_review)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = args.handler(args)
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
        OSError,
    ) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

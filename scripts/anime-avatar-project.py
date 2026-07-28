#!/usr/bin/env python3
"""Initialize, inspect and validate a no-rig anime-avatar source library."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from anime_avatar_common import (
    SKILL_ROOT,
    VOWEL_VISEMES,
    bgr_to_pil,
    contact_sheet,
    ensure_crop,
    executable,
    frame_cells,
    library_path,
    load_cropped_frames,
    load_project,
    paginate,
    parse_xywh,
    probe_video,
    project_paths,
    read_json,
    resolve_source,
    sampled_indices,
    validate_library_payload,
    validate_media_manifest,
    write_json,
)


def init_project(args: argparse.Namespace) -> dict:
    paths = project_paths(Path(args.project))
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
        starter = SKILL_ROOT / "assets" / "media-project-starter" / "media-sources.json"
        shutil.copyfile(starter, paths["manifest"])

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

    project = {
        "protocol": "visual-multimedia-anime-avatar-project",
        "version": 1,
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
        "library_file": "visual-viseme-library.json",
        "render": {
            "language": "zh-CN",
            "internal_fps": 24,
            "delivery_fps": 48,
            "output_size": [900, 900],
        },
    }
    write_json(paths["project"], project)
    for directory in (
        root / "reports" / "avatar-source-review",
        root / "reports" / "avatar-library-review",
        root / "reports" / "avatar-renders",
        root / "working" / "anime-avatar",
        root / "renders",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return {
        "ok": True,
        "project": str(root),
        "avatar_project": str(paths["project"]),
        "media_sources": str(paths["manifest"]),
        "prompts": copied_prompts,
        "next": (
            "生成并确认母版，将母版导入 media-sources.json，"
            "再填写 character.master_source_id 与 master_status=confirmed。"
        ),
    }


def source_context(project_root: Path):
    project, paths = load_project(project_root)
    manifest = validate_media_manifest(paths["manifest"])
    motion = project["motion_source"]
    source, source_path = resolve_source(
        manifest,
        paths["root"],
        motion.get("source_id"),
        {"video", "generated"},
    )
    crop = parse_xywh(motion.get("source_crop_xywh"), "motion_source.source_crop_xywh")
    return project, paths, manifest, source, source_path, crop


def prepare_review(args: argparse.Namespace) -> dict:
    project, paths, _, source, source_path, crop = source_context(
        Path(args.project)
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

    mouth_crop_value = project["motion_source"].get("mouth_review_crop_xywh")
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
        "protocol": "visual-multimedia-anime-avatar-source-review",
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
    project, paths, _, source, source_path, crop = source_context(
        Path(args.project)
    )
    frames, fps = load_cropped_frames(source_path, crop)
    library_file = library_path(project, paths)
    library = read_json(library_file)
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
    project, paths, _, source, source_path, crop = source_context(
        Path(args.project)
    )
    frames, fps = load_cropped_frames(source_path, crop)
    library_file = library_path(project, paths)
    library = read_json(library_file)
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
    gestures_by_id = {item["id"]: item for item in library["gesture_clips"]}
    for viseme in VOWEL_VISEMES:
        clips = [
            item for item in library["gesture_clips"] if item["viseme"] == viseme
        ]
        for clip in sorted(clips, key=lambda item: item["take"]):
            for level, frame_index in enumerate(
                clip["representative_frames_by_intensity"]
            ):
                level_cells.append(
                    (
                        bgr_to_pil(frames[frame_index]),
                        f"{viseme}{level} {clip['id']} f{frame_index}",
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
            for level, frame_index in enumerate(
                clip["representative_frames_by_intensity"]
            ):
                eo_cells.append(
                    (
                        bgr_to_pil(frames[frame_index]),
                        f"{viseme}{level} {clip['id']} f{frame_index}",
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

    strip_cells = []
    for clip in library["gesture_clips"]:
        sequence = (
            clip["rise_frames_by_intensity"]
            + list(range(
                clip["peak_frame_range_inclusive"][0],
                clip["peak_frame_range_inclusive"][1] + 1,
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
        for frame_index in selected:
            strip_cells.append(
                (
                    bgr_to_pil(frames[frame_index]),
                    f"{clip['id']} f{frame_index}",
                )
            )
    for page_index, page in enumerate(
        [strip_cells[index : index + 65] for index in range(0, len(strip_cells), 65)],
        start=1,
    ):
        strip_path = output_dir / f"gesture-continuity-{page_index:02d}.jpg"
        contact_sheet(
            page,
            strip_path,
            columns=13,
            cell_width=125,
            cell_height=125,
            label_height=34,
        )
        outputs.append(str(strip_path))

    report = {
        "ok": True,
        "validation": validation,
        "outputs": outputs,
        "required_human_or_ai_checks": [
            "A/I/U/E/O visual identity is correct",
            "0-4 is monotonic within each vowel, not across vowels",
            "largest openings were actually reviewed",
            "E and O remain visually distinct",
            "every gesture strip has a continuous rise, peak and fall",
            "closed clips preserve natural secondary motion",
        ],
    }
    write_json(output_dir / "library-review.json", report)
    report["report"] = str(output_dir / "library-review.json")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="建立、检查和验证无需 Live2D 的二次元口播形象项目。"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

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
        help="检查 AI 已写好的素材库结构、帧边界和质量数量",
    )
    validate_parser.add_argument("--project", required=True)
    validate_parser.set_defaults(handler=validate_library)

    render_parser = subparsers.add_parser(
        "render-library-review",
        help="从 AI 标注反向生成类别、强度和连续动作审查图",
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

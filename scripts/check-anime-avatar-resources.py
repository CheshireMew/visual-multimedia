#!/usr/bin/env python3
"""Validate registered anime-avatar resources without rendering a video."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from anime_avatar_common import (
    AVATAR_LIBRARY_ROOT,
    load_cropped_frames,
    load_project,
    parse_xywh,
    project_paths,
    registered_library_records,
    resolve_avatar_library,
    resolve_under,
    validate_library_payload,
)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validate_registered_resources(deep: bool) -> dict:
    records = registered_library_records()
    checked: list[dict] = []
    for record in records:
        project = {
            "library": {
                "kind": "registered",
                "id": record["id"],
                "version": record["version"],
            }
        }
        context = resolve_avatar_library(
            project,
            project_paths(AVATAR_LIBRARY_ROOT.parent),
        )
        package = context["package"]
        validation = package.get("validation")
        if not isinstance(validation, dict):
            raise ValueError(
                f"{record['id']}@{record['version']} 缺少正式验证记录"
            )
        actual_library_sha256 = file_sha256(context["library_path"])
        if validation.get("library_sha256") != actual_library_sha256:
            raise ValueError(
                f"{record['id']}@{record['version']} 的口型库哈希与包记录不一致"
            )
        evidence_files = []
        for relative in validation.get("review_evidence_files") or []:
            evidence = resolve_under(
                context["root"],
                relative,
                "validation.review_evidence_files",
            )
            if not evidence.is_file() or evidence.stat().st_size == 0:
                raise FileNotFoundError(f"角色素材库审阅证据不存在：{evidence}")
            evidence_files.append(str(evidence))
        accepted_evidence_relative = validation.get(
            "accepted_production_evidence_file"
        )
        accepted_evidence = None
        if accepted_evidence_relative:
            accepted_evidence = resolve_under(
                context["root"],
                accepted_evidence_relative,
                "validation.accepted_production_evidence_file",
            )
            if not accepted_evidence.is_file():
                raise FileNotFoundError(
                    f"用户验收生产证据不存在：{accepted_evidence}"
                )
        item = {
            "id": record["id"],
            "version": record["version"],
            "is_default": record["is_default"],
            "is_preferred": record["is_preferred"],
            "package": str(context["package_path"]),
            "media_sources": str(context["manifest_path"]),
            "visual_viseme_library": str(context["library_path"]),
            "review_evidence_count": len(evidence_files),
            "accepted_production_evidence": (
                str(accepted_evidence) if accepted_evidence else None
            ),
            "capabilities": package["capabilities"],
            "closed_motion_exhaustive_review": context["library"][
                "annotation"
            ]["closed_motion_exhaustive_review"],
            "closed_motion_clip_count": len(
                context["library"]["closed_motion_clips"]
            ),
            "deep_library_validation": None,
        }
        if deep:
            motion = package["motion_source"]
            source = context["motion_source"]
            source_path = context["motion_source_path"]
            crop = parse_xywh(
                motion["source_crop_xywh"],
                "motion_source.source_crop_xywh",
            )
            frames, fps = load_cropped_frames(source_path, crop)
            report = validate_library_payload(
                context["library"],
                source_id=source["id"],
                source_fps=fps,
                source_frame_count=len(frames),
                source_crop=crop,
            )
            if not report["ok"]:
                raise ValueError(
                    f"{record['id']}@{record['version']} 口型库质量门失败：\n- "
                    + "\n- ".join(report["errors"])
                )
            item["deep_library_validation"] = {
                "ok": True,
                "decoded_frame_count": len(frames),
                "source_fps": round(fps, 6),
                "capability_facts": report["capability_facts"],
            }
        checked.append(item)
    return {
        "registered_library_count": len(checked),
        "default_library_count": sum(
            1 for item in checked if item["is_default"]
        ),
        "libraries": checked,
    }


def validate_adopted_project(project_root: Path) -> dict:
    project, paths = load_project(project_root)
    if project["library"]["kind"] != "registered":
        raise ValueError("--project 必须是通过 adopt-library 建立的注册资源项目")
    context = resolve_avatar_library(project, paths)
    return {
        "project": str(paths["root"]),
        "avatar_project": str(paths["project"]),
        "library_reference": project["library"],
        "resolved_package": str(context["package_path"]),
        "resolved_media_sources": str(context["manifest_path"]),
        "resolved_visual_viseme_library": str(context["library_path"]),
        "consumer_loaded_character_id": context["package"]["character"]["id"],
        "consumer_loaded_motion_source_id": context["package"]["motion_source"][
            "source_id"
        ],
        "consumer_loaded_capabilities": context["package"]["capabilities"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--deep",
        action="store_true",
        help="解码真实校准视频并验证口型库帧合同；仍不合成视频",
    )
    parser.add_argument(
        "--project",
        help="检查一个由 adopt-library 建立的全新外部项目是否实际解析注册资源",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "ok": True,
        "rendered_video": False,
        "registered_resources": validate_registered_resources(args.deep),
        "adopted_project": (
            validate_adopted_project(Path(args.project))
            if args.project
            else None
        ),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, ValueError, RuntimeError, OSError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

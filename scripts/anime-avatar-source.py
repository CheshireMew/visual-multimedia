#!/usr/bin/env python3
"""Manage the active source-only contract for no-rig anime avatars."""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from anime_avatar_media import (
    ID_RE,
    SKILL_ROOT,
    SOURCE_CATALOG,
    SOURCE_ROOT,
    VERSION_RE,
    contact_sheet,
    ensure_crop,
    ensure_skill_task_project,
    executable,
    file_sha256,
    load_cropped_frames,
    parse_xywh,
    probe_video,
    read_json,
    resolve_source,
    sampled_indices,
    validate_media_manifest,
    write_json,
)
from media_task_workspace import assert_skill_task_path


PROJECT_PROTOCOL = "visual-multimedia-anime-avatar-source-project"
SOURCE_PROTOCOL = "visual-multimedia-anime-avatar-source-set"
CATALOG_PROTOCOL = "visual-multimedia-anime-avatar-source-catalog"
PROJECT_FILE = "anime-avatar-source.json"
LOCAL_PACKAGE_FILE = "avatar-source/anime-avatar-source-set.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def project_for_init(value: str) -> Path:
    root = assert_skill_task_path(value, "角色源素材项目")
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "media-sources.json"
    if not manifest.exists():
        write_json(
            manifest,
            {
                "protocol": "visual-multimedia-media-sources",
                "version": 3,
                "sources": [],
            },
        )
    validate_media_manifest(manifest)
    return root


def stable_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ValueError(f"{field} 必须是稳定的小写 id")
    return value


def semantic_version(value: Any, field: str) -> str:
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        raise ValueError(f"{field} 必须是 x.y.z 版本号")
    return value


def project_file(root: Path) -> Path:
    return root / PROJECT_FILE


def local_package_file(root: Path) -> Path:
    return root / LOCAL_PACKAGE_FILE


def validate_project_record(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) != {"protocol", "version", "source"}:
        raise ValueError("anime-avatar-source.json 字段不完整或含未知字段")
    if payload.get("protocol") != PROJECT_PROTOCOL or payload.get("version") != 1:
        raise ValueError("anime-avatar-source.json 协议或版本不正确")
    source = payload.get("source")
    if not isinstance(source, dict):
        raise ValueError("anime-avatar-source.json.source 必须是对象")
    kind = source.get("kind")
    if kind == "project":
        if source != {"kind": "project", "package_file": LOCAL_PACKAGE_FILE}:
            raise ValueError("项目候选角色必须引用唯一的本地 source set")
    elif kind == "registered":
        if set(source) != {"kind", "id", "source_version"}:
            raise ValueError("已注册角色引用字段不正确")
        stable_id(source.get("id"), "source.id")
        semantic_version(source.get("source_version"), "source.source_version")
    else:
        raise ValueError("source.kind 必须是 project 或 registered")
    return source


def load_catalog() -> dict[str, Any]:
    payload = read_json(SOURCE_CATALOG)
    if payload.get("protocol") != CATALOG_PROTOCOL or payload.get("version") != 1:
        raise ValueError("角色源素材目录协议或版本不正确")
    if payload.get("default_source") is not None:
        raise ValueError("角色源素材目录不得设置默认角色")
    if not isinstance(payload.get("sources"), list):
        raise ValueError("角色源素材目录 sources 必须是数组")
    return payload


def find_registered(source_id: str, version: str) -> tuple[dict[str, Any], Path]:
    catalog = load_catalog()
    matches: list[dict[str, Any]] = []
    for source in catalog["sources"]:
        if source.get("id") != source_id:
            continue
        for record in source.get("versions", []):
            if record.get("version") == version:
                matches.append(record)
    if len(matches) != 1:
        raise ValueError(f"无法唯一解析已注册角色源素材：{source_id}@{version}")
    package_path = (SOURCE_ROOT / matches[0]["package_file"]).resolve()
    try:
        package_path.relative_to(SOURCE_ROOT.resolve())
    except ValueError as error:
        raise ValueError("已注册角色源素材路径越出资源目录") from error
    return matches[0], package_path


def resolve_package(root: Path) -> tuple[dict[str, Any], Path, Path]:
    source = validate_project_record(read_json(project_file(root)))
    if source["kind"] == "project":
        package_path = local_package_file(root)
        package_root = root
    else:
        _, package_path = find_registered(source["id"], source["source_version"])
        package_root = package_path.parent
    return read_json(package_path), package_path, package_root


def validate_source_set(
    package: dict[str, Any],
    package_root: Path,
    *,
    ffprobe: str,
    require_confirmed_review: bool,
) -> dict[str, Any]:
    required = {
        "protocol",
        "version",
        "id",
        "source_version",
        "display_name",
        "status",
        "character",
        "calibration",
        "media_sources_file",
        "source_review",
        "parameter_provenance",
        "provenance",
    }
    if set(package) != required:
        raise ValueError("角色源素材包字段不完整或含未知字段")
    if package.get("protocol") != SOURCE_PROTOCOL or package.get("version") != 1:
        raise ValueError("角色源素材包协议或版本不正确")
    source_id = stable_id(package.get("id"), "id")
    source_version = semantic_version(package.get("source_version"), "source_version")
    if package.get("status") not in {"candidate", "registered"}:
        raise ValueError("status 必须是 candidate 或 registered")
    if not isinstance(package.get("display_name"), str) or not package["display_name"]:
        raise ValueError("display_name 不能为空")

    character = package.get("character")
    if not isinstance(character, dict) or set(character) != {
        "id",
        "name",
        "origin",
        "specification",
        "master_source_id",
        "master_status",
    }:
        raise ValueError("character 字段不正确")
    stable_id(character.get("id"), "character.id")
    for field in ("name", "origin", "specification"):
        if not isinstance(character.get(field), str) or not character[field].strip():
            raise ValueError(f"character.{field} 不能为空")
    if character.get("master_source_id") is not None:
        stable_id(character["master_source_id"], "character.master_source_id")
    if character.get("master_status") not in {"pending", "confirmed"}:
        raise ValueError("character.master_status 不正确")

    calibration = package.get("calibration")
    if not isinstance(calibration, dict) or set(calibration) != {
        "source_id",
        "status",
        "source_crop_xywh",
        "mouth_review_crop_xywh",
    }:
        raise ValueError("calibration 字段不正确")
    if calibration.get("source_id") is not None:
        stable_id(calibration["source_id"], "calibration.source_id")
    if calibration.get("status") not in {"pending", "accepted"}:
        raise ValueError("calibration.status 不正确")
    source_crop = (
        parse_xywh(calibration["source_crop_xywh"], "calibration.source_crop_xywh")
        if calibration.get("source_crop_xywh") is not None
        else None
    )
    mouth_crop = (
        parse_xywh(
            calibration["mouth_review_crop_xywh"],
            "calibration.mouth_review_crop_xywh",
        )
        if calibration.get("mouth_review_crop_xywh") is not None
        else None
    )
    if package.get("media_sources_file") != "media-sources.json":
        raise ValueError("media_sources_file 必须是 media-sources.json")
    manifest = validate_media_manifest(package_root / "media-sources.json")

    master_record = master_path = calibration_record = calibration_path = None
    if character.get("master_source_id"):
        master_record, master_path = resolve_source(
            manifest,
            package_root,
            character["master_source_id"],
            {"photo", "generated", "screenshot"},
        )
    if calibration.get("source_id"):
        calibration_record, calibration_path = resolve_source(
            manifest,
            package_root,
            calibration["source_id"],
            {"video"},
        )
    if character.get("master_status") == "confirmed" and master_path is None:
        raise ValueError("已确认母版必须绑定真实素材")
    if calibration.get("status") == "accepted":
        if calibration_path is None or source_crop is None or mouth_crop is None:
            raise ValueError("已接受校准视频必须绑定素材和两组固定裁切")
    calibration_probe = None
    if calibration_path is not None:
        calibration_probe = probe_video(calibration_path, ffprobe)
        if source_crop is not None:
            ensure_crop(
                source_crop,
                calibration_probe["width"],
                calibration_probe["height"],
                "calibration.source_crop_xywh",
            )
        if source_crop is not None and mouth_crop is not None:
            ensure_crop(
                mouth_crop,
                source_crop[2],
                source_crop[3],
                "calibration.mouth_review_crop_xywh",
            )

    review = package.get("source_review")
    if not isinstance(review, dict) or set(review) != {
        "status",
        "report_file",
        "report_sha256",
        "observations_file",
        "observations_sha256",
        "reviewed_at",
        "reviewer",
        "notes",
    }:
        raise ValueError("source_review 字段不正确")
    if review.get("status") not in {"pending", "confirmed"}:
        raise ValueError("source_review.status 不正确")
    review_files: dict[str, str] = {}
    if review["status"] == "confirmed":
        for file_field, hash_field in (
            ("report_file", "report_sha256"),
            ("observations_file", "observations_sha256"),
        ):
            relative = review.get(file_field)
            expected_hash = review.get(hash_field)
            if not relative or not expected_hash:
                raise ValueError(f"已确认审阅缺少 {file_field} 或 {hash_field}")
            path = (package_root / relative).resolve()
            try:
                path.relative_to(package_root.resolve())
            except ValueError as error:
                raise ValueError(f"{file_field} 越出角色源素材目录") from error
            if not path.is_file() or file_sha256(path) != expected_hash:
                raise ValueError(f"{file_field} 缺失或哈希不一致")
            review_files[file_field] = str(path)
        if not review.get("reviewed_at") or not review.get("reviewer"):
            raise ValueError("已确认审阅必须记录 reviewer 和 reviewed_at")
    elif require_confirmed_review:
        raise ValueError("角色源素材尚未完成 Agent/人工视觉审阅")

    if package.get("status") == "registered":
        if review.get("status") != "confirmed":
            raise ValueError("已注册角色源素材必须经过视觉审阅")
        if not package.get("provenance", {}).get("registered_at"):
            raise ValueError("已注册角色源素材缺少 registered_at")
    return {
        "id": source_id,
        "source_version": source_version,
        "status": package["status"],
        "package_root": str(package_root),
        "master": {
            "record": master_record,
            "path": str(master_path) if master_path else None,
        },
        "calibration": {
            "record": calibration_record,
            "path": str(calibration_path) if calibration_path else None,
            "probe": calibration_probe,
            "source_crop_xywh": list(source_crop) if source_crop else None,
            "mouth_review_crop_xywh": list(mouth_crop) if mouth_crop else None,
        },
        "review": {
            "status": review["status"],
            "files": review_files,
        },
    }


def init_command(args: argparse.Namespace) -> int:
    root = project_for_init(args.project)
    destination = project_file(root)
    package_path = local_package_file(root)
    if destination.exists() or package_path.exists():
        raise FileExistsError("项目已存在角色源素材入口，不会覆盖")
    created_at = utc_now()
    package = {
        "protocol": SOURCE_PROTOCOL,
        "version": 1,
        "id": stable_id(args.source_id, "source-id"),
        "source_version": semantic_version(args.source_version, "source-version"),
        "display_name": args.display_name,
        "status": "candidate",
        "character": {
            "id": stable_id(args.character_id, "character-id"),
            "name": args.character_name,
            "origin": args.origin,
            "specification": args.specification,
            "master_source_id": None,
            "master_status": "pending",
        },
        "calibration": {
            "source_id": None,
            "status": "pending",
            "source_crop_xywh": None,
            "mouth_review_crop_xywh": None,
        },
        "media_sources_file": "media-sources.json",
        "source_review": {
            "status": "pending",
            "report_file": None,
            "report_sha256": None,
            "observations_file": None,
            "observations_sha256": None,
            "reviewed_at": None,
            "reviewer": None,
            "notes": "",
        },
        "parameter_provenance": {
            "protocol_invariants": [
                "master and calibration source ids resolve through media-sources v3",
                "source and mouth review crops are fixed for every reviewed frame",
            ],
            "asset_calibration": [
                "calibration.source_crop_xywh",
                "calibration.mouth_review_crop_xywh",
            ],
        },
        "provenance": {
            "created_at": created_at,
            "registered_at": None,
            "source_project_hint": root.name,
        },
    }
    package_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(package_path, package)
    write_json(
        destination,
        {
            "protocol": PROJECT_PROTOCOL,
            "version": 1,
            "source": {
                "kind": "project",
                "package_file": LOCAL_PACKAGE_FILE,
            },
        },
    )
    prompt_source = SKILL_ROOT / "assets" / "anime-avatar-prompts" / "master-image.md"
    if prompt_source.is_file():
        prompt_destination = root / "prompts" / "master-image.md"
        prompt_destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(prompt_source, prompt_destination)
    print(json.dumps({"project": str(root), "package": str(package_path)}, ensure_ascii=False, indent=2))
    return 0


def configure_command(args: argparse.Namespace) -> int:
    root = ensure_skill_task_project(args.project)
    project = validate_project_record(read_json(project_file(root)))
    if project["kind"] != "project":
        raise ValueError("已采用注册资源的项目不能改写注册包")
    package_path = local_package_file(root)
    package = read_json(package_path)
    package_root = root
    manifest = validate_media_manifest(root / "media-sources.json")
    master_source_id = stable_id(args.master_source_id, "master-source-id")
    calibration_source_id = stable_id(
        args.calibration_source_id,
        "calibration-source-id",
    )
    resolve_source(
        manifest,
        package_root,
        master_source_id,
        {"photo", "generated", "screenshot"},
    )
    _, calibration_path = resolve_source(
        manifest,
        package_root,
        calibration_source_id,
        {"video"},
    )
    ffprobe = executable("ffprobe", args.ffprobe)
    probe = probe_video(calibration_path, ffprobe)
    source_crop = parse_xywh(
        [int(item) for item in args.source_crop.split(",")],
        "source-crop",
    )
    mouth_crop = parse_xywh(
        [int(item) for item in args.mouth_review_crop.split(",")],
        "mouth-review-crop",
    )
    ensure_crop(source_crop, probe["width"], probe["height"], "source-crop")
    ensure_crop(mouth_crop, source_crop[2], source_crop[3], "mouth-review-crop")
    package["character"]["master_source_id"] = master_source_id
    package["character"]["master_status"] = "confirmed"
    package["calibration"] = {
        "source_id": calibration_source_id,
        "status": "accepted",
        "source_crop_xywh": list(source_crop),
        "mouth_review_crop_xywh": list(mouth_crop),
    }
    package["source_review"] = {
        "status": "pending",
        "report_file": None,
        "report_sha256": None,
        "observations_file": None,
        "observations_sha256": None,
        "reviewed_at": None,
        "reviewer": None,
        "notes": "素材或固定裁切变化后必须重新进行视觉审阅。",
    }
    write_json(package_path, package)
    print(json.dumps({"package": str(package_path), "calibration_probe": probe}, ensure_ascii=False, indent=2))
    return 0


def prepare_review_command(args: argparse.Namespace) -> int:
    root = ensure_skill_task_project(args.project)
    package, package_path, package_root = resolve_package(root)
    if package_path != local_package_file(root):
        raise ValueError("已注册资源只读；请在候选项目中准备审阅")
    ffprobe = executable("ffprobe", args.ffprobe)
    resolved = validate_source_set(
        package,
        package_root,
        ffprobe=ffprobe,
        require_confirmed_review=False,
    )
    calibration_path = Path(resolved["calibration"]["path"])
    frames, fps = load_cropped_frames(
        calibration_path,
        tuple(resolved["calibration"]["source_crop_xywh"]),
    )
    report_root = package_root / "reports" / "avatar-source-review"
    if report_root.exists():
        raise FileExistsError(
            "审阅资料已存在；素材或裁切变化时请建立新候选版本，不覆盖旧证据"
        )
    overview = sampled_indices(len(frames), fps, 1.0)
    full = sampled_indices(len(frames), fps, 4.0)
    mouth = sampled_indices(len(frames), fps, 8.0)
    contact_sheet(frames, overview, fps, report_root / "overview.jpg", columns=5)
    evidence = ["reports/avatar-source-review/overview.jpg"]
    for prefix, values, crop in (
        ("full-4fps", full, None),
        (
            "mouth-8fps",
            mouth,
            tuple(resolved["calibration"]["mouth_review_crop_xywh"]),
        ),
    ):
        for page_index in range(0, len(values), 30):
            page = values[page_index : page_index + 30]
            name = f"{prefix}-{page_index // 30 + 1:02d}.jpg"
            contact_sheet(
                frames,
                page,
                fps,
                report_root / name,
                local_crop=crop,
                columns=5,
            )
            evidence.append(f"reports/avatar-source-review/{name}")
    report = {
        "protocol": "visual-multimedia-anime-avatar-source-review",
        "version": 1,
        "source_set": {
            "id": package["id"],
            "source_version": package["source_version"],
        },
        "inputs": {
            "master_source_id": package["character"]["master_source_id"],
            "master_sha256": resolved["master"]["record"]["integrity"]["sha256"],
            "calibration_source_id": package["calibration"]["source_id"],
            "calibration_sha256": resolved["calibration"]["record"]["integrity"]["sha256"],
            "source_crop_xywh": package["calibration"]["source_crop_xywh"],
            "mouth_review_crop_xywh": package["calibration"]["mouth_review_crop_xywh"],
        },
        "calibration_probe": resolved["calibration"]["probe"],
        "contact_sheets": evidence,
        "responsibility_boundary": {
            "script_did": [
                "decode the entire calibration video",
                "apply one fixed source crop to every frame",
                "sample indexed frames and produce contact sheets",
            ],
            "script_did_not": [
                "classify CLOSED, A, I, U, E or O",
                "infer mouth strength from pixels",
                "approve reusable mouth motions",
                "claim lip-sync or motion quality",
            ],
            "next_actor": (
                "Agent or human must directly inspect the sheets and original video, "
                "record identity/framing/state observations, and decide whether the "
                "source material is accepted. Mouth-planner readiness remains separate."
            ),
        },
        "automatic_checks": {
            "media_sources_v3_valid": True,
            "master_hash_matches": True,
            "calibration_hash_matches": True,
            "entire_video_decoded": len(frames) > 0,
            "fixed_source_crop_used": True,
            "fixed_mouth_review_crop_used": True,
        },
        "human_or_agent_review": {
            "status": "pending",
            "checks": [
                "角色身份、服装、发饰和正面头肩构图与母版一致",
                "人物整体位置、尺度和底部固定位置在整段视频中稳定",
                "头顶、猫耳、呆毛、肩部和衣服没有越出预定安全区",
                "逐帧观察嘴型、眼睛、耳朵、头发、饰品和身体动作阶段",
                "记录候选状态，但不把本次观察包装成通用口型库",
            ],
        },
    }
    report_path = report_root / "source-review.json"
    write_json(report_path, report)
    print(
        json.dumps(
            {
                "report": str(report_path),
                "contact_sheets": [str(package_root / item) for item in evidence],
                "decoded_frames": len(frames),
                "fps": fps,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def confirm_review_command(args: argparse.Namespace) -> int:
    root = ensure_skill_task_project(args.project)
    package, package_path, package_root = resolve_package(root)
    if package_path != local_package_file(root):
        raise ValueError("已注册资源只读")
    report_path = package_root / "reports" / "avatar-source-review" / "source-review.json"
    observations_path = Path(args.observations_file).expanduser()
    if not observations_path.is_absolute():
        observations_path = root / observations_path
    observations_path = observations_path.resolve()
    try:
        observations_path.relative_to(package_root.resolve())
    except ValueError as error:
        raise ValueError("视觉观察记录必须位于项目角色源素材目录内") from error
    if not report_path.is_file() or not observations_path.is_file():
        raise FileNotFoundError("确认前必须存在审阅报告和 Agent/人工视觉观察记录")
    report = read_json(report_path)
    if report.get("human_or_agent_review", {}).get("status") != "pending":
        raise ValueError("审阅报告状态异常")
    report["human_or_agent_review"]["status"] = "confirmed"
    report["human_or_agent_review"]["reviewer"] = args.reviewer
    report["human_or_agent_review"]["reviewed_at"] = utc_now()
    report["human_or_agent_review"]["notes"] = args.notes
    write_json(report_path, report)
    package["source_review"] = {
        "status": "confirmed",
        "report_file": str(report_path.relative_to(package_root)).replace("\\", "/"),
        "report_sha256": file_sha256(report_path),
        "observations_file": str(observations_path.relative_to(package_root)).replace("\\", "/"),
        "observations_sha256": file_sha256(observations_path),
        "reviewed_at": report["human_or_agent_review"]["reviewed_at"],
        "reviewer": args.reviewer,
        "notes": args.notes,
    }
    write_json(package_path, package)
    print(json.dumps(package["source_review"], ensure_ascii=False, indent=2))
    return 0


def validate_command(args: argparse.Namespace) -> int:
    root = ensure_skill_task_project(args.project)
    package, package_path, package_root = resolve_package(root)
    resolved = validate_source_set(
        package,
        package_root,
        ffprobe=executable("ffprobe", args.ffprobe),
        require_confirmed_review=args.require_confirmed_review,
    )
    print(json.dumps({"package": str(package_path), "resolved": resolved}, ensure_ascii=False, indent=2))
    return 0


def list_command(args: argparse.Namespace) -> int:
    catalog = load_catalog()
    print(json.dumps(catalog, ensure_ascii=False, indent=2))
    return 0


def validate_registered_command(args: argparse.Namespace) -> int:
    record, package_path = find_registered(args.source_id, args.source_version)
    resolved = validate_source_set(
        read_json(package_path),
        package_path.parent,
        ffprobe=executable("ffprobe", args.ffprobe),
        require_confirmed_review=True,
    )
    print(
        json.dumps(
            {
                "catalog_record": record,
                "package": str(package_path),
                "resolved": resolved,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def adopt_command(args: argparse.Namespace) -> int:
    root = project_for_init(args.project)
    destination = project_file(root)
    if destination.exists():
        raise FileExistsError("项目已存在角色源素材入口，不会覆盖")
    record, package_path = find_registered(args.source_id, args.source_version)
    package = read_json(package_path)
    validate_source_set(
        package,
        package_path.parent,
        ffprobe=executable("ffprobe", args.ffprobe),
        require_confirmed_review=True,
    )
    write_json(
        destination,
        {
            "protocol": PROJECT_PROTOCOL,
            "version": 1,
            "source": {
                "kind": "registered",
                "id": args.source_id,
                "source_version": args.source_version,
            },
        },
    )
    print(json.dumps({"project": str(root), "catalog_record": record, "package": str(package_path)}, ensure_ascii=False, indent=2))
    return 0


def _copy_registered_files(
    package: dict[str, Any],
    source_root: Path,
    destination: Path,
) -> None:
    manifest = read_json(source_root / "media-sources.json")
    files = {"media-sources.json"}
    for source in manifest.get("sources", []):
        files.add(source["file"])
    review = package["source_review"]
    files.add(review["report_file"])
    files.add(review["observations_file"])
    report = read_json(source_root / review["report_file"])
    files.update(report.get("contact_sheets", []))
    for relative in sorted(files):
        source = (source_root / relative).resolve()
        try:
            source.relative_to(source_root.resolve())
        except ValueError as error:
            raise ValueError(f"注册文件越出候选资源目录：{relative}") from error
        if not source.is_file():
            raise FileNotFoundError(f"注册文件不存在：{source}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def register_command(args: argparse.Namespace) -> int:
    if not args.confirm_long_term_reuse:
        raise ValueError("注册共享资源必须显式传入 --confirm-long-term-reuse")
    root = ensure_skill_task_project(args.project)
    project = validate_project_record(read_json(project_file(root)))
    if project["kind"] != "project":
        raise ValueError("当前项目已经采用注册资源")
    package_path = local_package_file(root)
    package = read_json(package_path)
    ffprobe = executable("ffprobe", args.ffprobe)
    validate_source_set(
        package,
        root,
        ffprobe=ffprobe,
        require_confirmed_review=True,
    )
    destination = SOURCE_ROOT / package["id"] / package["source_version"]
    if destination.exists():
        raise FileExistsError(f"注册目标已存在，不会覆盖：{destination}")
    _copy_registered_files(package, root, destination)
    registered = json.loads(json.dumps(package))
    registered["status"] = "registered"
    registered["provenance"]["registered_at"] = utc_now()
    registered["provenance"]["source_project_hint"] = root.name
    registered_path = destination / "source-set.json"
    write_json(registered_path, registered)
    validate_source_set(
        registered,
        destination,
        ffprobe=ffprobe,
        require_confirmed_review=True,
    )
    catalog = load_catalog()
    if any(
        item.get("id") == registered["id"]
        and any(
            version.get("version") == registered["source_version"]
            for version in item.get("versions", [])
        )
        for item in catalog["sources"]
    ):
        raise ValueError("目录中已经存在同 id 同版本资源")
    source_record = next(
        (item for item in catalog["sources"] if item.get("id") == registered["id"]),
        None,
    )
    if source_record is None:
        source_record = {
            "id": registered["id"],
            "display_name": registered["display_name"],
            "versions": [],
        }
        catalog["sources"].append(source_record)
    source_record["versions"].append(
        {
            "version": registered["source_version"],
            "status": "registered",
            "package_file": str(registered_path.relative_to(SOURCE_ROOT)).replace("\\", "/"),
        }
    )
    catalog["sources"].sort(key=lambda item: item["id"])
    source_record["versions"].sort(key=lambda item: item["version"])
    write_json(SOURCE_CATALOG, catalog)
    write_json(
        project_file(root),
        {
            "protocol": PROJECT_PROTOCOL,
            "version": 1,
            "source": {
                "kind": "registered",
                "id": registered["id"],
                "source_version": registered["source_version"],
            },
        },
    )
    print(json.dumps({"registered": str(registered_path), "project_now_uses": f"{registered['id']}@{registered['source_version']}"}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "建立和采用二次元角色源素材。此入口只证明母版、校准视频、"
            "固定裁切、来源和视觉审阅，不建立口型库，也不渲染说话视频。"
        )
    )
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="在 Skill 外建立候选角色源素材项目")
    init.add_argument("--project", required=True)
    init.add_argument("--source-id", required=True)
    init.add_argument("--source-version", default="1.0.0")
    init.add_argument("--display-name", required=True)
    init.add_argument("--character-id", required=True)
    init.add_argument("--character-name", required=True)
    init.add_argument("--origin", required=True)
    init.add_argument("--specification", required=True)
    init.set_defaults(handler=init_command)

    configure = commands.add_parser("configure", help="绑定母版、校准视频和固定裁切")
    configure.add_argument("--project", required=True)
    configure.add_argument("--master-source-id", required=True)
    configure.add_argument("--calibration-source-id", required=True)
    configure.add_argument("--source-crop", required=True, help="x,y,width,height")
    configure.add_argument("--mouth-review-crop", required=True, help="相对 source-crop 的 x,y,width,height")
    configure.add_argument("--ffprobe")
    configure.set_defaults(handler=configure_command)

    prepare = commands.add_parser("prepare-review", help="完整解码并制作带帧号联系表；不自动分类口型")
    prepare.add_argument("--project", required=True)
    prepare.add_argument("--ffprobe")
    prepare.set_defaults(handler=prepare_review_command)

    confirm = commands.add_parser("confirm-review", help="绑定 Agent/人工直接看图后的观察记录")
    confirm.add_argument("--project", required=True)
    confirm.add_argument("--observations-file", required=True)
    confirm.add_argument("--reviewer", required=True)
    confirm.add_argument("--notes", required=True)
    confirm.set_defaults(handler=confirm_review_command)

    validate = commands.add_parser("validate", help="验证正式角色源素材消费边界")
    validate.add_argument("--project", required=True)
    validate.add_argument("--require-confirmed-review", action="store_true")
    validate.add_argument("--ffprobe")
    validate.set_defaults(handler=validate_command)

    listing = commands.add_parser("list-sources", help="列出显式可采用的注册角色源素材")
    listing.set_defaults(handler=list_command)

    registered = commands.add_parser(
        "validate-registered",
        help="从正式目录解析并验证一个已注册 source-only 资源",
    )
    registered.add_argument("--source-id", required=True)
    registered.add_argument("--source-version", required=True)
    registered.add_argument("--ffprobe")
    registered.set_defaults(handler=validate_registered_command)

    adopt = commands.add_parser("adopt", help="按稳定 id 和版本采用已注册角色源素材")
    adopt.add_argument("--project", required=True)
    adopt.add_argument("--source-id", required=True)
    adopt.add_argument("--source-version", required=True)
    adopt.add_argument("--ffprobe")
    adopt.set_defaults(handler=adopt_command)

    register = commands.add_parser("register", help="在用户确认长期复用后注册 source-only 资源")
    register.add_argument("--project", required=True)
    register.add_argument("--confirm-long-term-reuse", action="store_true")
    register.add_argument("--ffprobe")
    register.set_defaults(handler=register_command)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.handler(args)


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

#!/usr/bin/env python3
"""Resolve Visual Multimedia production paths inside its ignored workspace."""

from __future__ import annotations

import re
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
TASK_WORKSPACE_ROOT = SKILL_ROOT / "artifacts"
TASK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def assert_task_id(value: str) -> str:
    """Validate a stable task workspace directory name."""
    task_id = str(value or "").strip()
    if not TASK_ID_RE.fullmatch(task_id) or len(task_id) > 32:
        raise ValueError(
            "task id 最多 32 个字符，只能使用小写字母、数字、点、下划线和连字符"
        )
    return task_id


def resolve_task_path(task_id: str, relative: str | Path = "") -> Path:
    """Resolve a task-owned path below artifacts/<task-id>."""
    base = TASK_WORKSPACE_ROOT / assert_task_id(task_id)
    suffix = Path(relative)
    if suffix.is_absolute():
        raise ValueError("任务相对路径不能是绝对路径")
    return assert_skill_task_path(base / suffix, "任务路径")


def assert_skill_task_path(value: str | Path, label: str = "路径") -> Path:
    """Reject production paths outside this Skill's task workspace."""
    target = Path(value).expanduser().resolve()
    try:
        relative = target.relative_to(TASK_WORKSPACE_ROOT.resolve())
    except ValueError as error:
        raise ValueError(
            f"{label} 必须位于 {TASK_WORKSPACE_ROOT} 下的任务目录内：{target}"
        ) from error
    if not relative.parts:
        raise ValueError(f"{label} 必须指向具体任务目录：{target}")
    assert_task_id(relative.parts[0])
    return target


def ensure_task_workspace(task_id: str) -> Path:
    """Create and return artifacts/<task-id> without removing existing files."""
    root = resolve_task_path(task_id)
    root.mkdir(parents=True, exist_ok=True)
    return root

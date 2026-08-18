#!/usr/bin/env python3
"""Deterministic, write-free checks for anime-avatar storage governance."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from anime_avatar_common import require_storage_budget


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent


def check_budget_gate() -> None:
    disk_usage = SimpleNamespace(total=1_000, used=200, free=800)
    with (
        patch("anime_avatar_common.managed_directory_bytes", return_value=100),
        patch("anime_avatar_common.shutil.disk_usage", return_value=disk_usage),
    ):
        report = require_storage_budget(
            SKILL_ROOT,
            expected_new_bytes=200,
            maximum_managed_bytes=400,
            minimum_free_bytes=500,
            label="self-test",
        )
        if report["projected_managed_bytes"] != 300:
            raise RuntimeError("存储预算预检没有返回可审计的预计占用")

        try:
            require_storage_budget(
                SKILL_ROOT,
                expected_new_bytes=350,
                maximum_managed_bytes=400,
                minimum_free_bytes=500,
                label="self-test",
            )
        except RuntimeError as error:
            message = str(error)
            if '"cleanup": "report-only-until-authorized"' not in message:
                raise RuntimeError("预算拒绝没有说明清理只报告、不自动执行") from error
        else:
            raise RuntimeError("预计超过项目上限时仍允许写入")


def check_shared_store_contract() -> None:
    source = (SCRIPT_DIR / "render-anime-avatar.py").read_text(encoding="utf-8")
    required = (
        "open_shared_source_frame_store",
        "anime-avatar-source-frames",
        "require_storage_budget",
        '"duplicate_task_copy_bytes": 0',
        "shared-content-addressed-disk-backed-uint8-memmap",
    )
    missing = [token for token in required if token not in source]
    if missing:
        raise RuntimeError(f"共享原始帧缓存合同缺少：{missing}")
    if 'working / "source-frames-bgr-u8.bin"' in source:
        raise RuntimeError("任务目录仍在生成原始帧重复副本")


def main() -> int:
    check_budget_gate()
    check_shared_store_contract()
    print(json.dumps({"ok": True, "checks": 2}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

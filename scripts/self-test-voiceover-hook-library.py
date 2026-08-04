from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


CASE_SCRIPT = Path(__file__).with_name("voiceover_reference_library.py")
HOOK_SCRIPT = Path(__file__).with_name("voiceover_hook_library.py")


def run(
    script: Path,
    config: Path,
    *args: str,
    expected: int = 0,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(script), "--config", str(config), *args],
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != expected:
        raise AssertionError(
            f"命令返回 {result.returncode}，预期 {expected}: {' '.join(args)}\n"
            f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def main() -> int:
    with tempfile.TemporaryDirectory(
        prefix="visual-multimedia-voiceover-hook-protocol-"
    ) as raw:
        workspace = Path(raw)
        root = workspace / "library"
        config = workspace / "config.json"
        run(CASE_SCRIPT, config, "init", "--root", str(root))
        run(HOOK_SCRIPT, config, "build-index")

        case_input = workspace / "case.md"
        case_input.write_text("这是一份完整口播案例，从头到尾保持完整。", encoding="utf-8")
        run(
            CASE_SCRIPT,
            config,
            "add-case",
            "--input",
            str(case_input),
            "--title",
            "完整口播",
            "--script-task",
            "解释机制",
            "--source",
            "local://case",
            "--context",
            "短视频旁白",
            "--writing-origin",
            "human-edited",
        )

        hook_input = workspace / "hook.md"
        hook_text = "门店昨天还在抄四遍地址。\n今天，他们只填一次。"
        hook_input.write_text(hook_text, encoding="utf-8")
        run(
            HOOK_SCRIPT,
            config,
            "add-hook",
            "--input",
            str(hook_input),
            "--title",
            "登记动作发生变化",
            "--hook-id",
            "registration-action-change",
            "--delivery-format",
            "短视频旁白",
            "--context",
            "解释机制",
            "--source",
            "local://opening",
        )
        run(HOOK_SCRIPT, config, "validate")
        run(HOOK_SCRIPT, config, "build-index", "--check")
        run(CASE_SCRIPT, config, "validate")

        hook_path = root / "独立口播钩子" / "短视频旁白" / "登记动作发生变化.md"
        hook_file = hook_path.read_text(encoding="utf-8")
        metadata_text = hook_file.split("<!-- voiceover-hook-index\n", 1)[1].split(
            "\n-->", 1
        )[0]
        metadata = json.loads(metadata_text)
        assert set(metadata) == {
            "resource_type",
            "hook_id",
            "delivery_format",
            "contexts",
        }
        assert hook_text in hook_file
        assert "完整口播" not in (root / "独立口播钩子" / "口播钩子索引.md").read_text(
            encoding="utf-8"
        )
        assert "登记动作发生变化" not in (root / "口播案例索引.md").read_text(
            encoding="utf-8"
        )

        rejected = run(
            CASE_SCRIPT,
            config,
            "add-hook",
            expected=2,
        )
        assert "invalid choice" in rejected.stderr

        polluted = hook_file.replace(
            '"hook_id": "registration-action-change",',
            '"hook_id": "registration-action-change", "comment": "extra",',
        )
        hook_path.write_text(polluted, encoding="utf-8")
        invalid = run(HOOK_SCRIPT, config, "validate", expected=1)
        assert "非寻址字段" in invalid.stderr

    print(
        "口播钩子库协议自测通过：独立生产、最少字段、独立索引、"
        "案例入口隔离和真实消费者读取均有效"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

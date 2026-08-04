from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("voiceover_reference_library.py")


def run(config: Path, *args: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--config", str(config), *args],
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
        prefix="visual-multimedia-voiceover-library-protocol-"
    ) as raw:
        workspace = Path(raw)
        root = workspace / "library"
        config = workspace / "config.json"

        initialized = json.loads(run(config, "init", "--root", str(root)).stdout)
        assert initialized["action"] == "initialized"
        assert initialized["version"] == 3
        assert not (root / "口播声音").exists()
        assert not (root / "完整口播案例").exists()

        voice_input = workspace / "voice.md"
        voice_text = (
            "先让听众看见具体对象、动作和结果，再补必要解释。"
            "判断紧跟证据，已经讲完时自然停住。"
        )
        voice_input.write_text(voice_text, encoding="utf-8")
        run(
            config,
            "set-voice",
            "--input",
            str(voice_input),
            "--source",
            "local://confirmed-voice-fixture",
        )
        assert voice_text in (root / "口播声音" / "voice.md").read_text(
            encoding="utf-8"
        )

        case_input = workspace / "case.md"
        case_text = (
            "周三下午，门店把原来要填四次的登记表合成了一次。\n\n"
            "店员少抄了三遍地址，顾客也不用在柜台前反复确认。"
        )
        case_input.write_text(case_text, encoding="utf-8")
        run(
            config,
            "add-case",
            "--input",
            str(case_input),
            "--title",
            "一次登记替代四次抄写",
            "--script-task",
            "解释机制",
            "--source",
            "local://confirmed-script-fixture",
            "--context",
            "短视频旁白",
            "--topic",
            "流程变化",
            "--move",
            "动作到结果",
            "--writing-origin",
            "human-edited",
            "--voice-eligible",
        )
        case_relative = (
            Path("完整口播案例") / "解释机制" / "一次登记替代四次抄写.md"
        ).as_posix()
        case_path = root / Path(case_relative)
        assert case_text in case_path.read_text(encoding="utf-8")

        rejected = run(
            config,
            "add-case",
            "--input",
            str(case_input),
            "--title",
            "不合格声音案例",
            "--script-task",
            "解释机制",
            "--source",
            "local://ai-draft-fixture",
            "--context",
            "短视频旁白",
            "--writing-origin",
            "ai-generated",
            "--voice-eligible",
            expected=1,
        )
        assert "--voice-eligible" in rejected.stderr

        external_input = workspace / "external-case.md"
        external_text = "测试人员打开页面，切换两个状态，确认同一字段保持一致。"
        external_input.write_text(external_text, encoding="utf-8")
        run(
            config,
            "add-case",
            "--input",
            str(external_input),
            "--title",
            "两个状态读取同一字段",
            "--script-task",
            "解释机制",
            "--source",
            "local://external-reference-fixture",
            "--context",
            "短视频旁白",
            "--writing-origin",
            "unknown",
        )

        candidates = json.loads(
            run(
                config,
                "voice-candidates",
                "--context",
                "短视频旁白",
                "--script-task",
                "解释机制",
            ).stdout
        )
        assert candidates["voice_profile"].endswith("口播声音\\voice.md")
        assert candidates["candidate_count"] == 1
        assert candidates["candidates"][0]["title"] == "一次登记替代四次抄写"

        run(config, "validate")
        run(config, "build-index", "--check")
        shown = json.loads(run(config, "show").stdout)
        assert shown["library_root"] == str(root.resolve())
        assert shown["version"] == 3
        assert shown["voice_ready"] is True
        assert shown["voice_candidate_count"] == 1
        assert shown["case_count"] == 2
        assert "hook_count" not in shown
        index_text = (root / "口播案例索引.md").read_text(encoding="utf-8")
        assert "当前口播声音" in index_text
        assert "一次登记替代四次抄写" in index_text
        assert "声音证据" in index_text

        updated_case = case_path.read_text(encoding="utf-8").replace(
            '"delivery_contexts": ["短视频旁白"]',
            '"delivery_contexts": ["播客独白"]',
        )
        case_path.write_text(updated_case, encoding="utf-8")
        stale = run(config, "validate", expected=1)
        assert "索引需要更新" in stale.stderr
        run(config, "build-index")
        run(config, "validate")
        no_candidates = json.loads(
            run(
                config,
                "voice-candidates",
                "--context",
                "短视频旁白",
                "--script-task",
                "解释机制",
            ).stdout
        )
        assert no_candidates["candidate_count"] == 0

        duplicate = run(
            config,
            "add-case",
            "--input",
            str(case_input),
            "--title",
            "重复案例",
            "--script-task",
            "解释机制",
            "--source",
            "local://duplicate-fixture",
            "--context",
            "短视频旁白",
            "--writing-origin",
            "human",
            expected=1,
        )
        assert "已经存在" in duplicate.stderr

        repeated = json.loads(run(config, "init", "--root", str(root)).stdout)
        assert repeated["action"] == "already-initialized"
        run(config, "validate")

        adopt_root = workspace / "adopt-library"
        adopt_root.mkdir()
        shutil.copytree(root / "口播声音", adopt_root / "口播声音")
        shutil.copytree(root / "完整口播案例", adopt_root / "完整口播案例")
        shutil.copy2(root / "口播案例索引.md", adopt_root)
        adopt_config = workspace / "adopt-config.json"
        adopted = json.loads(
            run(adopt_config, "adopt", "--root", str(adopt_root)).stdout
        )
        assert adopted["action"] == "adopted"
        assert adopted["version"] == 3
        adopted_show = json.loads(run(adopt_config, "show").stdout)
        assert adopted_show["library_root"] == str(adopt_root.resolve())
        assert adopted_show["voice_ready"] is True
        assert adopted_show["voice_candidate_count"] == 1
        assert adopted_show["case_count"] == 2

    print(
        "口播私人库案例协议自测通过：v3 初始化与接入、声音真源、"
        "声音资格、完整案例索引重建和去重均有效；本测试不评价创作质量"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

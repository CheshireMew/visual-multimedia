#!/usr/bin/env python3
"""Exercise the real media importer and avatar-inset renderer in a fresh project."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = SKILL_ROOT / "scripts" / "compose-anime-avatar-inset.py"
IMPORTER = SKILL_ROOT / "scripts" / "import-media-asset.mjs"
STARTER_MANIFEST = SKILL_ROOT / "assets" / "media-project-starter" / "media-sources.json"


def executable(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"自检找不到 {name}")
    return found


def run(command: list[str], *, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=SKILL_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if expect_success and result.returncode != 0:
        raise RuntimeError(
            f"命令失败（{result.returncode}）：{' '.join(command)}\n"
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    if not expect_success and result.returncode == 0:
        raise RuntimeError(f"命令本应失败却成功：{' '.join(command)}")
    return result


def make_video(
    ffmpeg: str,
    destination: Path,
    *,
    size: str,
    color: str,
    frequency: int,
) -> None:
    run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s={size}:r=24:d=1.5",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:sample_rate=48000:duration=1.5",
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-y",
            str(destination),
        ]
    )


def import_video(node: str, project: Path, source: Path, source_id: str, usage: str) -> None:
    run(
        [
            node,
            str(IMPORTER),
            "--project",
            str(project),
            "--input",
            str(source),
            "--id",
            source_id,
            "--media-type",
            "video",
            "--method",
            "project-owned",
            "--rights-status",
            "confirmed",
            "--license",
            "deterministic-self-test",
            "--usage",
            usage,
        ]
    )


def init_job(
    project: Path,
    *,
    job_id: str,
    audio_source: str,
    job: str | None = None,
    expect_success: bool = True,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(SCRIPT),
        "init",
        "--project",
        str(project),
        "--job-id",
        job_id,
        "--base-source-id",
        "base-video",
        "--avatar-source-id",
        "avatar-video",
        "--avatar-crop",
        "0,0,128,128",
        "--shape",
        "circle",
        "--x",
        "210",
        "--y",
        "70",
        "--size",
        "96",
        "--border-width",
        "2",
        "--audio-source",
        audio_source,
    ]
    if job:
        command.extend(["--job", job])
    return run(command, expect_success=expect_success)


def main() -> int:
    ffmpeg = executable("ffmpeg")
    ffprobe = executable("ffprobe")
    node = executable("node")
    test_root = SKILL_ROOT / "artifacts" / "self-tests"
    test_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="avatar-inset-", dir=test_root) as temp:
        project = Path(temp) / "project"
        project.mkdir()
        shutil.copy2(STARTER_MANIFEST, project / "media-sources.json")

        base = Path(temp) / "base.mp4"
        avatar = Path(temp) / "avatar.mp4"
        make_video(ffmpeg, base, size="320x180", color="0x15202B", frequency=440)
        make_video(ffmpeg, avatar, size="128x128", color="white", frequency=660)
        import_video(node, project, base, "base-video", "角色窗自检底片")
        import_video(node, project, avatar, "avatar-video", "角色窗自检角色轨")

        init_job(project, job_id="base-audio", audio_source="base")
        base_job = json.loads(
            (project / "avatar-insets" / "base-audio.json").read_text(encoding="utf-8")
        )
        if base_job["audio"]["base_gain_db"] != 0.0:
            raise RuntimeError("audio-source=base 没有保持 0 dB")

        init_job(project, job_id="mix-audio", audio_source="mix")
        mix_job = json.loads(
            (project / "avatar-insets" / "mix-audio.json").read_text(encoding="utf-8")
        )
        if mix_job["audio"]["base_gain_db"] != -12.0:
            raise RuntimeError("audio-source=mix 没有使用 -12 dB 底片默认增益")

        escaped = init_job(
            project,
            job_id="escaped",
            audio_source="base",
            job="../escaped.json",
            expect_success=False,
        )
        if "项目目录内" not in (escaped.stderr + escaped.stdout):
            raise RuntimeError("越界任务路径虽被拒绝，但没有返回明确项目边界错误")

        output_relative = "renders/base-audio.mp4"
        run(
            [
                sys.executable,
                str(SCRIPT),
                "render",
                "--project",
                str(project),
                "--job",
                "avatar-insets/base-audio.json",
                "--output",
                output_relative,
                "--ffmpeg",
                ffmpeg,
                "--ffprobe",
                ffprobe,
            ]
        )
        output = project / output_relative
        report = project / "reports" / "avatar-insets" / "base-audio" / "render-report.json"
        contact_sheet = project / "reports" / "avatar-insets" / "base-audio" / "contact-sheet.jpg"
        for visible in (output, report, contact_sheet):
            if not visible.is_file() or visible.stat().st_size == 0:
                raise RuntimeError(f"真实角色窗链路没有生成可见结果：{visible}")

        run([ffmpeg, "-v", "error", "-i", str(output), "-f", "null", "-"])
        probe = json.loads(
            run(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration:stream=codec_type,width,height,sample_rate,channels",
                    "-of",
                    "json",
                    str(output),
                ]
            ).stdout
        )
        stream_types = {item.get("codec_type") for item in probe.get("streams", [])}
        if stream_types != {"video", "audio"}:
            raise RuntimeError(f"角色窗输出音视频轨不完整：{stream_types}")
        if float(probe.get("format", {}).get("duration") or 0) < 1.4:
            raise RuntimeError("角色窗输出时长不足")

        print(
            json.dumps(
                {
                    "status": "passed",
                    "producer": "scripts/import-media-asset.mjs",
                    "consumer": "scripts/compose-anime-avatar-inset.py",
                    "base_gain_db": base_job["audio"]["base_gain_db"],
                    "mix_base_gain_db": mix_job["audio"]["base_gain_db"],
                    "project_relative_output": output_relative,
                    "visible_outputs": [
                        str(output.relative_to(project)),
                        str(contact_sheet.relative_to(project)),
                        str(report.relative_to(project)),
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1)

"""Shared file and media boundary for recording producers (no project state)."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

from media_task_workspace import assert_skill_task_path


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else _digest(stream)


def _digest(stream) -> str:
    value = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(block)
    return value.hexdigest()


def run(arguments, **options):
    result = subprocess.run([str(arg) for arg in arguments], capture_output=True,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), **options)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-5000:])
    return result.stdout


def source(project: Path, source_id: str):
    project = assert_skill_task_path(project, "project")
    manifest = json.loads((project / "media-sources.json").read_text(encoding="utf-8"))
    item = next((item for item in manifest["sources"] if item["id"] == source_id), None)
    if not item or item["representation"]["kind"] != "source":
        raise ValueError("source id must reference an original asset")
    file = (project / item["file"]).resolve(strict=True)
    if not file.is_relative_to(project) or digest(file) != item["integrity"]["sha256"]:
        raise ValueError("source file or hash does not match the asset ledger")
    return project, file, item


def probe(ffprobe, file: Path):
    return json.loads(run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", file]))


def write_json(file: Path, value):
    file = assert_skill_task_path(file, "output")
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def binding(project: Path, file: Path):
    return {"file": file.relative_to(project).as_posix(), "sha256": digest(file)}


def read_pcm(ffmpeg, file: Path, rate=16000, seconds=60):
    import numpy as np
    data = run([ffmpeg, "-v", "error", "-i", file, "-t", seconds, "-vn", "-ac", "1",
                "-ar", rate, "-f", "f32le", "-"])
    return np.frombuffer(data, dtype="<f4").astype("float64")

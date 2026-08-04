from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


SKILL_ROOT = Path(__file__).resolve().parents[1]
LIBRARY_SCHEMA = "visual-multimedia-voiceover-reference-library"
LIBRARY_VERSION = 3
MANIFEST_RELATIVE = Path(".visual-multimedia/voiceover-reference-library.json")
DEFAULT_CONFIG_RELATIVE = Path(
    ".visual-multimedia/voiceover-reference-library-config.json"
)
CASE_DIRECTORY = "完整口播案例"
VOICE_DIRECTORY = "口播声音"
VOICE_NAME = "voice.md"
LOCAL_PRIVATE_DIRECTORY = "口播私人库"
CASE_INDEX_NAME = "口播案例索引.md"
WRITING_ORIGINS = {"human", "human-edited", "ai-generated", "unknown"}
VOICE_ELIGIBLE_ORIGINS = {"human", "human-edited"}
METADATA_PATTERN = re.compile(
    r"\n?<!-- voiceover-reference-index\s*\n(?P<metadata>\{.*\})\n-->\s*$",
    re.DOTALL,
)


class LibraryError(ValueError):
    pass


@dataclass(frozen=True)
class LibraryLayout:
    root: Path

    @property
    def manifest(self) -> Path:
        return self.root / MANIFEST_RELATIVE

    @property
    def case_root(self) -> Path:
        return self.root / CASE_DIRECTORY

    @property
    def voice(self) -> Path:
        return self.root / VOICE_DIRECTORY / VOICE_NAME

    @property
    def case_index(self) -> Path:
        return self.root / CASE_INDEX_NAME


@dataclass(frozen=True)
class VoiceoverCase:
    path: Path
    title: str
    script_task: str
    delivery_contexts: tuple[str, ...]
    topics: tuple[str, ...]
    moves: tuple[str, ...]
    original_text: str
    source: str
    writing_origin: str
    voice_eligible: bool


@dataclass(frozen=True)
class VoiceProfile:
    path: Path
    text: str
    source: str


def default_config_path() -> Path:
    return Path.home() / DEFAULT_CONFIG_RELATIVE


def _absolute(path: Path) -> Path:
    return path.expanduser().resolve()


def _inside_skill(path: Path) -> bool:
    try:
        path.relative_to(SKILL_ROOT.resolve())
    except ValueError:
        return False
    return True


def _allowed_library_location(path: Path) -> bool:
    if not _inside_skill(path):
        return True
    allowed_root = (SKILL_ROOT / LOCAL_PRIVATE_DIRECTORY).resolve()
    try:
        path.resolve().relative_to(allowed_root)
    except ValueError:
        return False
    return True


def _check_library_location(path: Path) -> None:
    if _allowed_library_location(path):
        return
    raise LibraryError(
        "口播私人库位于 visual-multimedia 目录内时，"
        f"只能使用已经从 Git 排除的 {LOCAL_PRIVATE_DIRECTORY} 目录"
    )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise LibraryError(f"文件不存在：{path}") from exc
    except json.JSONDecodeError as exc:
        raise LibraryError(f"{path} 不是有效 JSON：{exc}") from exc
    if not isinstance(value, dict):
        raise LibraryError(f"{path} 必须是 JSON 对象")
    return value


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    _write_text(
        path,
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
    )


def _manifest_value() -> dict[str, Any]:
    return {"schema": LIBRARY_SCHEMA, "version": LIBRARY_VERSION}


def _config_value(root: Path) -> dict[str, Any]:
    return {
        "schema": LIBRARY_SCHEMA,
        "version": LIBRARY_VERSION,
        "library_root": str(root),
    }


def _check_manifest(path: Path) -> None:
    value = _read_json(path)
    if value.get("schema") != LIBRARY_SCHEMA:
        raise LibraryError(f"不是 visual-multimedia 口播参考库：{path}")
    if value.get("version") != LIBRARY_VERSION:
        raise LibraryError(
            f"口播参考库版本不受支持：{value.get('version')}，"
            f"当前需要 {LIBRARY_VERSION}"
        )


def _write_config(root: Path, config_path: Path | None) -> Path:
    target = _absolute(config_path or default_config_path())
    _write_json(target, _config_value(root))
    return target


def resolve_library_root(
    root: Path | None = None,
    config_path: Path | None = None,
) -> Path:
    if root is not None:
        resolved = _absolute(root)
    else:
        config = _absolute(config_path or default_config_path())
        value = _read_json(config)
        if value.get("schema") != LIBRARY_SCHEMA:
            raise LibraryError(f"不是 visual-multimedia 口播参考库配置：{config}")
        if value.get("version") != LIBRARY_VERSION:
            raise LibraryError(
                f"口播参考库配置版本不受支持：{value.get('version')}"
            )
        raw_root = value.get("library_root")
        if not isinstance(raw_root, str) or not raw_root.strip():
            raise LibraryError(f"口播参考库配置缺少 library_root：{config}")
        resolved = _absolute(Path(raw_root))
    if not resolved.exists() or not resolved.is_dir():
        raise LibraryError(f"口播参考库目录不存在：{resolved}")
    _check_manifest(resolved / MANIFEST_RELATIVE)
    return resolved


def _safe_segment(value: str, field: str) -> str:
    cleaned = value.strip()
    if (
        not cleaned
        or cleaned in {".", ".."}
        or any(character in cleaned for character in '<>:"/\\|?*')
    ):
        raise LibraryError(f"{field} 不能作为目录或文件名：{value}")
    return cleaned


def _clean_values(values: Sequence[str], field: str, *, required: bool) -> tuple[str, ...]:
    cleaned = tuple(dict.fromkeys(value.strip() for value in values if value.strip()))
    if required and not cleaned:
        raise LibraryError(f"{field} 不能为空")
    return cleaned


def _metadata_block(value: dict[str, Any]) -> str:
    return "\n".join(
        [
            "<!-- voiceover-reference-index",
            json.dumps(value, ensure_ascii=False, sort_keys=True),
            "-->",
        ]
    )


def _parse_metadata(text: str) -> tuple[dict[str, Any], str]:
    match = METADATA_PATTERN.search(text.lstrip("\ufeff"))
    if not match:
        raise LibraryError("缺少 voiceover-reference-index")
    try:
        metadata = json.loads(match.group("metadata"))
    except json.JSONDecodeError as exc:
        raise LibraryError(f"voiceover-reference-index 不是有效 JSON：{exc}") from exc
    if not isinstance(metadata, dict):
        raise LibraryError("voiceover-reference-index 必须是 JSON 对象")
    return metadata, text[: match.start()].rstrip()


def _required_string(metadata: dict[str, Any], key: str) -> str:
    value = metadata.get(key)
    if not isinstance(value, str) or not value.strip():
        raise LibraryError(f"缺少 {key}")
    return value.strip()


def _required_bool(metadata: dict[str, Any], key: str) -> bool:
    value = metadata.get(key)
    if not isinstance(value, bool):
        raise LibraryError(f"{key} 必须是 true 或 false")
    return value


def _writing_origin(metadata: dict[str, Any]) -> str:
    value = _required_string(metadata, "writing_origin")
    if value not in WRITING_ORIGINS:
        raise LibraryError(
            f"writing_origin 不受支持：{value}；"
            f"可用值为 {', '.join(sorted(WRITING_ORIGINS))}"
        )
    return value


def _string_list(
    metadata: dict[str, Any],
    key: str,
    *,
    required: bool,
) -> tuple[str, ...]:
    value = metadata.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise LibraryError(f"{key} 必须是字符串数组")
    return _clean_values(value, key, required=required)


def _title(body: str) -> str:
    match = re.search(r"^# (.+?)\s*$", body, re.MULTILINE)
    if not match:
        raise LibraryError("缺少一级标题")
    return match.group(1).strip()


def _body_section(body: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\s*$", body, re.MULTILINE)
    if not match:
        raise LibraryError(f"缺少“{heading}”")
    return body[match.end() :].strip()


def _text_and_source(section: str) -> tuple[str, str]:
    matches = list(re.finditer(r"^来源：\s*(.+?)\s*$", section, re.MULTILINE))
    if not matches:
        raise LibraryError("缺少来源")
    match = matches[-1]
    if section[match.end() :].strip():
        raise LibraryError("来源必须位于正文末尾")
    text = section[: match.start()].strip()
    source = match.group(1).strip()
    if not text:
        raise LibraryError("正文不能为空")
    if not source:
        raise LibraryError("来源不能为空")
    return text, source


def _parse_voice_profile(path: Path) -> VoiceProfile:
    metadata, body = _parse_metadata(path.read_text(encoding="utf-8-sig"))
    if metadata.get("resource_type") != "voice-profile":
        raise LibraryError("口播声音的 resource_type 必须是 voice-profile")
    text, source = _text_and_source(_body_section(body, "当前声音"))
    return VoiceProfile(path=path, text=text, source=source)


def load_voice_profile(layout: LibraryLayout) -> VoiceProfile | None:
    if not layout.voice.exists():
        return None
    try:
        return _parse_voice_profile(layout.voice)
    except (LibraryError, OSError, UnicodeError) as exc:
        raise LibraryError(f"{layout.voice}: {exc}") from exc


def _parse_case(path: Path, layout: LibraryLayout) -> VoiceoverCase:
    try:
        relative = path.relative_to(layout.case_root)
    except ValueError as exc:
        raise LibraryError("完整口播案例必须位于完整口播案例目录") from exc
    if len(relative.parts) != 2:
        raise LibraryError("完整口播案例必须使用“写作任务/文件”两级路径")
    metadata, body = _parse_metadata(path.read_text(encoding="utf-8-sig"))
    if metadata.get("resource_type") != "voiceover-case":
        raise LibraryError("完整口播案例的 resource_type 必须是 voiceover-case")
    script_task = _required_string(metadata, "script_task")
    if script_task != relative.parts[0]:
        raise LibraryError("script_task 必须与案例目录一致")
    writing_origin = _writing_origin(metadata)
    voice_eligible = _required_bool(metadata, "voice_eligible")
    if voice_eligible and writing_origin not in VOICE_ELIGIBLE_ORIGINS:
        raise LibraryError(
            "voice_eligible 只能用于 writing_origin 为 human 或 human-edited 的案例"
        )
    original_text, source = _text_and_source(_body_section(body, "口播全文"))
    return VoiceoverCase(
        path=path,
        title=_title(body),
        script_task=script_task,
        delivery_contexts=_string_list(
            metadata, "delivery_contexts", required=True
        ),
        topics=_string_list(metadata, "topics", required=False),
        moves=_string_list(metadata, "moves", required=False),
        original_text=original_text,
        source=source,
        writing_origin=writing_origin,
        voice_eligible=voice_eligible,
    )


def load_library(layout: LibraryLayout) -> tuple[list[VoiceoverCase], list[str]]:
    resources: list[VoiceoverCase] = []
    issues: list[str] = []
    case_texts: dict[str, Path] = {}
    paths = layout.case_root.rglob("*.md") if layout.case_root.is_dir() else []
    for path in sorted(paths):
        try:
            resource = _parse_case(path, layout)
            previous = case_texts.get(resource.original_text)
            if previous is not None:
                raise LibraryError(f"口播全文与 {previous} 重复")
            case_texts[resource.original_text] = path
            resources.append(resource)
        except (LibraryError, OSError, UnicodeError) as exc:
            issues.append(f"{path}: {exc}")
    return resources, issues


def _relative_link(path: Path, layout: LibraryLayout) -> str:
    return Path(os.path.relpath(path, layout.root)).as_posix()


def build_index(resources: Sequence[VoiceoverCase], layout: LibraryLayout) -> str:
    cases = list(resources)
    voice_profile = load_voice_profile(layout)
    voice_cases = [item for item in cases if item.voice_eligible]
    lines = [
        "# 口播案例索引",
        "",
        "本索引只负责定位完整口播案例。作者声音只来自当前口播声音真源和经过资格确认的同语境口播；案例身份不自动证明作者声音。",
        "",
        f"当前声音真源：{'可用' if voice_profile else '未建立'}；声音候选 {len(voice_cases)} 份；完整口播案例 {len(cases)} 份。",
        "",
        "需要缩小范围时，先按写作任务和成品语境浏览本索引，再用普通文本搜索标题、全文和隐藏标签；索引摘要不能代替原文。",
        "",
        "```powershell",
        f'rg -n -i "主题|动作|结果" "{CASE_DIRECTORY}"',
        "```",
        "",
        "## 口播声音",
        "",
    ]
    if voice_profile:
        lines.append(f"- [当前口播声音](<{_relative_link(voice_profile.path, layout)}>)")
    else:
        lines.append("- 尚未建立。")
    lines.extend([
        "",
        "## 完整口播案例",
        "",
    ])
    case_groups: dict[str, list[VoiceoverCase]] = {}
    for case in cases:
        case_groups.setdefault(case.script_task, []).append(case)
    for script_task in sorted(case_groups):
        lines.extend([f"### {script_task}", ""])
        for case in sorted(case_groups[script_task], key=lambda item: item.title):
            contexts = "、".join(case.delivery_contexts)
            voice_label = "；声音证据" if case.voice_eligible else ""
            lines.append(
                f"- [{case.title}](<{_relative_link(case.path, layout)}>) — "
                f"{contexts}；来源 {case.writing_origin}{voice_label}"
            )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _write_index(layout: LibraryLayout, resources: Sequence[VoiceoverCase]) -> Path:
    _write_text(layout.case_index, build_index(resources, layout))
    return layout.case_index


def validate_library(root: Path) -> tuple[LibraryLayout, list[VoiceoverCase]]:
    layout = LibraryLayout(_absolute(root))
    if not layout.root.exists() or not layout.root.is_dir():
        raise LibraryError(f"口播参考库目录不存在：{layout.root}")
    _check_manifest(layout.manifest)
    resources, issues = load_library(layout)
    if issues:
        raise LibraryError("\n".join(issues))
    if not layout.case_index.is_file():
        raise LibraryError(f"口播案例索引不存在：{layout.case_index}")
    expected = build_index(resources, layout)
    if layout.case_index.read_text(encoding="utf-8") != expected:
        raise LibraryError(f"口播案例索引需要更新：{layout.case_index}")
    return layout, resources


def initialize_library(
    root: Path,
    config_path: Path | None = None,
) -> tuple[LibraryLayout, Path, bool]:
    resolved = _absolute(root)
    _check_library_location(resolved)
    manifest = resolved / MANIFEST_RELATIVE
    if resolved.exists() and any(resolved.iterdir()) and not manifest.exists():
        raise LibraryError(
            f"目标目录已有内容但不是口播参考库：{resolved}；"
            "确认它是现有口播库时使用 adopt"
        )
    created = not manifest.exists()
    resolved.mkdir(parents=True, exist_ok=True)
    if manifest.exists():
        _check_manifest(manifest)
    else:
        _write_json(manifest, _manifest_value())
    layout = LibraryLayout(resolved)
    resources, issues = load_library(layout)
    if issues:
        raise LibraryError("\n".join(issues))
    _write_index(layout, resources)
    validate_library(resolved)
    config = _write_config(resolved, config_path)
    return layout, config, created


def adopt_library(
    root: Path,
    config_path: Path | None = None,
) -> tuple[LibraryLayout, Path]:
    resolved = _absolute(root)
    _check_library_location(resolved)
    if not resolved.exists() or not resolved.is_dir():
        raise LibraryError(f"现有口播参考库目录不存在：{resolved}")
    layout = LibraryLayout(resolved)
    if not layout.manifest.exists() and not any(
        path.exists()
        for path in (layout.voice, layout.case_root, layout.case_index)
    ):
        raise LibraryError("现有目录没有口播声音、完整案例或案例索引")
    if layout.manifest.exists():
        _check_manifest(layout.manifest)
    resources, issues = load_library(layout)
    if issues:
        raise LibraryError("\n".join(issues))
    if not layout.manifest.exists():
        _write_json(layout.manifest, _manifest_value())
    _write_index(layout, resources)
    validate_library(resolved)
    config = _write_config(resolved, config_path)
    return layout, config


def set_voice_profile(
    layout: LibraryLayout,
    *,
    input_path: Path,
    source: str,
) -> Path:
    source = source.strip()
    if not source:
        raise LibraryError("source 不能为空")
    try:
        text = input_path.read_text(encoding="utf-8-sig").strip()
    except FileNotFoundError as exc:
        raise LibraryError(f"输入文件不存在：{input_path}") from exc
    if not text:
        raise LibraryError("口播声音不能为空")
    metadata = {"resource_type": "voice-profile"}
    body = "\n\n".join(
        [
            "# 口播声音",
            "## 当前声音",
            text,
            f"来源：{source}",
            _metadata_block(metadata),
        ]
    ) + "\n"
    temporary = layout.voice.with_suffix(layout.voice.suffix + ".tmp")
    temporary.parent.mkdir(parents=True, exist_ok=True)
    temporary.write_text(body, encoding="utf-8")
    _parse_voice_profile(temporary)
    temporary.replace(layout.voice)
    return layout.voice


def add_case(
    layout: LibraryLayout,
    resources: Sequence[VoiceoverCase],
    *,
    input_path: Path,
    title: str,
    script_task: str,
    source: str,
    delivery_contexts: Sequence[str],
    topics: Sequence[str],
    moves: Sequence[str],
    writing_origin: str,
    voice_eligible: bool,
) -> Path:
    title = _safe_segment(title, "title")
    script_task = _safe_segment(script_task, "script_task")
    source = source.strip()
    if not source:
        raise LibraryError("source 不能为空")
    writing_origin = writing_origin.strip()
    if writing_origin not in WRITING_ORIGINS:
        raise LibraryError(
            f"writing_origin 不受支持：{writing_origin}；"
            f"可用值为 {', '.join(sorted(WRITING_ORIGINS))}"
        )
    if voice_eligible and writing_origin not in VOICE_ELIGIBLE_ORIGINS:
        raise LibraryError(
            "--voice-eligible 只能与 --writing-origin human 或 human-edited 一起使用"
        )
    try:
        original = input_path.read_text(encoding="utf-8-sig").strip()
    except FileNotFoundError as exc:
        raise LibraryError(f"输入文件不存在：{input_path}") from exc
    if not original:
        raise LibraryError("口播全文不能为空")
    if any(item.original_text == original for item in resources):
        raise LibraryError("这份口播全文已经存在于参考库")
    metadata = {
        "resource_type": "voiceover-case",
        "script_task": script_task,
        "delivery_contexts": list(
            _clean_values(delivery_contexts, "delivery_contexts", required=True)
        ),
        "topics": list(_clean_values(topics, "topics", required=False)),
        "moves": list(_clean_values(moves, "moves", required=False)),
        "writing_origin": writing_origin,
        "voice_eligible": voice_eligible,
    }
    path = layout.case_root / script_task / f"{title}.md"
    if path.exists():
        raise LibraryError(f"完整口播案例已经存在：{path}")
    body = "\n\n".join(
        [
            f"# {title}",
            "## 口播全文",
            original,
            f"来源：{source}",
            _metadata_block(metadata),
        ]
    ) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(body, encoding="utf-8")
    _parse_case(temporary, layout)
    temporary.replace(path)
    return path


def _counts(resources: Sequence[VoiceoverCase]) -> tuple[int, int]:
    return (
        len(resources),
        sum(item.voice_eligible for item in resources),
    )


def voice_candidates(
    resources: Sequence[VoiceoverCase],
    *,
    delivery_context: str,
    script_task: str | None,
    limit: int,
) -> list[VoiceoverCase]:
    context = delivery_context.strip()
    if not context:
        raise LibraryError("context 不能为空")
    if limit < 1:
        raise LibraryError("limit 必须大于 0")
    task = (script_task or "").strip()
    candidates = [
        item
        for item in resources
        if item.voice_eligible
        and context in item.delivery_contexts
        and (not task or item.script_task == task)
    ]
    candidates.sort(key=lambda item: (item.title, str(item.path)))
    return candidates[:limit]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="初始化、定位和维护 visual-multimedia 口播私人库"
    )
    parser.add_argument("--config", type=Path, help="本机口播参考库指针配置")
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="初始化口播私人库")
    init.add_argument("--root", type=Path, required=True)

    adopt = commands.add_parser("adopt", help="接入已有口播参考库")
    adopt.add_argument("--root", type=Path, required=True)

    for command, help_text in (
        ("show", "显示当前口播参考库"),
        ("validate", "验证声音、完整案例与案例索引"),
    ):
        item = commands.add_parser(command, help=help_text)
        item.add_argument("--root", type=Path)

    index = commands.add_parser("build-index", help="重建或核对口播案例索引")
    index.add_argument("--root", type=Path)
    index.add_argument("--check", action="store_true")

    voice = commands.add_parser("set-voice", help="写入用户已经确认的口播声音真源")
    voice.add_argument("--root", type=Path)
    voice.add_argument("--input", type=Path, required=True)
    voice.add_argument("--source", required=True)

    candidates = commands.add_parser(
        "voice-candidates",
        help="按成品语境和职责返回经过资格确认的声音候选",
    )
    candidates.add_argument("--root", type=Path)
    candidates.add_argument("--context", required=True)
    candidates.add_argument("--script-task")
    candidates.add_argument("--limit", type=int, default=5)

    case = commands.add_parser("add-case", help="从确认全文建立完整口播案例")
    case.add_argument("--root", type=Path)
    case.add_argument("--input", type=Path, required=True)
    case.add_argument("--title", required=True)
    case.add_argument("--script-task", required=True)
    case.add_argument("--source", required=True)
    case.add_argument("--context", action="append", required=True)
    case.add_argument("--topic", action="append", default=[])
    case.add_argument("--move", action="append", default=[])
    case.add_argument(
        "--writing-origin",
        choices=sorted(WRITING_ORIGINS),
        required=True,
    )
    case.add_argument("--voice-eligible", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "init":
            layout, config, created = initialize_library(args.root, args.config)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "action": "initialized" if created else "already-initialized",
                        "library_root": str(layout.root),
                        "config": str(config),
                        "case_index": str(layout.case_index),
                        "version": LIBRARY_VERSION,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "adopt":
            layout, config = adopt_library(args.root, args.config)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "action": "adopted",
                        "library_root": str(layout.root),
                        "config": str(config),
                        "case_index": str(layout.case_index),
                        "version": LIBRARY_VERSION,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

        root = resolve_library_root(args.root, args.config)
        layout = LibraryLayout(root)
        resources, issues = load_library(layout)
        if issues:
            raise LibraryError("\n".join(issues))
        if args.command == "show":
            layout, resources = validate_library(root)
            case_count, voice_candidate_count = _counts(resources)
            profile = load_voice_profile(layout)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "library_root": str(layout.root),
                        "case_index": str(layout.case_index),
                        "version": LIBRARY_VERSION,
                        "voice_profile": str(profile.path) if profile else None,
                        "voice_ready": profile is not None,
                        "voice_candidate_count": voice_candidate_count,
                        "case_count": case_count,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "validate":
            layout, resources = validate_library(root)
            case_count, voice_candidate_count = _counts(resources)
            profile = load_voice_profile(layout)
            print(
                f"口播私人库有效：声音真源 {'可用' if profile else '未建立'}，"
                f"声音候选 {voice_candidate_count} 份，完整口播 {case_count} 份；"
                f"案例索引：{layout.case_index}"
            )
            return 0
        if args.command == "voice-candidates":
            layout, resources = validate_library(root)
            profile = load_voice_profile(layout)
            candidates = voice_candidates(
                resources,
                delivery_context=args.context,
                script_task=args.script_task,
                limit=args.limit,
            )
            print(
                json.dumps(
                    {
                        "ok": True,
                        "library_root": str(layout.root),
                        "voice_profile": str(profile.path) if profile else None,
                        "delivery_context": args.context.strip(),
                        "script_task": (args.script_task or "").strip() or None,
                        "candidate_count": len(candidates),
                        "candidates": [
                            {
                                "title": item.title,
                                "path": str(item.path),
                                "script_task": item.script_task,
                                "delivery_contexts": list(item.delivery_contexts),
                                "writing_origin": item.writing_origin,
                            }
                            for item in candidates
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "build-index":
            expected = build_index(resources, layout)
            if args.check:
                if layout.case_index.read_text(encoding="utf-8") != expected:
                    raise LibraryError(f"口播案例索引需要更新：{layout.case_index}")
                print(f"口播案例索引有效：{layout.case_index}")
            else:
                _write_text(layout.case_index, expected)
                validate_library(layout.root)
                print(f"口播案例索引已更新：{layout.case_index}")
            return 0
        layout, resources = validate_library(root)
        if args.command == "set-voice":
            created = set_voice_profile(
                layout,
                input_path=args.input,
                source=args.source,
            )
        elif args.command == "add-case":
            created = add_case(
                layout,
                resources,
                input_path=args.input,
                title=args.title,
                script_task=args.script_task,
                source=args.source,
                delivery_contexts=args.context,
                topics=args.topic,
                moves=args.move,
                writing_origin=args.writing_origin,
                voice_eligible=args.voice_eligible,
            )
        else:
            raise LibraryError(f"不支持的命令：{args.command}")
        resources, issues = load_library(layout)
        if issues:
            raise LibraryError("\n".join(issues))
        _write_index(layout, resources)
        validate_library(layout.root)
        print(
            json.dumps(
                {
                    "ok": True,
                    "action": args.command,
                    "created": str(created),
                    "case_index": str(layout.case_index),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except (LibraryError, OSError, UnicodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

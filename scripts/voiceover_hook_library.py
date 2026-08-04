from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

try:
    from scripts.voiceover_reference_library import LibraryError, resolve_library_root
except ModuleNotFoundError:
    from voiceover_reference_library import LibraryError, resolve_library_root


HOOK_DIRECTORY = "独立口播钩子"
HOOK_INDEX_NAME = "口播钩子索引.md"
METADATA_PATTERN = re.compile(
    r"\n?<!-- voiceover-hook-index\s*\n(?P<metadata>\{.*\})\n-->\s*$",
    re.DOTALL,
)


@dataclass(frozen=True)
class HookLayout:
    root: Path

    @property
    def hook_root(self) -> Path:
        return self.root / HOOK_DIRECTORY

    @property
    def hook_index(self) -> Path:
        return self.hook_root / HOOK_INDEX_NAME


@dataclass(frozen=True)
class VoiceoverHook:
    path: Path
    hook_id: str
    title: str
    delivery_format: str
    contexts: tuple[str, ...]
    text: str
    source: str


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def _safe_segment(value: str, field: str) -> str:
    cleaned = value.strip()
    if (
        not cleaned
        or cleaned in {".", ".."}
        or any(character in cleaned for character in '<>:"/\\|?*')
    ):
        raise LibraryError(f"{field} 不能作为目录或文件名：{value}")
    return cleaned


def _clean_values(values: Sequence[str], field: str) -> tuple[str, ...]:
    cleaned = tuple(dict.fromkeys(value.strip() for value in values if value.strip()))
    if not cleaned:
        raise LibraryError(f"{field} 不能为空")
    return cleaned


def _metadata_block(value: dict[str, Any]) -> str:
    return "\n".join(
        [
            "<!-- voiceover-hook-index",
            json.dumps(value, ensure_ascii=False, sort_keys=True),
            "-->",
        ]
    )


def _parse_metadata(text: str) -> tuple[dict[str, Any], str]:
    match = METADATA_PATTERN.search(text.lstrip("\ufeff"))
    if not match:
        raise LibraryError("缺少 voiceover-hook-index")
    try:
        metadata = json.loads(match.group("metadata"))
    except json.JSONDecodeError as exc:
        raise LibraryError(f"voiceover-hook-index 不是有效 JSON：{exc}") from exc
    if not isinstance(metadata, dict):
        raise LibraryError("voiceover-hook-index 必须是 JSON 对象")
    return metadata, text[: match.start()].rstrip()


def _required_string(metadata: dict[str, Any], key: str) -> str:
    value = metadata.get(key)
    if not isinstance(value, str) or not value.strip():
        raise LibraryError(f"缺少 {key}")
    return value.strip()


def _string_list(metadata: dict[str, Any], key: str) -> tuple[str, ...]:
    value = metadata.get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise LibraryError(f"{key} 必须是字符串数组")
    return _clean_values(value, key)


def _title(body: str) -> str:
    match = re.search(r"^# (.+?)\s*$", body, re.MULTILINE)
    if not match:
        raise LibraryError("缺少一级标题")
    return match.group(1).strip()


def _section(body: str) -> str:
    match = re.search(r"^## 钩子原文\s*$", body, re.MULTILINE)
    if not match:
        raise LibraryError("缺少“钩子原文”")
    return body[match.end() :].strip()


def _text_and_source(section: str) -> tuple[str, str]:
    matches = list(re.finditer(r"^来源：\s*(.+?)\s*$", section, re.MULTILINE))
    if not matches:
        raise LibraryError("缺少来源")
    match = matches[-1]
    if section[match.end() :].strip():
        raise LibraryError("来源必须位于钩子原文末尾")
    text = section[: match.start()].strip()
    source = match.group(1).strip()
    if not text:
        raise LibraryError("钩子原文不能为空")
    if not source:
        raise LibraryError("来源不能为空")
    return text, source


def _parse_hook(path: Path, layout: HookLayout) -> VoiceoverHook:
    try:
        relative = path.relative_to(layout.hook_root)
    except ValueError as exc:
        raise LibraryError("钩子必须位于独立口播钩子目录") from exc
    if len(relative.parts) != 2:
        raise LibraryError("钩子必须使用“成品形态/文件”两级路径")
    metadata, body = _parse_metadata(path.read_text(encoding="utf-8-sig"))
    allowed = {"resource_type", "hook_id", "delivery_format", "contexts"}
    unknown = sorted(set(metadata) - allowed)
    if unknown:
        raise LibraryError("钩子元数据含有非寻址字段：" + "、".join(unknown))
    if metadata.get("resource_type") != "voiceover-hook":
        raise LibraryError("resource_type 必须是 voiceover-hook")
    delivery_format = _required_string(metadata, "delivery_format")
    if delivery_format != relative.parts[0]:
        raise LibraryError("delivery_format 必须与钩子目录一致")
    text, source = _text_and_source(_section(body))
    return VoiceoverHook(
        path=path,
        hook_id=_required_string(metadata, "hook_id"),
        title=_title(body),
        delivery_format=delivery_format,
        contexts=_string_list(metadata, "contexts"),
        text=text,
        source=source,
    )


def load_library(layout: HookLayout) -> tuple[list[VoiceoverHook], list[str]]:
    hooks: list[VoiceoverHook] = []
    issues: list[str] = []
    ids: dict[str, Path] = {}
    texts: dict[str, Path] = {}
    paths = sorted(layout.hook_root.rglob("*.md")) if layout.hook_root.is_dir() else []
    for path in paths:
        if path == layout.hook_index:
            continue
        try:
            hook = _parse_hook(path, layout)
            if hook.hook_id in ids:
                raise LibraryError(f"hook_id 与 {ids[hook.hook_id]} 重复")
            if hook.text in texts:
                raise LibraryError(f"钩子原文与 {texts[hook.text]} 重复")
            ids[hook.hook_id] = path
            texts[hook.text] = path
            hooks.append(hook)
        except (LibraryError, OSError, UnicodeError) as exc:
            issues.append(f"{path}: {exc}")
    return hooks, issues


def build_index(hooks: Sequence[VoiceoverHook], layout: HookLayout) -> str:
    lines = [
        "# 口播钩子索引",
        "",
        "本索引只按成品形态和使用语境定位独立钩子。写作时打开实际文件；索引不能替代原文。",
        "",
        f"当前共有 {len(hooks)} 条独立口播钩子。",
        "",
    ]
    groups: dict[str, list[VoiceoverHook]] = {}
    for hook in hooks:
        groups.setdefault(hook.delivery_format, []).append(hook)
    for delivery_format in sorted(groups):
        lines.extend([f"## {delivery_format}", ""])
        for hook in sorted(groups[delivery_format], key=lambda item: item.title):
            relative = Path(os.path.relpath(hook.path, layout.hook_root)).as_posix()
            lines.append(f"- [{hook.title}](<{relative}>) — {'、'.join(hook.contexts)}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_index(layout: HookLayout, hooks: Sequence[VoiceoverHook]) -> Path:
    _write_text(layout.hook_index, build_index(hooks, layout))
    return layout.hook_index


def add_hook(
    layout: HookLayout,
    existing: Sequence[VoiceoverHook],
    *,
    input_path: Path,
    title: str,
    hook_id: str,
    delivery_format: str,
    contexts: Sequence[str],
    source: str,
) -> Path:
    title = _safe_segment(title, "title")
    delivery_format = _safe_segment(delivery_format, "delivery_format")
    hook_id = hook_id.strip()
    source = source.strip()
    if not hook_id:
        raise LibraryError("hook_id 不能为空")
    if not source:
        raise LibraryError("source 不能为空")
    if any(item.hook_id == hook_id for item in existing):
        raise LibraryError(f"hook_id 已经存在：{hook_id}")
    try:
        hook_text = input_path.read_text(encoding="utf-8-sig").strip()
    except FileNotFoundError as exc:
        raise LibraryError(f"输入文件不存在：{input_path}") from exc
    if not hook_text:
        raise LibraryError("钩子原文不能为空")
    if any(item.text == hook_text for item in existing):
        raise LibraryError("这份钩子原文已经存在")
    metadata = {
        "resource_type": "voiceover-hook",
        "hook_id": hook_id,
        "delivery_format": delivery_format,
        "contexts": list(_clean_values(contexts, "contexts")),
    }
    path = layout.hook_root / delivery_format / f"{title}.md"
    if path.exists():
        raise LibraryError(f"钩子已经存在：{path}")
    body = "\n\n".join(
        [
            f"# {title}",
            "## 钩子原文",
            hook_text,
            f"来源：{source}",
            _metadata_block(metadata),
        ]
    ) + "\n"
    _write_text(path, body)
    _parse_hook(path, layout)
    return path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="维护 visual-multimedia 独立口播钩子库")
    parser.add_argument("--config", type=Path, help="本机口播私人库指针配置")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("validate", "build-index"):
        item = commands.add_parser(command)
        item.add_argument("--root", type=Path)
        if command == "build-index":
            item.add_argument("--check", action="store_true")
    add = commands.add_parser("add-hook")
    add.add_argument("--root", type=Path)
    add.add_argument("--input", type=Path, required=True)
    add.add_argument("--title", required=True)
    add.add_argument("--hook-id", required=True)
    add.add_argument("--delivery-format", required=True)
    add.add_argument("--context", action="append", required=True)
    add.add_argument("--source", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        root = resolve_library_root(args.root, args.config)
        layout = HookLayout(root)
        hooks, issues = load_library(layout)
        if issues:
            raise LibraryError("\n".join(issues))
        if args.command == "add-hook":
            created = add_hook(
                layout,
                hooks,
                input_path=args.input,
                title=args.title,
                hook_id=args.hook_id,
                delivery_format=args.delivery_format,
                contexts=args.context,
                source=args.source,
            )
            hooks, issues = load_library(layout)
            if issues:
                raise LibraryError("\n".join(issues))
            index_path = write_index(layout, hooks)
            print(f"口播钩子已保存：{created}\n钩子索引已更新：{index_path}")
            return 0
        expected = build_index(hooks, layout)
        if args.command == "validate":
            if not layout.hook_index.is_file():
                raise LibraryError(f"口播钩子索引不存在：{layout.hook_index}")
            if layout.hook_index.read_text(encoding="utf-8") != expected:
                raise LibraryError(f"口播钩子索引需要更新：{layout.hook_index}")
            print(f"口播钩子库有效：{len(hooks)} 条；索引：{layout.hook_index}")
            return 0
        if args.check:
            if not layout.hook_index.is_file():
                raise LibraryError(f"口播钩子索引不存在：{layout.hook_index}")
            if layout.hook_index.read_text(encoding="utf-8") != expected:
                raise LibraryError(f"口播钩子索引需要更新：{layout.hook_index}")
            print(f"口播钩子索引有效：{layout.hook_index}")
            return 0
        index_path = write_index(layout, hooks)
        print(f"口播钩子索引已更新：{index_path}")
        return 0
    except (LibraryError, OSError, UnicodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

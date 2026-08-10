#!/usr/bin/env python3
"""Audit real rendered frames for semantic graphic motion.

The script does not render or advance time. It consumes frames produced through
the project's existing deterministic window.__hf boundary, then reports static
fit diagnostics and suspicious stall-to-jump transitions.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def load_rgba(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGBA"), dtype=np.uint8)


def parse_roi(value: str | None) -> tuple[int, int, int, int] | None:
    if value is None:
        return None
    parts = value.split(",")
    if len(parts) != 4:
        raise ValueError("--roi 必须是 x,y,width,height")
    x, y, width, height = (int(part.strip()) for part in parts)
    if min(x, y) < 0 or width <= 0 or height <= 0:
        raise ValueError("--roi 需要非负坐标和正宽高")
    return x, y, width, height


def crop(array: np.ndarray, roi: tuple[int, int, int, int] | None) -> np.ndarray:
    if roi is None:
        return array
    x, y, width, height = roi
    if x + width > array.shape[1] or y + height > array.shape[0]:
        raise ValueError("--roi 超出图像边界")
    return array[y : y + height, x : x + width]


def premultiplied_rgba(array: np.ndarray) -> np.ndarray:
    rgba = array.astype(np.float32) / 255.0
    alpha = rgba[..., 3:4]
    return np.concatenate((rgba[..., :3] * alpha, alpha), axis=2)


def normalized_delta(left: np.ndarray, right: np.ndarray) -> float:
    if left.shape != right.shape:
        raise ValueError(f"帧尺寸不一致：{left.shape[1]}x{left.shape[0]} 与 {right.shape[1]}x{right.shape[0]}")
    return float(np.mean(np.abs(premultiplied_rgba(left) - premultiplied_rgba(right))))


def infer_background(array: np.ndarray) -> np.ndarray:
    corners = np.stack(
        (
            array[0, 0, :3],
            array[0, -1, :3],
            array[-1, 0, :3],
            array[-1, -1, :3],
        )
    )
    return np.median(corners.astype(np.float32), axis=0)


def parse_color(value: str | None) -> np.ndarray | None:
    if value is None:
        return None
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", value.strip())
    if not match:
        raise ValueError("--background 必须是 RRGGBB 或 #RRGGBB")
    raw = match.group(1)
    return np.asarray([int(raw[index : index + 2], 16) for index in (0, 2, 4)], dtype=np.float32)


def foreground_mask(array: np.ndarray, background: np.ndarray | None, threshold: float) -> np.ndarray:
    alpha = array[..., 3]
    if np.any(alpha < 250):
        return alpha >= max(1, int(threshold))
    resolved_background = infer_background(array) if background is None else background
    distance = np.linalg.norm(array[..., :3].astype(np.float32) - resolved_background, axis=2)
    return distance >= threshold


def static_fit_metrics(
    approved: np.ndarray,
    actual: np.ndarray,
    background: np.ndarray | None,
    foreground_threshold: float,
    pixel_threshold: float,
) -> dict[str, object]:
    if approved.shape != actual.shape:
        raise ValueError(
            f"获准静态图与结果帧尺寸不一致：{approved.shape[1]}x{approved.shape[0]} 与 "
            f"{actual.shape[1]}x{actual.shape[0]}"
        )
    difference = np.abs(premultiplied_rgba(approved) - premultiplied_rgba(actual))
    changed = np.max(difference, axis=2) >= pixel_threshold
    approved_mask = foreground_mask(approved, background, foreground_threshold)
    actual_mask = foreground_mask(actual, background, foreground_threshold)
    intersection = int(np.count_nonzero(approved_mask & actual_mask))
    union = int(np.count_nonzero(approved_mask | actual_mask))
    iou = 1.0 if union == 0 else intersection / union
    return {
        "width": int(approved.shape[1]),
        "height": int(approved.shape[0]),
        "mean_absolute_error": float(np.mean(difference)),
        "changed_pixel_ratio": float(np.mean(changed)),
        "foreground_iou": float(iou),
        "diagnostic_only": True,
    }


def analyze_continuity(
    frames: Sequence[np.ndarray],
    names: Sequence[str],
    stall_threshold: float,
    jump_threshold: float,
    jump_ratio: float,
    stall_run: int,
) -> dict[str, object]:
    deltas = [normalized_delta(frames[index - 1], frames[index]) for index in range(1, len(frames))]
    flags: list[dict[str, object]] = []
    for index, current in enumerate(deltas):
        previous = deltas[max(0, index - stall_run) : index]
        if len(previous) < stall_run or current < jump_threshold:
            continue
        previous_peak = max(previous)
        ratio = current / max(float(np.mean(previous)), 1e-12)
        if previous_peak <= stall_threshold or ratio >= jump_ratio:
            flags.append(
                {
                    "transition_index": index + 1,
                    "from": names[index],
                    "to": names[index + 1],
                    "delta": current,
                    "previous_deltas": previous,
                    "jump_ratio": ratio,
                    "signal": "stall_then_jump" if previous_peak <= stall_threshold else "relative_jump",
                }
            )
    return {
        "frame_count": len(frames),
        "transition_count": len(deltas),
        "deltas": [
            {"from": names[index], "to": names[index + 1], "normalized_delta": value}
            for index, value in enumerate(deltas)
        ],
        "minimum_delta": min(deltas),
        "median_delta": float(np.median(deltas)),
        "maximum_delta": max(deltas),
        "flags": flags,
        "review_required": bool(flags),
        "thresholds": {
            "stall": stall_threshold,
            "jump": jump_threshold,
            "jump_ratio": jump_ratio,
            "stall_run": stall_run,
        },
    }


def difference_panel(approved: np.ndarray, actual: np.ndarray) -> Image.Image:
    difference = np.max(np.abs(premultiplied_rgba(approved) - premultiplied_rgba(actual)), axis=2)
    heat = np.zeros((*difference.shape, 4), dtype=np.uint8)
    heat[..., 0] = np.clip(difference * 510.0, 0, 255).astype(np.uint8)
    heat[..., 1] = np.clip((difference - 0.5) * 510.0, 0, 255).astype(np.uint8)
    heat[..., 3] = 255
    return Image.fromarray(heat, mode="RGBA")


def save_overlay(path: Path, approved: np.ndarray, actual: np.ndarray) -> None:
    height, width = approved.shape[:2]
    label_height = 24
    canvas = Image.new("RGBA", (width * 3, height + label_height), (24, 24, 24, 255))
    panels = (Image.fromarray(approved, mode="RGBA"), Image.fromarray(actual, mode="RGBA"), difference_panel(approved, actual))
    for index, panel in enumerate(panels):
        canvas.paste(panel, (index * width, label_height))
    draw = ImageDraw.Draw(canvas)
    for index, label in enumerate(("approved", "actual", "difference")):
        draw.text((index * width + 6, 6), label, fill=(255, 255, 255, 255))
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path)


def selected_indices(frame_count: int, flagged_transitions: Iterable[int], limit: int = 12) -> list[int]:
    if frame_count <= limit:
        selected = set(range(frame_count))
    else:
        selected = {round(index * (frame_count - 1) / (limit - 1)) for index in range(limit)}
    for transition in flagged_transitions:
        selected.update((max(0, transition - 1), transition, min(frame_count - 1, transition + 1)))
    return sorted(selected)


def save_contact_sheet(
    path: Path,
    frames: Sequence[np.ndarray],
    names: Sequence[str],
    flags: Sequence[dict[str, object]],
) -> None:
    flagged = {int(flag["transition_index"]) for flag in flags}
    indices = selected_indices(len(frames), flagged)
    thumb_width = 220
    source_height, source_width = frames[0].shape[:2]
    thumb_height = max(1, round(source_height * thumb_width / source_width))
    label_height = 26
    columns = min(4, len(indices))
    rows = (len(indices) + columns - 1) // columns
    canvas = Image.new("RGBA", (columns * thumb_width, rows * (thumb_height + label_height)), (20, 20, 20, 255))
    draw = ImageDraw.Draw(canvas)
    for position, frame_index in enumerate(indices):
        row, column = divmod(position, columns)
        x = column * thumb_width
        y = row * (thumb_height + label_height)
        image = Image.fromarray(frames[frame_index], mode="RGBA").resize(
            (thumb_width, thumb_height), Image.Resampling.LANCZOS
        )
        canvas.paste(image, (x, y + label_height))
        label = f"{frame_index}: {names[frame_index]}"
        draw.text((x + 5, y + 7), label[:34], fill=(255, 255, 255, 255))
        if frame_index in flagged:
            draw.rectangle(
                (x + 1, y + label_height + 1, x + thumb_width - 2, y + label_height + thumb_height - 2),
                outline=(255, 64, 64, 255),
                width=4,
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path)


def ensure_writable(paths: Iterable[Path | None], overwrite: bool) -> None:
    existing = [path for path in paths if path is not None and path.exists()]
    if existing and not overwrite:
        joined = ", ".join(str(path) for path in existing)
        raise FileExistsError(f"输出已存在；如需覆盖请传 --overwrite：{joined}")


def load_frame_paths(directory: Path) -> list[Path]:
    if not directory.is_dir():
        raise FileNotFoundError(f"帧目录不存在：{directory}")
    paths = sorted(
        (path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES),
        key=natural_key,
    )
    if len(paths) < 2:
        raise ValueError("连续性检查至少需要两帧 PNG、JPG 或 WebP")
    return paths


def run_self_test() -> dict[str, object]:
    frames: list[np.ndarray] = []
    positions = (2, 4, 6, 6, 6, 22)
    for x in positions:
        frame = np.full((32, 32, 4), 255, dtype=np.uint8)
        frame[10:18, x : x + 8, :3] = (20, 80, 180)
        frames.append(frame)
    names = [f"frame-{index:02d}.png" for index in range(len(frames))]
    continuity = analyze_continuity(frames, names, 0.0005, 0.01, 8.0, 2)
    fit = static_fit_metrics(frames[-1], frames[-1], None, 12.0, 1.0 / 255.0)
    ok = bool(continuity["flags"]) and fit["mean_absolute_error"] == 0.0 and fit["foreground_iou"] == 1.0
    return {"ok": ok, "continuity_flag_count": len(continuity["flags"]), "identical_fit": fit}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="检查语义图形动效的真实帧连续性，并可比较最终帧与获准静态状态。"
    )
    parser.add_argument("--frames-dir", type=Path, help="按文件名自然排序的真实渲染帧目录")
    parser.add_argument("--approved-state", type=Path, help="获准静态状态图片；默认与最后一帧比较")
    parser.add_argument("--result-frame", type=Path, help="用于静态比较的结果帧；省略时使用最后一帧")
    parser.add_argument("--report", type=Path, help="JSON 报告输出路径")
    parser.add_argument("--overlay", type=Path, help="获准状态、结果帧和差异热图输出路径")
    parser.add_argument("--contact-sheet", type=Path, help="连续性联系表输出路径")
    parser.add_argument("--roi", help="只分析 x,y,width,height 指定区域")
    parser.add_argument("--background", help="不透明图片的背景色，RRGGBB；省略时从四角估计")
    parser.add_argument("--foreground-threshold", type=float, default=12.0, help="前景色差阈值，默认 12")
    parser.add_argument("--pixel-threshold", type=float, default=1.0 / 255.0, help="变化像素阈值，默认 1/255")
    parser.add_argument("--stall-threshold", type=float, default=0.0005, help="连续静止阈值，默认 0.0005")
    parser.add_argument("--jump-threshold", type=float, default=0.01, help="跳变最小差值，默认 0.01")
    parser.add_argument("--jump-ratio", type=float, default=8.0, help="相对跳变倍数，默认 8")
    parser.add_argument("--stall-run", type=int, default=2, help="跳变前至少连续静止的转场数，默认 2")
    parser.add_argument("--overwrite", action="store_true", help="允许覆盖已有报告和图片")
    parser.add_argument("--self-test", action="store_true", help="运行不写文件的内存自检")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            result = run_self_test()
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["ok"] else 1
        if args.frames_dir is None or args.report is None:
            parser.error("实际检查必须同时传 --frames-dir 和 --report")
        if args.overlay is not None and args.approved_state is None:
            parser.error("输出 --overlay 时必须传 --approved-state")
        if args.stall_run < 1:
            parser.error("--stall-run 必须至少为 1")

        ensure_writable((args.report, args.overlay, args.contact_sheet), args.overwrite)
        roi = parse_roi(args.roi)
        background = parse_color(args.background)
        frame_paths = load_frame_paths(args.frames_dir.resolve())
        raw_frames = [load_rgba(path) for path in frame_paths]
        expected_shape = raw_frames[0].shape
        if any(frame.shape != expected_shape for frame in raw_frames[1:]):
            raise ValueError("帧目录中存在不同尺寸的图片")
        frames = [crop(frame, roi) for frame in raw_frames]
        names = [path.name for path in frame_paths]
        continuity = analyze_continuity(
            frames,
            names,
            args.stall_threshold,
            args.jump_threshold,
            args.jump_ratio,
            args.stall_run,
        )

        report: dict[str, object] = {
            "protocol": "visual-multimedia-semantic-motion-audit",
            "version": 1,
            "frames_dir": str(args.frames_dir.resolve()),
            "roi": args.roi,
            "continuity": continuity,
            "interpretation": "自动指标只定位风险，不能替代结构、平滑度、识别和运动含义审阅。",
        }

        approved_array: np.ndarray | None = None
        actual_array: np.ndarray | None = None
        if args.approved_state is not None:
            approved_array = crop(load_rgba(args.approved_state.resolve()), roi)
            result_path = args.result_frame.resolve() if args.result_frame is not None else frame_paths[-1]
            actual_array = crop(load_rgba(result_path), roi)
            report["static_fit"] = {
                "approved_state": str(args.approved_state.resolve()),
                "result_frame": str(result_path),
                **static_fit_metrics(
                    approved_array,
                    actual_array,
                    background,
                    args.foreground_threshold,
                    args.pixel_threshold,
                ),
            }

        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if args.overlay is not None and approved_array is not None and actual_array is not None:
            save_overlay(args.overlay, approved_array, actual_array)
        if args.contact_sheet is not None:
            save_contact_sheet(args.contact_sheet, frames, names, continuity["flags"])
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (FileNotFoundError, FileExistsError, ValueError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

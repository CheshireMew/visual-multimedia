#!/usr/bin/env python3
"""Regression checks for silence-safe cache-unit planning."""

from __future__ import annotations

import json
from dataclasses import dataclass

from anime_avatar_segments import plan_unit_ranges


@dataclass(frozen=True)
class Unit:
    start: float
    end: float


def main() -> int:
    fps = 24
    units = [
        Unit(0.0, 23.34),
        Unit(27.80, 37.84),
        Unit(49.67, 72.67),
        Unit(85.17, 102.29),
        Unit(102.29, 102.44),  # 多
        Unit(102.44, 102.65),  # 久
        Unit(115.33, 139.17),
        Unit(147.90, 190.033),
    ]
    ranges = plan_unit_ranges(units, 4561, fps, 24, 48, 1.2)
    boundaries = {value for pair in ranges for value in pair}
    forbidden_start = round(102.29 * fps)
    forbidden_end = round(102.65 * fps)
    if any(forbidden_start < value < forbidden_end for value in boundaries):
        raise RuntimeError("分段器仍会把“多久”的连续发音拆开")
    if max(end - start for start, end in ranges) > 48 * fps:
        raise RuntimeError("连续讲话单元超过显式硬上限")
    if not any(end - start > 24 * fps for start, end in ranges):
        raise RuntimeError("测试没有证明连续讲话可受控超过目标单元长度")

    long_silence = plan_unit_ranges(
        [Unit(0.0, 1.0), Unit(61.0, 62.0)],
        62 * fps,
        fps,
        24,
        48,
        1.2,
    )
    if max(end - start for start, end in long_silence) > 24 * fps:
        raise RuntimeError("长静音没有按目标缓存粒度切分")

    try:
        plan_unit_ranges([Unit(0.0, 49.0)], 49 * fps, fps, 24, 48, 1.2)
    except RuntimeError as error:
        if "连续讲话区间超过" not in str(error):
            raise
    else:
        raise RuntimeError("超过硬上限的连续讲话没有被明确拒绝")

    print(
        json.dumps(
            {
                "status": "passed",
                "ranges": ranges,
                "forbidden_word_split_frames": [
                    forbidden_start,
                    forbidden_end,
                ],
                "long_silence_ranges": long_silence,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

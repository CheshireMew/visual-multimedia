#!/usr/bin/env python3
"""Smooth small residual jumps at compatible whole-frame avatar joins.

This module deliberately does not try to repair incompatible portraits.  It
uses bidirectional DIS optical flow only after a join passes identity, motion,
and consistency checks.  If the only remaining difference is a conservative
neighbor-luminance warning, the same two-frame optical-flow result is retained
as an explicit 83 ms micro transition instead of triggering route retries.  A
join boundary is the index of the first frame on the right side of a cut.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from typing import Any, Sequence

import cv2
import numpy as np


@dataclass(frozen=True)
class BlendThresholds:
    """Conservative limits for treating a join as a small residual change."""

    # Flow is estimated on a bounded proxy for practical render time, then
    # upsampled and photometrically verified against the real output pixels.
    flow_max_dimension: int | None = 640
    max_raw_luma_mae: float = 0.22
    max_warped_luma_mae: float = 0.14
    max_warp_regression: float = 0.025
    max_motion_median_ratio: float = 0.025
    max_motion_p95_ratio: float = 0.10
    max_fb_consistency_p95_ratio: float = 0.055
    max_flow_out_of_bounds_ratio: float = 0.08
    max_neighbor_motion_multiplier: float = 2.75
    max_neighbor_motion_margin_ratio: float = 0.012
    max_neighbor_luma_multiplier: float = 2.75
    max_neighbor_luma_margin: float = 0.025
    max_motion_step_ratio: float = 0.025


@dataclass(frozen=True)
class _FlowPair:
    forward: np.ndarray
    backward: np.ndarray
    flow_width: int
    flow_height: int
    metrics: dict[str, float | int]


def _validate_portraits(portraits: Sequence[np.ndarray]) -> None:
    if not portraits:
        raise ValueError("portraits 不能为空")
    first = portraits[0]
    if not isinstance(first, np.ndarray):
        raise TypeError("portraits 中的每一项都必须是 numpy.ndarray")
    if first.dtype != np.uint8:
        raise TypeError("portraits 只接受 uint8 图像帧")
    if first.ndim not in (2, 3):
        raise ValueError("图像帧必须是灰度、BGR 或 BGRA")
    if first.ndim == 3 and first.shape[2] not in (1, 3, 4):
        raise ValueError("图像帧通道数必须为 1、3 或 4")
    if first.shape[0] < 2 or first.shape[1] < 2:
        raise ValueError("图像帧尺寸至少为 2x2")

    for index, portrait in enumerate(portraits):
        if not isinstance(portrait, np.ndarray):
            raise TypeError(f"portraits[{index}] 不是 numpy.ndarray")
        if portrait.dtype != first.dtype or portrait.shape != first.shape:
            raise ValueError(
                "所有 portraits 必须具有完全相同的尺寸、通道数和 dtype；"
                f"portraits[{index}] 不一致"
            )


def _to_gray(frame: np.ndarray) -> np.ndarray:
    if frame.ndim == 2:
        return frame
    if frame.shape[2] == 1:
        return frame[..., 0]
    if frame.shape[2] == 3:
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.cvtColor(frame, cv2.COLOR_BGRA2GRAY)


def _flow_size(
    width: int,
    height: int,
    max_dimension: int | None,
) -> tuple[int, int]:
    if max_dimension is None:
        return width, height
    if max_dimension < 32:
        raise ValueError("flow_max_dimension 不能小于 32")
    scale = min(1.0, max_dimension / max(width, height))
    return (
        max(2, int(round(width * scale))),
        max(2, int(round(height * scale))),
    )


def _make_dis() -> cv2.DISOpticalFlow:
    estimator = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    estimator.setFinestScale(0)
    estimator.setUseSpatialPropagation(True)
    return estimator


def _masked_mean(values: np.ndarray, mask: np.ndarray) -> float:
    selected = values[mask]
    if selected.size == 0:
        return float(np.mean(values))
    return float(np.mean(selected))


def _masked_percentile(
    values: np.ndarray,
    mask: np.ndarray,
    percentile: float,
) -> float:
    selected = values[mask]
    if selected.size == 0:
        selected = values.reshape(-1)
    return float(np.percentile(selected, percentile))


def _content_mask(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    first_float = first.astype(np.float32)
    second_float = second.astype(np.float32)
    gradient_first = cv2.magnitude(
        cv2.Sobel(first_float, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(first_float, cv2.CV_32F, 0, 1, ksize=3),
    )
    gradient_second = cv2.magnitude(
        cv2.Sobel(second_float, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(second_float, cv2.CV_32F, 0, 1, ksize=3),
    )
    changed = cv2.absdiff(first, second) >= 8
    active = (gradient_first >= 12) | (gradient_second >= 12) | changed
    active = cv2.dilate(
        active.astype(np.uint8),
        np.ones((5, 5), dtype=np.uint8),
        iterations=1,
    ).astype(bool)
    if float(np.mean(active)) < 0.02:
        return np.ones(first.shape, dtype=bool)
    return active


def _estimate_flow_pair(
    first: np.ndarray,
    second: np.ndarray,
    thresholds: BlendThresholds,
) -> _FlowPair:
    full_height, full_width = first.shape[:2]
    flow_width, flow_height = _flow_size(
        full_width,
        full_height,
        thresholds.flow_max_dimension,
    )
    first_gray = cv2.resize(
        _to_gray(first),
        (flow_width, flow_height),
        interpolation=cv2.INTER_AREA,
    )
    second_gray = cv2.resize(
        _to_gray(second),
        (flow_width, flow_height),
        interpolation=cv2.INTER_AREA,
    )

    forward = _make_dis().calc(first_gray, second_gray, None)
    backward = _make_dis().calc(second_gray, first_gray, None)
    if forward is None or backward is None:
        raise RuntimeError("DIS 光流计算没有返回结果")
    if not np.all(np.isfinite(forward)) or not np.all(np.isfinite(backward)):
        raise RuntimeError("DIS 光流包含非有限数值")

    scale_x = full_width / flow_width
    scale_y = full_height / flow_height
    full_diagonal = math.hypot(full_width, full_height)
    grid_x, grid_y = np.meshgrid(
        np.arange(flow_width, dtype=np.float32),
        np.arange(flow_height, dtype=np.float32),
    )
    proxy_focus = _content_mask(first_gray, second_gray)

    forward_px = np.sqrt(
        np.square(forward[..., 0] * scale_x)
        + np.square(forward[..., 1] * scale_y)
    )
    backward_px = np.sqrt(
        np.square(backward[..., 0] * scale_x)
        + np.square(backward[..., 1] * scale_y)
    )
    motion_values = np.concatenate(
        (forward_px[proxy_focus], backward_px[proxy_focus]),
    )
    if motion_values.size == 0:
        motion_values = np.concatenate(
            (forward_px.reshape(-1), backward_px.reshape(-1)),
        )

    forward_target_x = grid_x + forward[..., 0]
    forward_target_y = grid_y + forward[..., 1]
    forward_valid = (
        (forward_target_x >= 0)
        & (forward_target_x <= flow_width - 1)
        & (forward_target_y >= 0)
        & (forward_target_y <= flow_height - 1)
    )
    backward_at_target_x = cv2.remap(
        backward[..., 0],
        forward_target_x,
        forward_target_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    backward_at_target_y = cv2.remap(
        backward[..., 1],
        forward_target_x,
        forward_target_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    fb_error_px = np.sqrt(
        np.square((forward[..., 0] + backward_at_target_x) * scale_x)
        + np.square((forward[..., 1] + backward_at_target_y) * scale_y)
    )
    consistency_mask = proxy_focus & forward_valid

    second_on_first = cv2.remap(
        second_gray,
        forward_target_x,
        forward_target_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    backward_target_x = grid_x + backward[..., 0]
    backward_target_y = grid_y + backward[..., 1]
    backward_valid = (
        (backward_target_x >= 0)
        & (backward_target_x <= flow_width - 1)
        & (backward_target_y >= 0)
        & (backward_target_y <= flow_height - 1)
    )
    first_on_second = cv2.remap(
        first_gray,
        backward_target_x,
        backward_target_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )

    proxy_raw_error = (
        cv2.absdiff(first_gray, second_gray).astype(np.float32) / 255.0
    )
    proxy_forward_error = (
        cv2.absdiff(first_gray, second_on_first).astype(np.float32) / 255.0
    )
    proxy_backward_error = (
        cv2.absdiff(second_gray, first_on_second).astype(np.float32) / 255.0
    )
    proxy_forward_photo_mask = proxy_focus & forward_valid
    proxy_backward_photo_mask = proxy_focus & backward_valid
    proxy_warped_luma_mae = 0.5 * (
        _masked_mean(proxy_forward_error, proxy_forward_photo_mask)
        + _masked_mean(proxy_backward_error, proxy_backward_photo_mask)
    )
    proxy_raw_luma_mae = _masked_mean(proxy_raw_error, proxy_focus)

    # Verify the proxy flow against the actual output pixels.  This catches a
    # small eye, mouth, hair, or accessory jump without paying the much larger
    # cost of estimating six bidirectional 900px flows for every join.
    full_forward = _full_resolution_flow(forward, full_width, full_height)
    full_backward = _full_resolution_flow(backward, full_width, full_height)
    full_grid_x, full_grid_y = np.meshgrid(
        np.arange(full_width, dtype=np.float32),
        np.arange(full_height, dtype=np.float32),
    )
    first_gray_full = _to_gray(first)
    second_gray_full = _to_gray(second)
    full_focus = _content_mask(first_gray_full, second_gray_full)
    full_forward_x = full_grid_x + full_forward[..., 0]
    full_forward_y = full_grid_y + full_forward[..., 1]
    full_backward_x = full_grid_x + full_backward[..., 0]
    full_backward_y = full_grid_y + full_backward[..., 1]
    full_forward_valid = (
        (full_forward_x >= 0)
        & (full_forward_x <= full_width - 1)
        & (full_forward_y >= 0)
        & (full_forward_y <= full_height - 1)
    )
    full_backward_valid = (
        (full_backward_x >= 0)
        & (full_backward_x <= full_width - 1)
        & (full_backward_y >= 0)
        & (full_backward_y <= full_height - 1)
    )
    second_on_first_full = cv2.remap(
        second_gray_full,
        full_forward_x,
        full_forward_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    first_on_second_full = cv2.remap(
        first_gray_full,
        full_backward_x,
        full_backward_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    full_raw_error = (
        cv2.absdiff(first_gray_full, second_gray_full).astype(np.float32)
        / 255.0
    )
    full_forward_error = (
        cv2.absdiff(first_gray_full, second_on_first_full).astype(np.float32)
        / 255.0
    )
    full_backward_error = (
        cv2.absdiff(second_gray_full, first_on_second_full).astype(np.float32)
        / 255.0
    )
    full_forward_photo_mask = full_focus & full_forward_valid
    full_backward_photo_mask = full_focus & full_backward_valid
    raw_luma_mae = _masked_mean(full_raw_error, full_focus)
    warped_luma_mae = 0.5 * (
        _masked_mean(full_forward_error, full_forward_photo_mask)
        + _masked_mean(full_backward_error, full_backward_photo_mask)
    )
    motion_median_px = float(np.median(motion_values))
    motion_p95_px = float(np.percentile(motion_values, 95))
    fb_consistency_p95_px = _masked_percentile(
        fb_error_px,
        consistency_mask,
        95,
    )

    metrics: dict[str, float | int] = {
        "flow_width": flow_width,
        "flow_height": flow_height,
        "full_resolution_width": full_width,
        "full_resolution_height": full_height,
        "full_resolution_content_ratio": round(
            float(np.mean(full_focus)),
            6,
        ),
        "raw_luma_mae": round(raw_luma_mae, 6),
        "warped_luma_mae": round(warped_luma_mae, 6),
        "photometric_similarity": round(max(0.0, 1.0 - warped_luma_mae), 6),
        "proxy_raw_luma_mae": round(proxy_raw_luma_mae, 6),
        "proxy_warped_luma_mae": round(proxy_warped_luma_mae, 6),
        "motion_median_px": round(motion_median_px, 4),
        "motion_p95_px": round(motion_p95_px, 4),
        "motion_median_ratio": round(motion_median_px / full_diagonal, 7),
        "motion_p95_ratio": round(motion_p95_px / full_diagonal, 7),
        "fb_consistency_p95_px": round(fb_consistency_p95_px, 4),
        "fb_consistency_p95_ratio": round(
            fb_consistency_p95_px / full_diagonal,
            7,
        ),
        "flow_out_of_bounds_ratio": round(
            1.0 - float(np.mean(forward_valid & backward_valid)),
            6,
        ),
    }
    return _FlowPair(
        forward=forward,
        backward=backward,
        flow_width=flow_width,
        flow_height=flow_height,
        metrics=metrics,
    )


def _failed_checks(
    metrics: dict[str, float | int],
    thresholds: BlendThresholds,
) -> list[str]:
    checks = (
        ("raw_luma_mae", thresholds.max_raw_luma_mae),
        ("warped_luma_mae", thresholds.max_warped_luma_mae),
        ("motion_median_ratio", thresholds.max_motion_median_ratio),
        ("motion_p95_ratio", thresholds.max_motion_p95_ratio),
        (
            "fb_consistency_p95_ratio",
            thresholds.max_fb_consistency_p95_ratio,
        ),
        (
            "flow_out_of_bounds_ratio",
            thresholds.max_flow_out_of_bounds_ratio,
        ),
    )
    failures = [
        name
        for name, limit in checks
        if float(metrics[name]) > limit
    ]
    warp_regression = (
        float(metrics["warped_luma_mae"]) - float(metrics["raw_luma_mae"])
    )
    if warp_regression > thresholds.max_warp_regression:
        failures.append("warp_regression")
    return failures


def _full_resolution_flow(
    flow: np.ndarray,
    width: int,
    height: int,
) -> np.ndarray:
    flow_height, flow_width = flow.shape[:2]
    if (flow_width, flow_height) == (width, height):
        return flow
    resized = cv2.resize(flow, (width, height), interpolation=cv2.INTER_LINEAR)
    resized[..., 0] *= width / flow_width
    resized[..., 1] *= height / flow_height
    return resized


def _intermediate(
    first: np.ndarray,
    second: np.ndarray,
    forward: np.ndarray,
    backward: np.ndarray,
    amount: float,
) -> np.ndarray:
    height, width = first.shape[:2]
    grid_x, grid_y = np.meshgrid(
        np.arange(width, dtype=np.float32),
        np.arange(height, dtype=np.float32),
    )
    first_warped = cv2.remap(
        first,
        grid_x - amount * forward[..., 0],
        grid_y - amount * forward[..., 1],
        cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    second_warped = cv2.remap(
        second,
        grid_x - (1.0 - amount) * backward[..., 0],
        grid_y - (1.0 - amount) * backward[..., 1],
        cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return cv2.addWeighted(
        first_warped,
        1.0 - amount,
        second_warped,
        amount,
        0.0,
    )


def blend_compatible_join_window_in_place(
    frames: list[np.ndarray],
    boundary: int,
    *,
    thresholds: BlendThresholds | None = None,
) -> dict[str, Any]:
    """Validate and smooth one join inside a small real-frame window.

    ``boundary`` is the first frame on the right side of the cut.  The caller
    must provide at least ``boundary - 2`` through ``boundary + 1`` so the
    function can verify all three edges after replacing frames
    ``boundary - 1`` and ``boundary``.  A rejected join leaves the list
    byte-for-byte unchanged.  This window API is intentionally suitable for
    both preflight and constant-memory streaming renders.
    """

    if not isinstance(frames, list):
        raise TypeError("frames 必须是可原地改写的 list")
    _validate_portraits(frames)
    if isinstance(boundary, bool) or not isinstance(boundary, (int, np.integer)):
        raise TypeError("boundary 必须是整数")
    boundary = int(boundary)
    if boundary < 2 or boundary + 1 >= len(frames):
        raise ValueError(
            "接缝窗口必须包含 boundary-2、boundary-1、boundary、boundary+1"
        )
    config = thresholds or BlendThresholds()
    first = frames[boundary - 1]
    second = frames[boundary]
    report: dict[str, Any] = {
        "boundary": boundary,
        "input_window": [boundary - 2, boundary + 1],
        "output_frame_indices": [boundary - 1, boundary],
        "fractions": [round(1.0 / 3.0, 6), round(2.0 / 3.0, 6)],
        "flow_resolution": (
            "bounded_proxy_flow_with_full_resolution_photometric_verification"
        ),
        "applied": False,
    }

    try:
        left_natural = _estimate_flow_pair(
            frames[boundary - 2],
            first,
            config,
        )
        cut = _estimate_flow_pair(first, second, config)
        right_natural = _estimate_flow_pair(
            second,
            frames[boundary + 1],
            config,
        )
    except (cv2.error, RuntimeError) as error:
        report["reason"] = "optical_flow_failed"
        report["error"] = str(error)
        return report

    report["original_edge_metrics"] = {
        "left_natural": left_natural.metrics,
        "cut": cut.metrics,
        "right_natural": right_natural.metrics,
    }
    cut_failures = _failed_checks(cut.metrics, config)
    if cut_failures:
        report["reason"] = "incompatible_join_rejected"
        report["failed_checks"] = [f"cut:{name}" for name in cut_failures]
        return report

    height, width = first.shape[:2]
    forward = _full_resolution_flow(cut.forward, width, height)
    backward = _full_resolution_flow(cut.backward, width, height)
    first_transition = _intermediate(
        first,
        second,
        forward,
        backward,
        1.0 / 3.0,
    )
    second_transition = _intermediate(
        first,
        second,
        forward,
        backward,
        2.0 / 3.0,
    )
    candidate_frames = (
        frames[boundary - 2],
        first_transition,
        second_transition,
        frames[boundary + 1],
    )
    candidate_pairs: list[_FlowPair] = []
    try:
        for left, right in zip(
            candidate_frames[:-1],
            candidate_frames[1:],
            strict=True,
        ):
            candidate_pairs.append(_estimate_flow_pair(left, right, config))
    except (cv2.error, RuntimeError) as error:
        report["reason"] = "blended_window_flow_failed"
        report["error"] = str(error)
        return report

    report["blended_edge_metrics"] = [
        pair.metrics for pair in candidate_pairs
    ]
    failures: list[str] = []
    for edge_index, pair in enumerate(candidate_pairs):
        failures.extend(
            f"blended_edge_{edge_index}:{name}"
            for name in _failed_checks(pair.metrics, config)
        )

    outer_motion = max(
        float(left_natural.metrics["motion_p95_ratio"]),
        float(right_natural.metrics["motion_p95_ratio"]),
    )
    motion_envelope = max(
        outer_motion * config.max_neighbor_motion_multiplier,
        outer_motion + config.max_neighbor_motion_margin_ratio,
    )
    outer_luma = max(
        float(left_natural.metrics["raw_luma_mae"]),
        float(right_natural.metrics["raw_luma_mae"]),
    )
    luma_envelope = max(
        outer_luma * config.max_neighbor_luma_multiplier,
        outer_luma + config.max_neighbor_luma_margin,
    )
    candidate_motion = [
        float(pair.metrics["motion_p95_ratio"])
        for pair in candidate_pairs
    ]
    candidate_luma = [
        float(pair.metrics["raw_luma_mae"])
        for pair in candidate_pairs
    ]
    motion_profile = [
        float(left_natural.metrics["motion_p95_ratio"]),
        *candidate_motion,
        float(right_natural.metrics["motion_p95_ratio"]),
    ]
    motion_steps = [
        abs(right - left)
        for left, right in zip(
            motion_profile[:-1],
            motion_profile[1:],
            strict=True,
        )
    ]
    if max(candidate_motion) > motion_envelope:
        failures.append("blended_window:neighbor_motion_spike")
    if max(candidate_luma) > luma_envelope:
        failures.append("blended_window:neighbor_luma_spike")
    if max(motion_steps) > config.max_motion_step_ratio:
        failures.append("blended_window:motion_acceleration_spike")

    report["window_validation"] = {
        "motion_p95_ratio_profile": [
            round(value, 7) for value in motion_profile
        ],
        "maximum_motion_step_ratio": round(max(motion_steps), 7),
        "motion_envelope_ratio": round(motion_envelope, 7),
        "raw_luma_envelope": round(luma_envelope, 7),
        "failed_checks": failures,
    }
    micro_transition_failures = {
        "blended_window:neighbor_luma_spike",
    }
    use_micro_transition = (
        bool(failures)
        and set(failures).issubset(micro_transition_failures)
    )
    if failures and not use_micro_transition:
        report["reason"] = "blended_window_rejected"
        report["failed_checks"] = failures
        return report

    frames[boundary - 1 : boundary + 1] = [
        first_transition,
        second_transition,
    ]
    report["applied"] = True
    report["transition_mode"] = (
        "micro_optical_flow_luma_fallback"
        if use_micro_transition
        else "strict_optical_flow"
    )
    report["strict_window_validation_passed"] = not failures
    report["fallback_warnings"] = failures if use_micro_transition else []
    report["reason"] = (
        "applied_micro_optical_flow_transition"
        if use_micro_transition
        else "applied"
    )
    return report


def _synthetic_frame(offset_x: int = 0) -> np.ndarray:
    frame = np.full((96, 96, 3), 245, dtype=np.uint8)
    center = (48 + offset_x, 44)
    cv2.circle(frame, center, 26, (55, 55, 70), -1, cv2.LINE_AA)
    cv2.circle(frame, (40 + offset_x, 40), 4, (235, 235, 245), -1)
    cv2.circle(frame, (56 + offset_x, 40), 4, (235, 235, 245), -1)
    cv2.ellipse(
        frame,
        (48 + offset_x, 52),
        (10, 5),
        0,
        0,
        180,
        (220, 220, 235),
        2,
        cv2.LINE_AA,
    )
    cv2.rectangle(
        frame,
        (25 + offset_x, 70),
        (71 + offset_x, 94),
        (75, 70, 90),
        -1,
    )
    return frame


def self_test() -> dict[str, Any]:
    """Run a fast in-memory check without creating files."""

    first = _synthetic_frame(0)
    second = _synthetic_frame(2)
    source = [
        _synthetic_frame(-1),
        first.copy(),
        second.copy(),
        _synthetic_frame(3),
    ]
    source_identity = id(source)
    source_length = len(source)
    report = blend_compatible_join_window_in_place(source, 2)
    assert id(source) == source_identity
    assert len(source) == source_length
    assert report["applied"] is True, report
    assert not np.array_equal(source[1], first)
    assert not np.array_equal(source[2], second)

    brighter = np.clip(
        first.astype(np.int16) + 30,
        0,
        255,
    ).astype(np.uint8)
    micro_transition = [
        first.copy(),
        first.copy(),
        brighter.copy(),
        brighter.copy(),
    ]
    micro_report = blend_compatible_join_window_in_place(
        micro_transition,
        2,
    )
    assert micro_report["applied"] is True, micro_report
    assert (
        micro_report["transition_mode"]
        == "micro_optical_flow_luma_fallback"
    ), micro_report
    assert micro_report["fallback_warnings"] == [
        "blended_window:neighbor_luma_spike"
    ], micro_report

    incompatible = np.full_like(first, 15)
    rejected = [
        first.copy(),
        first.copy(),
        incompatible.copy(),
        incompatible.copy(),
    ]
    rejected_before = [frame.copy() for frame in rejected]
    rejected_identities = [id(frame) for frame in rejected]
    rejected_length = len(rejected)
    rejected_report = blend_compatible_join_window_in_place(rejected, 2)
    assert rejected_report["applied"] is False, rejected_report
    assert rejected_report["reason"] == "incompatible_join_rejected"
    assert len(rejected) == rejected_length
    assert [id(frame) for frame in rejected] == rejected_identities
    assert all(
        np.array_equal(after, before)
        for after, before in zip(rejected, rejected_before, strict=True)
    )

    return {
        "ok": True,
        "compatible_join": report,
        "micro_transition": micro_report,
        "incompatible_join": rejected_report,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="对已兼容的二次元整画面切换做双向 DIS 光流残差平滑。"
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="运行不读写文件的轻量自测。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.self_test:
        raise SystemExit("当前命令行入口只提供 --self-test；生产流程请导入函数调用。")
    print(json.dumps(self_test(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

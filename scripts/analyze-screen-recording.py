"""Actual recording frames -> screen vocabulary, motion and normalized OCR boxes."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import cv2
import numpy as np

from recording_media import source, probe, run, write_json, binding, digest
from media_task_workspace import assert_skill_task_path


def camera_motion(a, b):
    detector = cv2.ORB_create(1500)
    ka, da = detector.detectAndCompute(a, None)
    kb, db = detector.detectAndCompute(b, None)
    if da is None or db is None or len(ka) < 20 or len(kb) < 20:
        return None
    matches = sorted(cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(da, db), key=lambda item: item.distance)[:400]
    if len(matches) < 20:
        return None
    pa = np.float32([ka[item.queryIdx].pt for item in matches])
    pb = np.float32([kb[item.trainIdx].pt for item in matches])
    matrix, inliers = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=3)
    if matrix is None or inliers is None or inliers.sum() < 15:
        return None
    return {"scale": float(np.hypot(matrix[0, 0], matrix[1, 0])),
            "dx": float(matrix[0, 2] / a.shape[1]), "dy": float(matrix[1, 2] / a.shape[0])}


def vocabulary(frames):
    counts = {}
    for frame in frames:
        terms = set()
        for item in frame["items"]:
            terms.update(re.findall(r"[A-Za-z][A-Za-z0-9.+_-]{2,}", item["text"]))
            text = item["text"].strip()
            if re.fullmatch(r"[\u3400-\u9fff]{2,8}", text):
                terms.add(text)
        for text in terms:
            counts[text] = counts.get(text, 0) + 1
    return [text for text, count in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0])) if count >= 2][:40]


def analyze(args):
    project, file, asset = source(args.project, args.source_id)
    metadata = probe(args.ffprobe, file)
    duration = float(metadata["format"]["duration"])
    video = next(item for item in metadata["streams"] if item["codec_type"] == "video")
    width, height = video["width"], video["height"]
    rotation = next((item["rotation"] for item in video.get("side_data_list", []) if "rotation" in item), 0)
    if abs(rotation) % 180 == 90:
        width, height = height, width
    if not 0 < args.fps <= 5:
        raise ValueError("sample fps must be in (0, 5]")
    folder = assert_skill_task_path(project / "work" / ("screen-" + asset["integrity"]["sha256"][:12] + f"-{args.fps:g}"))
    folder.mkdir(parents=True, exist_ok=True)
    frames = []
    previous = None
    for index, t in enumerate(np.arange(0, duration, 1 / args.fps)):
        image = folder / f"frame-{index:06d}.png"
        run([args.ffmpeg, "-v", "error", "-y", "-ss", float(t), "-i", file,
             "-frames:v", "1", "-vf", "scale=1280:-2", image])
        gray = cv2.imread(str(image), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            raise ValueError("frame could not be decoded")
        movement = camera_motion(previous, gray) if previous is not None else None
        frames.append({"t": round(float(t), 6), "image": binding(project, image), "motion": movement,
                       "stable": bool(movement and abs(movement["scale"] - 1) <= .012
                                      and abs(movement["dx"]) <= .012 and abs(movement["dy"]) <= .012)})
        previous = gray
    request_path = folder / "ocr-input.json"
    write_json(request_path, {"language": args.language,
                              "frames": [{"t": row["t"], "file": str(project / row["image"]["file"])} for row in frames]})
    result = json.loads(run([args.powershell, "-NoProfile", "-File", Path(__file__).with_name("screen-ocr-windows.ps1"),
                             "-InputJson", request_path]).decode("utf-8-sig"))
    for frame, recognized in zip(frames, result["frames"], strict=True):
        frame["items"] = recognized["items"]
    report = {"protocol": "visual-multimedia-recording-analysis", "version": 1,
              "source_id": args.source_id, "source": binding(project, file),
              "producer_sha256": digest(Path(__file__)), "duration_seconds": duration,
              "sample_fps": args.fps, "ocr": {"engine": result["engine"], "language": args.language},
              "width": width, "height": height,
              "vocabulary": vocabulary(frames), "frames": frames}
    write_json(args.output, report)
    return {"report": str(args.output), "frames": len(frames), "vocabulary": report["vocabulary"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--powershell", required=True)
    parser.add_argument("--language", default="zh-Hans-CN")
    parser.add_argument("--fps", type=float, default=1)
    print(json.dumps(analyze(parser.parse_args()), ensure_ascii=False))

"""Align a microphone recording of the same speech by one verified constant offset."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.signal import correlate, correlation_lags

from recording_media import source, probe, read_pcm, run, binding, write_json
from media_task_workspace import assert_skill_task_path


def estimate(reference, candidate, rate=16000, maximum_offset=20):
    reference = reference - np.mean(reference)
    candidate = candidate - np.mean(candidate)
    if min(len(reference), len(candidate)) < rate * 2 or min(np.std(reference), np.std(candidate)) < 1e-5:
        raise ValueError("alignment requires at least two seconds of shared audible speech")
    # RMS envelopes survive different microphones; sample-level correlation refines the winner.
    step = rate // 100
    envelope = lambda values: np.sqrt(np.mean(values[:len(values)//step*step].reshape(-1, step)**2, axis=1))
    a, b = envelope(reference), envelope(candidate)
    a -= a.mean(); b -= b.mean()
    values = correlate(b, a, method="fft")
    lags = correlation_lags(len(b), len(a))
    allowed = np.abs(lags) <= maximum_offset * 100
    coarse = int(lags[allowed][np.argmax(values[allowed])]) * step
    candidates = range(coarse - step, coarse + step + 1)
    best = (-1.0, coarse)
    for lag in candidates:
        ai, bi = max(0, -lag), max(0, lag)
        count = min(len(reference)-ai, len(candidate)-bi)
        if count < rate * 2:
            continue
        x, y = reference[ai:ai+count], candidate[bi:bi+count]
        score = abs(float(np.dot(x, y))) / max(1e-12, float(np.linalg.norm(x)*np.linalg.norm(y)))
        if score > best[0]:
            best = score, lag
    if best[0] < .35:
        raise ValueError(f"shared speech correlation too low ({best[0]:.3f}); original audio retained")
    return best[1] / rate, best[0]


def align(args):
    project, original, _ = source(args.project, args.source_id)
    _, voice, _ = source(project, args.voice_source_id)
    offset, score = estimate(read_pcm(args.ffmpeg, original), read_pcm(args.ffmpeg, voice))
    duration = float(probe(args.ffprobe, original)["format"]["duration"])
    output = assert_skill_task_path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    shift = f"atrim=start={offset:.9f},asetpts=PTS-STARTPTS" if offset >= 0 else f"adelay={round(-offset*48000)}S:all=1"
    run([args.ffmpeg, "-v", "error", "-n", "-i", voice, "-vn", "-ac", "1", "-ar", "48000",
         "-af", f"aresample=48000,{shift},apad,atrim=duration={duration:.9f}", "-c:a", "pcm_s16le", output])
    report = {"protocol": "visual-multimedia-recording-audio-alignment", "version": 1,
              "reference_source_id": args.source_id, "voice_source_id": args.voice_source_id,
              "reference": binding(project, original), "voice": binding(project, voice),
              "output": binding(project, output), "duration_seconds": duration,
              "offset_seconds": offset, "correlation": score,
              "model": "constant-offset", "positive_offset": "trim microphone start"}
    write_json(output.with_suffix(".alignment.json"), report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--voice-source-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    print(json.dumps(align(parser.parse_args()), ensure_ascii=False))

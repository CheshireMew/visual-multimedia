#!/usr/bin/env python3
"""Optional instrumental BGM: one score, bounded NumPy windows, no samples or network."""
# Arrangement and timbres adapted from joeseesun/qiaomu-screen2video (MIT).
# Copyright (c) 2026 向阳乔木. Full license: ../THIRD_PARTY_NOTICES.md.
import argparse
import math
from media_task_workspace import assert_skill_task_path
from recording_media import digest, write_json
import json
import wave
from pathlib import Path

import numpy as np

SR = 48000
NOTE = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6,
        'G': 7, 'Ab': 8, 'A': 9, 'Bb': 10, 'B': 11}
# I – V/3 – vi7 – IVmaj7, in scale degrees (semitones from tonic); calm, forward, unobtrusive.
PROGRESSION = [[0, 4, 7, 11], [-5, 2, 7, 11], [-3, 4, 7, 9], [-7, 4, 9, 12]]
BASS = [0, -8, -3, -7]
# Hand-written 8-bar lead over the 4-bar loop: (bar, beat, beats, semitone above tonic, F4 register).
# Phrase A asks (ends open on the 9th), phrase B answers higher and settles; mostly chord tones,
# stepwise, long notes on strong beats so it stays a bed under speech rather than a second voice.
MELODY = [
    (0, 0, 1.5, 12), (0, 1.5, .5, 9), (0, 2, 2, 7),
    (1, 0, 1.5, 7), (1, 1.5, .5, 4), (1, 2, 1, 2), (1, 3, 1, 4),
    (2, 0, 1.5, 9), (2, 1.5, .5, 7), (2, 2, 2, 4),
    (3, 0, 1, 5), (3, 1, 1, 4), (3, 2, 2, 7),
    (4, 0, 1, 12), (4, 1, 1, 14), (4, 2, 1.5, 16), (4, 3.5, .5, 14),
    (5, 0, 2, 14), (5, 2, 1, 11), (5, 3, 1, 7),
    (6, 0, 1.5, 9), (6, 1.5, .5, 12), (6, 2, 2, 9),
    (7, 0, 1, 7), (7, 1, 1, 5), (7, 2, 2, 4),
]
ENDING = [(0, 3, 12)]  # final bar: land on the tonic
PROFILES = {
    'tutorial_focused': dict(bpm=104, drums=1.0, shaker=1.0, motif=1.0),
    'calm_explainer': dict(bpm=92, drums=0.55, shaker=0.6, motif=0.8),
    'fast_demo': dict(bpm=116, drums=1.2, shaker=1.2, motif=1.0),
    'deep_build': dict(bpm=98, drums=0.8, shaker=0.4, motif=0.5),
}


def hz(semi, root):
    return 440.0 * 2 ** ((root + semi - 9) / 12)


def env(n, attack, decay):
    t = np.arange(n) / SR
    a = np.minimum(1.0, t / max(attack, 1e-4))
    return a * np.exp(-t / decay)


def piano(f, dur, vel):
    """Felt-piano-like tone: soft attack, inharmonic-ish partials, fast high decay."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k, amp in [(1, 1.0), (2, 0.38), (3, 0.16), (4, 0.07), (5, 0.03)]:
        fk = f * k * (1 + 0.0004 * k * k)
        out += amp * np.sin(2 * np.pi * fk * t) * np.exp(-t * (1.6 + 1.3 * k))
    return vel * out * np.minimum(1.0, t / 0.008)


def pad(freqs, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for f in freqs:
        for det in (-0.12, 0.0, 0.11):
            ff = f * 2 ** (det / 12)
            out += np.sin(2 * np.pi * ff * t) + 0.18 * np.sin(4 * np.pi * ff * t)
    shape = np.minimum(1.0, t / 0.9) * np.minimum(1.0, (dur - t) / 0.9)
    return out * np.clip(shape, 0, 1) / (len(freqs) * 3)


def kick(rng):
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    f = 46 + 70 * np.exp(-t * 32)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11)


def shaker(rng):
    n = int(0.07 * SR)
    noise = rng.standard_normal(n + 8)
    noise = np.convolve(noise, np.ones(4) / 4, 'same')        # tame the top octave
    noise = np.diff(noise)[:n]                                 # remove lows → soft band-pass
    return noise * env(n, 0.006, 0.016) * 0.18


def rim(rng):
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 820 * t) * np.exp(-t * 60)
    noise = np.diff(np.concatenate([[0], rng.standard_normal(n)])) * np.exp(-t * 45) * 0.3
    return (tone * 0.5 + noise) * 0.5


def add(buf, sig, start, pan=0.0, gain=1.0):
    i = int(start * SR)
    if i >= buf.shape[1]:
        return
    if i < 0:
        sig = sig[-i:]
        i = 0
    sig = sig[: buf.shape[1] - i] * gain
    buf[0, i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    buf[1, i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))


def score(seconds, profile='tutorial_focused', key='F', bpm=None, seed=7):
    """Arrangement as note events (MIDI pitches), shared by every renderer."""
    cfg = PROFILES[profile]
    bpm = bpm or cfg['bpm']
    beat = 60.0 / bpm
    bar = 4 * beat
    base = 60 + NOTE[key]  # semitone 0 == tonic in the F4 register
    rng = np.random.default_rng(seed)
    bars = int(np.ceil(seconds / bar)) + 1
    end_bar = int(seconds // bar)  # final bar rings out, no drums
    ev = []

    def note(kind, t, dur, pitch, vel, pan=0.0):
        ev.append({'kind': kind, 't': round(t, 4), 'dur': round(dur, 4), 'pitch': int(pitch),
                   'vel': round(float(min(1.0, vel)), 3), 'pan': pan})

    for b in range(bars):
        t0 = b * bar
        if t0 >= seconds:
            break
        chord = PROGRESSION[b % 4]
        section = 'intro' if b < 4 else 'outro' if b >= end_bar else 'break' if (b // 8) % 4 == 3 else 'main'
        last = b >= end_bar
        pad_dur = bar + 0.8 if not last else min(bar * 2, seconds - t0 + 2)
        for c in chord:
            note('pad', t0, pad_dur, base + c - 12, 0.5)
        # soft comping: low root + gentle broken chord, not a running arpeggio
        if last:
            for i, c in enumerate(chord[:3]):
                note('piano', t0 + i * 0.03, 4.5, base + c - 12, 0.45, -0.2 + 0.2 * i)
        else:
            for bt, idxs, vel in ((0, (0, 1, 2), 0.42), (1.5, (2,), 0.3), (2.5, (1, 3), 0.32), (3.5, (2,), 0.26)):
                for j, idx in enumerate(idxs):
                    note('piano', t0 + bt * beat + j * 0.012, 1.8, base + chord[idx] - 12,
                         vel * (0.9 + 0.1 * rng.random()), -0.3 + 0.2 * idx)
        if section != 'intro':
            for bt, v in ((0, 0.5), (2, 0.38)) if not last else ((0, 0.5),):
                note('bass', t0 + bt * beat, beat * 2.2, base + BASS[b % 4] - 24, v)
        if section == 'main':
            for bt in (0, 2):
                note('kick', t0 + bt * beat, 0.3, 36, 0.5 * cfg['drums'])
            for bt in (1, 3):
                note('rim', t0 + bt * beat + 0.01, 0.1, 37, 0.3 * cfg['drums'], 0.15)
            for x in range(16):
                note('shaker', t0 + x * beat / 4 + rng.normal(0, 0.003), 0.07, 70,
                     (0.5 if x % 4 == 2 else 0.28) * cfg['shaker'], 0.35)
        elif section == 'break':
            for x in range(8):
                note('shaker', t0 + x * beat / 2, 0.07, 70, 0.3 * cfg['shaker'], 0.35)
        # lead melody: plays 8 bars, rests 8 bars, so it breathes with the narration
        phrase = (b - 4) // 8
        if last:
            for bt, dur, semi in ENDING:
                note('lead', t0 + bt * beat, 4.0, base + semi, 0.5 * cfg['motif'], 0.1)
        elif section in ('main', 'intro') and (b < 4 or phrase % 2 == 0):
            local = (b if b < 4 else b - 4) % 8
            for mb, bt, dur, semi in MELODY:
                if mb == local:
                    note('lead', t0 + bt * beat, max(1.2, dur * beat + 0.6), base + semi,
                         0.5 * cfg['motif'] * (0.92 + 0.08 * rng.random()), 0.1)
    meta = dict(bpm=bpm, key=key, profile=profile, seed=seed, seconds=seconds)
    return ev, meta


def midi_hz(pitch):
    return 440.0 * 2 ** ((pitch - 69) / 12)


GAIN = {'pad': 0.22, 'piano': 0.26, 'bass': 0.45, 'lead': 0.24, 'kick': 0.4, 'rim': 0.4, 'shaker': 1.0}


def render_numpy(events, seconds, seed):
    rng = np.random.default_rng(seed)
    buf = np.zeros((2, int((seconds + 2.0) * SR)))
    k, shakers, r = kick(rng), [shaker(rng) for _ in range(6)], rim(rng)
    pads = {}
    for e in events:  # pads are rendered per chord so the detuned voices stay together
        if e['kind'] == 'pad':
            pads.setdefault((e['t'], e['dur']), []).append(midi_hz(e['pitch']))
    for (t, dur), freqs in pads.items():
        add(buf, pad(freqs, dur), t, 0.0, GAIN['pad'])
    for n, e in enumerate(events):
        n = e.get('_index', n)
        kind = e['kind']
        if kind == 'pad':
            continue
        if kind in ('piano', 'lead'):
            sig = piano(midi_hz(e['pitch']), e['dur'], e['vel'])
        elif kind == 'bass':
            sig = piano(midi_hz(e['pitch']), e['dur'], 1.0) * 0.9 * e['vel'] / 0.5
        elif kind == 'kick':
            sig = k * e['vel']
        elif kind == 'rim':
            sig = r * e['vel']
        else:
            sig = shakers[n % len(shakers)] * e['vel']
        add(buf, sig, e['t'], e['pan'], GAIN[kind])
    return buf



def produce(args):
    seconds = args.seconds
    if not math.isfinite(seconds) or seconds <= 0 or (args.bpm is not None and not 40 <= args.bpm <= 180):
        raise ValueError("duration must be positive; BPM must be in [40, 180]")
    output = assert_skill_task_path(args.output)
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    events, meta = score(seconds, args.profile, args.key, args.bpm, args.seed)
    events = [dict(event, _index=index) for index, event in enumerate(events)]
    raw_path = output.with_suffix(".pcm.f32")
    power, samples = 0.0, 0
    # Bound RAM by rendering 20-second windows; notes crossing a boundary retain their onset.
    with raw_path.open("xb") as raw:
        for start in np.arange(0, seconds, 20):
            end = min(seconds, start + 20)
            pre = min(8.0, float(start))
            local = [dict(event, t=event["t"]-start+pre) for event in events
                     if event["t"] < end+2 and event["t"]+event["dur"] > start-pre]
            buf = render_numpy(local, end-start+pre, args.seed)
            block = buf[:, round(pre*SR):round((end-start+pre)*SR)].T
            times = np.arange(len(block))/SR + start
            fade = min(2.5, seconds/4)
            block *= np.minimum(1, np.maximum(0, (seconds-times)/fade))[:, None]**1.5
            block *= np.minimum(1, times/.1)[:, None]
            power += float(np.sum(block**2)); samples += block.size
            raw.write(block.astype("<f4").tobytes())
    gain = .12 / max(1e-9, np.sqrt(power / samples))
    with raw_path.open("rb") as raw, wave.open(str(output), "wb") as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(SR)
        while True:
            block = raw.read(48000*2*4)
            if not block:
                break
            audio = np.frombuffer(block, dtype="<f4").astype("float64") * gain
            audio = np.tanh(audio*1.1)/np.tanh(1.1)
            wav.writeframes((np.clip(audio, -.89, .89)*32767).astype("<i2").tobytes())
    meta.update(protocol="visual-multimedia-code-music", version=1, provider="code-synth",
                engine="numpy", samples=False, output=str(output), output_sha256=digest(output),
                producer_sha256=digest(Path(__file__)), events=len(events), sample_rate=SR,
                channels=2, intermediate=str(raw_path))
    write_json(output.with_suffix(".music.json"), meta)
    return meta


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate optional instrumental BGM locally; no samples or network.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--profile", choices=sorted(PROFILES), default="tutorial_focused")
    parser.add_argument("--key", choices=sorted(NOTE), default="F")
    parser.add_argument("--bpm", type=float)
    parser.add_argument("--seed", type=int, default=7)
    print(json.dumps(produce(parser.parse_args()), ensure_ascii=False))


#!/usr/bin/env python3
"""Render a looping underwater ambient piece — pads + soft melody, no noise bed."""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

SR = 44100
BPM = 56
BEAT = 60.0 / BPM
BARS = 16
BEATS_PER_BAR = 4
DURATION = BARS * BEATS_PER_BAR * BEAT  # ~68.6s
N = int(SR * DURATION)


def midi(n: float) -> float:
    return 440.0 * (2.0 ** ((n - 69.0) / 12.0))


def env_adsr(t: float, dur: float, a=2.4, d=1.8, s=0.72, r=3.2) -> float:
    if t < 0 or t > dur:
        return 0.0
    if t < a:
        return t / a
    if t < a + d:
        return 1.0 - (1.0 - s) * ((t - a) / d)
    if t > dur - r:
        return s * max(0.0, (dur - t) / r)
    return s


def soft_pad(freq: float, t: float, phase: float) -> float:
    # Warm sine stack — no square/saw grit
    w = 2 * math.pi * freq * t + phase
    return (
        math.sin(w)
        + 0.38 * math.sin(2 * w + 0.15)
        + 0.14 * math.sin(3 * w + 0.4)
        + 0.06 * math.sin(4 * w)
    ) / 1.58


# Dmaj9  Gmaj7  Bm11  Aadd9   (root midi)
CHORDS = [
    [50, 54, 57, 61, 64],  # D3 F# A C# E
    [55, 59, 62, 66],  # G3 B D F#
    [47, 50, 54, 57, 61],  # B2 D F# A C#
    [57, 61, 64, 69],  # A3 C# E A
]

# Quiet pentatonic bells over D
MELODY = [
    # (beat_index, midi, beats)
    (0, 78, 2.0),
    (4, 76, 2.0),
    (8, 81, 3.0),
    (16, 74, 2.0),
    (20, 76, 2.0),
    (24, 73, 4.0),
    (32, 81, 2.0),
    (36, 78, 2.0),
    (40, 76, 2.0),
    (44, 74, 2.0),
    (48, 73, 4.0),
    (54, 69, 4.0),
    (60, 71, 4.0),
]


def render() -> list[tuple[float, float]]:
    left = [0.0] * N
    right = [0.0] * N
    chord_beats = 4 * 4  # 4 bars each
    chord_dur = chord_beats * BEAT
    overlap = 4.2

    # Pads — overlapping voices so changes crossfade instead of dropping out
    for i in range(N):
        t = i / SR
        sl = 0.0
        sr = 0.0
        for ci, notes in enumerate(CHORDS):
            # each chord repeats every full cycle
            cycle = len(CHORDS) * chord_dur
            start = ci * chord_dur
            # also the wrapped instance from previous loop for seamless loop
            for origin in (start, start - cycle, start + cycle):
                local = t - origin
                if local < -0.01 or local > chord_dur + overlap:
                    continue
                e = env_adsr(local, chord_dur + overlap * 0.35, a=3.2, d=2.4, s=0.74, r=4.5)
                if e <= 0:
                    continue
                for k, m in enumerate(notes):
                    f = midi(m)
                    det = 1.0 + 0.0016 * math.sin(0.06 * t + k + ci)
                    v = soft_pad(f * det, t, k * 0.7 + ci) * e
                    pan = (k / max(1, len(notes) - 1)) * 0.5 + 0.25
                    sl += v * (1.0 - pan)
                    sr += v * pan
        left[i] += sl * 0.16
        right[i] += sr * 0.16

    # Soft bells
    for start_beat, note, length in MELODY:
        start = int(start_beat * BEAT * SR)
        length_s = length * BEAT
        samples = int(length_s * SR)
        f = midi(note)
        for j in range(samples):
            idx = start + j
            if idx >= N:
                break
            t = j / SR
            e = math.exp(-t * 1.6) * (1.0 - math.exp(-t * 28.0))
            w = 2 * math.pi * f * t
            s = (math.sin(w) + 0.22 * math.sin(2 * w)) * e * 0.055
            # light ping-pong
            if (start_beat // 4) % 2 == 0:
                left[idx] += s * 0.75
                right[idx] += s * 0.35
            else:
                left[idx] += s * 0.35
                right[idx] += s * 0.75

    # Gentle swell LFO on master (not a filter sweep)
    out: list[tuple[float, float]] = []
    peak = 1e-9
    for i in range(N):
        t = i / SR
        g = 0.88 + 0.12 * math.sin(2 * math.pi * t / DURATION)
        # fade ends for seamless loop
        fade = 1.0
        edge = 1.6
        if t < edge:
            fade = t / edge
        elif t > DURATION - edge:
            fade = (DURATION - t) / edge
        l = left[i] * g * fade
        r = right[i] * g * fade
        peak = max(peak, abs(l), abs(r))
        out.append((l, r))

    norm = 0.72 / peak
    return [(l * norm, r * norm) for l, r in out]


def write_wav(path: Path, frames: list[tuple[float, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        buf = bytearray()
        for l, r in frames:
            ls = max(-1.0, min(1.0, l))
            rs = max(-1.0, min(1.0, r))
            buf += struct.pack("<hh", int(ls * 32767), int(rs * 32767))
        w.writeframes(bytes(buf))


def main() -> None:
    frames = render()
    wav = Path("/workspace/public/audio/reef-ambient.wav")
    write_wav(wav, frames)
    print(f"wrote {wav}  duration={DURATION:.2f}s  samples={len(frames)}")


if __name__ == "__main__":
    main()

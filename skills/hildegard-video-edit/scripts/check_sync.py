#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Check procedural video sync, non-hold frame liveness, log-space zoom bounds, and cyclic camera seams.

  python3 -B check_sync.py --video FILE.mp4 [--beats BEATS.json] [--tol-ms 45]
                           [--hold-tail 1.0] [--min-liveness 0.55] [--json]
  python3 -B check_sync.py --camera CAMERA.json [--json]

Needs Python 3 (stdlib only for --camera; ffmpeg + ffprobe on PATH for --video).
"""

import argparse
import json
import math
import re
import shutil
import subprocess
import sys

FFMPEG = shutil.which("ffmpeg")
SAMPLE_FPS, W, H = 20, 32, 18


def _chk(cid, ok, value, limit, detail):
    return {"id": cid, "ok": bool(ok), "value": value, "limit": limit, "detail": detail}


def _thumbnails(video_path):
    r = subprocess.run(
        [FFMPEG, "-v", "error", "-i", video_path, "-an", "-vf", f"fps={SAMPLE_FPS},scale={W}:{H}:flags=area,format=rgb24", "-f", "rawvideo", "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg could not read frames from {video_path}")
    sz = W * H * 3
    return [r.stdout[i : i + sz] for i in range(0, len(r.stdout) - sz + 1, sz)]


def _speech_onsets(video_path):
    """Fallback beat/word onsets from FFmpeg silencedetect when no transcript timestamps exist."""
    r = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", video_path, "-vn", "-af", "silencedetect=noise=-35dB:d=0.2", "-f", "null", "-"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", r.stderr)]


def check_video_sync(video_path, beats_path=None, tol_ms=45.0, hold_tail=1.0, min_liveness=0.55):
    if not FFMPEG:
        raise RuntimeError("ffmpeg must be on PATH")
    frames = _thumbnails(video_path)
    if len(frames) < 4:
        raise RuntimeError(f"{video_path}: too few frames ({len(frames)})")
    steps = [
        sum(abs(a - b) for a, b in zip(frames[i - 1], frames[i])) / (len(frames[i]) * 255.0)
        for i in range(1, len(frames))
    ]
    # Non-hold window excludes closing hold_tail seconds
    active_end = max(1, len(steps) - int(round(hold_tail * SAMPLE_FPS)))
    active_steps = steps[:active_end]
    live_count = sum(1 for s in active_steps if s >= 0.0025)
    liveness = live_count / max(1, len(active_steps))

    checks = [
        _chk("frame_liveness", liveness >= min_liveness, round(liveness, 3), f">= {min_liveness}", "non-hold frames show real motion (not dead/frozen)"),
    ]

    # Visual event times (frame jumps above local median)
    events = []
    for i, s in enumerate(steps):
        lo, hi = max(0, i - 6), min(len(steps), i + 7)
        med = sorted(steps[lo:hi])[len(steps[lo:hi]) // 2]
        if s >= 0.05 and s >= 2.2 * max(med, 0.01):
            events.append((i + 1) / float(SAMPLE_FPS))

    if beats_path:
        beats_doc = json.load(open(beats_path, encoding="utf-8"))
        beats = [float(b["t"] if isinstance(b, dict) else b) for b in (beats_doc.get("beats", beats_doc) if isinstance(beats_doc, dict) else beats_doc)]
        if not beats:
            beats = _speech_onsets(video_path)
        if beats:
            errs_ms = [min((abs(b - e) for e in events), default=999.0) * 1000.0 for b in beats]
            worst = max(errs_ms)
            checks.append(_chk("beat_sync", worst <= tol_ms, round(worst, 1), f"<= {tol_ms} ms", "visual transitions align with word/beat cues"))

    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "liveness": round(liveness, 3), "visual_events_s": [round(e, 3) for e in events], "checks": checks}


def check_camera_spec(spec):
    checks = []
    # 1. Deterministic seed + contact-sheet frame count
    seed = spec.get("seed")
    checks.append(_chk("deterministic_seed", isinstance(seed, int), seed, "integer seed", "per-part procedural drawing requires explicit seed"))
    sheet_n = int(spec.get("contact_sheet_frames", 8))
    checks.append(_chk("contact_sheet_frames", 8 <= sheet_n <= 16, sheet_n, "8..16 frames", "pre-render visual verification sheet"))

    # 2. Log-space zoom uniformity & clamped frame bounds
    if "zoom" in spec:
        z = spec["zoom"]
        s0, s1 = float(z["start_scale"]), float(z["end_scale"])
        samples = [float(x) for x in z.get("samples", [])]
        if len(samples) >= 3 and s0 > 0 and s1 > 0:
            logs = [math.log(max(1e-9, x)) for x in samples]
            diffs = [logs[i + 1] - logs[i] for i in range(len(logs) - 1)]
            spread = max(diffs) - min(diffs)
            checks.append(_chk("log_space_zoom", spread < 1e-3, round(spread, 6), "< 1e-3", "zoom interpolates in log(scale) space for constant apparent speed"))
        # Bounds check: viewport at scale s with pan (px, py) stays inside [0, src_w] x [0, src_h]
        if "pan_x" in z and "pan_y" in z and "max_pan_x" in z and "max_pan_y" in z:
            in_bounds = abs(float(z["pan_x"])) <= float(z["max_pan_x"]) + 1e-6 and abs(float(z["pan_y"])) <= float(z["max_pan_y"]) + 1e-6
            checks.append(_chk("camera_bounds", in_bounds, [z["pan_x"], z["pan_y"]], f"<= [{z['max_pan_x']}, {z['max_pan_y']}]", "clamped camera never leaks past photo edge"))
        if "mipmap_levels" in z:
            ml = int(z["mipmap_levels"])
            checks.append(_chk("mipmap_levels", ml >= 4, ml, ">= 4", "area-filtered mipmap chain prevents zoom shimmer"))

    # 3. Cyclic camera-shake seam continuity (integer harmonic frequencies over loop period T)
    if "shake" in spec:
        sh = spec["shake"]
        period = float(sh.get("period_s", 1.0))
        freqs = [float(f) for f in sh.get("freqs_hz", [])]
        # Every frequency f must satisfy f * period == integer (within 1e-4) for exact cyclic loop seam
        seam_err = max((abs(f * period - round(f * period)) for f in freqs), default=0.0)
        checks.append(_chk("cyclic_shake_seam", bool(freqs) and seam_err < 1e-4, round(seam_err, 6), "< 1e-4", "cyclic shake frequencies are integer multiples of 1/period"))

    # 4. Beat-to-frame absolute math check (round(t * fps), zero cumulative drift)
    if "beats" in spec:
        fps = float(spec.get("fps", 30.0))
        max_frame_err = 0.0
        for b in spec["beats"]:
            want_f = round(float(b["t"]) * fps)
            got_f = int(b["frame"])
            max_frame_err = max(max_frame_err, abs(want_f - got_f))
        checks.append(_chk("beat_frame_math", max_frame_err == 0, int(max_frame_err), 0, "frames computed from round(t * fps) without cumulative drift"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video")
    ap.add_argument("--beats")
    ap.add_argument("--camera")
    ap.add_argument("--tol-ms", type=float, default=45.0)
    ap.add_argument("--hold-tail", type=float, default=1.0)
    ap.add_argument("--min-liveness", type=float, default=0.55)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if not (a.video or a.camera):
        ap.error("provide --video FILE.mp4 or --camera CAMERA.json")
    if a.camera:
        res = check_camera_spec(json.load(open(a.camera, encoding="utf-8")))
    else:
        res = check_video_sync(a.video, beats_path=a.beats, tol_ms=a.tol_ms, hold_tail=a.hold_tail, min_liveness=a.min_liveness)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

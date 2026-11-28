#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Check procedural video sync, freeze-free liveness, post-AAC loudness, and motion/timing/framing/seam contracts.

  python3 -B check_sync.py --video FILE.mp4 [--beats BEATS.json] [--tol-ms 45]
                           [--hold-tail 1.0] [--min-liveness 0.55]
                           [--max-freeze 0.5] [--post-aac-lufs -14] [--post-aac-peak -2.0] [--json]
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
SAMPLE_FPS, W, H = 60, 32, 18  # 16.7 ms step, well below default 45 ms beat tolerance
LIVENESS_STRIDE = 6  # 10 Hz liveness sampling (100 ms intervals)

KNOWN_CAMERA_KEYS = {
    "seed",
    "contact_sheet_frames",
    "fps",
    "zoom",
    "shake",
    "beats",
    "motion",
    "timing",
    "framing",
    "seams",
}
BEZIER_RE = re.compile(
    r"^cubic-bezier\(\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,"
    r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\)$"
)
FEEL_DAMPING = {"dead_still": 1.0, "single_bounce": 0.8, "playful": 0.5}
DIR_SIGN = {
    "left": -1,
    "right": 1,
    "up": -1,
    "down": 1,
    "push": 1,
    "pull": -1,
    "+1": 1,
    "-1": -1,
    "1": 1,
}


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


def _detect_freezes(video_path, max_freeze_s, active_cutoff_s):
    """Run FFmpeg freezedetect and return unintended freeze intervals starting before active_cutoff_s."""
    r = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", video_path, "-an", "-vf", f"freezedetect=n=-60dB:d={max_freeze_s}", "-f", "null", "-"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg freezedetect failed on {video_path}")
    starts = [float(m) for m in re.findall(r"freeze_start:\s*([\d.]+)", r.stderr)]
    durs = [float(m) for m in re.findall(r"freeze_duration:\s*([\d.]+)", r.stderr)]
    unintended = []
    for idx, st in enumerate(starts):
        dur = durs[idx] if idx < len(durs) else max(0.0, active_cutoff_s - st)
        if st < active_cutoff_s - 0.05:
            unintended.append({"start_s": round(st, 3), "duration_s": round(dur, 3)})
    return unintended


def _measure_post_aac_loudness(video_path):
    """Measure integrated LUFS and true peak (dBTP) directly on the encoded file via FFmpeg ebur128."""
    r = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", video_path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if r.returncode != 0:
        return None, None
    i_matches = re.findall(r"^\s*I:\s*([+-]?[\d.]+)\s*LUFS", r.stderr, re.M)
    p_matches = re.findall(r"^\s*Peak:\s*([+-]?[\d.]+)\s*dBFS", r.stderr, re.M)
    lufs = float(i_matches[-1]) if i_matches else None
    peak = float(p_matches[-1]) if p_matches else None
    return lufs, peak


def check_video_sync(
    video_path,
    beats_path=None,
    tol_ms=45.0,
    hold_tail=1.0,
    min_liveness=0.55,
    max_freeze=None,
    post_aac_lufs=None,
    post_aac_peak=None,
):
    if not FFMPEG:
        raise RuntimeError("ffmpeg must be on PATH")
    frames = _thumbnails(video_path)
    if len(frames) < 4:
        raise RuntimeError(f"{video_path}: too few frames ({len(frames)})")
    duration_s = len(frames) / float(SAMPLE_FPS)
    steps = [
        sum(abs(a - b) for a, b in zip(frames[i - 1], frames[i])) / (len(frames[i]) * 255.0)
        for i in range(1, len(frames))
    ]

    # Non-hold frame liveness at 10 Hz: detects either global motion (mean >= 0.0025) or localized motion (max channel diff >= 3/255)
    l_frames = frames[::LIVENESS_STRIDE]
    l_fps = SAMPLE_FPS / float(LIVENESS_STRIDE)
    active_end = max(1, (len(l_frames) - 1) - int(round(hold_tail * l_fps)))
    live_count = 0
    sec_buckets = {}
    for i in range(1, len(l_frames)):
        prev_f, cur_f = l_frames[i - 1], l_frames[i]
        diffs = [abs(a - b) for a, b in zip(prev_f, cur_f)]
        mean_d = sum(diffs) / (len(cur_f) * 255.0)
        max_d = max(diffs) / 255.0 if diffs else 0.0
        sec = int((i - 1) / l_fps)
        sec_buckets.setdefault(sec, []).append(mean_d)
        if i <= active_end and (mean_d >= 0.0025 or max_d >= 3.0 / 255.0):
            live_count += 1
    liveness = live_count / max(1, active_end)
    per_second_energy = {str(s): round(sum(v) / len(v), 5) for s, v in sorted(sec_buckets.items())}

    checks = [
        _chk("frame_liveness", liveness >= min_liveness, round(liveness, 3), f">= {min_liveness}", "non-hold frames show real motion (not dead/frozen)"),
    ]

    if max_freeze is not None:
        if not math.isfinite(max_freeze) or max_freeze <= 0.0:
            checks.append(_chk("unintended_freezes", False, max_freeze, "> 0 s", "max_freeze threshold must be positive"))
        else:
            active_cutoff = max(0.0, duration_s - max(0.0, hold_tail))
            freezes = _detect_freezes(video_path, max_freeze, active_cutoff)
            checks.append(
                _chk(
                    "unintended_freezes",
                    len(freezes) == 0,
                    freezes if freezes else "none",
                    f"0 freezes >= {max_freeze} s",
                    "ffmpeg freezedetect finds no unintended frozen spans before hold tail",
                )
            )

    if post_aac_lufs is not None or post_aac_peak is not None:
        lufs_val, peak_val = _measure_post_aac_loudness(video_path)
        if post_aac_lufs is not None:
            ok_lufs = lufs_val is not None and abs(lufs_val - post_aac_lufs) <= 2.0
            checks.append(
                _chk(
                    "post_aac_lufs",
                    ok_lufs,
                    round(lufs_val, 2) if lufs_val is not None else None,
                    f"{post_aac_lufs} +/- 2.0 LUFS",
                    "integrated loudness measured after AAC encode",
                )
            )
        if post_aac_peak is not None:
            ok_peak = peak_val is not None and peak_val <= post_aac_peak + 0.05
            checks.append(
                _chk(
                    "post_aac_peak",
                    ok_peak,
                    round(peak_val, 2) if peak_val is not None else None,
                    f"<= {post_aac_peak} dBTP",
                    "true peak measured after AAC encode",
                )
            )

    # Visual event times at 60 Hz with interval midpoint timestamps (i + 0.5) / SAMPLE_FPS
    events = []
    win = 18  # +/- 0.3 s at 60 Hz
    for i, s in enumerate(steps):
        lo, hi = max(0, i - win), min(len(steps), i + win + 1)
        med = sorted(steps[lo:hi])[len(steps[lo:hi]) // 2]
        if s >= 0.05 and s >= 2.2 * max(med, 0.01):
            events.append((i + 0.5) / float(SAMPLE_FPS))

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
    return {
        "ok": ok,
        "liveness": round(liveness, 3),
        "per_second_energy": per_second_energy,
        "visual_events_s": [round(e, 3) for e in events],
        "checks": checks,
    }


def _valid_bezier(text):
    if not isinstance(text, str):
        return False
    m = BEZIER_RE.match(text.strip())
    if not m:
        return False
    x1, _, x2, _ = (float(g) for g in m.groups())
    return 0.0 <= x1 <= 1.0 and 0.0 <= x2 <= 1.0


def _dir_sign(val):
    if isinstance(val, (int, float)) and not isinstance(val, bool) and val in (-1, 1):
        return int(val)
    if isinstance(val, str):
        return DIR_SIGN.get(val.strip().lower())
    return None


def _check_motion_block(m):
    if not isinstance(m, dict) or not m:
        return [_chk("motion_config", False, m, "non-empty object", "motion block must declare closed_form and numeric spring/easing rules")]
    checks = []
    checks.append(_chk("closed_form_motion", m.get("closed_form") is True, m.get("closed_form"), True, "pure closed-form renderAt(t) with zero carried velocity state"))
    if "damping_ratio" in m:
        try:
            dr = float(m["damping_ratio"])
        except (TypeError, ValueError):
            dr = float("nan")
        dr_ok = math.isfinite(dr) and (0.4 <= dr <= 1.2)
        feel = m.get("feel")
        if dr_ok and isinstance(feel, str) and feel.strip().lower() in FEEL_DAMPING:
            want = FEEL_DAMPING[feel.strip().lower()]
            dr_ok = abs(dr - want) <= 0.05
        checks.append(_chk("spring_damping_ratio", dr_ok, dr if math.isfinite(dr) else str(dr), "0.5 (playful) / 0.8 (single_bounce) / 1.0 (dead_still)", "numeric damping ratio replaces vague adjectives"))
    if "ease_in" in m:
        checks.append(_chk("ease_in_curve", _valid_bezier(m["ease_in"]), m["ease_in"], "cubic-bezier(x1,y1,x2,y2)", "numeric entrance cubic-bezier curve"))
    if "ease_out" in m:
        checks.append(_chk("ease_out_curve", _valid_bezier(m["ease_out"]), m["ease_out"], "cubic-bezier(x1,y1,x2,y2)", "numeric exit cubic-bezier curve"))
    if "ease_in_ms" in m and "ease_out_ms" in m:
        try:
            ein, eout = float(m["ease_in_ms"]), float(m["ease_out_ms"])
        except (TypeError, ValueError):
            ein, eout = -1.0, -1.0
        ratio_ok = math.isfinite(ein) and math.isfinite(eout) and ein > 0.0 and (0.35 * ein <= eout <= 0.65 * ein)
        checks.append(_chk("exit_shorter_than_entry", ratio_ok, [ein, eout], "exit 40-50% shorter than entry (0.35..0.65x)", "exit duration is shorter than entrance"))
    return checks


def _check_timing_block(t):
    if not isinstance(t, dict) or not t:
        return [_chk("timing_config", False, t, "non-empty object", "timing block must declare fps, bpm, and/or events/loop bounds")]
    checks = []
    if "fps" in t and "bpm" in t:
        try:
            fps, bpm = float(t["fps"]), float(t["bpm"])
        except (TypeError, ValueError):
            fps, bpm = 0.0, 0.0
        valid_clock = math.isfinite(fps) and math.isfinite(bpm) and fps > 0.0 and bpm > 0.0
        if "frames_per_beat" in t:
            try:
                fpb = float(t["frames_per_beat"])
            except (TypeError, ValueError):
                fpb = float("nan")
            expected = (fps * 60.0 / bpm) if valid_clock else float("nan")
            fpb_ok = valid_clock and math.isfinite(fpb) and abs(fpb - expected) <= 1e-3
            checks.append(_chk("frames_per_beat", fpb_ok, fpb if math.isfinite(fpb) else str(fpb), round(expected, 4) if valid_clock else "> 0", "frames_per_beat == fps * 60 / bpm"))
        else:
            checks.append(_chk("timing_clock", valid_clock, [fps, bpm], "fps > 0 and bpm > 0", "positive master clock fps and bpm"))
    if "events" in t:
        evs = t["events"]
        if not isinstance(evs, list) or not evs:
            checks.append(_chk("audio_lag_1f", False, evs, "non-empty events list", "master timing events required"))
        else:
            bad_ev = []
            for idx, ev in enumerate(evs):
                if not isinstance(ev, dict) or "visual_frame" not in ev or "audio_frame" not in ev:
                    bad_ev.append(idx)
                    continue
                vf, af = ev["visual_frame"], ev["audio_frame"]
                if not (isinstance(vf, int) and not isinstance(vf, bool) and isinstance(af, int) and not isinstance(af, bool)):
                    bad_ev.append(idx)
                elif vf < 0 or af != vf + 1:
                    bad_ev.append(idx)
            checks.append(_chk("audio_lag_1f", not bad_ev, bad_ev or "all +1f", "audio_frame == visual_frame + 1", "audio hits land 1 frame after visual events"))
    if t.get("seamless_loop") is True:
        tf = t.get("total_frames")
        lf = t.get("last_frame")
        loop_ok = (
            isinstance(tf, int)
            and not isinstance(tf, bool)
            and isinstance(lf, int)
            and not isinstance(lf, bool)
            and tf >= 2
            and lf == tf - 1
        )
        checks.append(_chk("seamless_loop_bounds", loop_ok, [lf, tf], "last_frame == total_frames - 1 (0..N-1)", "seamless loop renders frames 0..N-1 without duplicate end frame"))
    if not checks:
        checks.append(_chk("timing_config", False, t, "fps/bpm, events, or seamless_loop", "timing block contained no verifiable timing fields"))
    return checks


def _check_framing_block(fr):
    if not isinstance(fr, dict) or not fr:
        return [_chk("framing_config", False, fr, "non-empty object", "framing block must declare shots and/or separate_planes")]
    checks = []
    if "shots" in fr:
        shots = fr["shots"]
        if not isinstance(shots, list) or not shots:
            checks.append(_chk("hero_min_width_px", False, shots, "non-empty shots list", "measure hero pixel width per shot before full render"))
        else:
            too_small = []
            for idx, sh in enumerate(shots):
                if not isinstance(sh, dict):
                    too_small.append(f"shot[{idx}]:invalid")
                    continue
                kind = str(sh.get("kind", "main")).strip().lower()
                fh = float(sh.get("frame_height", 1080.0))
                hw = float(sh.get("hero_width_px", 0.0))
                if not (math.isfinite(fh) and fh > 0.0 and math.isfinite(hw)):
                    too_small.append(f"shot[{idx}]:non-finite")
                    continue
                floor_px = (95.0 if kind == "wide" else 170.0) * (fh / 1080.0)
                if hw < floor_px - 1e-6:
                    too_small.append(f"shot[{idx}]({kind}):{round(hw, 1)}<{round(floor_px, 1)}px")
            checks.append(_chk("hero_min_width_px", not too_small, too_small or "all >= floor", ">= 170 px main / >= 95 px wide at 1080p", "hero stays readable at phone size on every shot"))
    if "separate_planes" in fr:
        checks.append(_chk("separate_planes", fr["separate_planes"] is True, fr["separate_planes"], True, "clipping designed out via separate geometric planes"))
    if not checks:
        checks.append(_chk("framing_config", False, fr, "shots or separate_planes", "framing block contained no verifiable fields"))
    return checks


def _check_seams_block(sm):
    if not isinstance(sm, dict) or not sm:
        return [_chk("seams_config", False, sm, "non-empty object", "seams block must declare stage_bg_opaque and transitions")]
    checks = []
    checks.append(_chk("opaque_stage_ground", sm.get("stage_bg_opaque") is True, sm.get("stage_bg_opaque"), True, "opaque stage background prevents white flash at seam opacity dips"))
    trans = sm.get("transitions")
    if not isinstance(trans, list) or not trans:
        checks.append(_chk("seam_vector_law", False, trans, "non-empty transitions list", "vector ledger transitions required"))
    else:
        bad_vec = []
        bad_phase = []
        ping_pong = []
        prev_axis, prev_sign = None, None
        for idx, row in enumerate(trans):
            if not isinstance(row, dict):
                bad_vec.append(idx)
                continue
            axis = str(row.get("axis", "")).strip().lower()
            s_out = _dir_sign(row.get("exit_dir"))
            s_in = _dir_sign(row.get("entry_dir"))
            if axis not in ("x", "y", "z") or s_out is None or s_in is None or s_out != s_in:
                bad_vec.append(idx)
            if row.get("cut_mid_motion") is not True:
                bad_phase.append(idx)
            if prev_axis == axis and prev_sign is not None and s_out is not None and s_out == -prev_sign:
                if not (isinstance(row.get("cause"), str) and row["cause"].strip()):
                    ping_pong.append(idx)
            prev_axis, prev_sign = axis, s_out
        checks.append(_chk("seam_vector_law", not bad_vec, bad_vec or "matched", "same axis and direction sign (incl. Z push/pull)", "exit and entry vectors match across every cut"))
        checks.append(_chk("seam_mid_motion", not bad_phase, bad_phase or "all mid-motion", "cut_mid_motion == true", "cuts land mid-motion on both sides"))
        checks.append(_chk("no_uncaused_ping_pong", not ping_pong, ping_pong or "none", "no opposing consecutive cuts without cause", "direction flips require an explicit visible cause"))
    return checks


def check_camera_spec(spec):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "camera spec must be a JSON object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - KNOWN_CAMERA_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized top-level keys: {', '.join(unknown)}"))

    # 1. Deterministic seed + contact-sheet frame count
    seed = spec.get("seed")
    checks.append(_chk("deterministic_seed", isinstance(seed, int) and not isinstance(seed, bool), seed, "integer seed", "per-part procedural drawing requires explicit seed"))
    sheet_n = int(spec.get("contact_sheet_frames", 8))
    checks.append(_chk("contact_sheet_frames", 8 <= sheet_n <= 16, sheet_n, "8..16 frames", "pre-render visual verification sheet"))

    # 2. Log-space zoom uniformity & clamped frame bounds
    if "zoom" in spec:
        z = spec["zoom"]
        if any(k in z for k in ("start_scale", "end_scale", "samples")):
            s0 = float(z["start_scale"]) if "start_scale" in z else None
            s1 = float(z["end_scale"]) if "end_scale" in z else None
            samples = [float(x) for x in z.get("samples", [])]
            if s0 is None or s1 is None or not (math.isfinite(s0) and math.isfinite(s1)) or s0 <= 0.0 or s1 <= 0.0:
                checks.append(_chk("log_space_zoom", False, [s0, s1], "start_scale > 0 and end_scale > 0", "positive finite start_scale and end_scale required"))
            elif len(samples) < 3 or any((not math.isfinite(x)) or x <= 0.0 for x in samples):
                checks.append(_chk("log_space_zoom", False, samples, ">= 3 positive samples", "at least 3 positive zoom samples required"))
            else:
                n_steps = len(samples) - 1
                max_err = max(
                    abs(math.log(samples[i]) - math.log(s0 * ((s1 / s0) ** (i / float(n_steps)))))
                    for i in range(len(samples))
                )
                checks.append(_chk("log_space_zoom", max_err < 1e-3, round(max_err, 6), "< 1e-3", "zoom samples match log-space curve from start_scale to end_scale"))
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

    # 5. Optional Motion QA / timing / framing / seam contracts
    if "motion" in spec:
        checks.extend(_check_motion_block(spec["motion"]))
    if "timing" in spec:
        checks.extend(_check_timing_block(spec["timing"]))
    if "framing" in spec:
        checks.extend(_check_framing_block(spec["framing"]))
    if "seams" in spec:
        checks.extend(_check_seams_block(spec["seams"]))

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
    ap.add_argument("--max-freeze", type=float, default=None)
    ap.add_argument("--post-aac-lufs", type=float, default=None)
    ap.add_argument("--post-aac-peak", type=float, default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if not (a.video or a.camera):
        ap.error("provide --video FILE.mp4 or --camera CAMERA.json")
    if a.camera:
        res = check_camera_spec(json.load(open(a.camera, encoding="utf-8")))
    else:
        res = check_video_sync(
            a.video,
            beats_path=a.beats,
            tol_ms=a.tol_ms,
            hold_tail=a.hold_tail,
            min_liveness=a.min_liveness,
            max_freeze=a.max_freeze,
            post_aac_lufs=a.post_aac_lufs,
            post_aac_peak=a.post_aac_peak,
        )
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

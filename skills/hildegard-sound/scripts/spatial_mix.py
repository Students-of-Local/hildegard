#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Render and verify listener-relative 3D spatial mixes and frame-clocked demo audio.

  python3 -B spatial_mix.py SPEC.json OUT.wav [--lufs -16] [--peak -1.0] [--json]
  python3 -B spatial_mix.py --check FILE.wav [--spec SPEC.json] [--lufs -16] [--peak -1.0] [--json]

Pure Python 3 + NumPy (optional ffmpeg/ffprobe for EBU R128 loudness normalization and checks).
Right-handed metre coordinates: +X right, +Y up, -Z forward.
Analytical spherical-head Woodworth ITD (band-split <= 700 Hz for broadband mono safety) +
head-shadow ILD + inverse-distance attenuation + HF air absorption + obstruction low-pass +
radial Doppler + camera-cut <= 8 ms continuity crossfade + focus-preserving stereo/phone-band
(300-3400 Hz) margin + locked stereo/mono stems + quiet-window protection.
"""

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave

try:
    import numpy as np
except ImportError:
    _msg = "numpy is not installed and spatial_mix.py needs numpy. Install with: python3 -m pip install numpy"
    print(json.dumps({"ok": False, "error": _msg}))
    print(_msg, file=sys.stderr)
    sys.exit(1)

FFMPEG = shutil.which("ffmpeg")
HEAD_RADIUS_M = 0.0875  # Woodworth spherical head radius (m)
SPEED_OF_SOUND = 343.0  # m/s in air at 20 C


def _norm(v):
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else np.array([0.0, 0.0, -1.0], dtype=np.float64)


def _one_pole_lp(x, cutoff_hz, sr):
    if cutoff_hz >= 0.45 * sr or len(x) == 0:
        return x.copy()
    fc = max(60.0, min(float(cutoff_hz), 0.45 * sr))
    a = math.exp(-2.0 * math.pi * fc / sr)
    b = 1.0 - a
    taps = min(len(x), max(32, int(6.0 / max(1e-4, 1.0 - a))))
    k = np.arange(taps, dtype=np.float64)
    ir = b * (a ** k)
    ir /= max(1e-12, float(ir.sum()))
    nfft = 1 << int(math.ceil(math.log2(len(x) + len(ir))))
    y = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(ir, nfft), nfft)[: len(x)]
    return y


def _bandpass_fft(x, lo_hz, hi_hz, sr):
    if len(x) == 0:
        return x.copy()
    nfft = 1 << int(math.ceil(math.log2(len(x))))
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    spec = np.fft.rfft(x, nfft)
    mask = (freqs >= lo_hz) & (freqs <= hi_hz)
    spec = spec * mask
    return np.fft.irfft(spec, nfft)[: len(x)]


def _frac_delay(x, delay_samples):
    if abs(delay_samples) < 1e-6 or len(x) == 0:
        return x.copy()
    n = len(x)
    idx = np.arange(n, dtype=np.float64) - float(delay_samples)
    return np.interp(idx, np.arange(n, dtype=np.float64), x, left=0.0, right=0.0)


def _read_wav_stereo(path):
    with wave.open(path, "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float64) / 2147483648.0
    else:
        raise ValueError(f"unsupported wav sample width {sw} in {path}")
    if ch == 1:
        return np.stack([data, data], axis=1), sr
    return data.reshape(-1, ch)[:, :2], sr


def _read_wav_stereo_resampled(path, target_sr, n, gain=1.0):
    st, wsr = _read_wav_stereo(path)
    if wsr != target_sr and len(st) > 1:
        new_len = max(1, int(round(len(st) * target_sr / float(wsr))))
        src_x = np.arange(len(st), dtype=np.float64)
        dst_x = np.linspace(0.0, len(st) - 1, new_len)
        st = np.stack([np.interp(dst_x, src_x, st[:, 0]), np.interp(dst_x, src_x, st[:, 1])], axis=1)
    out = np.zeros((n, 2), dtype=np.float64)
    k = min(n, len(st))
    out[:k] = st[:k] * float(gain)
    return out


def _read_wav_mono(path, sr):
    st, wsr = _read_wav_stereo(path)
    data = st.mean(axis=1)
    if wsr != sr and len(data) > 1:
        new_len = max(1, int(round(len(data) * sr / float(wsr))))
        data = np.interp(np.linspace(0.0, len(data) - 1, new_len), np.arange(len(data), dtype=np.float64), data)
    return data


def _write_wav_stereo(path, stereo, sr):
    clipped = np.clip(stereo, -1.0, 1.0)
    pcm = np.round(clipped * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def _synth_signal(sig, n, sr, seed=1):
    rng = np.random.default_rng(int(seed))
    t = np.arange(n, dtype=np.float64) / sr
    kind = str(sig.get("kind", "tone")).lower()
    default_gain = 1.0 if kind == "file" else 0.35
    amp = float(sig.get("gain", default_gain))
    if kind == "file":
        arr = _read_wav_mono(sig["path"], sr)
        out = np.zeros(n, dtype=np.float64)
        k = min(n, len(arr))
        out[:k] = arr[:k] * amp
        return out
    if kind == "tone":
        f = float(sig.get("freq_hz", 440.0))
        x = np.sin(2.0 * math.pi * f * t) + 0.35 * np.sin(2.0 * math.pi * 2.0 * f * t)
        return amp * x / 1.35
    if kind == "voice":
        f0 = float(sig.get("freq_hz", 165.0))
        mod = 0.65 + 0.35 * np.sin(2.0 * math.pi * 3.2 * t)
        x = (
            0.55 * np.sin(2.0 * math.pi * f0 * t)
            + 0.45 * np.sin(2.0 * math.pi * 3.0 * f0 * t)
            + 0.40 * np.sin(2.0 * math.pi * 8.0 * f0 * t)
            + 0.25 * np.sin(2.0 * math.pi * 15.0 * f0 * t)
        ) * mod
        return amp * x / 1.65
    if kind == "noise":
        x = rng.standard_normal(n)
        x = _one_pole_lp(x, float(sig.get("cutoff_hz", 6000.0)), sr)
        rms = float(np.sqrt(np.mean(x * x)) + 1e-12)
        return amp * (x / rms) * 0.35
    if kind == "bed":
        freqs = sig.get("freqs_hz", [220.0, 277.18, 329.63, 660.0, 1320.0])
        x = sum(np.sin(2.0 * math.pi * float(f) * t + 0.3 * i) for i, f in enumerate(freqs))
        return amp * x / max(1.0, len(freqs))
    if kind == "click":
        dur = max(0.004, min(0.05, float(sig.get("click_s", 0.015))))
        m = min(n, int(round(dur * sr)))
        out = np.zeros(n, dtype=np.float64)
        tt = np.arange(m, dtype=np.float64) / sr
        env = np.exp(-tt / (dur * 0.25))
        f = float(sig.get("freq_hz", 1800.0))
        out[:m] = amp * env * (0.7 * np.sin(2.0 * math.pi * f * tt) + 0.3 * rng.standard_normal(m))
        return out
    raise ValueError(f"unknown signal kind: {kind}")


def _listener_frame(pose):
    pos = np.array(pose.get("pos", [0.0, 0.0, 0.0]), dtype=np.float64)
    fwd = _norm(np.array(pose.get("forward", [0.0, 0.0, -1.0]), dtype=np.float64))
    up = _norm(np.array(pose.get("up", [0.0, 1.0, 0.0]), dtype=np.float64))
    right = _norm(np.cross(fwd, up))
    up = _norm(np.cross(right, fwd))
    return pos, right, up, fwd


def _spatialize_segment(mono, src, pose, sr):
    """Binaural band-split Woodworth ITD (<= 700 Hz) + head-shadow ILD + distance/air/obstruction."""
    lpos, lright, _, _ = _listener_frame(pose)
    spos = np.array(src.get("pos", [0.0, 0.0, -1.0]), dtype=np.float64)
    rel = spos - lpos
    dist = float(np.linalg.norm(rel))
    ref_dist = max(0.1, float(src.get("ref_distance", 1.0)))
    rolloff = float(src.get("rolloff", 1.0))
    eff_dist = max(ref_dist, dist)
    dist_gain = ref_dist / (ref_dist + rolloff * (eff_dist - ref_dist))

    rx = float(np.dot(rel, lright))
    sin_lat = max(-1.0, min(1.0, rx / max(1e-6, dist)))
    lat = math.asin(sin_lat)

    # Analytical Woodworth ITD (seconds), capped at 0.30 ms and applied to the <= 700 Hz band
    # so broadband noise and >= 1 kHz tones remain mono-fold safe (corr >= +0.2) while preserving ITD localization.
    itd_s = (HEAD_RADIUS_M / SPEED_OF_SOUND) * (abs(math.sin(lat)) + abs(lat))
    max_itd_s = float(src.get("max_itd_ms", 0.30)) / 1000.0
    itd_s = min(itd_s, max_itd_s)
    itd_samp = itd_s * sr

    obstruction = max(0.0, min(1.0, float(src.get("obstruction", 0.0))))
    air_fc = max(1200.0, 16000.0 * math.exp(-0.08 * max(0.0, dist - ref_dist)))
    obs_fc = 16000.0 * (1.0 - 0.92 * obstruction)
    obs_gain = 10.0 ** (-12.0 * obstruction / 20.0)
    base = _one_pole_lp(mono * (dist_gain * obs_gain), min(air_fc, obs_fc), sr)

    pan = sin_lat
    g_l = math.sqrt(max(0.18, 0.5 * (1.0 - 0.72 * pan)))
    g_r = math.sqrt(max(0.18, 0.5 * (1.0 + 0.72 * pan)))
    shadow_fc = 14000.0 - 10500.0 * abs(pan)

    low = _one_pole_lp(base, 700.0, sr)
    high = base - low
    shadow_high = _one_pole_lp(high, shadow_fc, sr)
    delayed_low = _frac_delay(low, itd_samp)

    if pan >= 0.0:
        right_ch = base * g_r
        left_ch = (delayed_low + shadow_high) * g_l
    else:
        left_ch = base * g_l
        right_ch = (delayed_low + shadow_high) * g_r
    return np.stack([left_ch, right_ch], axis=1)


def _apply_doppler(mono, src, pose, sr):
    vel = np.array(src.get("vel", [0.0, 0.0, 0.0]), dtype=np.float64)
    if float(np.linalg.norm(vel)) < 1e-6:
        return mono
    lpos, _, _, _ = _listener_frame(pose)
    spos = np.array(src.get("pos", [0.0, 0.0, -1.0]), dtype=np.float64)
    t = np.arange(len(mono), dtype=np.float64) / sr
    pos_t = spos[None, :] + t[:, None] * vel[None, :]
    d_t = np.linalg.norm(pos_t - lpos[None, :], axis=1)
    delay = (d_t - d_t[0]) / SPEED_OF_SOUND
    tau_samp = np.arange(len(mono), dtype=np.float64) - delay * sr
    return np.interp(tau_samp, np.arange(len(mono), dtype=np.float64), mono, left=0.0, right=0.0)


def _apply_fade_edges(buf, sr, ms=8.0):
    k = min(len(buf) // 4, max(1, int(round(ms * sr / 1000.0))))
    ramp = np.linspace(0.0, 1.0, k)[:, None]
    out = buf.copy()
    out[:k] *= ramp
    out[-k:] *= ramp[::-1]
    return out


def _ebur128_stats(wav_path):
    if not FFMPEG:
        return None
    r = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", wav_path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    txt = r.stderr[r.stderr.rfind("Summary:") :]
    mi = re.search(r"I:\s+(-?[\d.]+) LUFS", txt)
    mp = re.search(r"Peak:\s+(-?[\d.]+) dBFS", txt)
    if not (mi and mp):
        return None
    return {"lufs": float(mi.group(1)), "true_peak_dbtp": float(mp.group(1))}


def _loudnorm_two_pass(in_wav, out_wav, target_lufs, peak_dbtp, sr):
    if not FFMPEG:
        shutil.copyfile(in_wav, out_wav)
        return
    p1 = subprocess.run(
        [
            FFMPEG,
            "-hide_banner",
            "-i",
            in_wav,
            "-af",
            f"loudnorm=I={target_lufs}:TP={peak_dbtp}:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p1.stderr, re.S)
    if not m:
        shutil.copyfile(in_wav, out_wav)
        return
    stats = json.loads(m.group(0))
    filt = (
        f"loudnorm=I={target_lufs}:TP={peak_dbtp}:LRA=11:"
        f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']}:linear=true"
    )
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", in_wav, "-af", filt, "-ar", str(sr), "-c:a", "pcm_s16le", out_wav],
        check=True,
    )


def render_spec(spec, out_wav, target_lufs=None, peak_dbtp=None):
    sr = int(spec.get("sample_rate", 48000))
    dur = float(spec.get("duration_s", 3.0))
    if dur <= 0.05 or dur > 300.0:
        raise ValueError(f"duration_s out of range: {dur}")
    n = int(round(dur * sr))
    fps = float(spec.get("fps", 30.0))
    cut_fade_ms = float(spec.get("camera_cut_fade_ms", 6.0))
    if cut_fade_ms > 8.0:
        raise ValueError(f"camera_cut_fade_ms must be <= 8.0 ms (got {cut_fade_ms})")

    base_pose = spec.get("listener", {"pos": [0.0, 0.0, 0.0], "forward": [0.0, 0.0, -1.0], "up": [0.0, 1.0, 0.0]})
    cuts = sorted(spec.get("camera_cuts", []), key=lambda c: float(c.get("t", 0.0)))
    segments = []
    cur_t = 0.0
    cur_pose = base_pose
    for c in cuts:
        ct = max(0.0, min(dur, float(c["t"])))
        if ct > cur_t:
            segments.append((cur_t, ct, cur_pose))
        cur_t = ct
        cur_pose = c.get("listener", cur_pose)
    if cur_t < dur:
        segments.append((cur_t, dur, cur_pose))

    locked_bus = np.zeros((n, 2), dtype=np.float64)
    locked_focus_bus = np.zeros((n, 2), dtype=np.float64)
    unlocked_focus_bus = np.zeros((n, 2), dtype=np.float64)
    bed_bus = np.zeros((n, 2), dtype=np.float64)
    has_focus = False
    has_locked = False

    # 1. Spatial and stem sources
    for idx, src in enumerate(spec.get("sources", [])):
        role = str(src.get("role", "bed")).lower()
        locked = bool(src.get("locked", False))
        sig = src.get("signal", {"kind": "tone"})
        sig_kind = str(sig.get("kind", "tone")).lower()
        is_spatial = bool(src.get("spatial", True))

        if locked:
            has_locked = True
            if sig_kind == "file":
                st = _read_wav_stereo_resampled(sig["path"], sr, n, gain=float(sig.get("gain", 1.0)))
            else:
                mono = _synth_signal(sig, n, sr, seed=src.get("seed", idx + 1))
                st = np.stack([mono, mono], axis=1)
            locked_bus += st
            if role == "focus":
                has_focus = True
                locked_focus_bus += st
            continue

        if not is_spatial and sig_kind == "file":
            st = _read_wav_stereo_resampled(sig["path"], sr, n, gain=float(sig.get("gain", 1.0)))
        else:
            mono = _synth_signal(sig, n, sr, seed=src.get("seed", idx + 1))
            if is_spatial:
                st = np.zeros((n, 2), dtype=np.float64)
                xfade_n = max(2, int(round(cut_fade_ms * sr / 1000.0)))
                for seg_i, (t0, t1, pose) in enumerate(segments):
                    i0 = int(round(t0 * sr))
                    i1 = int(round(t1 * sr))
                    pad0 = max(0, i0 - xfade_n) if seg_i > 0 else i0
                    seg_mono = _apply_doppler(mono[pad0:i1], src, pose, sr)
                    seg_st = _spatialize_segment(seg_mono, src, pose, sr)
                    if seg_i == 0:
                        st[i0:i1] = seg_st
                    else:
                        ov = min(xfade_n, i0 - pad0, i1 - i0)
                        if ov > 0:
                            w = np.linspace(0.0, 1.0, ov)[:, None]
                            st[i0 - ov : i0] = st[i0 - ov : i0] * (1.0 - w) + seg_st[:ov] * w
                        st[i0:i1] = seg_st[i0 - pad0 :]
            else:
                st = np.stack([mono, mono], axis=1)

        st = _apply_fade_edges(st, sr, ms=8.0)
        if role == "focus":
            has_focus = True
            unlocked_focus_bus += st
        else:
            bed_bus += st

    # 2. Frame-clocked demo cues with gesture dedupe
    min_gap_s = float(spec.get("gesture_dedupe_ms", 120.0)) / 1000.0
    placed_cues = []
    last_by_group = {}
    cues_sorted = sorted(
        spec.get("cues", []),
        key=lambda c: float(c["frame"]) / fps if "frame" in c else float(c.get("t", 0.0)),
    )
    for ci, cue in enumerate(cues_sorted):
        t_cue = float(cue["frame"]) / fps if "frame" in cue else float(cue.get("t", 0.0))
        grp = str(cue.get("group", "default"))
        if grp in last_by_group and (t_cue - last_by_group[grp]) < min_gap_s:
            continue
        last_by_group[grp] = t_cue
        placed_cues.append({"t": t_cue, "group": grp, "frame": cue.get("frame")})
        start = int(round(t_cue * sr))
        if 0 <= start < n:
            click_n = min(n - start, int(round(0.05 * sr)))
            c_mono = _synth_signal(cue.get("signal", {"kind": "click", "gain": 0.45}), click_n, sr, seed=100 + ci)
            if "pos" in cue:
                c_st = _spatialize_segment(c_mono, cue, base_pose, sr)
            else:
                c_st = np.stack([c_mono, c_mono], axis=1)
            bed_bus[start : start + click_n] += c_st

    # 3. Focus-preserving gain control (fullband + 300-3400 Hz phone band) against combined focus stems
    margin_db = float(spec.get("focus_margin_db", 8.0))
    bed_scale = 1.0
    total_focus = locked_focus_bus + unlocked_focus_bus
    if has_focus and float(np.sqrt(np.mean(bed_bus ** 2))) > 1e-7:
        f_mono = total_focus.mean(axis=1)
        b_mono = bed_bus.mean(axis=1)
        f_phone = _bandpass_fft(f_mono, 300.0, 3400.0, sr)
        b_phone = _bandpass_fft(b_mono, 300.0, 3400.0, sr)
        win = max(1, int(round(0.1 * sr)))
        m_full, m_phone = [], []
        for i in range(0, n - win + 1, win):
            fr = float(np.sqrt(np.mean(f_mono[i : i + win] ** 2)))
            br = float(np.sqrt(np.mean(b_mono[i : i + win] ** 2)))
            if fr > 1e-4 and br > 1e-6:
                m_full.append(20.0 * math.log10(fr / br))
            fpr = float(np.sqrt(np.mean(f_phone[i : i + win] ** 2)))
            bpr = float(np.sqrt(np.mean(b_phone[i : i + win] ** 2)))
            if fpr > 1e-4 and bpr > 1e-6:
                m_phone.append(20.0 * math.log10(fpr / bpr))
        cur_margin = min(
            float(np.percentile(m_full, 10)) if m_full else 99.0,
            float(np.percentile(m_phone, 10)) if m_phone else 99.0,
        )
        if cur_margin < margin_db + 1.5:
            need_db = (margin_db + 1.5) - cur_margin
            bed_scale = 10.0 ** (-need_db / 20.0)
            bed_bus *= bed_scale

    # 4. Protected quiet windows (< -45 dBFS) on all unlocked buses (locked_bus passes through untouched)
    for qw in spec.get("quiet_windows", []):
        q0 = max(0, int(round(float(qw[0]) * sr)))
        q1 = min(n, int(round(float(qw[1]) * sr)))
        fade = min(int(round(0.01 * sr)), max(1, (q1 - q0) // 4))
        if q1 > q0:
            env = np.ones((n, 1), dtype=np.float64)
            env[q0:q1] = 0.001
            if fade > 1 and q0 >= fade:
                env[q0 - fade : q0] = np.linspace(1.0, 0.001, fade)[:, None]
            if fade > 1 and q1 + fade <= n:
                env[q1 : q1 + fade] = np.linspace(0.001, 1.0, fade)[:, None]
            bed_bus *= env
            unlocked_focus_bus *= env

    # Combine disjoint buses without cancelling locked non-focus stems
    mix = locked_bus + unlocked_focus_bus + bed_bus

    if not has_locked:
        mix -= np.mean(mix, axis=0, keepdims=True)
        peak_lin = float(np.max(np.abs(mix))) if len(mix) else 0.0
        if peak_lin > 0.89:
            mix *= 0.89 / peak_lin

    lufs_t = target_lufs if target_lufs is not None else spec.get("target_lufs")
    peak_t = peak_dbtp if peak_dbtp is not None else float(spec.get("peak_dbtp", -1.0))

    if lufs_t is not None and not has_locked and FFMPEG:
        with tempfile.TemporaryDirectory() as td:
            raw_wav = os.path.join(td, "raw.wav")
            _write_wav_stereo(raw_wav, mix, sr)
            _loudnorm_two_pass(raw_wav, out_wav, float(lufs_t), float(peak_t), sr)
    else:
        _write_wav_stereo(out_wav, mix, sr)

    return {
        "ok": True,
        "out": out_wav,
        "sample_rate": sr,
        "duration_s": dur,
        "bed_scale": round(bed_scale, 5),
        "placed_cues": placed_cues,
    }


def check_audio(wav_path, spec=None, target_lufs=None, peak_dbtp=None):
    stereo, sr = _read_wav_stereo(wav_path)
    l_ch, r_ch = stereo[:, 0], stereo[:, 1]
    n = len(stereo)
    dur = n / float(sr)
    dc = float(max(abs(np.mean(l_ch)), abs(np.mean(r_ch))))
    sample_peak = float(np.max(np.abs(stereo))) if n else 0.0
    clipped = int(np.sum(np.abs(stereo) >= 0.999))
    rms_l = float(np.sqrt(np.mean(l_ch ** 2)) + 1e-12)
    rms_r = float(np.sqrt(np.mean(r_ch ** 2)) + 1e-12)
    lr_db = 20.0 * math.log10(rms_r / rms_l)

    denom = float(np.linalg.norm(l_ch) * np.linalg.norm(r_ch))
    corr = float(np.dot(l_ch, r_ch) / denom) if denom > 1e-12 else 1.0

    max_lag = int(round(0.0008 * sr))
    seg = min(n, sr * 2)
    a, b = r_ch[:seg] - np.mean(r_ch[:seg]), l_ch[:seg] - np.mean(l_ch[:seg])
    best_lag, best_val = 0, -1e18
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            v = float(np.dot(a[: seg - lag], b[lag:seg]))
        else:
            v = float(np.dot(a[-lag:seg], b[: seg + lag]))
        if v > best_val:
            best_val, best_lag = v, lag
    itd_ms = best_lag * 1000.0 / sr

    cut_jumps = []
    if spec and spec.get("camera_cuts"):
        diff = np.max(np.abs(np.diff(stereo, axis=0)), axis=1)
        for c in spec["camera_cuts"]:
            idx = int(round(float(c["t"]) * sr))
            lo, hi = max(0, idx - int(0.015 * sr)), min(len(diff), idx + int(0.015 * sr))
            cut_jumps.append(float(np.max(diff[lo:hi])) if hi > lo else 0.0)

    quiet_peaks_db = []
    if spec and spec.get("quiet_windows"):
        for qw in spec["quiet_windows"]:
            q0 = max(0, int(round(float(qw[0]) * sr)))
            q1 = min(n, int(round(float(qw[1]) * sr)))
            p = float(np.max(np.abs(stereo[q0:q1]))) if q1 > q0 else 0.0
            quiet_peaks_db.append(20.0 * math.log10(max(p, 1e-9)))

    has_locked = bool(spec and any(bool(s.get("locked")) for s in spec.get("sources", [])))
    eff_lufs = target_lufs if target_lufs is not None else (spec.get("target_lufs") if spec else None)
    eff_peak = peak_dbtp if peak_dbtp is not None else float((spec or {}).get("peak_dbtp", -1.0))

    eb = _ebur128_stats(wav_path)
    checks = [
        {"id": "clipping", "ok": clipped == 0, "value": clipped, "limit": 0},
        {"id": "dc_offset", "ok": dc < 0.005, "value": round(dc, 6), "limit": 0.005},
        {"id": "mono_corr", "ok": corr >= 0.2, "value": round(corr, 4), "limit": 0.2},
    ]
    if eb:
        if eff_lufs is not None and not (has_locked and target_lufs is None):
            checks.append({"id": "lufs", "ok": abs(eb["lufs"] - float(eff_lufs)) <= 1.0, "value": eb["lufs"], "limit": float(eff_lufs)})
        checks.append({"id": "true_peak", "ok": eb["true_peak_dbtp"] <= eff_peak + 0.1, "value": eb["true_peak_dbtp"], "limit": eff_peak})
    if quiet_peaks_db:
        checks.append({"id": "quiet_windows", "ok": max(quiet_peaks_db) < -45.0, "value": round(max(quiet_peaks_db), 2), "limit": -45.0})

    ok = all(c["ok"] for c in checks)
    return {
        "ok": ok,
        "duration_s": round(dur, 4),
        "sample_rate": sr,
        "sample_peak": round(sample_peak, 5),
        "clipped_samples": clipped,
        "dc_offset": round(dc, 6),
        "lr_db": round(lr_db, 3),
        "itd_ms": round(itd_ms, 4),
        "mono_corr": round(corr, 4),
        "ebur128": eb,
        "cut_jumps": [round(x, 5) for x in cut_jumps],
        "quiet_peaks_db": [round(x, 2) for x in quiet_peaks_db],
        "checks": checks,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec_or_wav", nargs="?")
    ap.add_argument("out_wav", nargs="?")
    ap.add_argument("--check", dest="check_file")
    ap.add_argument("--spec", dest="check_spec")
    ap.add_argument("--lufs", type=float, default=None)
    ap.add_argument("--peak", type=float, default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.check_file:
        sp = json.load(open(a.check_spec, encoding="utf-8")) if a.check_spec else None
        res = check_audio(a.check_file, spec=sp, target_lufs=a.lufs, peak_dbtp=a.peak)
        if a.json:
            print(json.dumps(res, indent=2))
        else:
            for c in res["checks"]:
                print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX'}")
            print(f"lr_db: {res['lr_db']} dB   itd_ms: {res['itd_ms']} ms   mono_corr: {res['mono_corr']}")
        sys.exit(0 if res["ok"] else 1)

    if not (a.spec_or_wav and a.out_wav):
        ap.error("provide SPEC.json OUT.wav, or --check FILE.wav")
    spec = json.load(open(a.spec_or_wav, encoding="utf-8"))
    info = render_spec(spec, a.out_wav, target_lufs=a.lufs, peak_dbtp=a.peak)
    chk = check_audio(a.out_wav, spec=spec, target_lufs=a.lufs, peak_dbtp=a.peak)
    out = {"render": info, "check": chk, "ok": chk["ok"]}
    if a.json:
        print(json.dumps(out, indent=2))
    else:
        print(f"wrote {a.out_wav} ({info['duration_s']:.2f} s, {info['sample_rate']} Hz)")
        for c in chk["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX'}")
    sys.exit(0 if chk["ok"] else 1)


if __name__ == "__main__":
    main()

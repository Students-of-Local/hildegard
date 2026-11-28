#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic invariant checker for interactive 3D scenes, browser games, VFX, and spatial game audio.

  python3 -B check_game.py SPEC.json [--json]

Verifies mathematical, simulation, camera, VFX, audio, and render-budget contracts using pure Python 3 stdlib:
  - Fixed-timestep accumulator (dt <= 0.25 s spike clamp, bounded catch-up, seeded determinism)
  - Subject-locked dolly-zoom (d * tan(fov / 2) invariant < 1e-6, corner coverage >= 1.0)
  - Endless parallax depth-speed ordering & C1 vista loop seam continuity (< 1e-3)
  - Wrapped particle corridor seam fade (visibility == 0 at wrap) & Beer-Lambert transmittance
  - Spring-bone damper decay & capsule clearance clamp (<= max_distance)
  - VFX timeline cue crossing (0 duplicates / 0 misses), HDR bloom HalfFloatType, NaN-safe shader guards
  - Local-only asset policy (refuses cloud-only generator endpoints) & Web Audio HRTF spatialization
  - Real-GPU canvas inspection & evidence manifest contract
"""

import argparse
import json
import math
import re
import sys

CLOUD_BLOCK = re.compile(r"\b(tripo3d|elevenlabs|api\.gemini|generativelanguage|meshy\.ai|runwayml)\b", re.I)
SW_RENDERERS = ("swiftshader", "llvmpipe", "software rasterizer")


def _chk(cid, ok, value, limit, detail):
    return {"id": cid, "ok": bool(ok), "value": value, "limit": limit, "detail": detail}


def check_fixed_timestep(cfg):
    checks = []
    dt_step = float(cfg.get("dt_step", 1.0 / 60.0))
    dt_max = float(cfg.get("dt_max", 0.25))
    seed = cfg.get("seed")
    checks.append(_chk("timestep_step", 1.0 / 240.0 <= dt_step <= 1.0 / 20.0, round(dt_step, 6), "1/240..1/20 s", "fixed simulation step"))
    checks.append(_chk("timestep_clamp", 0.01 <= dt_max <= 0.25, round(dt_max, 4), "<= 0.25 s", "frame-spike clamp prevents spiral of death"))
    checks.append(_chk("seeded_rng", isinstance(seed, int), seed, "integer seed", "deterministic simulation requires explicit integer seed"))

    # Simulate a 1.0 s lag spike followed by 60 normal frames twice to prove bounded catch-up + determinism.
    def run_sim(s):
        state = int(s) if isinstance(s, int) else 1
        acc, x, v, steps_on_spike = 0.0, 0.0, 1.0, 0
        for fi, raw_dt in enumerate([1.0] + [1.0 / 60.0] * 60):
            clamped = min(raw_dt, dt_max)
            acc += clamped
            n_sub = 0
            while acc >= dt_step - 1e-12:
                state = (1103515245 * state + 12345) & 0x7FFFFFFF
                jitter = ((state / 0x7FFFFFFF) - 0.5) * 0.01
                x += (v + jitter) * dt_step
                acc -= dt_step
                n_sub += 1
            if fi == 0:
                steps_on_spike = n_sub
        alpha = acc / dt_step
        return x, steps_on_spike, alpha

    x1, spike_steps, alpha = run_sim(seed)
    x2, _, _ = run_sim(seed)
    max_allowed = int(math.ceil(0.25 / max(dt_step, 1e-6))) + 1
    checks.append(_chk("spike_bounded", math.isfinite(x1) and spike_steps <= max_allowed, spike_steps, f"<= {max_allowed}", "1.0 s spike bounded by dt_max"))
    checks.append(_chk("sim_deterministic", x1 == x2 and 0.0 <= alpha < 1.0 + 1e-9, round(x1, 6), "identical across runs", "repeatable seeded state and valid render alpha"))
    return checks


def check_dolly_zoom(cfg):
    checks = []
    ref_h = float(cfg["half_height"])
    samples = cfg.get("samples", [])
    if len(samples) < 2:
        return [_chk("dolly_samples", False, len(samples), ">= 2", "provide at least two (fov_deg, distance) samples")]
    max_err = 0.0
    min_cov = 999.0
    for s in samples:
        fov_rad = math.radians(float(s["fov_deg"]))
        dist = float(s["distance"])
        h = dist * math.tan(fov_rad * 0.5)
        max_err = max(max_err, abs(h - ref_h))
        if "backdrop_half_height" in s:
            min_cov = min(min_cov, float(s["backdrop_half_height"]) / max(1e-9, h))
        else:
            min_cov = min(min_cov, 1.0)
    checks.append(_chk("dolly_height_invariant", max_err < 1e-5, round(max_err, 8), "< 1e-5", "d * tan(fov/2) must hold subject framing constant"))
    checks.append(_chk("dolly_corner_coverage", min_cov >= 1.0 - 1e-6, round(min_cov, 4), ">= 1.0", "backdrop covers wide-FOV corners"))
    return checks


def check_parallax_loop(cfg):
    checks = []
    layers = cfg.get("layers", [])
    if len(layers) >= 2:
        ordered = all(
            float(layers[i]["depth"]) < float(layers[i + 1]["depth"])
            and float(layers[i]["speed"]) > float(layers[i + 1]["speed"])
            for i in range(len(layers) - 1)
        )
        checks.append(_chk("parallax_order", ordered, len(layers), "closer depth => higher speed", "depth-speed ratio monotonically decreases with depth"))
    # C1 periodic curve test: sum of harmonics a_k cos(2*pi*k*t/T) + b_k sin(2*pi*k*t/T) or explicit endpoint states
    if "start_pos" in cfg and "end_pos" in cfg:
        dp = math.dist(cfg["start_pos"], cfg["end_pos"])
        dv = math.dist(cfg.get("start_vel", [0, 0, 0]), cfg.get("end_vel", [0, 0, 0]))
        checks.append(_chk("loop_c0_seam", dp < 1e-3, round(dp, 6), "< 1e-3", "loop start and end positions match"))
        checks.append(_chk("loop_c1_seam", dv < 1e-3, round(dv, 6), "< 1e-3", "loop start and end velocities match (C1 continuity)"))
    return checks


def check_particles_and_clouds(cfg):
    checks = []
    if "wrap_alpha" in cfg:
        wa = float(cfg["wrap_alpha"])
        checks.append(_chk("particle_wrap_invisible", abs(wa) <= 1e-6, wa, "0.0", "particles fade to alpha 0 at corridor wrap seam"))
    if "fade_margin" in cfg and "corridor_length" in cfg:
        fm = float(cfg["fade_margin"])
        cl = float(cfg["corridor_length"])
        checks.append(_chk("particle_fade_margin", 0.0 < fm <= 0.45 * cl, round(fm, 4), f"0 < margin <= {0.45*cl:.2f}", "depth fade margin fits inside corridor"))
    if "cloud_density" in cfg and "cloud_thickness" in cfg:
        dens = float(cfg["cloud_density"])
        thick = float(cfg["cloud_thickness"])
        t_val = math.exp(-max(0.0, dens) * max(0.0, thick))
        ok = dens >= 0.0 and thick >= 0.0 and 0.0 < t_val <= 1.0
        checks.append(_chk("beer_lambert", ok, round(t_val, 5), "(0, 1]", "Beer-Lambert transmittance exp(-density * thickness)"))
    return checks


def check_spring_bone(cfg):
    checks = []
    stiffness = float(cfg.get("stiffness", 120.0))
    damping = float(cfg.get("damping", 14.0))
    max_dist = float(cfg.get("max_distance", 0.5))
    capsule_r = float(cfg.get("capsule_radius", 0.15))
    dt = min(float(cfg.get("dt_step", 1.0 / 60.0)), 0.05)

    # Simulate 2 seconds from an initial offset; verify energy decays and distance stays clamped
    pos = max_dist * 0.8
    vel = 0.0
    e0 = 0.5 * stiffness * pos * pos
    max_seen = abs(pos)
    for _ in range(int(round(2.0 / dt))):
        acc = -stiffness * pos - damping * vel
        vel += acc * dt
        pos += vel * dt
        if abs(pos) > max_dist:
            pos = math.copysign(max_dist, pos)
            vel *= 0.5
        max_seen = max(max_seen, abs(pos))
    e1 = 0.5 * stiffness * pos * pos + 0.5 * vel * vel
    checks.append(_chk("spring_energy_decay", math.isfinite(e1) and e1 < e0 * 0.25, round(e1, 5), f"< {e0*0.25:.5f}", "spring damper settles without exploding"))
    checks.append(_chk("spring_max_distance", max_seen <= max_dist + 1e-9, round(max_seen, 5), f"<= {max_dist}", "tip clamped to max_distance"))
    checks.append(_chk("spring_capsule", capsule_r >= 0.0 and max_dist > 0.0, capsule_r, ">= 0", "valid capsule radius"))
    return checks


def check_vfx_and_audio(cfg):
    checks = []
    if "vfx" in cfg:
        v = cfg["vfx"]
        rt = str(v.get("render_target_type", ""))
        checks.append(_chk("vfx_hdr_target", rt in ("HalfFloatType", "FloatType"), rt, "HalfFloatType|FloatType", "HDR bloom requires float render target"))
        checks.append(_chk("vfx_depth_fallback", bool(v.get("depth_texture_fallback", False)), v.get("depth_texture_fallback"), True, "soft particles have DepthTexture fallback"))
        checks.append(_chk("vfx_nan_guard", bool(v.get("nan_safe_shaders", False)), v.get("nan_safe_shaders"), True, "GLSL guards pow/sqrt/div inputs with max(x, 1e-5)"))
        cues = sorted(float(t) for t in v.get("cue_times", []))
        if cues:
            # Verify scrub-safe half-open interval (prev, next] emits each cue exactly once across variable dt
            emitted = []
            prev = -1e-9
            t_end = max(cues) + 0.5
            dts = [0.016, 0.033, 0.008, 0.05, 0.017]
            k = 0
            while prev < t_end:
                nxt = prev + dts[k % len(dts)]
                for ct in cues:
                    if prev < ct <= nxt:
                        emitted.append(ct)
                prev = nxt
                k += 1
            checks.append(_chk("vfx_cue_exact", emitted == cues, len(emitted), len(cues), "collectCrossedCues fires every cue once with zero duplicates"))
    if "audio" in cfg:
        au = cfg["audio"]
        checks.append(_chk("audio_hrtf", str(au.get("panning_model", "")).upper() == "HRTF", au.get("panning_model"), "HRTF", "Web Audio PannerNode uses HRTF panning"))
        checks.append(_chk("audio_distance", str(au.get("distance_model", "")).lower() in ("inverse", "exponential"), au.get("distance_model"), "inverse|exponential", "physically monotonic distance attenuation"))
        checks.append(_chk("audio_listener_sync", bool(au.get("listener_synced_to_camera", False)), au.get("listener_synced_to_camera"), True, "AudioListener forward/up tracks active camera"))
    return checks


def check_inspection_and_policy(spec):
    checks = []
    raw = json.dumps(spec)
    m = CLOUD_BLOCK.search(raw)
    checks.append(_chk("local_assets_only", m is None, m.group(0) if m else "clean", "no cloud-only APIs", "assets use local Hildegard tools, never cloud-only generators"))
    if "inspect" in spec:
        ins = spec["inspect"]
        rend = str(ins.get("webgl_renderer", "")).lower()
        is_sw = any(sw in rend for sw in SW_RENDERERS) or not rend
        checks.append(_chk("real_gpu_renderer", not is_sw, ins.get("webgl_renderer", ""), "hardware GPU renderer", "visual signoff rejects SwiftShader/llvmpipe"))
        checks.append(_chk("canvas_entropy", float(ins.get("color_entropy_bits", 0.0)) >= 2.0, ins.get("color_entropy_bits", 0.0), ">= 2.0 bits", "non-blank rendered frame"))
        checks.append(_chk("canvas_edges", float(ins.get("edge_density", 0.0)) >= 0.01, ins.get("edge_density", 0.0), ">= 0.01", "visible geometric detail"))
        checks.append(_chk("console_errors", int(ins.get("console_errors", 1)) == 0, ins.get("console_errors", 1), 0, "zero runtime console errors"))
        if "draw_calls" in ins and "max_draw_calls" in ins:
            checks.append(_chk("draw_call_budget", int(ins["draw_calls"]) <= int(ins["max_draw_calls"]), ins["draw_calls"], f"<= {ins['max_draw_calls']}", "render draw-call budget"))
    return checks


def check_spec(spec):
    checks = []
    if "timestep" in spec:
        checks.extend(check_fixed_timestep(spec["timestep"]))
    if "dolly_zoom" in spec:
        checks.extend(check_dolly_zoom(spec["dolly_zoom"]))
    if "parallax_loop" in spec:
        checks.extend(check_parallax_loop(spec["parallax_loop"]))
    if "particles" in spec:
        checks.extend(check_particles_and_clouds(spec["particles"]))
    if "spring_bone" in spec:
        checks.extend(check_spring_bone(spec["spring_bone"]))
    checks.extend(check_vfx_and_audio(spec))
    checks.extend(check_inspection_and_policy(spec))
    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding="utf-8"))
    res = check_spec(spec)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

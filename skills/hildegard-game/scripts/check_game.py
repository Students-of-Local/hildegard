#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic invariant checker for interactive 3D scenes, browser games, VFX, and spatial game audio.

  python3 -B check_game.py SPEC.json [--src DIR] [--json]

Verifies mathematical, simulation, camera, VFX, audio, and render-budget contracts using pure Python 3 stdlib:
  - Fixed-timestep accumulator (dt <= 0.25 s spike clamp, bounded catch-up, seeded determinism)
  - Subject-locked dolly-zoom (d * tan(fov / 2) invariant < 1e-5, corner coverage >= 1.0)
  - Endless parallax depth-speed ordering & C1 vista loop seam continuity (< 1e-3)
  - Wrapped particle corridor seam fade (visibility == 0 at wrap) & Beer-Lambert transmittance
  - Spring-bone damper decay (strictly positive stiffness/damping, dt_step <= 0.05) & capsule clearance
  - VFX timeline cue crossing (0 duplicates / 0 misses), HDR bloom HalfFloatType, declared shader guards
  - Local-only asset policy (refuses cloud-only generator endpoints) & Web Audio HRTF spatialization
  - Optional --src DIR static scan checking source files for cloud generator endpoints and unguarded GLSL pow/sqrt
"""

import argparse
import json
import math
import os
import re
import sys

CLOUD_BLOCK = re.compile(r"\b(tripo3d|elevenlabs|api\.gemini|generativelanguage|meshy\.ai|runwayml)\b", re.I)
SW_RENDERERS = ("swiftshader", "llvmpipe", "software rasterizer")
KNOWN_KEYS = {"timestep", "dolly_zoom", "parallax_loop", "particles", "spring_bone", "vfx", "audio", "inspect"}
SRC_EXTS = {".js", ".mjs", ".ts", ".jsx", ".tsx", ".html", ".glsl", ".frag", ".vert"}
SHADER_EXTS = {".glsl", ".frag", ".vert"}
SKIP_DIRS = {"node_modules", ".git", "__pycache__"}
SHADER_CALL_RE = re.compile(r"(?<!\.)\b(pow|sqrt)\s*\(")
GLSL_COMMENT_RE = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/")
HTML_SHADER_SCRIPT_RE = re.compile(r"<script\b[^>]*type\s*=\s*[\"'][^\"']*shader[^\"']*[\"'][^>]*>([\s\S]*?)</script>", re.I)
JS_TOKEN_RE = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/|(`(?:\\.|[^`\\])*`|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')")
GLSL_MARKER_RE = re.compile(r"\b(?:void\s+main|gl_FragColor|gl_Position|precision\s+(?:lowp|mediump|highp)|uniform\s+\w+|varying\s+\w+|attribute\s+\w+|#version|vec[234]\s+\w+|fragColor)\b")
GUARD_PREFIX_RE = re.compile(r"^(?:max|abs|clamp|saturate)\s*\(")
POS_NUM_RE = re.compile(r"^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fF]?$")


def _chk(cid, ok, value, limit, detail):
    return {"id": cid, "ok": bool(ok), "value": value, "limit": limit, "detail": detail}


def check_fixed_timestep(cfg):
    if not isinstance(cfg, dict) or not cfg:
        return [_chk("timestep_config", False, cfg, "non-empty object", "timestep block must specify dt_step, dt_max, seed")]
    checks = []
    dt_step = float(cfg.get("dt_step", 1.0 / 60.0))
    dt_max = float(cfg.get("dt_max", 0.25))
    seed = cfg.get("seed")
    step_ok = math.isfinite(dt_step) and (1.0 / 240.0 <= dt_step <= 1.0 / 20.0)
    clamp_ok = math.isfinite(dt_max) and (0.01 <= dt_max <= 0.25)
    checks.append(_chk("timestep_step", step_ok, round(dt_step, 6) if math.isfinite(dt_step) else str(dt_step), "1/240..1/20 s", "fixed simulation step"))
    checks.append(_chk("timestep_clamp", clamp_ok, round(dt_max, 4) if math.isfinite(dt_max) else str(dt_max), "<= 0.25 s", "frame-spike clamp prevents spiral of death"))
    checks.append(_chk("seeded_rng", isinstance(seed, int) and not isinstance(seed, bool), seed, "integer seed", "deterministic simulation requires explicit integer seed"))

    if not math.isfinite(dt_step) or dt_step <= 1e-4 or not math.isfinite(dt_max) or dt_max <= 0.0:
        checks.append(_chk("spike_bounded", False, dt_step, "dt_step > 1e-4", "invalid dt_step or dt_max prevents bounded simulation"))
        checks.append(_chk("sim_deterministic", False, dt_step, "dt_step > 1e-4", "invalid dt_step prevents deterministic simulation"))
        return checks

    def run_sim(s):
        state = int(s) if isinstance(s, int) and not isinstance(s, bool) else 1
        acc, x, v, steps_on_spike = 0.0, 0.0, 1.0, 0
        for fi, raw_dt in enumerate([1.0] + [1.0 / 60.0] * 60):
            clamped = min(raw_dt, dt_max)
            acc += clamped
            n_sub = 0
            while acc >= dt_step - 1e-12 and n_sub < 10_000:
                state = (1103515245 * state + 12345) & 0x7FFFFFFF
                jitter = ((state / 0x7FFFFFFF) - 0.5) * 0.01
                x += (v + jitter) * dt_step
                acc = max(0.0, acc - dt_step)
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
    if not isinstance(cfg, dict) or "half_height" not in cfg:
        return [_chk("dolly_config", False, cfg, "half_height + samples", "dolly_zoom block requires half_height and samples")]
    checks = []
    ref_h = float(cfg["half_height"])
    samples = cfg.get("samples", [])
    if len(samples) < 2 or ref_h <= 0.0:
        return [_chk("dolly_samples", False, len(samples), ">= 2 with half_height > 0", "provide positive half_height and at least two (fov_deg, distance) samples")]
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
    if not isinstance(cfg, dict):
        return [_chk("parallax_config", False, cfg, "object", "parallax_loop must be an object")]
    checks = []
    layers = cfg.get("layers", [])
    if len(layers) >= 2:
        ordered = all(
            float(layers[i]["depth"]) < float(layers[i + 1]["depth"])
            and float(layers[i]["speed"]) > float(layers[i + 1]["speed"])
            for i in range(len(layers) - 1)
        )
        checks.append(_chk("parallax_order", ordered, len(layers), "closer depth => higher speed", "depth-speed ratio monotonically decreases with depth"))
    if "start_pos" in cfg and "end_pos" in cfg:
        dp = math.dist(cfg["start_pos"], cfg["end_pos"])
        dv = math.dist(cfg.get("start_vel", [0, 0, 0]), cfg.get("end_vel", [0, 0, 0]))
        checks.append(_chk("loop_c0_seam", dp < 1e-3, round(dp, 6), "< 1e-3", "loop start and end positions match"))
        checks.append(_chk("loop_c1_seam", dv < 1e-3, round(dv, 6), "< 1e-3", "loop start and end velocities match (C1 continuity)"))
    if not checks:
        checks.append(_chk("parallax_config", False, cfg, "layers (>=2) or start_pos/end_pos", "parallax_loop block has no verifiable layers or endpoints"))
    return checks


def check_particles_and_clouds(cfg):
    if not isinstance(cfg, dict):
        return [_chk("particles_config", False, cfg, "object", "particles must be an object")]
    checks = []
    if "wrap_alpha" in cfg:
        wa = float(cfg["wrap_alpha"])
        checks.append(_chk("particle_wrap_invisible", abs(wa) <= 1e-6, wa, "0.0", "particles fade to alpha 0 at corridor wrap seam"))
    if "fade_margin" in cfg and "corridor_length" in cfg:
        fm = float(cfg["fade_margin"])
        cl = float(cfg["corridor_length"])
        checks.append(_chk("particle_fade_margin", cl > 0.0 and 0.0 < fm <= 0.45 * cl, round(fm, 4), f"0 < margin <= {0.45*cl:.2f}", "depth fade margin fits inside corridor"))
    if "cloud_density" in cfg and "cloud_thickness" in cfg:
        dens = float(cfg["cloud_density"])
        thick = float(cfg["cloud_thickness"])
        t_val = math.exp(-max(0.0, dens) * max(0.0, thick))
        ok = dens >= 0.0 and thick >= 0.0 and 0.0 < t_val <= 1.0
        checks.append(_chk("beer_lambert", ok, round(t_val, 5), "(0, 1]", "Beer-Lambert transmittance exp(-density * thickness)"))
    if not checks:
        checks.append(_chk("particles_config", False, cfg, "wrap_alpha / fade_margin / cloud params", "particles block has no verifiable fields"))
    return checks


def check_spring_bone(cfg):
    if not isinstance(cfg, dict) or not cfg:
        return [_chk("spring_config", False, cfg, "non-empty object", "spring_bone block requires stiffness, damping, max_distance, dt_step")]
    checks = []
    stiffness = float(cfg.get("stiffness", 120.0))
    damping = float(cfg.get("damping", 14.0))
    max_dist = float(cfg.get("max_distance", 0.5))
    capsule_r = float(cfg.get("capsule_radius", 0.15))
    dt = float(cfg.get("dt_step", 1.0 / 60.0))

    dt_ok = math.isfinite(dt) and (0.0 < dt <= 0.05)
    params_ok = math.isfinite(stiffness) and stiffness > 0.0 and math.isfinite(damping) and damping > 0.0 and max_dist > 0.0
    checks.append(_chk("spring_dt", dt_ok, round(dt, 6) if math.isfinite(dt) else str(dt), "0 < dt_step <= 0.05", "spring integration step must be positive and <= 0.05 s"))
    checks.append(_chk("spring_params", params_ok, {"stiffness": stiffness, "damping": damping}, "stiffness > 0, damping > 0", "damped spring requires positive stiffness and damping"))
    checks.append(_chk("spring_capsule", capsule_r >= 0.0 and max_dist > 0.0, capsule_r, ">= 0", "valid capsule radius"))

    if not (dt_ok and params_ok):
        checks.append(_chk("spring_energy_decay", False, "skipped", "valid dt_step/stiffness/damping", "invalid spring parameters prevent stable simulation"))
        checks.append(_chk("spring_max_distance", False, "skipped", f"<= {max_dist}", "invalid spring parameters prevent stable simulation"))
        return checks

    pos = max_dist * 0.8
    vel = 0.0
    e0 = 0.5 * stiffness * pos * pos
    max_seen = abs(pos)
    steps = min(20_000, max(1, int(round(2.0 / dt))))
    for _ in range(steps):
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
    return checks


def check_vfx_and_audio(cfg):
    checks = []
    if "vfx" in cfg:
        v = cfg["vfx"]
        if not isinstance(v, dict) or not v:
            checks.append(_chk("vfx_config", False, v, "non-empty object", "vfx block must declare render target and guards"))
        else:
            rt = str(v.get("render_target_type", ""))
            checks.append(_chk("vfx_hdr_target", rt in ("HalfFloatType", "FloatType"), rt, "HalfFloatType|FloatType", "HDR bloom requires float render target"))
            checks.append(_chk("vfx_depth_fallback", bool(v.get("depth_texture_fallback", False)), v.get("depth_texture_fallback"), True, "soft particles have DepthTexture fallback"))
            checks.append(_chk("vfx_nan_guard", bool(v.get("nan_safe_shaders", False)), v.get("nan_safe_shaders"), True, "GLSL guards pow/sqrt/div inputs with max(x, 1e-5)"))
            cues = sorted(float(t) for t in v.get("cue_times", []))
            if cues:
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
        if not isinstance(au, dict) or not au:
            checks.append(_chk("audio_config", False, au, "non-empty object", "audio block must declare panning_model and distance_model"))
        else:
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
        if not isinstance(ins, dict) or not ins:
            checks.append(_chk("inspect_config", False, ins, "non-empty object", "inspect block must record renderer and pixel metrics"))
        else:
            rend = str(ins.get("webgl_renderer", "")).lower()
            is_sw = any(sw in rend for sw in SW_RENDERERS) or not rend
            checks.append(_chk("real_gpu_renderer", not is_sw, ins.get("webgl_renderer", ""), "hardware GPU renderer", "visual signoff rejects SwiftShader/llvmpipe"))
            checks.append(_chk("canvas_entropy", float(ins.get("color_entropy_bits", 0.0)) >= 2.0, ins.get("color_entropy_bits", 0.0), ">= 2.0 bits", "non-blank rendered frame"))
            checks.append(_chk("canvas_edges", float(ins.get("edge_density", 0.0)) >= 0.01, ins.get("edge_density", 0.0), ">= 0.01", "visible geometric detail"))
            checks.append(_chk("console_errors", int(ins.get("console_errors", 1)) == 0, ins.get("console_errors", 1), 0, "zero runtime console errors"))
            if "draw_calls" in ins and "max_draw_calls" in ins:
                checks.append(_chk("draw_call_budget", int(ins["draw_calls"]) <= int(ins["max_draw_calls"]), ins["draw_calls"], f"<= {ins['max_draw_calls']}", "render draw-call budget"))
    return checks


def _strip_glsl_comments(code):
    return GLSL_COMMENT_RE.sub(lambda m: "".join("\n" if ch == "\n" else " " for ch in m.group(0)), code)


def _first_call_arg(text, start):
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0:
                return text[start:i].strip()
            depth -= 1
        elif ch == "," and depth == 0:
            return text[start:i].strip()
    return text[start:].strip()


def _is_safe_shader_arg(fn, arg):
    if GUARD_PREFIX_RE.match(arg):
        return True
    if POS_NUM_RE.match(arg):
        val = float(arg.rstrip("fF"))
        return val > 0.0 if fn == "pow" else val >= 0.0
    return False


def _scan_glsl_block(code, rel, base_line, hits):
    cleaned = _strip_glsl_comments(code)
    for sm in SHADER_CALL_RE.finditer(cleaned):
        fn = sm.group(1)
        arg = _first_call_arg(cleaned, sm.end())
        if not _is_safe_shader_arg(fn, arg):
            ln = base_line + cleaned[: sm.start()].count("\n")
            compact = re.sub(r"\s+", " ", arg)
            hits.append(f"{rel}:{ln}:{fn}({compact})")


def check_source_dir(src_dir):
    """Static audit over project source/shader files (dir or single file) for cloud endpoints and unguarded GLSL pow/sqrt."""
    if not os.path.exists(src_dir):
        return [_chk("src_path_exists", False, src_dir, "existing source file or directory", "source path does not exist")]

    targets = []
    if os.path.isfile(src_dir):
        if os.path.splitext(src_dir)[1].lower() in SRC_EXTS:
            targets.append((src_dir, os.path.basename(src_dir)))
    elif os.path.isdir(src_dir):
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [d for d in sorted(dirs) if d not in SKIP_DIRS]
            for name in sorted(files):
                if os.path.splitext(name)[1].lower() in SRC_EXTS:
                    path = os.path.join(root, name)
                    targets.append((path, os.path.relpath(path, src_dir)))
    else:
        return [_chk("src_path_exists", False, src_dir, "existing source file or directory", "source path is neither a file nor a directory")]

    if not targets:
        return [_chk("src_files_scanned", False, 0, ">= 1 source/shader file", f"no matching source/shader files found under {src_dir}")]

    cloud_hits = []
    shader_hits = []
    for path, rel in targets:
        ext = os.path.splitext(path)[1].lower()
        text = open(path, encoding="utf-8", errors="replace").read()
        m = CLOUD_BLOCK.search(text)
        if m:
            cloud_hits.append(f"{rel}:{m.group(0)}")
        if ext in SHADER_EXTS:
            _scan_glsl_block(text, rel, 1, shader_hits)
        else:
            if ext == ".html":
                for sm in HTML_SHADER_SCRIPT_RE.finditer(text):
                    base_line = text[: sm.start(1)].count("\n") + 1
                    _scan_glsl_block(sm.group(1), rel, base_line, shader_hits)
            for sm in JS_TOKEN_RE.finditer(text):
                lit = sm.group(1)
                if not lit:
                    continue
                body = lit[1:-1].replace("\\n", "\n").replace("\\r", "\r") if lit[0] in ('"', "'") else lit[1:-1]
                if GLSL_MARKER_RE.search(body):
                    base_line = text[: sm.start(1)].count("\n") + 1
                    _scan_glsl_block(body, rel, base_line, shader_hits)
    return [
        _chk("src_files_scanned", True, len(targets), ">= 1 source/shader file", "source/shader files scanned"),
        _chk("src_local_assets_only", not cloud_hits, cloud_hits or "clean", "[]", "source files contain no cloud-only asset generator endpoints"),
        _chk("src_shader_nan_guards", not shader_hits, shader_hits or "clean", "[]", "GLSL pow/sqrt inputs guarded with max/abs/clamp or positive literals"),
    ]


def check_spec(spec, src_dir=None):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "top-level spec must be an object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - KNOWN_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized top-level keys: {', '.join(unknown)}"))

    subsystem_checks = []
    if "timestep" in spec:
        subsystem_checks.extend(check_fixed_timestep(spec["timestep"]))
    if "dolly_zoom" in spec:
        subsystem_checks.extend(check_dolly_zoom(spec["dolly_zoom"]))
    if "parallax_loop" in spec:
        subsystem_checks.extend(check_parallax_loop(spec["parallax_loop"]))
    if "particles" in spec:
        subsystem_checks.extend(check_particles_and_clouds(spec["particles"]))
    if "spring_bone" in spec:
        subsystem_checks.extend(check_spring_bone(spec["spring_bone"]))
    subsystem_checks.extend(check_vfx_and_audio(spec))
    policy_checks = check_inspection_and_policy(spec)
    if "inspect" in spec:
        subsystem_checks.extend(c for c in policy_checks if c["id"] != "local_assets_only")

    if not subsystem_checks:
        checks.append(_chk("has_subsystems", False, 0, ">= 1 subsystem", "spec must include at least one recognized game subsystem block"))
    checks.extend(subsystem_checks)
    checks.extend(c for c in policy_checks if c["id"] == "local_assets_only")
    if src_dir:
        checks.extend(check_source_dir(src_dir))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec")
    ap.add_argument("--src", default=None, help="optional build source folder to audit for cloud APIs and GLSL guards")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding="utf-8"))
    res = check_spec(spec, src_dir=a.src)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

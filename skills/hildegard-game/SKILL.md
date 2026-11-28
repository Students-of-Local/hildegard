---
name: hildegard-game
description: Build interactive 3D scenes and browser games with Three.js, procedural VFX, fixed-timestep simulation, and HRTF spatial audio, verified before delivery.
---

# Games and interactive 3D

Build interactive 3D scenes, browser games, procedural VFX, and spatial game audio with deterministic math, local assets,
and real-GPU verification.

This skill works alone. Without Hildegard: use Three.js, Web Audio, local GLB models (**hildegard-3d**), local audio
(**hildegard-music** and **hildegard-sound**), and run `python3 scripts/check_game.py spec.json` (pure Python 3 stdlib,
no extra packages needed) to verify simulation, camera, VFX, audio, and render-budget contracts before delivery. Never
wire cloud-only asset generators (Tripo, Meshy, ElevenLabs, Runway, Gemini image APIs).

## Fast path

1. **Write the scene contract** (`spec.json`) covering the subsystems your build uses: fixed timestep, camera rig,
   parallax/loop, particles/clouds, spring-bone secondary motion, VFX timeline, HRTF audio, and inspection budgets.
2. **Verify every invariant** before shipping:

   ```sh
   python3 scripts/check_game.py spec.json
   ```

   Every line must print `OK`. Fix any `FIX` line in the config and code, then re-run.
3. **Inspect on a real GPU** in headless Chromium (`channel: 'chromium'`, checking `WEBGL_debug_renderer_info`; reject
   SwiftShader/llvmpipe for visual signoff), capture screenshots of initial/active/end states, verify zero console errors,
   non-blank pixel entropy (`>= 2.0` bits) and edge density (`>= 0.01`), and check draw-call budgets.

## Engineering invariants (exact formulas)

### 1. Fixed-timestep simulation (`timestep`)

- Advance physics on a fixed step `dt_step` (`0.0166667` for 60 Hz, `0.0083333` for 120 Hz) inside an accumulator loop.
- Clamp raw frame delta to `dt_max <= 0.25` seconds so a 1.0 s tab-switch or lag spike never spirals or tunnels.
- Interpolate render poses by `alpha = accumulator / dt_step`.
- Seed every procedural/PRNG call with an explicit integer `"seed"` so two runs produce identical state.

### 2. Subject-locked dolly zoom (`dolly_zoom`)

Hold the visible half-height `H` at the subject plane constant while sweeping vertical FOV:

```text
distance = half_height / tan(radians(fov_deg) / 2)
```

Exact reference tangents: `fov_deg = 90` has `tan(45 deg) = 1.0` so `distance = half_height`; `fov_deg = 53.130102` has
`tan(26.565051 deg) = 0.5` so `distance = 2 * half_height`; `fov_deg = 60` has `tan(30 deg) = 0.57735027` so
`distance = half_height / 0.57735027`. Size every backdrop with `backdrop_half_height >= half_height` so wide-FOV corners
never clip.

### 3. Endless parallax and C1 vista loop (`parallax_loop`)

- Order `layers` from nearest to farthest: strictly increasing `depth` and strictly decreasing `speed`.
- Make periodic camera loops C1 continuous: `start_pos` equals `end_pos` and `start_vel` equals `end_vel` (within `1e-3`).

### 4. Wrapped particle corridor and Beer-Lambert clouds (`particles`)

- Fade particles smoothly to `wrap_alpha: 0.0` at both ends of a wrapped corridor so wrap seams are invisible.
- Keep `0 < fade_margin <= 0.45 * corridor_length`.
- Compute cloud transmittance with Beer-Lambert attenuation `T = exp(-cloud_density * cloud_thickness)` where both
  `cloud_density >= 0` and `cloud_thickness >= 0`.

### 5. Secondary motion spring bones (`spring_bone`)

- Integrate a damped spring (`stiffness`, `damping`) at fixed `dt_step <= 0.05` so energy decays smoothly and never explodes.
- Clamp bone tip displacement to `max_distance > 0` and keep `capsule_radius >= 0` outside body colliders.

### 6. Procedural VFX, HDR bloom, and cues (`vfx`)

- Use floating-point render targets (`"render_target_type": "HalfFloatType"` or `"FloatType"`) for HDR bloom.
- Provide a `"depth_texture_fallback": true` path for soft particles when depth textures are unavailable.
- Guard all custom GLSL `pow`, `sqrt`, and divisions with `max(x, 1e-5)` (`"nan_safe_shaders": true`).
- Trigger timeline cues with scrub-safe half-open interval checks `prevTime < cue <= nextTime` (`"cue_times": [...]`)
  so variable frame deltas fire each cue once with zero duplicates and zero misses.

### 7. Spatial Web Audio (`audio`)

- Route 3D game sounds through Web Audio `PannerNode` with `"panning_model": "HRTF"` and `"distance_model": "inverse"`.
- Sync `AudioListener` position, forward, and up vectors to the active camera every frame (`"listener_synced_to_camera": true`).

### 8. Real-GPU headless canvas inspection (`inspect`)

- Record the real GPU `"webgl_renderer"` string (reject `SwiftShader` or `llvmpipe`).
- Verify `"color_entropy_bits" >= 2.0`, `"edge_density" >= 0.01`, `"console_errors": 0`, and `"draw_calls" <= "max_draw_calls"`.

## Exact JSON schema for check_game.py

Include only the blocks relevant to the brief (all numeric fields use plain numbers):

```json
{
  "timestep": {
    "dt_step": 0.0166667,
    "dt_max": 0.25,
    "seed": 1337
  },
  "dolly_zoom": {
    "half_height": 2.0,
    "samples": [
      { "fov_deg": 90, "distance": 2.0, "backdrop_half_height": 2.5 },
      { "fov_deg": 53.130102, "distance": 4.0, "backdrop_half_height": 2.5 }
    ]
  },
  "parallax_loop": {
    "layers": [
      { "depth": 5, "speed": 10.0 },
      { "depth": 20, "speed": 4.0 },
      { "depth": 80, "speed": 1.0 }
    ],
    "start_pos": [0, 0, 0],
    "end_pos": [0, 0, 0],
    "start_vel": [0, 0, -5],
    "end_vel": [0, 0, -5]
  },
  "particles": {
    "wrap_alpha": 0.0,
    "corridor_length": 40.0,
    "fade_margin": 6.0,
    "cloud_density": 0.35,
    "cloud_thickness": 2.5
  },
  "spring_bone": {
    "stiffness": 120.0,
    "damping": 16.0,
    "max_distance": 0.45,
    "capsule_radius": 0.14,
    "dt_step": 0.0166667
  },
  "vfx": {
    "render_target_type": "HalfFloatType",
    "depth_texture_fallback": true,
    "nan_safe_shaders": true,
    "cue_times": [0.25, 0.75, 1.5]
  },
  "audio": {
    "panning_model": "HRTF",
    "distance_model": "inverse",
    "listener_synced_to_camera": true
  },
  "inspect": {
    "webgl_renderer": "Apple M3 GPU",
    "color_entropy_bits": 4.2,
    "edge_density": 0.08,
    "console_errors": 0,
    "draw_calls": 42,
    "max_draw_calls": 100
  }
}
```

## Deliver

Hand over the runnable build, screenshots of key states, and the `check_game.py` output (run with `--src <build-dir>` when
shipping JS/GLSL files so cloud endpoints and GLSL `pow`/`sqrt` guards are audited on source, not just declared in JSON).
State plainly what was simulated mechanically (`check_game.py`: fixed-timestep spike clamp, dolly-zoom math, parallax/C1
loop, Beer-Lambert transmittance, spring-bone damping, cue crossing), what was measured live in Chromium on a real GPU
(renderer string, draw calls, console errors, screenshots), and what remains open for human playtesting (game feel,
difficulty balance, and visual taste).

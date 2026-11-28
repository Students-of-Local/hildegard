// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic verification tests for spatial_mix.py, check_game.py, and check_game_asset.py (including neon-d R1 regressions).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const hasNumpy = spawnSync(python, ['-c', 'import numpy']).status === 0;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const SPATIAL_MIX = join(root, 'skills/hildegard-sound/scripts/spatial_mix.py');
const CHECK_GAME = join(root, 'skills/hildegard-game/scripts/check_game.py');
const CHECK_ASSET = join(root, 'skills/hildegard-3d/scripts/check_game_asset.py');

let dir: string;

const runPy = (script: string, args: string[]) =>
  spawnSync(python, ['-B', '-I', script, ...args], { encoding: 'utf8' });

describe('theon media, game, and 3D checks', { timeout: 60_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hildegard-theon-checks-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  describe.skipIf(!hasNumpy)('spatial_mix.py', () => {
    it('renders right-panned binaural audio with R>L energy, positive ITD, mono safety, and quiet windows', () => {
      const spec = join(dir, 'spatial-ok.json');
      const wav = join(dir, 'spatial-ok.wav');
      writeFileSync(
        spec,
        JSON.stringify({
          duration_s: 1.5,
          sample_rate: 48000,
          fps: 30,
          listener: { pos: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] },
          camera_cut_fade_ms: 6.0,
          camera_cuts: [{ t: 0.75, listener: { pos: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] } }],
          focus_margin_db: 8.0,
          gesture_dedupe_ms: 120,
          quiet_windows: [[0.9, 1.15]],
          sources: [
            {
              role: 'bed',
              spatial: true,
              pos: [2.0, 0.0, -1.0],
              signal: { kind: 'tone', freq_hz: 440, gain: 0.35 },
            },
          ],
          cues: [
            { frame: 5, group: 'ui', signal: { kind: 'click', gain: 0.4 } },
            { frame: 6, group: 'ui', signal: { kind: 'click', gain: 0.4 } },
            { frame: 18, group: 'ui', signal: { kind: 'click', gain: 0.4 } },
          ],
        }),
      );
      const r = runPy(SPATIAL_MIX, [spec, wav, '--json']);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.ok).toBe(true);
      expect(out.check.lr_db).toBeGreaterThan(1.5);
      expect(out.check.itd_ms).toBeGreaterThan(0.05);
      expect(out.check.mono_corr).toBeGreaterThanOrEqual(0.2);
      expect(out.render.placed_cues).toHaveLength(2);
      expect(out.check.quiet_peaks_db[0]).toBeLessThan(-45);
    });

    it('keeps mono_corr >= 0.2 on spatialized 1000 Hz tone and 6 kHz broadband noise', () => {
      for (const [name, signal] of [
        ['tone1k', { kind: 'tone', freq_hz: 1000, gain: 0.35 }],
        ['noise6k', { kind: 'noise', cutoff_hz: 6000, gain: 0.35 }],
      ] as const) {
        const sp = join(dir, `spatial-${name}.json`);
        const wav = join(dir, `spatial-${name}.wav`);
        writeFileSync(
          sp,
          JSON.stringify({
            duration_s: 1.0,
            sources: [{ role: 'bed', spatial: true, pos: [2.0, 0.0, -1.0], signal }],
          }),
        );
        const r = runPy(SPATIAL_MIX, [sp, wav, '--json']);
        expect(r.status, `${name}: ${r.stdout}`).toBe(0);
        const out = JSON.parse(r.stdout);
        expect(out.check.mono_corr, name).toBeGreaterThanOrEqual(0.2);
        expect(out.check.lr_db, name).toBeGreaterThan(1.5);
      }
    });

    it('preserves locked bed stem alongside unlocked focus stem, and preserves stereo unity gain on locked file stems', () => {
      // 1. Locked bed + unlocked focus + quiet window: locked bed must NOT cancel out, unlocked focus ducks in quiet window.
      const sp1 = join(dir, 'locked-bed-plus-focus.json');
      const wav1 = join(dir, 'locked-bed-plus-focus.wav');
      writeFileSync(
        sp1,
        JSON.stringify({
          duration_s: 1.0,
          quiet_windows: [[0.4, 0.7]],
          sources: [
            { role: 'bed', locked: true, signal: { kind: 'tone', freq_hz: 220, gain: 0.3 } },
            { role: 'focus', spatial: false, locked: false, signal: { kind: 'voice', gain: 0.25 } },
          ],
        }),
      );
      const r1 = runPy(SPATIAL_MIX, [sp1, wav1, '--json']);
      const out1 = JSON.parse(r1.stdout);
      // Locked bed remains loud (~-10 dBFS) even inside quiet_windows (it wasn't cancelled to silence).
      expect(out1.check.quiet_peaks_db[0]).toBeGreaterThan(-25);

      // 2. Stereo file stem marked locked: true passes through at unity gain (1.0) preserving stereo separation.
      const stereoSrc = join(dir, 'stereo-master.wav');
      const mkStereo = `
import wave, numpy as np
sr = 48000; n = sr
t = np.arange(n, dtype=np.float64) / sr
l = 0.5 * np.sin(2 * np.pi * 300 * t)
r = 0.1 * np.sin(2 * np.pi * 300 * t)
pcm = np.round(np.stack([l, r], axis=1) * 32767.0).astype(np.int16)
with wave.open(${JSON.stringify(stereoSrc)}, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
`;
      expect(spawnSync(python, ['-B', '-c', mkStereo]).status).toBe(0);
      const sp2 = join(dir, 'locked-stereo.json');
      const wav2 = join(dir, 'locked-stereo.wav');
      writeFileSync(
        sp2,
        JSON.stringify({
          duration_s: 1.0,
          sources: [{ role: 'focus', locked: true, signal: { kind: 'file', path: stereoSrc } }],
        }),
      );
      const r2 = runPy(SPATIAL_MIX, [sp2, wav2, '--json']);
      expect(r2.status, r2.stdout).toBe(0);
      const out2 = JSON.parse(r2.stdout);
      // Unity gain preserves ~0.5 peak (old 0.35 default would drop peak to ~0.105) and preserves L >> R (~-14 dB lr_db)
      expect(out2.check.sample_peak).toBeGreaterThan(0.45);
      expect(out2.check.lr_db).toBeLessThan(-10);
    });

    it.skipIf(!hasFfmpeg)('honors spec target_lufs and peak_dbtp in --check --spec and render modes', () => {
      const sp = join(dir, 'quiet-spec.json');
      const wav = join(dir, 'quiet-out.wav');
      writeFileSync(
        sp,
        JSON.stringify({
          duration_s: 1.0,
          sources: [{ role: 'bed', spatial: false, signal: { kind: 'tone', freq_hz: 440, gain: 0.05 } }],
        }),
      );
      expect(runPy(SPATIAL_MIX, [sp, wav, '--json']).status).toBe(0);

      // Checking that quiet (~-30 LUFS) wav against a spec demanding -16 LUFS must fail without --lufs on CLI.
      const strictSp = join(dir, 'strict-lufs.json');
      writeFileSync(strictSp, JSON.stringify({ target_lufs: -16, peak_dbtp: -1.0 }));
      const rCheck = runPy(SPATIAL_MIX, ['--check', wav, '--spec', strictSp, '--json']);
      expect(rCheck.status).toBe(1);
      const badIds = JSON.parse(rCheck.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id);
      expect(badIds).toContain('lufs');

      // Spec peak_dbtp (-6.0) must be enforced when --peak is omitted on CLI.
      const hotSp = join(dir, 'peak-spec.json');
      const hotWav = join(dir, 'peak-out.wav');
      writeFileSync(
        hotSp,
        JSON.stringify({
          duration_s: 1.0,
          peak_dbtp: -6.0,
          sources: [{ role: 'bed', spatial: false, signal: { kind: 'tone', freq_hz: 440, gain: 0.8 } }],
        }),
      );
      const rPeak = runPy(SPATIAL_MIX, [hotSp, hotWav, '--json']);
      expect(rPeak.status).toBe(1);
      const peakCheck = JSON.parse(rPeak.stdout).check.checks.find(
        (c: { id: string }) => c.id === 'true_peak',
      );
      expect(peakCheck.limit).toBe(-6.0);
      expect(peakCheck.ok).toBe(false);
    });

    it('rejects a camera cut fade longer than 8 ms', () => {
      const spec = join(dir, 'spatial-bad-fade.json');
      const wav = join(dir, 'spatial-bad-fade.wav');
      writeFileSync(
        spec,
        JSON.stringify({
          duration_s: 1.0,
          camera_cut_fade_ms: 25.0,
          sources: [{ role: 'bed', spatial: true, pos: [1, 0, -1], signal: { kind: 'tone' } }],
        }),
      );
      const r = runPy(SPATIAL_MIX, [spec, wav, '--json']);
      expect(r.status).not.toBe(0);
    });
  });

  describe('check_game.py', () => {
    it('passes valid contracts, rejects empty/typoed/invalid timestep & spring configs, and audits --src files', () => {
      const good = join(dir, 'game-ok.json');
      writeFileSync(
        good,
        JSON.stringify({
          timestep: { dt_step: 0.01666666666667, dt_max: 0.25, seed: 42 },
          dolly_zoom: {
            half_height: 2.0,
            samples: [
              { fov_deg: 90, distance: 2.0, backdrop_half_height: 2.5 },
              { fov_deg: 53.130102, distance: 4.0, backdrop_half_height: 2.5 },
            ],
          },
          parallax_loop: {
            layers: [
              { depth: 5, speed: 10 },
              { depth: 20, speed: 4 },
              { depth: 80, speed: 1 },
            ],
            start_pos: [0, 0, 0],
            end_pos: [0, 0, 0],
            start_vel: [0, 0, -5],
            end_vel: [0, 0, -5],
          },
          particles: {
            wrap_alpha: 0.0,
            corridor_length: 40,
            fade_margin: 6,
            cloud_density: 0.3,
            cloud_thickness: 2,
          },
          spring_bone: {
            stiffness: 120,
            damping: 16,
            max_distance: 0.45,
            capsule_radius: 0.14,
            dt_step: 1 / 60,
          },
          vfx: {
            render_target_type: 'HalfFloatType',
            depth_texture_fallback: true,
            nan_safe_shaders: true,
            cue_times: [0.2, 0.8],
          },
          audio: {
            panning_model: 'HRTF',
            distance_model: 'inverse',
            listener_synced_to_camera: true,
          },
          inspect: {
            webgl_renderer: 'Apple M3 GPU',
            color_entropy_bits: 4.1,
            edge_density: 0.06,
            console_errors: 0,
            draw_calls: 24,
            max_draw_calls: 80,
          },
        }),
      );
      const ok = runPy(CHECK_GAME, [good, '--json']);
      expect(ok.status, ok.stdout).toBe(0);
      expect(JSON.parse(ok.stdout).ok).toBe(true);

      // Must fail cleanly (never hang or crash) on empty spec, typoed key, empty subsystem, dt_step=0, dt_step=0.5, stiffness<0
      for (const [name, payload] of [
        ['empty', {}],
        ['typo', { time_step: { dt_step: 5.0 } }],
        ['empty-parallax', { parallax_loop: {} }],
        ['zero-dt', { timestep: { dt_step: 0, dt_max: 0.25, seed: 1 } }],
        ['spring-zero-dt', { spring_bone: { stiffness: 120, damping: 16, max_distance: 0.5, dt_step: 0 } }],
        [
          'spring-large-dt',
          { spring_bone: { stiffness: 120, damping: 16, max_distance: 0.5, dt_step: 0.5 } },
        ],
        [
          'spring-neg-k',
          { spring_bone: { stiffness: -100, damping: 16, max_distance: 0.5, dt_step: 1 / 60 } },
        ],
      ] as const) {
        const p = join(dir, `game-${name}.json`);
        writeFileSync(p, JSON.stringify(payload));
        const r = runPy(CHECK_GAME, [p, '--json']);
        expect(r.status, `${name}: ${r.stdout}`).toBe(1);
      }

      // --src static audit: missing path and empty directory must fail (never silently pass)
      expect(runPy(CHECK_GAME, [good, '--src', join(dir, 'nonexistent-dir'), '--json']).status).toBe(1);
      const emptySrc = join(dir, 'empty-src');
      mkdirSync(emptySrc, { recursive: true });
      expect(runPy(CHECK_GAME, [good, '--src', emptySrc, '--json']).status).toBe(1);

      // --src static audit: valid standalone & inline GLSL with positive literals and comments passes
      const cleanSrc = join(dir, 'clean-src');
      mkdirSync(cleanSrc, { recursive: true });
      writeFileSync(
        join(cleanSrc, 'safe.frag'),
        '// guard pow(x, 2.0)\n/* sqrt(y) */\nvoid main() { float k = 1.0 / sqrt(2.0); float p = pow(2.0, r) + pow(max(x, 1e-5), 2.0); }\n',
      );
      writeFileSync(
        join(cleanSrc, 'app.js'),
        'const v = Math.pow(x, 2) + Math.sqrt(y);\nconst frag = `void main() { float p = pow(abs(n), 2.0); }`;\n',
      );
      const rClean = runPy(CHECK_GAME, [good, '--src', cleanSrc, '--json']);
      expect(rClean.status, rClean.stdout).toBe(0);

      // --src static audit catches single-file cloud URL, inline JS/HTML shaders, multi-line pow, and nested sqrt(max(pow(x,2),1e-5))
      const srcDir = join(dir, 'bad-src');
      mkdirSync(srcDir, { recursive: true });
      const badJs = join(srcDir, 'main.js');
      writeFileSync(
        badJs,
        'const url = "https://api.tripo3d.ai/v2/mesh";\nconst frag = "void main() { float y = pow(x, 2.0); }";\n',
      );
      const rSingle = runPy(CHECK_GAME, [good, '--src', badJs, '--json']);
      expect(rSingle.status).toBe(1);
      const singleBad = JSON.parse(rSingle.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id);
      expect(singleBad).toContain('src_local_assets_only');
      expect(singleBad).toContain('src_shader_nan_guards');

      const htmlDir = join(dir, 'bad-html');
      mkdirSync(htmlDir, { recursive: true });
      writeFileSync(
        join(htmlDir, 'index.html'),
        '<script type="x-shader/x-fragment">void main() { float y = sqrt(max(pow(\n  x, 2.0), 1e-5)); }</script>\n',
      );
      const rHtml = runPy(CHECK_GAME, [good, '--src', htmlDir, '--json']);
      expect(rHtml.status).toBe(1);
      expect(
        JSON.parse(rHtml.stdout)
          .checks.filter((c: { ok: boolean }) => !c.ok)
          .map((c: { id: string }) => c.id),
      ).toContain('src_shader_nan_guards');
    });
  });

  describe.skipIf(!hasNumpy)('check_game_asset.py', () => {
    const runGlbBuilder = (code: string) => {
      const r = spawnSync(python, ['-B', '-c', code], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    };

    it('handles normalized integer UVs/weights, parent/matrix scale, WEIGHTS_1, missing skin, and TRIANGLE_STRIP/LINES modes', () => {
      // 1. Valid GLB with UNSIGNED_BYTE normalized WEIGHTS_0 and UNSIGNED_SHORT normalized TEXCOORD_0 + explicit node skin
      const normGlb = join(dir, 'norm-ok.glb');
      runGlbBuilder(`
import json, struct, numpy as np
v = np.array([[-0.5,0,-0.5],[0.5,0,-0.5],[0.5,1,-0.5],[-0.5,1,-0.5],
              [-0.5,0,0.5],[0.5,0,0.5],[0.5,1,0.5],[-0.5,1,0.5]], dtype=np.float32)
tris = np.array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], dtype=np.uint16)
uv = np.array([[0,0],[65535,0],[65535,65535],[0,65535],[6553,6553],[58981,6553],[58981,58981],[6553,58981]], dtype=np.uint16)
jts = np.tile(np.array([0,1,2,3], dtype=np.uint8), (8,1))
wts = np.tile(np.array([128,77,50,0], dtype=np.uint8), (8,1))
buf, bvs, accs = bytearray(), [], []
def add(raw, ct, tp, cnt, norm=False):
    while len(buf) % 4: buf.append(0)
    off = len(buf); buf.extend(raw)
    bvs.append({"buffer":0,"byteOffset":off,"byteLength":len(raw)})
    a = {"bufferView":len(bvs)-1,"componentType":ct,"count":cnt,"type":tp}
    if norm: a["normalized"] = True
    accs.append(a); return len(accs)-1
attrs = {"POSITION": add(v.tobytes(), 5126, "VEC3", 8),
         "TEXCOORD_0": add(uv.tobytes(), 5123, "VEC2", 8, True),
         "JOINTS_0": add(jts.tobytes(), 5121, "VEC4", 8),
         "WEIGHTS_0": add(wts.tobytes(), 5121, "VEC4", 8, True)}
doc = {"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
       "nodes":[{"name":"body","mesh":0,"skin":0},{"name":"j0"},{"name":"j1"},{"name":"j2"},{"name":"j3"}],
       "meshes":[{"name":"body","primitives":[{"attributes":attrs,"indices":add(tris.tobytes(),5123,"SCALAR",len(tris)),"material":0}]}],
       "materials":[{"name":"m0"}],"skins":[{"joints":[1,2,3,4]}],
       "buffers":[{"byteLength":len(buf)}],"bufferViews":bvs,"accessors":accs}
jb = json.dumps(doc).encode()
while len(jb) % 4: jb += b" "
while len(buf) % 4: buf.append(0)
with open(${JSON.stringify(normGlb)}, "wb") as f:
    f.write(struct.pack("<4sII", b"glTF", 2, 12+8+len(jb)+8+len(buf)))
    f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
    f.write(struct.pack("<II", len(buf), 0x004E4942)); f.write(buf)
`);
      const rNorm = runPy(CHECK_ASSET, [normGlb, '--require-uv', '--require-rig', '--json']);
      expect(rNorm.status, rNorm.stdout).toBe(0);
      expect(JSON.parse(rNorm.stdout).verdict).toBe('SHIP');

      // 2. Parent node scale [2,2,2] + WEIGHTS_1 (>4 influences) + missing skin must FAIL clean_transforms & skinning_hygiene
      const badParentGlb = join(dir, 'bad-parent.glb');
      runGlbBuilder(`
import json, struct, numpy as np
v = np.array([[0,0,0],[1,0,0],[0,1,0],[1,1,0]], dtype=np.float32)
idx = np.array([0,1,2,3], dtype=np.uint16)  # 4-vert TRIANGLE_STRIP -> 2 triangles
jts = np.tile(np.array([0,1,2,3], dtype=np.uint8), (4,1))
w0 = np.tile(np.array([0.2,0.2,0.2,0.2], dtype=np.float32), (4,1))
w1 = np.tile(np.array([0.2,0.0,0.0,0.0], dtype=np.float32), (4,1))
buf, bvs, accs = bytearray(), [], []
def add(raw, ct, tp, cnt):
    while len(buf) % 4: buf.append(0)
    off = len(buf); buf.extend(raw)
    bvs.append({"buffer":0,"byteOffset":off,"byteLength":len(raw)})
    accs.append({"bufferView":len(bvs)-1,"componentType":ct,"count":cnt,"type":tp})
    return len(accs)-1
attrs = {"POSITION": add(v.tobytes(), 5126, "VEC3", 4),
         "JOINTS_0": add(jts.tobytes(), 5121, "VEC4", 4), "WEIGHTS_0": add(w0.tobytes(), 5126, "VEC4", 4),
         "JOINTS_1": add(jts.tobytes(), 5121, "VEC4", 4), "WEIGHTS_1": add(w1.tobytes(), 5126, "VEC4", 4)}
# Primitive 0: TRIANGLE_STRIP (mode 5, 2 tris); Primitive 1: LINES (mode 1, 0 tris)
p0 = {"attributes": attrs, "indices": add(idx.tobytes(), 5123, "SCALAR", 4), "mode": 5, "material": 0}
p1 = {"attributes": {"POSITION": 0}, "indices": add(np.array([0,1], dtype=np.uint16).tobytes(), 5123, "SCALAR", 2), "mode": 1}
doc = {"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
       "nodes":[{"name":"root","scale":[2,2,2],"children":[1]},{"name":"child","mesh":0}],
       "meshes":[{"name":"strip","primitives":[p0, p1]}],"materials":[{"name":"m0"}],
       "buffers":[{"byteLength":len(buf)}],"bufferViews":bvs,"accessors":accs}
jb = json.dumps(doc).encode()
while len(jb) % 4: jb += b" "
while len(buf) % 4: buf.append(0)
with open(${JSON.stringify(badParentGlb)}, "wb") as f:
    f.write(struct.pack("<4sII", b"glTF", 2, 12+8+len(jb)+8+len(buf)))
    f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
    f.write(struct.pack("<II", len(buf), 0x004E4942)); f.write(buf)
`);
      const rBad = runPy(CHECK_ASSET, [badParentGlb, '--require-rig', '--json']);
      expect(rBad.status).toBe(1);
      const parsed = JSON.parse(rBad.stdout);
      expect(parsed.info.triangles).toBe(2); // mode 5 strip = 2 tris, mode 1 lines = 0 tris
      expect(parsed.info.max_influences).toBe(5); // caught WEIGHTS_1 5th influence
      const badIds = parsed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
      expect(badIds).toContain('clean_transforms');
      expect(badIds).toContain('skinning_hygiene');

      // 3. Single-skin GLB whose mesh node omits `"skin": 0` MUST fail skinning_hygiene (no len(skins)==1 fallback)
      const unboundSkinGlb = join(dir, 'unbound-skin.glb');
      runGlbBuilder(`
import json, struct, numpy as np
v = np.array([[-0.5,0,-0.5],[0.5,0,-0.5],[0.5,1,-0.5],[-0.5,1,-0.5],
              [-0.5,0,0.5],[0.5,0,0.5],[0.5,1,0.5],[-0.5,1,0.5]], dtype=np.float32)
tris = np.array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], dtype=np.uint16)
jts = np.tile(np.array([0,1,2,3], dtype=np.uint8), (8,1))
wts = np.tile(np.array([0.5,0.3,0.2,0.0], dtype=np.float32), (8,1))
buf, bvs, accs = bytearray(), [], []
def add(raw, ct, tp, cnt):
    while len(buf) % 4: buf.append(0)
    off = len(buf); buf.extend(raw)
    bvs.append({"buffer":0,"byteOffset":off,"byteLength":len(raw)})
    accs.append({"bufferView":len(bvs)-1,"componentType":ct,"count":cnt,"type":tp})
    return len(accs)-1
attrs = {"POSITION": add(v.tobytes(), 5126, "VEC3", 8),
         "JOINTS_0": add(jts.tobytes(), 5121, "VEC4", 8),
         "WEIGHTS_0": add(wts.tobytes(), 5126, "VEC4", 8)}
doc = {"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
       "nodes":[{"name":"body","mesh":0},{"name":"j0"},{"name":"j1"},{"name":"j2"},{"name":"j3"}],
       "meshes":[{"name":"body","primitives":[{"attributes":attrs,"indices":add(tris.tobytes(),5123,"SCALAR",len(tris)),"material":0}]}],
       "materials":[{"name":"m0"}],"skins":[{"joints":[1,2,3,4]}],
       "buffers":[{"byteLength":len(buf)}],"bufferViews":bvs,"accessors":accs}
jb = json.dumps(doc).encode()
while len(jb) % 4: jb += b" "
while len(buf) % 4: buf.append(0)
with open(${JSON.stringify(unboundSkinGlb)}, "wb") as f:
    f.write(struct.pack("<4sII", b"glTF", 2, 12+8+len(jb)+8+len(buf)))
    f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
    f.write(struct.pack("<II", len(buf), 0x004E4942)); f.write(buf)
`);
      const rUnbound = runPy(CHECK_ASSET, [unboundSkinGlb, '--require-rig', '--json']);
      expect(rUnbound.status, rUnbound.stdout).toBe(1);
      expect(
        JSON.parse(rUnbound.stdout)
          .checks.filter((c: { ok: boolean }) => !c.ok)
          .map((c: { id: string }) => c.id),
      ).toContain('skinning_hygiene');
    });
  });
});

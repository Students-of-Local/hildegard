// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic verification tests for spatial_mix.py, check_game.py, check_game_asset.py and check_sync.py.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const hasNumpy = spawnSync(python, ['-c', 'import numpy']).status === 0;

const SPATIAL_MIX = join(root, 'skills/hildegard-sound/scripts/spatial_mix.py');
const CHECK_GAME = join(root, 'skills/hildegard-game/scripts/check_game.py');
const CHECK_ASSET = join(root, 'skills/hildegard-3d/scripts/check_game_asset.py');

let dir: string;

const runPy = (script: string, args: string[]) =>
  spawnSync(python, ['-B', '-I', script, ...args], { encoding: 'utf8' });

describe('theon media, game, 3D and sync checks', { timeout: 60_000 }, () => {
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
    it('passes a valid game contract and fails broken dolly zoom, cloud APIs, or SwiftShader', () => {
      const good = join(dir, 'game-ok.json');
      writeFileSync(
        good,
        JSON.stringify({
          timestep: { dt_step: 1 / 60, dt_max: 0.25, seed: 42 },
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
          audio: { panning_model: 'HRTF', distance_model: 'inverse', listener_synced_to_camera: true },
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

      const bad = join(dir, 'game-bad.json');
      writeFileSync(
        bad,
        JSON.stringify({
          dolly_zoom: {
            half_height: 2.0,
            samples: [
              { fov_deg: 90, distance: 5.0 },
              { fov_deg: 60, distance: 5.0 },
            ],
          },
          inspect: {
            webgl_renderer: 'Google SwiftShader',
            color_entropy_bits: 0.5,
            edge_density: 0.0,
            console_errors: 2,
          },
          assets: 'https://api.tripo3d.ai/v2',
        }),
      );
      const fail = runPy(CHECK_GAME, [bad, '--json']);
      expect(fail.status).toBe(1);
      const parsed = JSON.parse(fail.stdout);
      const failedIds = parsed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
      expect(failedIds).toContain('dolly_height_invariant');
      expect(failedIds).toContain('real_gpu_renderer');
      expect(failedIds).toContain('local_assets_only');
    });
  });

  describe.skipIf(!hasNumpy)('check_game_asset.py', () => {
    const buildGlb = (outPath: string, opts: { gap?: number; scale?: number[]; badWeights?: boolean }) => {
      const helper = `
import json, struct, numpy as np
gap = ${opts.gap ?? 0.0}
sc = ${JSON.stringify(opts.scale ?? [1, 1, 1])}
bw = ${opts.badWeights ? 'True' : 'False'}
def box(cy):
    return np.array([[-0.5,cy-0.5,-0.5],[0.5,cy-0.5,-0.5],[0.5,cy+0.5,-0.5],[-0.5,cy+0.5,-0.5],
                     [-0.5,cy-0.5,0.5],[0.5,cy-0.5,0.5],[0.5,cy+0.5,0.5],[-0.5,cy+0.5,0.5]], dtype=np.float32)
tris = np.array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], dtype=np.uint16)
uv = np.array([[0,0],[1,0],[1,1],[0,1],[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]], dtype=np.float32)
jts = np.tile(np.array([0,1,2,3], dtype=np.uint8), (8,1))
wts = np.tile(np.array([0.8,0.5,0.0,0.0] if bw else [0.5,0.3,0.2,0.0], dtype=np.float32), (8,1))
buf, bvs, accs, meshes, nodes = bytearray(), [], [], [], []
def add(raw, ct, tp, cnt):
    while len(buf) % 4: buf.append(0)
    off = len(buf); buf.extend(raw)
    bvs.append({"buffer":0,"byteOffset":off,"byteLength":len(raw)})
    accs.append({"bufferView":len(bvs)-1,"componentType":ct,"count":cnt,"type":tp})
    return len(accs)-1
for i, cy in enumerate([0.5, 1.5 + gap]):
    v = box(cy)
    attrs = {"POSITION": add(v.tobytes(), 5126, "VEC3", 8), "TEXCOORD_0": add(uv.tobytes(), 5126, "VEC2", 8),
             "JOINTS_0": add(jts.tobytes(), 5121, "VEC4", 8), "WEIGHTS_0": add(wts.tobytes(), 5126, "VEC4", 8)}
    meshes.append({"name": f"p{i}", "primitives": [{"attributes": attrs, "indices": add(tris.tobytes(), 5123, "SCALAR", len(tris)), "material": 0}]})
    nodes.append({"name": f"p{i}", "mesh": i, "scale": sc})
for j in range(4): nodes.append({"name": f"j{j}"})
doc = {"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0,1]}],"nodes":nodes,"meshes":meshes,"materials":[{"name":"m0"}],
       "skins":[{"joints":[2,3,4,5]}],"buffers":[{"byteLength":len(buf)}],"bufferViews":bvs,"accessors":accs}
jb = json.dumps(doc).encode()
while len(jb) % 4: jb += b" "
while len(buf) % 4: buf.append(0)
with open(${JSON.stringify(outPath)}, "wb") as f:
    f.write(struct.pack("<4sII", b"glTF", 2, 12+8+len(jb)+8+len(buf)))
    f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
    f.write(struct.pack("<II", len(buf), 0x004E4942)); f.write(buf)
`;
      const r = spawnSync(python, ['-B', '-c', helper], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    };

    it('ships a clean touching GLB with unit scale, UVs and normalized weights, and rejects floating/unapplied/bad-weight GLBs', () => {
      const good = join(dir, 'asset-ok.glb');
      const bad = join(dir, 'asset-bad.glb');
      buildGlb(good, { gap: 0.0, scale: [1, 1, 1], badWeights: false });
      buildGlb(bad, { gap: 0.35, scale: [2, 1, 1], badWeights: true });

      const rOk = runPy(CHECK_ASSET, [
        good,
        '--require-uv',
        '--require-rig',
        '--contact-tol',
        '0.02',
        '--json',
      ]);
      expect(rOk.status, rOk.stdout).toBe(0);
      expect(JSON.parse(rOk.stdout).verdict).toBe('SHIP');

      const rBad = runPy(CHECK_ASSET, [
        bad,
        '--require-uv',
        '--require-rig',
        '--contact-tol',
        '0.02',
        '--json',
      ]);
      expect(rBad.status).toBe(1);
      const parsed = JSON.parse(rBad.stdout);
      expect(parsed.verdict).toBe('NO-SHIP');
      const badIds = parsed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
      expect(badIds).toContain('clean_transforms');
      expect(badIds).toContain('assembly_contact');
      expect(badIds).toContain('skinning_hygiene');
    });
  });
});

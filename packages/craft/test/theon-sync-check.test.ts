// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic tests for check_sync.py (log-space zoom, cyclic shake seams, beat frames, video liveness & beat sync).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const CHECK_SYNC = join(root, 'skills/hildegard-video-edit/scripts/check_sync.py');

let dir: string;
const runPy = (args: string[]) => spawnSync(python, ['-B', '-I', CHECK_SYNC, ...args], { encoding: 'utf8' });

describe('check_sync.py', { timeout: 60_000 }, () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hildegard-sync-check-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('validates log-space zoom, cyclic shake seams and beat frame math, and catches stale/invalid zoom samples', () => {
    const good = join(dir, 'cam-ok.json');
    writeFileSync(
      good,
      JSON.stringify({
        seed: 7,
        contact_sheet_frames: 10,
        fps: 30,
        zoom: {
          start_scale: 1,
          end_scale: 4,
          samples: [1, 2, 4],
          pan_x: 10,
          pan_y: 5,
          max_pan_x: 30,
          max_pan_y: 20,
          mipmap_levels: 4,
        },
        shake: { period_s: 2.0, freqs_hz: [0.5, 1.0, 2.5] },
        beats: [
          { t: 0.5, frame: 15 },
          { t: 2.0, frame: 60 },
        ],
      }),
    );
    expect(runPy(['--camera', good, '--json']).status).toBe(0);

    // Pan-only zoom block without start_scale/end_scale must not crash with KeyError.
    const panOnly = join(dir, 'cam-pan-only.json');
    writeFileSync(
      panOnly,
      JSON.stringify({
        seed: 7,
        contact_sheet_frames: 10,
        zoom: { pan_x: 10, pan_y: 5, max_pan_x: 30, max_pan_y: 20, mipmap_levels: 4 },
      }),
    );
    expect(runPy(['--camera', panOnly, '--json']).status).toBe(0);

    // Stale template samples (end_scale 9 vs samples ending at 4), non-positive samples, and < 3 samples must all fail.
    for (const [name, zoom] of [
      ['stale', { start_scale: 1, end_scale: 9, samples: [1, 2, 4] }],
      ['zeros', { start_scale: 1, end_scale: 4, samples: [0, 0, 0] }],
      ['negative', { start_scale: 1, end_scale: 4, samples: [-1, -2, -4] }],
      ['short', { start_scale: 1, end_scale: 4, samples: [1, 4] }],
      ['bad-start', { start_scale: 0, end_scale: 4, samples: [1, 2, 4] }],
    ] as const) {
      const p = join(dir, `cam-${name}.json`);
      writeFileSync(p, JSON.stringify({ seed: 7, contact_sheet_frames: 10, zoom }));
      const r = runPy(['--camera', p, '--json']);
      expect(r.status, name).toBe(1);
      const badIds = JSON.parse(r.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id);
      expect(badIds, name).toContain('log_space_zoom');
    }

    const bad = join(dir, 'cam-bad.json');
    writeFileSync(
      bad,
      JSON.stringify({
        seed: 7,
        contact_sheet_frames: 10,
        fps: 30,
        zoom: {
          start_scale: 1,
          end_scale: 4,
          samples: [1, 2.5, 4],
          pan_x: 50,
          pan_y: 0,
          max_pan_x: 30,
          max_pan_y: 20,
          mipmap_levels: 2,
        },
        shake: { period_s: 2.0, freqs_hz: [0.33] },
        beats: [{ t: 0.5, frame: 17 }],
      }),
    );
    const r = runPy(['--camera', bad, '--json']);
    expect(r.status).toBe(1);
    const badIds = JSON.parse(r.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('log_space_zoom');
    expect(badIds).toContain('camera_bounds');
    expect(badIds).toContain('mipmap_levels');
    expect(badIds).toContain('cyclic_shake_seam');
    expect(badIds).toContain('beat_frame_math');
  });

  it.skipIf(!hasFfmpeg)(
    'detects frozen vs localized live motion and aligns 24 fps beat cuts within 45 ms',
    () => {
      const frozen = join(dir, 'frozen.mp4');
      const localized = join(dir, 'localized.mp4');
      const cut24 = join(dir, 'cut24.mp4');
      const beatsOk = join(dir, 'beats-ok.json');
      const beatsBad = join(dir, 'beats-bad.json');

      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x90:r=20:d=3',
        '-pix_fmt',
        'yuv420p',
        frozen,
      ]);
      // Localized motion (~1% of frame: a small 12x12 white box sweeping across a static navy background)
      // Global mean diff stays < 0.003 (fails old 0.008 threshold), while localized max diff passes.
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x102040:s=160x90:r=20:d=3',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:s=12x12:r=20:d=3',
        '-filter_complex',
        "[0:v][1:v]overlay=x='10+25*t':y=38:shortest=1",
        '-pix_fmt',
        'yuv420p',
        localized,
      ]);
      expect(runPy(['--video', frozen, '--min-liveness', '0.5', '--json']).status).toBe(1);
      expect(runPy(['--video', localized, '--min-liveness', '0.5', '--json']).status).toBe(0);

      // 24 fps cut at frame 11 (t = 11/24 = 0.4583 s), matching beat at t = 0.45 s under round(t * fps).
      const partA = join(dir, 'a24.mp4');
      const partB = join(dir, 'b24.mp4');
      const list = join(dir, 'list24.txt');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x102040:s=160x90:r=24:d=0.458333',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:s=24x24:r=24:d=0.458333',
        '-filter_complex',
        "[0:v][1:v]overlay=x='10+40*t':y=30:shortest=1",
        '-pix_fmt',
        'yuv420p',
        partA,
      ]);
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0xe07020:s=160x90:r=24:d=2.0',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=24x24:r=24:d=2.0',
        '-filter_complex',
        "[0:v][1:v]overlay=x='10+40*t':y=30:shortest=1",
        '-pix_fmt',
        'yuv420p',
        partB,
      ]);
      writeFileSync(list, `file '${partA}'\nfile '${partB}'\n`);
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-c',
        'copy',
        cut24,
      ]);

      writeFileSync(beatsOk, JSON.stringify([{ t: 0.45 }]));
      writeFileSync(beatsBad, JSON.stringify([{ t: 0.8 }]));
      const rOk = runPy([
        '--video',
        cut24,
        '--beats',
        beatsOk,
        '--tol-ms',
        '45',
        '--min-liveness',
        '0.5',
        '--json',
      ]);
      expect(rOk.status, rOk.stdout).toBe(0);
      const rBad = runPy([
        '--video',
        cut24,
        '--beats',
        beatsBad,
        '--tol-ms',
        '45',
        '--min-liveness',
        '0.5',
        '--json',
      ]);
      expect(rBad.status, rBad.stdout).toBe(1);
    },
  );
});

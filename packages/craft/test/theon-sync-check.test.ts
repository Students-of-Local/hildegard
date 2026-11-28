// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic tests for check_sync.py (log-space zoom, cyclic shake seams, beat frames, video liveness).
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

  it('validates log-space zoom, cyclic shake seams and beat frame math, and catches linear zoom or seam drift', () => {
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

  it.skipIf(!hasFfmpeg)('detects dead frozen video vs live moving video with --video', () => {
    const frozen = join(dir, 'frozen.mp4');
    const live = join(dir, 'live.mp4');
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
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=20:d=3',
      '-pix_fmt',
      'yuv420p',
      live,
    ]);
    expect(runPy(['--video', frozen, '--min-liveness', '0.5', '--json']).status).toBe(1);
    expect(runPy(['--video', live, '--min-liveness', '0.5', '--json']).status).toBe(0);
  });
});

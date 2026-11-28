// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic tests for check_sync.py (log-space zoom, cyclic shake seams, beat frames, video liveness & beat sync).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

      // Motion QA: --max-freeze 0.5 fails frozen video and passes continuous localized motion
      const rFreezeBad = runPy([
        '--video',
        frozen,
        '--hold-tail',
        '0',
        '--max-freeze',
        '0.5',
        '--min-liveness',
        '0',
        '--json',
      ]);
      expect(rFreezeBad.status, rFreezeBad.stdout).toBe(1);
      expect(
        JSON.parse(rFreezeBad.stdout)
          .checks.filter((c: { ok: boolean }) => !c.ok)
          .map((c: { id: string }) => c.id),
      ).toContain('unintended_freezes');

      const rFreezeOk = runPy([
        '--video',
        localized,
        '--hold-tail',
        '0',
        '--max-freeze',
        '0.5',
        '--min-liveness',
        '0.5',
        '--json',
      ]);
      expect(rFreezeOk.status, rFreezeOk.stdout).toBe(0);

      // Post-AAC loudness & true peak check: encode an AAC MP4 near -14 LUFS / <= -2 dBTP vs a clipped 0 dBFS AAC MP4
      const aacOk = join(dir, 'aac-ok.mp4');
      const aacHot = join(dir, 'aac-hot.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        localized,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-af',
        'volume=8dB',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        aacOk,
      ]);
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        localized,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-af',
        'volume=20dB',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        aacHot,
      ]);
      const rAacOk = runPy([
        '--video',
        aacOk,
        '--min-liveness',
        '0.5',
        '--post-aac-lufs',
        '-14',
        '--post-aac-peak',
        '-2.0',
        '--json',
      ]);
      expect(rAacOk.status, rAacOk.stdout).toBe(0);
      const rAacHot = runPy([
        '--video',
        aacHot,
        '--min-liveness',
        '0.5',
        '--post-aac-lufs',
        '-14',
        '--post-aac-peak',
        '-2.0',
        '--json',
      ]);
      expect(rAacHot.status, rAacHot.stdout).toBe(1);
      const hotBad = JSON.parse(rAacHot.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id);
      expect(hotBad).toContain('post_aac_peak');

      // --static skips frame_liveness for honest static footage / reading holds while keeping post-AAC checks active
      const staticAac = join(dir, 'static-aac.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        frozen,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-af',
        'volume=8dB',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        staticAac,
      ]);
      expect(
        runPy(['--video', staticAac, '--post-aac-lufs', '-14', '--post-aac-peak', '-2.0', '--json']).status,
      ).toBe(1);
      const rStatic = runPy([
        '--video',
        staticAac,
        '--static',
        '--post-aac-lufs',
        '-14',
        '--post-aac-peak',
        '-2.0',
        '--json',
      ]);
      expect(rStatic.status, rStatic.stdout).toBe(0);

      // Verify hildegard-video-edit SKILL.md uses numeric setpts offset (never FFmpeg's built-in T variable) and that the shifted overlay keeps 1x timing
      const videoEditSkill = readFileSync(join(root, 'skills/hildegard-video-edit/SKILL.md'), 'utf8');
      expect(videoEditSkill).not.toContain('setpts=PTS-STARTPTS+T/TB');
      expect(videoEditSkill).toContain('setpts=PTS-STARTPTS+<offset_s>/TB');
      const shifted = join(dir, 'shifted.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x102040:s=160x90:r=20:d=2',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:s=24x24:r=20:d=1',
        '-filter_complex',
        '[1:v]setpts=PTS-STARTPTS+0.5/TB[ov];[0:v][ov]overlay=10:10:eof_action=pass',
        '-pix_fmt',
        'yuv420p',
        shifted,
      ]);
      expect(runPy(['--video', shifted, '--static', '--json']).status).toBe(0);
    },
  );

  it('validates closed-form motion, master timing clock, hero framing widths, and seam vector-sign contracts', () => {
    const goodQa = join(dir, 'qa-ok.json');
    writeFileSync(
      goodQa,
      JSON.stringify({
        seed: 7,
        contact_sheet_frames: 10,
        motion: {
          closed_form: true,
          feel: 'single_bounce',
          damping_ratio: 0.8,
          ease_in: 'cubic-bezier(0.16, 1, 0.3, 1)',
          ease_out: 'cubic-bezier(0.7, 0, 0.84, 0)',
          ease_in_ms: 700,
          ease_out_ms: 350,
        },
        timing: {
          fps: 60,
          bpm: 120,
          frames_per_beat: 30,
          events: [
            { visual_frame: 30, audio_frame: 31 },
            { visual_frame: 60, audio_frame: 61 },
          ],
          seamless_loop: true,
          total_frames: 120,
          last_frame: 119,
        },
        framing: {
          separate_planes: true,
          shots: [
            { kind: 'main', hero_width_px: 195, frame_height: 1080 },
            { kind: 'wide', hero_width_px: 105, frame_height: 1080 },
          ],
        },
        seams: {
          stage_bg_opaque: true,
          transitions: [
            { axis: 'x', exit_dir: 'left', entry_dir: 'left', cut_mid_motion: true },
            { axis: 'z', exit_dir: 'push', entry_dir: 'push', cut_mid_motion: true },
          ],
        },
      }),
    );
    const rOk = runPy(['--camera', goodQa, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    const badQa = join(dir, 'qa-bad.json');
    writeFileSync(
      badQa,
      JSON.stringify({
        seed: 7,
        contact_sheet_frames: 10,
        motion: {
          closed_form: false,
          feel: 'dead_still',
          damping_ratio: 0.5,
          ease_in: 'smooth',
          ease_out: 'linear',
          ease_in_ms: 500,
          ease_out_ms: 500,
        },
        timing: {
          fps: 60,
          bpm: 120,
          frames_per_beat: 24,
          events: [{ visual_frame: 30, audio_frame: 30 }],
          seamless_loop: true,
          total_frames: 120,
          last_frame: 120,
        },
        framing: {
          separate_planes: false,
          shots: [{ kind: 'main', hero_width_px: 80, frame_height: 1080 }],
        },
        seams: {
          stage_bg_opaque: false,
          transitions: [
            { axis: 'z', exit_dir: 'pull', entry_dir: 'push', cut_mid_motion: false },
            { axis: 'x', exit_dir: 'left', entry_dir: 'left', cut_mid_motion: true },
            { axis: 'x', exit_dir: 'right', entry_dir: 'right', cut_mid_motion: true },
          ],
        },
      }),
    );
    const rBad = runPy(['--camera', badQa, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('closed_form_motion');
    expect(badIds).toContain('spring_damping_ratio');
    expect(badIds).toContain('ease_in_curve');
    expect(badIds).toContain('exit_shorter_than_entry');
    expect(badIds).toContain('frames_per_beat');
    expect(badIds).toContain('audio_lag_1f');
    expect(badIds).toContain('seamless_loop_bounds');
    expect(badIds).toContain('hero_min_width_px');
    expect(badIds).toContain('separate_planes');
    expect(badIds).toContain('opaque_stage_ground');
    expect(badIds).toContain('seam_vector_law');
    expect(badIds).toContain('seam_mid_motion');
    expect(badIds).toContain('no_uncaused_ping_pong');

    // Off-axis named directions (e.g. x with pull, z with right/down) MUST fail seam_vector_law
    for (const [label, row] of [
      ['x-pull', { axis: 'x', exit_dir: 'left', entry_dir: 'pull', cut_mid_motion: true }],
      ['z-right-down', { axis: 'z', exit_dir: 'right', entry_dir: 'down', cut_mid_motion: true }],
    ] as const) {
      const p = join(dir, `seam-${label}.json`);
      writeFileSync(
        p,
        JSON.stringify({
          seed: 7,
          contact_sheet_frames: 8,
          seams: { stage_bg_opaque: true, transitions: [row] },
        }),
      );
      const r = runPy(['--camera', p, '--json']);
      expect(r.status, `${label}: ${r.stdout}`).toBe(1);
      expect(
        JSON.parse(r.stdout)
          .checks.filter((c: { ok: boolean }) => !c.ok)
          .map((c: { id: string }) => c.id),
      ).toContain('seam_vector_law');
    }
  });
});

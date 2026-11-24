// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-video-edit's caption commands, run as written: the text lands on the frame, whole. Until 2026-11-24 the skill
// said to raise MarginV to about 300 for a vertical video; libass counts margins on a 288-line canvas, so nothing showed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const skill = readFileSync(
  resolve(import.meta.dirname, '../../../skills/hildegard-video-edit/SKILL.md'),
  'utf8',
);
const filters = [...skill.matchAll(/-vf "(subtitles=captions\.srt:[^"]+)"/g)].map((m) => m[1] ?? '');
const size = (filter: string) =>
  ['X', 'Y'].map((axis) => Number(filter.match(new RegExp(`PlayRes${axis}=(\\d+)`))?.[1])) as [
    number,
    number,
  ];
const canRender =
  spawnSync('ffmpeg', ['-hide_banner', '-h', 'filter=subtitles'], { encoding: 'utf8' }).stdout?.includes(
    'force_style',
  ) ?? false;

/** The rows and columns that hold text when `filter` draws a long caption on a black frame. */
function drawn(filter: string, [w, h]: [number, number], dir: string) {
  const px = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=black:s=${w}x${h}:d=1`,
      '-vf',
      filter,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { cwd: dir, maxBuffer: w * h * 2 },
  );
  let [top, bottom, left, right] = [h, -1, w, -1];
  for (let i = 0; i < px.length; i++) {
    if ((px[i] ?? 0) <= 120) continue;
    const y = Math.floor(i / w);
    const x = i % w;
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    left = Math.min(left, x);
    right = Math.max(right, x);
  }
  return { top, bottom, left, right };
}

describe('hildegard-video-edit captions', () => {
  it('has one command for wide and one for tall, each laid out in its own pixels', () => {
    expect(filters.map(size)).toEqual([
      [1920, 1080],
      [1080, 1920],
    ]);
  });

  describe.skipIf(!canRender)('drawn by ffmpeg', { timeout: 60_000 }, () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'captions-'));
      writeFileSync(
        join(dir, 'captions.srt'),
        '1\n00:00:00,000 --> 00:00:02,000\nWe fixed the flaky test in the payments worker by waiting on it\n',
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it.each(filters)('is whole and inside the safe area: %s', (filter) => {
      const [w, h] = size(filter);
      const box = drawn(filter, [w, h], dir);
      expect(box.bottom).toBeGreaterThan(h / 2);
      expect(box.bottom).toBeLessThan(h * (h > w ? 0.8 : 0.93));
      expect(box.top).toBeGreaterThan(h / 2);
      expect(box.left).toBeGreaterThan(w * 0.04);
      expect(box.right).toBeLessThan(w * 0.9);
    });

    it('the old advice for a vertical video drew nothing', () => {
      const old = "subtitles=captions.srt:force_style='FontSize=18,MarginV=300'";
      expect(drawn(old, [1080, 1920], dir).bottom).toBe(-1);
    });
  });
});

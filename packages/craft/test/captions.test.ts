// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-video-edit's caption commands, run as written: the text lands on the frame, whole. Until 2026-11-24 the skill
// said to raise MarginV to about 300 for a vertical video; libass counts margins on a 288-line canvas, so nothing showed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (path: string) =>
  readFileSync(resolve(import.meta.dirname, '../../..', path, 'hildegard-video-edit/SKILL.md'), 'utf8');
const commands = (text: string) =>
  [...text.matchAll(/-vf "(subtitles=captions\.srt:[^"]+)"/g)].map((m) => m[1] ?? '');
const skill = read('skills');
const [wide = '', tall = ''] = commands(skill);
// The line lengths the skill gives, so the cue below is as long as it allows.
const [, wideChars, tallChars] = (
  skill.match(/about (\d+) characters a line \(about (\d+) on a vertical video/) ?? []
).map(Number);
const words = 'We fixed the flaky test in the payments worker by waiting on it, then moved the queue away';
const canRender =
  spawnSync('ffmpeg', ['-hide_banner', '-h', 'filter=subtitles'], { encoding: 'utf8' }).stdout?.includes(
    'force_style',
  ) ?? false;

/** Where the text lands, and in how many lines, when `filter` draws `captions.srt` on a black frame. */
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
  const inked = new Set<number>();
  for (let i = 0; i < px.length; i++) {
    if ((px[i] ?? 0) <= 120) continue;
    const y = Math.floor(i / w);
    const x = i % w;
    inked.add(y);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    left = Math.min(left, x);
    right = Math.max(right, x);
  }
  // A gap of more than 0.3% of the height between inked rows starts a new line; smaller ones are inside a letter.
  const rows = [...inked].sort((a, b) => a - b);
  const lines = rows.filter((y, i) => i === 0 || y - (rows[i - 1] ?? y) > h * 0.003).length;
  return { top, bottom, left, right, lines };
}

describe('hildegard-video-edit captions', () => {
  it('has one command for wide and one for tall, the same in both copies of the skill', () => {
    expect(commands(skill)).toHaveLength(2);
    expect(commands(read('local-studio/hildegard/skills'))).toEqual(commands(skill));
  });

  describe.skipIf(!canRender)('drawn by ffmpeg', { timeout: 60_000 }, () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'captions-'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const cue = (chars: number) =>
      writeFileSync(
        join(dir, 'captions.srt'),
        `1\n00:00:00,000 --> 00:00:02,000\n${words.slice(0, chars)}\n${words.slice(chars, 2 * chars)}\n`,
      );

    it.each([
      ['wide', 1920, 1080],
      ['wide', 1280, 720],
      ['tall', 1080, 1920],
      ['tall', 720, 1280],
    ])('a full two-line cue stays two lines in the safe area, %s at %ix%i', (shape, w, h) => {
      cue(Number(shape === 'wide' ? wideChars : tallChars));
      const box = drawn(shape === 'wide' ? wide : tall, [w, h], dir);
      expect(box.lines).toBe(2);
      expect(box.top).toBeGreaterThan(h / 2);
      expect(box.bottom).toBeLessThan(h * (h > w ? 0.8 : 0.93));
      expect(box.left).toBeGreaterThan(w * 0.04);
      expect(box.right).toBeLessThan(w * 0.9);
    });
  });
});

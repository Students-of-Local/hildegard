// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-video-edit's section 8 programs (spans.sh, cap.py, sync.py, meaning.py), taken out of the skill text and run as written: each
// passes a good input and fails the fault it is there to catch.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const skill = readFileSync(
  resolve(import.meta.dirname, '../../..', 'skills/hildegard-video-edit/SKILL.md'),
  'utf8',
).replaceAll('\r\n', '\n');
const programs = new Map(
  [...skill.matchAll(/```(?:python|bash)\n((?:#!.*\n)?# (?:python3|bash) (\w+\.(?:py|sh))[\s\S]*?)```\n/g)].map(
    (m) => [m[2] ?? '', m[1] ?? ''],
  ),
);
const has = (cmd: string, ...args: string[]) => spawnSync(cmd, args).status === 0;
const hasFfmpeg = has('ffmpeg', '-version') && has('ffprobe', '-version');
let dir: string;
const run = (cmd: string, ...args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: dir, env: { ...process.env, FIT: 'scale=160:90' } });
  return { ok: r.status === 0, said: r.stdout + r.stderr };
};
const save = (name: string, body: string) => writeFileSync(join(dir, name), body);
/** A transcript: one word every 0.4 s, 0.3 s long, the way faster-whisper writes it (a space before each word). */
const words = (text: string) =>
  JSON.stringify(text.split(' ').map((w, i) => ({ w: ` ${w}`, s: i * 0.4, e: i * 0.4 + 0.3 })));
const said =
  'I was nine then. We sold the house in May. But we did not want to go. She never came back to see it.';
const spans = (...list: [number, number][]) =>
  list.map(([i, j]) => `a.mkv ${(i * 0.4 - 0.05).toFixed(2)} ${((j - 1) * 0.4 + 0.35).toFixed(2)}`).join('\n');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'video-programs-'));
  for (const [name, body] of programs) save(name, body);
  save('words.json', words(said));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('finds all four in the skill', () => {
  expect([...programs.keys()].sort()).toEqual(['cap.py', 'meaning.py', 'spans.sh', 'sync.py']);
});

describe.skipIf(!has(python, '--version'))('the words', () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

  it('cap.py writes short lines that never overlap', () => {
    const { said: srt } = run(python, 'cap.py', 'words.json');
    const cues = srt.trim().split('\n\n');
    let last = 0;
    for (const cue of cues) {
      const [, time = '', text = ''] = cue.split('\n');
      const [from = 0, to = 0] = time.split(' --> ').map((t) => {
        const [h = 0, m = 0, s = 0, ms = 0] = t.split(/[:,]/).map(Number);
        return h * 3600 + m * 60 + s + ms / 1000;
      });
      expect(text.split(/\s/).length, text).toBeLessThanOrEqual(6);
      expect(text).not.toMatch(/ {2}|^ /);
      expect(from).toBeGreaterThanOrEqual(last);
      expect(to).toBeGreaterThan(from);
      last = to;
    }
    expect(cues.map((c) => c.split('\n')[2]).join(' ')).toBe(said);
  });

  it.each<[string, [number, number][], boolean, string]>([
    ['whole sentences in order', [[0, 4], [17, 24]], true, 'span 2'],
    ['a kept line whose next sentence takes it back', [[4, 10]], true, 'LOOK the next sentence takes it back'],
    ['a cut inside a sentence', [[4, 8]], false, 'FIX ends inside a sentence'],
    ['an answer moved earlier', [[17, 24], [0, 4]], false, 'FIX is earlier on the tape'],
  ])('meaning.py: %s', (_, list, ok, line) => {
    save('spans.txt', spans(...list));
    const r = run(python, 'meaning.py', 'words.json', 'spans.txt');
    expect(r.ok, r.said).toBe(ok);
    expect(r.said).toContain(line);
  });

  it('meaning.py fails a film that lost a "not"', () => {
    save('spans.txt', spans([10, 17], [17, 24]));
    save('cut.json', words('But we did not want to go. She never came back to see it.'));
    const same = run(python, 'meaning.py', 'words.json', 'spans.txt', 'cut.json');
    expect(same.ok, same.said).toBe(true);
    save('cut.json', words('But we did want to go. She never came back to see it.'));
    const lost = run(python, 'meaning.py', 'words.json', 'spans.txt', 'cut.json');
    expect(lost.ok).toBe(false);
    expect(lost.said).toContain('a not, if or maybe changed');
  });
});

describe.skipIf(!hasFfmpeg || process.platform === 'win32')('spans.sh', () => {
  beforeAll(() => {
    const source = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=6'];
    run('ffmpeg', ...source, '-f', 'lavfi', '-i', 'sine=d=6', '-c:v', 'libx264', '-c:a', 'aac', 'a.mkv');
    run('ffmpeg', ...source, '-c:v', 'libx264', 'silent.mkv');
  });
  it('joins to the frame, a silent file and a last line with no newline included', () => {
    save('spans.txt', 'a.mkv 0.51 2.02\nsilent.mkv 1 2.5 setpts=PTS-STARTPTS\na.mkv 3.333 4.1');
    const r = run('bash', 'spans.sh');
    expect(r.ok, r.said).toBe(true);
    expect(r.said).toMatch(/OK frames 114 of 114/);
  });
  it('fails a span past the end of its file', () => {
    save('spans.txt', 'a.mkv 0.5 2\na.mkv 5 8\n');
    const r = run('bash', 'spans.sh');
    expect(r.ok).toBe(false);
    expect(r.said).toContain('FIX frames');
  });
});

describe.skipIf(!hasFfmpeg || !has(python, '-c', 'import numpy'))('sync.py', () => {
  beforeAll(() => {
    const noise = (seed: number, d: number) => `anoisesrc=d=${d}:c=pink:seed=${seed}:r=16000,tremolo=f=0.7:d=0.9`;
    const wav = (out: string, input: string, ...more: string[]) =>
      run('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', input, ...more, out);
    wav('main.wav', noise(3, 120));
    wav('other.wav', noise(8, 80));
    run('ffmpeg', '-v', 'error', '-y', '-ss', '17.42', '-t', '80', '-i', 'main.wav', '-af', 'volume=0.4', 'cam.wav');
  });
  it('finds where a camera starts', () => {
    const r = run(python, 'sync.py', 'main.wav', 'cam.wav');
    expect(r.ok, r.said).toBe(true);
    expect(Number(r.said.match(/starts \+?(-?[\d.]+) s/)?.[1])).toBeCloseTo(17.42, 2);
  });
  it('fails a track from another event', () => {
    const r = run(python, 'sync.py', 'main.wav', 'other.wav');
    expect(r.ok).toBe(false);
    expect(r.said).toContain('FIX other.wav');
  });
});

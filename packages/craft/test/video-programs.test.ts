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
  [
    ...skill.matchAll(/```(?:python|bash)\n((?:#!.*\n)?# (?:python3|bash) (\w+\.(?:py|sh))[\s\S]*?)```\n/g),
  ].map((m) => [m[2] ?? '', m[1] ?? '']),
);
const has = (cmd: string, ...args: string[]) => spawnSync(cmd, args).status === 0;
const hasFfmpeg = has('ffmpeg', '-version') && has('ffprobe', '-version');
let dir: string;
const run = (cmd: string, ...args: string[]) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, FIT: 'scale=160:90' },
  });
  return { ok: r.status === 0, said: (r.stdout + r.stderr).replaceAll('\r\n', '\n') };
};
const save = (name: string, body: string) => writeFileSync(join(dir, name), body);
/** A transcript: one word every `step` s, the way faster-whisper writes it (a space before each word). */
const words = (text: string, step = 0.4) =>
  JSON.stringify(text.split(' ').map((w, i) => ({ w: ` ${w}`, s: i * step, e: i * step + step * 0.75 })));
const said =
  'I was nine then. We sold the house in May. But we did not want to go. She never came back to see it.';
/** Spans of whole words, cut as the skill says: 0.15 s outside, but never past the middle of the 0.1 s gap. */
const spans = (...list: [number, number][]) =>
  list
    .map(([i, j]) => `tape.mkv ${(i * 0.4 - 0.05).toFixed(2)} ${((j - 1) * 0.4 + 0.35).toFixed(2)}`)
    .join('\n');
const meaning = (text: string, list: [number, number][], cut?: string) => {
  save('m.json', words(text));
  save('spans.txt', `${spans(...list).replace('\n', '\ncard.mkv 0 3\n')}\n`); // a card where time jumps
  if (cut) save('cut.json', words(cut));
  return run(python, 'meaning.py', 'm.json', 'spans.txt', 'tape.mkv', ...(cut ? ['cut.json'] : []));
};
/** The same words, numbered from where each sentence starts. */
const at = (text: string, from: string, to: string): [number, number] => {
  const all = text.split(' ');
  const word = (index: number) => text.slice(0, index).split(' ').length - 1;
  const start = text.indexOf(from);
  return [word(start), Math.min(all.length, word(text.indexOf(to, start)) + to.split(' ').length)];
};

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

  it.each([0.4, 0.17])(
    'cap.py: a word every %s s makes short lines, 1 s or more, none overlapping',
    (step) => {
      save('c.json', words(said, step));
      const cues = run(python, 'cap.py', 'c.json').said.trim().split('\n\n');
      let last = 0;
      for (const cue of cues) {
        const [, time = '', text = ''] = cue.split('\n');
        const [from = 0, to = 0] = time.split(' --> ').map((t) => {
          const [h = 0, m = 0, sec = 0, ms = 0] = t.split(/[:,]/).map(Number);
          return h * 3600 + m * 60 + sec + ms / 1000;
        });
        expect(text.length).toBeLessThanOrEqual(56); // two lines of the vertical style
        expect(text).not.toMatch(/ {2}|^ /);
        expect(from).toBeGreaterThanOrEqual(last);
        expect(to - from).toBeGreaterThanOrEqual(0.999);
        last = to;
      }
      expect(cues.map((c) => c.split('\n')[2]).join(' ')).toBe(said);
    },
  );

  const hit =
    'Did you ever hit him? Of course I did not. Did you miss him? Every single day. I hated my father. I am joking of course.';
  it.each<[string, string, [string, string][], boolean, string]>([
    [
      'whole sentences in order, a card between',
      said,
      [
        ['I was', 'then.'],
        ['She never', 'see it.'],
      ],
      true,
      'span 2',
    ],
    [
      'the next sentence takes it back',
      said,
      [['We sold', 'in May.']],
      true,
      'LOOK the next sentence may take it back',
    ],
    ['it was a joke', hit, [['I hated', 'my father.']], true, 'LOOK the next sentence may take it back'],
    [
      'its question is cut',
      hit,
      [['Every', 'single day.']],
      true,
      'LOOK cut just before it: Of course I did not. Did you miss him?',
    ],
    [
      'a question with its own answer',
      hit,
      [
        ['Did you miss', 'him?'],
        ['Every', 'single day.'],
      ],
      true,
      'span 2',
    ],
    [
      'an answer under another question',
      hit,
      [
        ['Did you ever', 'hit him?'],
        ['Every', 'single day.'],
      ],
      false,
      'FIX answers a question',
    ],
    ['a cut inside a sentence', said, [['We sold', 'the house']], false, 'FIX ends inside a sentence'],
    [
      'an answer moved earlier',
      said,
      [
        ['She never', 'see it.'],
        ['I was', 'then.'],
      ],
      false,
      'FIX is earlier on the tape',
    ],
  ])('meaning.py: %s', (_, text, list, ok, line) => {
    const r = meaning(
      text,
      list.map(([a, b]) => at(text, a, b)),
    );
    expect(r.ok, r.said).toBe(ok);
    expect(r.said).toContain(line);
  });

  const told =
    'Tell me about your father. He was the kindest man I knew. Tell me about the war. I hated every minute of it. Did you miss him? Oh yes. Every single day.';
  it.each([
    [
      'Tell me about your father.',
      'I hated every minute of it.',
      'cut just before it: He was the kindest man I knew. Tell me about the war.',
    ],
    ['Did you miss him?', 'Every single day.', 'FIX answers a question that was not its own'],
  ])('meaning.py shows what a join dropped: "%s" then "%s"', (a, b, line) => {
    const r = meaning(told, [at(told, a, a), at(told, b, b)]);
    expect(r.said).toContain(line);
    expect(r.said).toContain('no words of the tape: card.mkv');
  });

  it('meaning.py reads two cameras as one interview, and curly quotes as quotes', () => {
    const quoted = said.replace('in May.', 'in \u201cMay.\u201d');
    save('m.json', words(quoted));
    const [one = '', two = ''] = spans(at(said, 'She never', 'see it.'), at(said, 'I was', 'then.')).split(
      '\n',
    );
    save('spans.txt', `${one}\n${two.replace('tape', 'side')}\n`);
    const both = run(python, 'meaning.py', 'm.json', 'spans.txt', 'tape.mkv,side.mkv');
    expect(both.said).toContain('FIX is earlier on the tape');
    save('spans.txt', spans(at(said, 'We sold', 'in May.'), at(said, 'But we', 'to go.')));
    const r = run(python, 'meaning.py', 'm.json', 'spans.txt', 'tape.mkv');
    expect(r.ok, r.said).toBe(true);
  });

  it('meaning.py takes a camera change mid-sentence and mid-word as no cut, and keeps every word', () => {
    save('m.json', words(said));
    save('cut.json', words(said));
    save('spans.txt', 'tape.mkv 0 2.1\nside.mkv 2.1 3.95\ntape.mkv 3.95 4\nside.mkv 4 10\n'); // 2.1 s is inside "sold"
    const r = run(python, 'meaning.py', 'm.json', 'spans.txt', 'tape.mkv,side.mkv', 'cut.json');
    expect(r.ok, r.said).toBe(true);
    expect(r.said).toContain('OK 0 of 24 words differ');
    save('spans.txt', 'tape.mkv 0 2.1\ncard.png 0 3\nside.mkv 2.1 10\n'); // the card breaks the voice
    const cut = run(python, 'meaning.py', 'm.json', 'spans.txt', 'tape.mkv,side.mkv');
    expect(cut.said).toContain('FIX cuts through a word');
  });

  it('meaning.py: a photo listed with the cameras lies over a voice that runs on', () => {
    save('m.json', words(said));
    save('spans.txt', 'tape.mkv 0 2.1\ncard.png 2.1 3.95\ntape.mkv 3.95 10\n');
    const r = run(python, 'meaning.py', 'm.json', 'spans.txt', 'tape.mkv,card.png');
    expect(r.ok, r.said).toBe(true);
    expect(r.said).not.toContain('not read');
  });

  it('meaning.py: a comma after "p.m." ends no sentence', () => {
    const r = meaning('We left at 5 p.m., against our will.', [[0, 5]]);
    expect(r.ok).toBe(false);
    expect(r.said).toContain('FIX ends inside a sentence');
  });

  it('meaning.py reads two interviews, each against its own words', () => {
    const [anna, ben] = ['Did you miss him? Every single day.', 'We never spoke again. I was nine then.'];
    save('anna.json', words(anna));
    save('ben.json', words(ben));
    save('spans.txt', 'anna.mkv 0 1.55\nben.mkv 0 1.55\nanna.mkv 1.55 2.75\n');
    const go = (film: string) => {
      save('cut.json', words(film));
      return run(python, 'meaning.py', 'anna.json+ben.json', 'spans.txt', 'anna.mkv+ben.mkv', 'cut.json');
    };
    const film = 'Did you miss him? We never spoke again. Every single day.';
    expect(go(film).ok, go(film).said).toBe(true);
    expect(go(film).said).toContain('LOOK follows a question that was put to someone else');
    expect(go(film.replace('never ', '')).ok).toBe(false);
    // Ben between them, a later answer of Anna's is still not the answer to her question
    save('anna.json', words('Did you miss him? Every single day. Was it cold? Yes.'));
    save('spans.txt', 'anna.mkv 0 1.55\nben.mkv 0 1.55\nanna.mkv 3.95 4.4\n');
    const other = go('Did you miss him? We never spoke again. Yes.');
    expect(other.ok).toBe(false);
    expect(other.said).toContain('FIX answers a question that was not its own');
  });

  it.each([
    [
      'Arabic',
      '\u0647\u0644 \u0647\u0648 \u0647\u0646\u0627\u061f',
      '\u0646\u0639\u0645 \u0647\u0646\u0627\u06d4',
    ],
    ['Japanese', '\u5143\u6c17\u3067\u3059 \u304b\uff1f', '\u5143\u6c17 \u3067\u3059\u3002'],
    ['Hindi', '\u0935\u0939 \u0926\u0940\u0928 \u0925\u093e\u0964', '\u0926\u093f\u0928 \u0925\u093e\u0964'],
    ['French', '\u00ab Il est venu. \u00bb', 'Elle aussi.'],
  ])('meaning.py knows where a sentence ends in %s', (_, one, two) => {
    const all = `${one} ${two} ${one}`;
    const n = one.split(' ').length;
    const r = meaning(all, [
      [0, n],
      [n, n + two.split(' ').length],
    ]);
    expect(r.ok, r.said).toBe(true);
    const swapped = meaning(`${one} ${two} ${two}`, [
      [0, n],
      [n + two.split(' ').length, n + 2 * two.split(' ').length],
    ]);
    expect(swapped.said.includes('FIX answers a question')).toBe(/[\u061f\uff1f]$/.test(one));
  });

  it('meaning.py tells words apart by a vowel sign, and not by an accent written another way or an opening quote', () => {
    const day = '\u0926\u093f\u0928';
    const all: [number, number][] = [[0, 3]];
    expect(meaning(`${day} ${day} ${day}\u0964`, all, `${day} ${day} \u0926\u0940\u0928\u0964`).ok).toBe(
      false,
    );
    const same = meaning('caf\u00e9 was \u2018not.\u2019', all, 'cafe\u0301 was not.');
    expect(same.ok, same.said).toBe(true);
  });

  it('meaning.py compares other alphabets word by word and says it knows no negations there', () => {
    const was =
      '\u041e\u043d \u0431\u044b\u043b \u0434\u043e\u0431\u0440. \u042f \u043f\u043e\u043c\u043d\u044e.';
    const r = meaning(
      was,
      [[0, 5]],
      '\u041e\u043d \u0431\u044b\u043b \u0437\u043e\u043b. \u042f \u043f\u043e\u043c\u043d\u044e.',
    );
    expect(r.ok).toBe(false);
    expect(r.said).toContain('LOOK not English?');
  });

  it('meaning.py fails a tape that no span names', () => {
    save('spans.txt', 'other.mkv 0 4\n');
    expect(run(python, 'meaning.py', 'words.json', 'spans.txt', 'tape.mkv').ok).toBe(false);
  });

  const long =
    'So the years went by and the town grew and the mill closed and the river came up twice in one spring before anybody built the wall we have';
  it.each([
    ['I did not forgive him.', 'I did forgive him.'],
    ['I cannot forgive him.', 'I can forgive him.'],
    ['I don\u2019t forgive him.', 'I do forgive him.'],
  ])('meaning.py fails a film where "%s" became "%s"', (was, now) => {
    const all: [number, number][] = [[0, `${long} ${was}`.split(' ').length]];
    const same = meaning(`${long} ${was}`, all, `${long} ${was.replace('\u2019', "'")}`);
    expect(same.ok, same.said).toBe(true);
    const lost = meaning(`${long} ${was}`, all, `${long} ${now}`);
    expect(lost.ok).toBe(false);
    expect(lost.said).toContain('a not, if or maybe changed');
  });
});

const noWindows = process.platform === 'win32';
describe.skipIf(!hasFfmpeg || noWindows)('spans.sh', () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  const ff = (...args: string[]) => {
    const r = run('ffmpeg', '-v', 'error', '-y', ...args);
    expect(r.ok, r.said).toBe(true);
  };
  const join3 = (list: string, env: Record<string, string> = {}) => {
    save('spans.txt', list);
    const r = spawnSync('bash', ['spans.sh'], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, FIT: 'scale=32:32', ...env },
    });
    return { ok: r.status === 0, said: r.stdout + r.stderr };
  };
  beforeAll(() => {
    const source = ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=6'];
    ff(...source, '-f', 'lavfi', '-i', 'sine=d=6', '-c:v', 'libx264', '-c:a', 'aac', 'a.mkv');
    ff(...source, '-c:v', 'libx264', 'silent.mkv');
    ff(...source, '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-c:a', 'aac', 'mic.mkv'); // the mic died at 3 s
    // One event at 60 fps, its brightness the frame number; the second camera started 121 frames (2.01667 s) in: half a frame off at 30 fps.
    ff(
      '-f',
      'lavfi',
      '-i',
      "nullsrc=s=32x32:r=60:d=40,geq=lum='16+mod(N,200)':cb=128:cr=128",
      '-c:v',
      'libx264',
      '-crf',
      '4',
      'event.mkv',
    );
    ff(
      '-i',
      'event.mkv',
      '-f',
      'lavfi',
      '-i',
      'sine=d=40',
      '-vf',
      'fps=30',
      '-c:v',
      'libx264',
      '-crf',
      '4',
      '-c:a',
      'pcm_s16le',
      'one.mkv',
    );
    ff(
      '-i',
      'event.mkv',
      '-vf',
      "select='gte(n,121)',setpts=N/60/TB,fps=30",
      '-c:v',
      'libx264',
      '-crf',
      '4',
      'two.mkv',
    );
  });

  it('joins to the frame: a silent file, a blank line, a last line with no newline', () => {
    const r = join3('a.mkv 0.51 2.02\n\nsilent.mkv 1 2.5 setpts=PTS-STARTPTS\na.mkv 3.333 4.1');
    expect(r.ok, r.said).toBe(true);
    expect(r.said).toMatch(/OK frames 114 of 114/);
    expect(join3('a.mkv 0.5 4.1\n', { FPS: '30000/1001' }).said).toMatch(/OK frames 108 of 108/);
  });
  it('fails a span past the end of its file, and one whose sound runs out', () => {
    const past = join3('a.mkv 0.5 2\na.mkv 5 8\n');
    expect(past.ok).toBe(false);
    expect(past.said).toContain('FIX frames');
    const mic = join3('mic.mkv 1 5\n');
    expect(mic.ok).toBe(false);
    expect(mic.said).toContain('FIX span 1: mic.mkv has sound for 2.0');
  });
  it('keeps the picture on the main clock through 20 camera changes', () => {
    save('sync.txt', 'one.mkv 0 0\ntwo.mkv 2.01667 0.0\n');
    const list = Array.from(
      { length: 20 },
      (_, i) =>
        `${i % 2 ? 'two' : 'one'}.mkv ${(5 + i * 1.5183).toFixed(4)} ${(5 + (i + 1) * 1.5183).toFixed(4)}`,
    );
    const r = join3(list.join('\n'));
    rmSync(join(dir, 'sync.txt'));
    expect(r.ok, r.said).toBe(true);
    const px = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-i', 'assembly.mkv', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
      { cwd: dir, maxBuffer: 1 << 26 },
    ).stdout;
    let worst = 0;
    for (let k = 0; k < px.length / 1536; k++) {
      const off = (((((px[k * 1536 + 500] ?? 0) - 16 - (150 + k) * 2) % 200) + 300) % 200) - 100;
      worst = Math.max(worst, Math.abs(off));
    }
    expect(worst).toBeLessThanOrEqual(2); // in 60 fps frames: one frame of the film at most, at the end as at the start
  });
  it('refuses a file with no line in sync.txt, and a span outside what the match covers', () => {
    save('sync.txt', 'a.mkv 0 0\nsilent.mkv 0 0 0 3\n');
    const list = (last: string) => `a.mkv 0.5 2\n${last}\n`;
    const good = join3(list('silent.mkv 1 2'));
    const stranger = join3(list('mic.mkv 1 2'));
    const past = join3(list('silent.mkv 2.5 4'));
    rmSync(join(dir, 'sync.txt'));
    expect(good.ok, good.said).toBe(true);
    expect(stranger.ok).toBe(false);
    expect(stranger.said).toContain('FIX span 2: mic.mkv has no line in sync.txt');
    expect(past.ok).toBe(false);
    expect(past.said).toContain('FIX span 2: silent.mkv only matched the main sound from 0 3 s');
  });
  it('holds a photo for its span, and SOUND=0 takes a camera whose mic died', () => {
    ff('-f', 'lavfi', '-i', 'color=red:s=64x48', '-frames:v', '1', 'card.png');
    const r = join3('a.mkv 0.5 2\ncard.png 0 3\na.mkv 2 3\n');
    expect(r.ok, r.said).toBe(true);
    expect(r.said).toContain('OK frames 165 of 165');
    const rgb = spawnSync(
      'ffmpeg',
      [
        ...['-v', 'error', '-ss', '3', '-i', 'assembly.mkv', '-frames:v', '1', '-f', 'rawvideo'],
        ...['-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24', '-'],
      ],
      { cwd: dir },
    ).stdout;
    expect(Math.abs((rgb[0] ?? 0) - 254)).toBeLessThan(6); // red as the camera's matrix shows it
    expect(Math.max(rgb[1] ?? 99, rgb[2] ?? 99)).toBeLessThan(6);
    save('sync.txt', 'one.mkv 0 0\n'); // a photo keeps the main clock's frames: 10.016 to 13.05 is 392 - 300 of them
    const clock = join3('one.mkv 9 10.016\ncard.png 10.016 13.05\none.mkv 13.05 14\n', { SOUND: '0' });
    rmSync(join(dir, 'sync.txt'));
    expect(clock.said).toContain('OK frames 150 of 150');
    expect(join3('mic.mkv 1 5\n', { SOUND: '0' }).ok).toBe(true);
  });
  it('makes a file section 6 can burn captions on and keep its sound', () => {
    expect(join3('a.mkv 0.5 2\n').ok).toBe(true);
    const out = skill.match(/-c:a copy -crf 17 (captioned\.\w+)/)?.[1] ?? 'none';
    ff('-i', 'assembly.mkv', '-vf', 'null', '-c:a', 'copy', '-crf', '17', out);
    expect(out).toMatch(/\.mkv$/);
  });
});

describe.skipIf(!hasFfmpeg || !has(python, '-c', 'import numpy'))('sync.py', () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  beforeAll(() => {
    const noise = (seed: number, d: number) => [
      '-f',
      'lavfi',
      '-i',
      `anoisesrc=d=${d}:c=pink:seed=${seed}:r=48000,tremolo=f=0.7:d=0.9`,
    ];
    const ff = (...args: string[]) => run('ffmpeg', '-v', 'error', '-y', ...args);
    ff(...noise(3, 240), 'main.wav');
    ff(...noise(8, 80), 'other.wav');
    ff('-ss', '17.42', '-t', '200', '-i', 'main.wav', 'cut.wav');
    // a phone 100 ppm slow, quieter, with its own hiss
    ff(
      '-i',
      'cut.wav',
      ...noise(5, 200),
      '-filter_complex',
      '[0]asetrate=48000*1.0001,aresample=48000,volume=0.5[a];[1]volume=0.1[b];[a][b]amix=duration=first',
      'phone.wav',
    );
    ff('-ss', '10', '-t', '110', '-i', 'main.wav', 'h1.wav');
    ff('-i', 'h1.wav', '-i', 'other.wav', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', 'half.wav');
    ff('-ss', '10', '-t', '60', '-i', 'main.wav', 'p1.wav');
    ff('-ss', '130', '-t', '60', '-i', 'main.wav', 'p2.wav');
    ff('-i', 'p1.wav', '-i', 'p2.wav', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', 'paused.wav');
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=s=32x32:d=200',
      '-itsoffset',
      '0.5',
      '-i',
      'cut.wav',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:a',
      'pcm_s16le',
      '-shortest',
      'late.mkv',
    );
    ff('-f', 'lavfi', '-i', 'color=s=32x32:d=12', 'drone.mkv');
  });
  it('finds a camera with drift and hiss, and one whose sound starts late', () => {
    const r = run(python, 'sync.py', '--write', 'main.wav', 'phone.wav', 'late.mkv');
    expect(r.ok, r.said).toBe(true);
    const rows = readFileSync(join(dir, 'sync.txt'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.split(' '));
    const [main = [], phone = [], late = []] = rows;
    expect(main).toEqual(['main.wav', '0', '0']);
    expect(Number(phone[1])).toBeCloseTo(17.42, 2);
    expect(Number(phone[2])).toBeGreaterThan(90);
    expect(Number(phone[2])).toBeLessThan(110);
    expect(Math.abs(Number(late[1]) - 16.92)).toBeLessThan(0.03);
  });
  it('leaves the camera list alone when it only checks a scene', () => {
    save('sync.txt', 'main.wav 0 0\ncam2.mp4 12.5 40.0\n');
    run(python, 'sync.py', 'main.wav', 'cut.wav');
    expect(readFileSync(join(dir, 'sync.txt'), 'utf8')).toContain('cam2.mp4 12.5');
  });
  it('says which stretch a half-covered camera was matched on', () => {
    const r = run(python, 'sync.py', '--write', 'main.wav', 'half.wav');
    expect(r.ok, r.said).toBe(true);
    const [, , , from, to] = (
      readFileSync(join(dir, 'sync.txt'), 'utf8').trim().split(/\r?\n/)[1] ?? ''
    ).split(' ');
    expect(Number(from)).toBeLessThan(20);
    expect(Number(to)).toBeGreaterThan(100); // the camera hears the event until 10 + 110 s, then something else
    expect(Number(to)).toBeLessThan(125);
  });
  it('fails another event, a paused camera and a file with no sound, and still reads the one after', () => {
    const r = run(python, 'sync.py', 'main.wav', 'other.wav', 'drone.mkv', 'paused.wav', 'cut.wav');
    expect(r.ok).toBe(false);
    expect(r.said).toContain('FIX other.wav matched in');
    expect(r.said).toContain('FIX drone.mkv has no sound');
    expect(r.said).toContain('FIX paused.wav jumps');
    expect(r.said).toContain('OK  cut.wav starts +17.420');
  });
});

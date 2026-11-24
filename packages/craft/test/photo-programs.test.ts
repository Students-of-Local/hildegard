// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-photo-edit's embedded programs (wb_patch, on_white, keystone, faces), taken out of the skill text and run as written: each one
// passes a good picture and fails the fault it is there to catch. Those verdicts decide whether a cutout or a portrait is delivered.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const fixture = join(import.meta.dirname, 'photo_programs_fixture.py');
const has = (modules: string) => spawnSync(python, ['-c', `import ${modules}`]).status === 0;
const programs = [
  ...readFileSync(join(root, 'skills/hildegard-photo-edit/SKILL.md'), 'utf8')
    .replaceAll('\r\n', '\n')
    .matchAll(/```python\n(# (\w+)\.py [\s\S]*?)```\n/g),
];
let dir: string;
const f = (name: string) => join(dir, name);
const run = (script: string, ...args: string[]) => {
  const r = spawnSync(python, ['-I', script, ...args], { encoding: 'utf8', cwd: dir });
  return { ok: r.status === 0, said: r.stdout + r.stderr };
};
const tool = (name: string, ...args: string[]) => run(f(`${name}.py`), ...args);
const read = (...args: string[]) => JSON.parse(run(fixture, ...args).said);

describe.skipIf(!has('PIL, numpy'))('hildegard-photo-edit embedded programs', () => {
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'photo-programs-'));
    for (const [, body = '', name] of programs) writeFileSync(f(`${name}.py`), body);
    const made = run(fixture, 'make', dir);
    expect(made.ok, made.said).toBe(true);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds all four in the skill', () => {
    expect(programs.map((m) => m[2]).sort()).toEqual(['faces', 'keystone', 'on_white', 'wb_patch']);
  });

  it('wb_patch leaves no coloured ring around a blown highlight', () => {
    const r = tool('wb_patch', f('ramp.png'), f('o.png'), '100', '220', '100', '60');
    expect(r.ok, r.said).toBe(true);
    expect(read('ramp', f('o.png')).worst).toBeLessThanOrEqual(3);
  });

  it('wb_patch refuses a clipped patch, and with no patch turns the photo upright', () => {
    expect(tool('wb_patch', f('ramp.png'), f('o.png'), '0', '0', '50', '50').said).toContain('pick another');
    expect(tool('keystone', f('turned.jpg'), f('o.png')).said).toContain('run wb_patch.py first');
    expect(tool('faces', f('turned.jpg'), f('o.png'), '9,9,9,9', '9,9,9,9').said).toContain('run wb_patch.py first');
    expect(tool('wb_patch', f('turned.jpg'), f('o.png')).ok).toBe(true);
    expect(tool('faces', f('o.png'), f('o2.png'), '0,0,40,40', '700,0,40,40').said).toContain('off the picture');
    expect(tool('faces', f('o.png'), f('o2.png'), '0,0,40,40', '0,700,40,40').said).not.toContain('off the picture');
  });

  describe.skipIf(!has('pymatting, scipy'))('on_white', () => {
    const cut = (matte: string, ...args: string[]) =>
      tool('on_white', f('photo.png'), f(`${matte}.png`), f('o.jpg'), '--size', '700', ...args);
    it.each([
      ['good', []],
      ['good', ['--size', '560x700', '--max-bytes', '400000']],
      ['crumb', []],
      ['second', ['--parts', '2']],
      ['thin', []],
    ])('passes %s %s', (matte, args) => {
      const r = cut(matte, ...args);
      expect(r.ok, r.said).toBe(true);
    });
    it.each([
      ['soft', [], 'edge width'],
      ['haze', [], 'haze left'],
      ['second', [], 'loose pieces dropped'],
      ['hollow', [], 'see-through pixels'],
      ['good', ['--size', '2000'], 'enlarged'],
      ['good', ['--max-bytes', '3000'], 'file'],
    ])('fails %s %s on "%s"', (matte, args, line) => {
      const r = cut(matte, ...args);
      expect(r.ok).toBe(false);
      expect(r.said).toContain(`FIX ${line}`);
    });
    it('refuses a photo that is turned', () => {
      expect(tool('on_white', f('turned.jpg'), f('good.png'), f('o.jpg')).said).toContain('run wb_patch.py first');
    });
  });

  // Uprights 250 px in over 620: the faces in the middle keep their shape, a row out to the sides is slanted by more than it may be.
  const lean = ['150,40', '90,680', '750,40', '810,680'];
  it('keystone passes faces in the middle and fails a row it would slant', () => {
    const mid = tool('keystone', f('photo.png'), f('o.png'), ...lean, '440,460,380', '30');
    expect(mid.said).toContain('now');
    expect(mid.ok, mid.said).toBe(true);
    const wide = tool('keystone', f('photo.png'), f('o.png'), ...lean, '100,800,380', '70');
    expect(wide.ok).toBe(false);
    expect(wide.said).toContain('FIX faces change shape');
  });

  it('faces lifts the socket and not the lit brow beside it', () => {
    const pair = ['297,197,66,46', '450,250,60,40'];
    const r = tool('faces', f('noon.png'), f('o.png'), ...pair);
    expect(r.ok, r.said).toBe(true);
    const moved = read('changed', f('noon.png'), f('o.png'));
    expect(moved.brow).toBe(0);
    expect(moved.socket).toBeGreaterThan(20);
    expect(tool('faces', f('deep.png'), f('o.png'), ...pair).said).toContain('one stop was not enough');
  });
});

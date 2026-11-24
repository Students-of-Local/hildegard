// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-openscad's enclosure, taken out of the skill text and rendered: the parts build, the two checks it teaches come out empty on the
// good case, and each planted fault makes one of them fail.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const skill = readFileSync(
  resolve(import.meta.dirname, '../../..', 'skills/hildegard-openscad/SKILL.md'),
  'utf8',
).replaceAll('\r\n', '\n');
const source = skill.match(/```openscad\n(part {2}= "all";[\s\S]*?)```\n/)?.[1] ?? '';
const openscad = process.env.HILDEGARD_OPENSCAD ?? 'openscad';
const has = spawnSync(openscad, ['--version']).status === 0;
let dir: string;
/** What OpenSCAD says about one part: "solid", "empty", or its error. */
const render = (part: string, ...set: string[]) => {
  const args = [
    ...[`part="${part}"`, ...set].flatMap((d) => ['-D', d]),
    '--hardwarnings',
    '-o',
    'x.stl',
    'case.scad',
  ];
  const r = spawnSync(openscad, args, { encoding: 'utf8', cwd: dir });
  const said = r.stdout + r.stderr;
  const error = said.match(/ERROR: .*/)?.[0];
  if (error) return error; // a failed assert says "empty" as well
  if (said.includes('Current top level object is empty')) return 'empty';
  return r.status === 0 ? 'solid' : said;
};

it('finds the enclosure in the skill', () => expect(source).toContain('module board_ghost()'));

describe.skipIf(!has)('the enclosure', () => {
  vi.setConfig({ testTimeout: 300_000 });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'openscad-case-'));
    writeFileSync(join(dir, 'case.scad'), source);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(['base', 'lid', 'lid_print'])('%s renders with no warning', (part) => {
    expect(render(part)).toBe('solid');
  });
  it.each(['clash', 'mate'])('%s is empty on the good case', (part) => expect(render(part)).toBe('empty'));
  it.each([
    ['the board moved 1 mm', 'clash', 'probe=true'],
    ['no openings for the plugs', 'clash', 'ports=[]'],
    ['a lid too low over the sockets', 'clash', 'tall=15.5'],
    ['a rim and snaps with no clearance', 'mate', 'fit=-0.3'],
  ])('a fault shows as a solid: %s', (_, part, fault) => expect(render(part, fault)).toBe('solid'));
  it.each([
    ['snap too stiff', 'arm_l=6'],
    ['no room for solder joints', 'post_h=2'],
    ['a snap arm reaches the board', 'arm_l=20'],
  ])('a number that cannot work stops the render: %s', (why, fault) =>
    expect(render('lid', fault)).toContain(why),
  );
});

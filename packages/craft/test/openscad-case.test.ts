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
if (process.env.HILDEGARD_OPENSCAD && !has) throw new Error(`HILDEGARD_OPENSCAD does not run: ${openscad}`);
let dir: string;
/** What OpenSCAD says about one part: "solid", "empty", or its error or warning. */
const render = (part: string, ...set: string[]) => renderText(source, part, ...set);
const renderText = (text: string, part: string, ...set: string[]) => {
  writeFileSync(join(dir, 'case.scad'), text);
  const args = [
    ...[`part="${part}"`, ...set].flatMap((d) => ['-D', d]),
    '--hardwarnings',
    '-o',
    'x.stl',
    'case.scad',
  ];
  const r = spawnSync(openscad, args, { encoding: 'utf8', cwd: dir, timeout: 280_000 });
  const said = r.stdout + r.stderr;
  const error = said.match(/(?:ERROR|WARNING): .*/)?.[0];
  if (error) return error; // a failed assert says "empty" as well
  if (said.includes('Current top level object is empty')) return 'empty';
  return r.status === 0 ? 'solid' : said;
};

it('finds the enclosure in the skill', () => expect(source).toContain('module board_ghost('));

describe.skipIf(!has)('the enclosure', () => {
  vi.setConfig({ testTimeout: 300_000 });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'openscad-case-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(['base', 'lid', 'lid_print'])('%s renders with no warning', (part) => {
    expect(render(part)).toBe('solid');
  });
  it.each(['clash', 'drop', 'mate'])('%s is empty on the good case', (part) =>
    expect(render(part)).toBe('empty'),
  );
  it.each([
    ['the board moved 1 mm', 'clash', 'probe=true'],
    ['no openings', 'clash', 'open=[]'],
    ['a lid too low over the sockets', 'clash', 'tall=17.2'],
    ['a rim and snaps with no clearance', 'mate', 'fit=-0.3'],
  ])('a fault shows as a solid: %s', (_, part, fault) => expect(render(part, fault)).toBe('solid'));
  const edit = (from: string, to: string) => {
    expect(source.split(from)).toHaveLength(2);
    return source.replace(from, to);
  };
  it.each([
    ['USB-C has no opening', '["front", 11.2, -2.4, 5.6, 13.5], ', ''],
    ['USB-C opens in the wrong place', '["front", 11.2, -2.4', '["front", 51.2, -2.4'],
    ['the card slot is too low', '["left", 28, -5, 0', '["left", 28, -5, -2'],
    ['the button opening is too high', '-0.75, 3.25, 5', '0.75, 3.25, 5'],
  ])('an opening on its own: %s', (_, from, to) => expect(renderText(edit(from, to), 'clash')).toBe('solid'));
  it('the board goes straight in, and not past a closed socket window', () => {
    expect(renderText(edit('-0.4, 99, 17]', '-0.4, 14.2, 17]'), 'drop')).toBe('solid');
  });
  it('a lid lifted 1 mm is held, and not by hooks that stop short of their windows', () => {
    expect(render('pull')).toBe('solid');
    expect(render('pull', 'hook=-0.1')).toBe('empty');
  });
  it('the lid slots go through a thicker lid', () => {
    const pin = `${source}\nif (part == "pin") intersection() { lid(); translate([vent_at[0] + 1, vent_at[1] + 5, h]) cylinder(d = 1, h = 9); }`;
    expect(renderText(pin, 'pin', 'lid_t=4', 'floor_t=2')).toBe('empty');
    expect(renderText(pin, 'pin', 'vent=[0.2, 14]')).toBe('solid');
  });
  it.each([
    ['snap too stiff', 'arm_l=6'],
    ['no room for solder joints', 'post_h=2'],
    ['a snap arm reaches the board', 'arm_l=20'],
    ['a skirt above the rim', 'tall=16.8'],
  ])('a number that cannot work stops the render: %s', (why, fault) =>
    expect(render('lid', fault)).toContain(why),
  );
});

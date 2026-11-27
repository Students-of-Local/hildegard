// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip } from '@hildegard/mcp';
import { describe, expect, it } from 'vitest';
import { findBlender, runBlender } from '../src/blender.ts';
import { fileStore, parseArgs, startServer } from '../src/index.ts';
import { freePort } from './harness.ts';

const blender = findBlender();
if (!blender)
  console.warn(
    'blender-kit.test.ts: no Blender here (set HILDEGARD_BLENDER or put blender on PATH), so the kit tests skip.',
  );

const SKILL = join(import.meta.dirname, '..', '..', '..', 'skills', 'hildegard-3d');
const KIT = join(SKILL, 'scripts', 'blender_kit.py');

/** The build script the skill shows, as a model would copy it. */
function skillExample(): string {
  const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const block = /```python\n(# hildegard: blender\n[\s\S]*?)```/.exec(text);
  expect(block, 'SKILL.md shows a Blender build script').toBeTruthy();
  return block![1]!;
}

/** The size of the first mesh in a GLB along its x, y and z, with its node's scale. */
function glbSize(path: string): number[] {
  const glb = readFileSync(path);
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const node = gltf.nodes.find((n: { mesh?: number }) => n.mesh !== undefined);
  const acc = gltf.accessors[gltf.meshes[node.mesh].primitives[0].attributes.POSITION];
  const scale: number[] = node.scale ?? [1, 1, 1];
  return acc.max.map((m: number, i: number) => (m - acc.min[i]) * scale[i]!);
}

/** Writes `lines` as `work/src/build.py` beside a copy of the kit. */
function build(work: string, lines: string[]) {
  mkdirSync(join(work, 'src'));
  copyFileSync(KIT, join(work, 'src', 'blender_kit.py'));
  writeFileSync(
    join(work, 'src', 'build.py'),
    [
      '# hildegard: blender',
      'import os, sys',
      'sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))',
      'import blender_kit as bk',
      'out, params = bk.args()',
      'bk.clear_scene()',
      'bk.units_mm()',
      ...lines,
    ].join('\n'),
  );
}

describe.skipIf(!blender)('the Blender kit', { timeout: 600_000 }, () => {
  it('renders a turntable that circles the model, with Cycles on the CPU', async () => {
    const work = mkdtempSync(join(tmpdir(), 'hg-turntable-'));
    build(work, [
      'bk.box("base", size=(30, 20, 10), location=(0, 0, 5))',
      'bk.sphere("knob", radius=8, location=(14, 0, 15))',
      'bk.export_glb(out)',
      'bk.turntable(out, frames=4, size=64, samples=4)',
    ]);
    await runBlender(blender!, work, 'build.py', join(work, 'model.glb'));
    const frames = [1, 2, 3, 4].map((f) => join(work, 'out', `turn_000${f}.png`));
    for (const f of frames) expect(statSync(f).size).toBeGreaterThan(1000);
    const look = spawnSync(
      'python3',
      [
        '-I',
        '-c',
        [
          'import sys',
          'from PIL import Image, ImageChops, ImageStat',
          'a, b = (Image.open(p).convert("L") for p in sys.argv[1:3])',
          'print(ImageStat.Stat(a).stddev[0], ImageStat.Stat(ImageChops.difference(a, b)).mean[0])',
        ].join('\n'),
        frames[0]!,
        frames[2]!,
      ],
      { encoding: 'utf8' },
    );
    expect(look.status, look.stderr).toBe(0);
    const [spread, moved] = look.stdout.trim().split(' ').map(Number);
    // Not one flat colour, and the half turn shows the knob on the other side.
    expect(spread).toBeGreaterThan(5);
    expect(moved).toBeGreaterThan(1);
  });

  it('cuts, bevels and exports an STL in millimetres and a GLB in metres', async () => {
    const work = mkdtempSync(join(tmpdir(), 'hg-cut-'));
    build(work, [
      'plate = bk.box("plate", size=(20, 20, 10), location=(0, 0, 5))',
      'bk.boolean(plate, bk.cylinder("hole", radius=4, depth=30, location=(0, 0, 5)))',
      'bk.bevel(plate, width=0.5, segments=2)',
      'bk.export_stl(out, ["plate"])',
      'bk.export_glb(out, ["plate"], scale=0.001)',
      'try:',
      '    bk.export_stl(out, [], filename="none.stl")',
      'except ValueError as e:',
      '    open(os.path.join(out, "empty.txt"), "w").write(str(e))',
    ]);
    const glb = join(work, 'model.glb');
    await runBlender(blender!, work, 'build.py', glb);
    expect(statSync(join(work, 'out', 'model.stl')).size).toBeGreaterThan(84);
    expect(readFileSync(join(work, 'out', 'empty.txt'), 'utf8')).toBe('no mesh to export');
    expect(existsSync(join(work, 'out', 'none.stl'))).toBe(false);
    // 20 by 20 mm and 10 mm tall, Y up, in metres.
    const [x, y, z] = glbSize(glb);
    expect(x).toBeCloseTo(0.02, 4);
    expect(y).toBeCloseTo(0.01, 4);
    expect(z).toBeCloseTo(0.02, 4);
  });

  it('runs the skill’s example build through a loop, sent as its folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-kit-'));
    const srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hostPort: await freePort() },
      { fakeTickMs: 20, secrets: fileStore(join(dir, 'secret.json')) },
    );
    try {
      const H = { 'content-type': 'application/json', 'x-hildegard': '1' };
      const res = await fetch(`${srv.url}/api/loops`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          kind: 'model',
          title: 'Figurine',
          brief: { for: 'a desk figurine', what: 'a figure', specifics: ['a round head'] },
        }),
      });
      const { id } = (await res.json()) as { id: string };
      const enc = new TextEncoder();
      const folder = zip([
        { name: 'build.py', data: enc.encode(skillExample()) },
        { name: 'blender_kit.py', data: new Uint8Array(readFileSync(KIT)) },
        { name: 'params.json', data: enc.encode('{"head": 12}') },
      ]);
      const r = await fetch(`${srv.url}/api/loops/${id}/rounds?note=example`, {
        method: 'POST',
        headers: { 'x-hildegard': '1' },
        body: new Uint8Array(folder),
      });
      const body = (await r.json()) as {
        round: { format: string; source: string; review: { info: { blender?: string; size?: number[] } } };
      };
      expect(r.status, JSON.stringify(body)).toBe(201);
      expect(body.round.format).toBe('glb');
      expect(body.round.source).toMatch(/round-1\.zip$/);
      expect(body.round.review.info.blender).toMatch(/^\d+\.\d+/);
      // The body is 45 mm and the 12 mm head is sunk into it, centred at 53.4: about 65 mm tall, standing up.
      const [x, y, z] = body.round.review.info.size!;
      expect(z).toBeGreaterThan(60);
      expect(z).toBeLessThan(70);
      expect(Math.max(x!, y!)).toBeLessThan(z!);
      expect(existsSync(join(dir, 'media', 'loops', id, 'round-1.glb'))).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

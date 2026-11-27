// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Blender: a model loop may send a build script, a Python file whose first line is `# hildegard: blender` (or a folder
 * with build.py), and Hildegard runs it in Blender itself, the way it renders OpenSCAD. Blender is a separate program
 * (GPL-2.0-or-later) that Hildegard finds on this computer and runs; it is never linked or shipped with Hildegard.
 *
 * A build script is full Python, so where it may come from is decided before this file is reached: only from this
 * computer (`runsHere` in access.ts), never through a link, a tunnel or a key. Here it runs in the same sandbox as
 * OpenSCAD (bubblewrap on Linux, sandbox-exec on macOS): no network, the system and Blender read only, and only the
 * round's own folder writable, holding its home, temp folder and Blender's config, so the owner's config and add-ons
 * are never read. Where there is no sandbox it doesn't run at all. It runs one at a time, with a time limit, and its
 * whole process group is stopped at the deadline. What it says comes back with this computer's paths taken out.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { findSandbox, MAX_MESH_BYTES, scrubPaths } from './openscad.ts';

export interface Blender {
  path: string;
  /** "5.2.2 LTS". */
  version: string;
}

export interface BlenderRun {
  out: string;
  seconds: number;
  version: string;
}

export class BlenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlenderError';
  }
}

/** Where Blender may be: HILDEGARD_BLENDER alone when it is set, else PATH, then the macOS app. */
export function blenderCandidates(env: NodeJS.ProcessEnv = process.env, os = platform()): string[] {
  if (env.HILDEGARD_BLENDER?.trim()) return [env.HILDEGARD_BLENDER.trim()];
  const exe = os === 'win32' ? 'blender.exe' : 'blender';
  const out = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, exe));
  if (os === 'darwin') out.push('/Applications/Blender.app/Contents/MacOS/Blender');
  return out;
}

const probed = new Map<string, Blender | null>();

/** Blender at `path` and its version, or null when it isn't one that runs. */
export function probeBlender(path: string): Blender | null {
  if (probed.has(path)) return probed.get(path)!;
  let found: Blender | null = null;
  if (existsSync(path) && statSync(path).isFile()) {
    const r = spawnSync(path, ['--factory-startup', '--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH },
      windowsHide: true,
    });
    const m = /^Blender (\d+\.\d+(?:\.\d+)?(?: LTS)?)/m.exec(r.stdout ?? '');
    if (m) found = { path, version: m[1]! };
  }
  probed.set(path, found);
  return found;
}

export function findBlender(env: NodeJS.ProcessEnv = process.env, os = platform()): Blender | null {
  for (const p of blenderCandidates(env, os)) {
    const b = probeBlender(p);
    if (b) return b;
  }
  return null;
}

/** Seconds a build may run, from HILDEGARD_BLENDER_TIMEOUT: a number of seconds above 0, or 180. */
export function blenderTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number(env.HILDEGARD_BLENDER_TIMEOUT?.trim() || Number.NaN);
  return (Number.isFinite(s) && s > 0 ? Math.min(s, 3600) : 180) * 1000;
}

/** Whether text is a Blender build script: its first line says so. */
export const looksLikeBlender = (head: string) => /^﻿?#\s*hildegard:\s*blender[ \t]*\r?(\n|$)/.test(head);

/**
 * Blender's own files, for the sandbox to read: its .app on macOS, nothing more for a system install, or the folder a
 * Blender download unpacks to (it holds a folder named for the version, such as `5.2`). Null for anything else.
 */
export function blenderFiles(path: string): string[] | null {
  const app = /^(.*?\.app)(?:[\\/]|$)/.exec(path);
  if (app) return [app[1]!];
  if (['/usr/', '/bin/', '/sbin/'].some((d) => path.startsWith(d))) return [];
  const dir = dirname(path);
  try {
    return readdirSync(dir).some((n) => /^\d+\.\d+$/.test(n)) ? [dir] : null;
  } catch {
    return null;
  }
}

/** The sandbox Blender would run in here, or null. */
export function blenderSandbox(b: Blender, work: string, hide: string[]) {
  const own = blenderFiles(b.path);
  return own ? findSandbox({ round: work, read: own, hide }) : null;
}

/** "build.py line 12: ValueError: boom", from a Python traceback, or null. */
export function tracebackLine(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findLastIndex((l) => l.startsWith('Traceback (most recent call last)'));
  if (start < 0) return null;
  const frames = lines.slice(start).filter((l) => /^\s*File "/.test(l));
  const frame = frames.at(-1) && /File "([^"]+)", line (\d+)/.exec(frames.at(-1)!);
  const error = lines
    .slice(start + 1)
    .find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/.test(l));
  if (!error) return null;
  return frame ? `${frame[1]} line ${frame[2]}: ${error.trim()}` : error.trim();
}

let queue: Promise<void> = Promise.resolve();

/**
 * Runs `script` (a path inside `work/src`) in Blender with `work` as the one folder it may write, and moves the
 * `model.glb` it writes into `work/out` to `out`. Throws BlenderError when it fails, writes no model, or runs too long.
 */
export function runBlender(
  b: Blender,
  work: string,
  script: string,
  out: string,
  opts: { hide?: string[]; timeoutMs?: number; params?: string } = {},
): Promise<BlenderRun> {
  const hide = opts.hide ?? [homedir()];
  const ms = opts.timeoutMs ?? blenderTimeoutMs();
  const src = join(work, 'src');
  const scrub = (t: string) => scrubPaths(t, src, [], [work, ...hide]);
  const run = () =>
    new Promise<BlenderRun>((resolvePromise, reject) => {
      const sandbox = blenderSandbox(b, work, hide);
      if (!sandbox)
        return reject(
          new BlenderError(
            'Blender can’t be sandboxed on this computer, so Hildegard won’t run a build script. On Linux, install bubblewrap; or export a GLB yourself and send that.',
          ),
        );
      const home = join(work, '.blender-home');
      const outDir = join(work, 'out');
      for (const d of [home, outDir, join(home, 'config'), join(home, 'scripts')])
        mkdirSync(d, { recursive: true });
      const args = [
        '--background',
        '--factory-startup',
        '--python-exit-code',
        '1',
        '--python',
        join(src, script),
        '--',
        '--out',
        outDir,
        ...(opts.params ? ['--params', join(src, opts.params)] : []),
      ];
      const limits = `ulimit -f ${Math.ceil((MAX_MESH_BYTES + 64 * 1024 * 1024) / 512)} 2>/dev/null; exec "$0" "$@"`;
      const cmd = sandbox.wrap('/bin/sh', ['-c', limits, b.path, ...args]);
      const started = Date.now();
      const child = spawn(cmd.cmd, cmd.args, {
        cwd: work,
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          HOME: home,
          TMPDIR: home,
          BLENDER_USER_CONFIG: join(home, 'config'),
          BLENDER_USER_SCRIPTS: join(home, 'scripts'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so stopping it stops everything it started.
        detached: true,
      });
      let text = '';
      const keep = (d: Buffer) => {
        text = (text + d.toString()).slice(-200_000);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      let settled = false;
      const settle = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        f();
      };
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        settle(() =>
          reject(
            new BlenderError(
              `Blender took longer than ${Math.round(ms / 1000)} s and was stopped. Lower the subdivision levels and the voxel size, and build one part at a time.`,
            ),
          ),
        );
      }, ms);
      child.once('error', (e) =>
        settle(() => reject(new BlenderError(`Couldn’t run Blender: ${scrub(e.message)}`))),
      );
      child.once('close', (code) =>
        settle(() => {
          const log = scrub(text);
          if (code !== 0) {
            const line = tracebackLine(log);
            const tail = log.trim().split('\n').slice(-3).join(' | ').slice(0, 600);
            return reject(new BlenderError(`Blender stopped: ${line ?? `exit ${code}: ${tail}`}`));
          }
          const glb = join(outDir, 'model.glb');
          const st = existsSync(glb) ? lstatSync(glb) : null;
          if (!st?.isFile() || st.nlink !== 1 || st.size < 20)
            return reject(
              new BlenderError(
                'The build script ran but wrote no model.glb. Export the model to the --out folder it was given.',
              ),
            );
          if (st.size > MAX_MESH_BYTES)
            return reject(new BlenderError(`model.glb came out over ${MAX_MESH_BYTES / 1024 / 1024} MB.`));
          if (readFileSync(glb).subarray(0, 4).toString('latin1') !== 'glTF')
            return reject(new BlenderError('model.glb isn’t a binary glTF.'));
          mkdirSync(dirname(out), { recursive: true });
          rmSync(out, { force: true });
          copyFileSync(glb, out);
          resolvePromise({ out, seconds: Math.round((Date.now() - started) / 100) / 10, version: b.version });
        }),
      );
    });
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const CYCLES_PROBE = `import bpy, os, sys
out = sys.argv[sys.argv.index("--out") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
s = bpy.context.scene
s.render.engine = "CYCLES"
s.cycles.device = "CPU"
s.cycles.samples = 1
s.render.resolution_x = s.render.resolution_y = 16
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
s.collection.objects.link(cam)
cam.location = (4, -4, 3)
cam.rotation_euler = (1.1, 0, 0.785)
s.camera = cam
s.render.filepath = os.path.join(out, "probe.png")
bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "model.glb"))
`;
const cycles = new Map<string, boolean>();

/** Whether Blender renders with Cycles on the CPU here, found once by rendering a 16 pixel cube in the sandbox. */
export async function cyclesRenders(b: Blender, hide?: string[]): Promise<boolean> {
  if (cycles.has(b.path)) return cycles.get(b.path)!;
  const work = mkdtempSync(join(tmpdir(), 'hg-blender-'));
  try {
    mkdirSync(join(work, 'src'));
    writeFileSync(join(work, 'src', 'build.py'), CYCLES_PROBE);
    await runBlender(b, work, 'build.py', join(work, 'probe.glb'), { hide, timeoutMs: 120_000 });
    cycles.set(b.path, existsSync(join(work, 'out', 'probe.png')));
  } catch {
    cycles.set(b.path, false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return cycles.get(b.path)!;
}

/** Whether `<data>/blender.json` lets build scripts run: on unless it says `"blenderScripts": "off"`. */
export function blenderScripts(dataDir: string): 'on' | 'off' {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, 'blender.json'), 'utf8')) as { blenderScripts?: unknown };
    return j.blenderScripts === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

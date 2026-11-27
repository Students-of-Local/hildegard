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
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { findSandbox, MAX_MESH_BYTES, scrubPaths } from './openscad.ts';

export interface Blender {
  path: string;
  /** The name it was found by, run as its argv[0], for a launcher that reads it (a snap). */
  argv0?: string;
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

// Each candidate's probe, kept while its real file and mtime stay the same, so an upgrade is probed again. A probe
// that failed is kept 30 s, so a `blender` that never answers isn't started on every request.
const probed = new Map<string, { real: string; mtime: number; at: number; found: Promise<Blender | null> }>();

function version(real: string, argv0: string): Promise<Blender | null> {
  return new Promise((done) => {
    let out = '';
    const child = spawn(real, ['--factory-startup', '--version'], {
      argv0,
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (d: Buffer) => {
      out = (out + d.toString()).slice(-20_000);
    });
    const end = () => {
      clearTimeout(timer);
      const m = /^Blender (\d+\.\d+(?:\.\d+)?(?: LTS)?)/m.exec(out);
      done(
        m ? { path: real, version: m[1]!, ...(basename(argv0) === basename(real) ? {} : { argv0 }) } : null,
      );
    };
    child.once('error', end);
    child.once('close', end);
  });
}

/**
 * Blender at `path` and its version, or null when it isn't one that runs. The path is the real file a link points
 * to, such as the .app behind Homebrew's `blender`, so the sandbox reads Blender's own folder and runs that file.
 */
export async function probeBlender(path: string): Promise<Blender | null> {
  let real: string;
  let mtime: number;
  try {
    real = await realpath(path);
    const st = await stat(real);
    if (!st.isFile()) return null;
    mtime = st.mtimeMs;
  } catch {
    probed.delete(path);
    return null;
  }
  const hit = probed.get(path);
  if (hit?.real === real && hit.mtime === mtime) {
    const b = await hit.found;
    if (b || Date.now() - hit.at < 30_000) return b;
  }
  const found = version(real, path);
  probed.set(path, { real, mtime, at: Date.now(), found });
  return found;
}

export async function findBlender(
  env: NodeJS.ProcessEnv = process.env,
  os = platform(),
): Promise<Blender | null> {
  for (const p of blenderCandidates(env, os)) {
    const b = await probeBlender(p);
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

/**
 * "build.py line 12: ValueError: boom", from a Python traceback with the round's folder taken out of its paths, or
 * null. The line is the last one in the round's own files, not in Blender's (bpy/ops.py), unless none is.
 */
export function tracebackLine(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findLastIndex((l) => l.startsWith('Traceback (most recent call last)'));
  if (start < 0) return null;
  const frames = lines
    .slice(start)
    .map((l) => /^\s*File "([^"]+)", line (\d+)/.exec(l))
    .filter((m) => !!m);
  const own = (f: string) => !/^([\\/<~]|[A-Za-z]:)/.test(f);
  const frame = frames.findLast((m) => own(m[1]!)) ?? frames.at(-1);
  const error = lines
    .slice(start + 1)
    .find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/.test(l));
  if (!error) return null;
  return frame ? `${frame[1]} line ${frame[2]}: ${error.trim()}` : error.trim();
}

let queue: Promise<void> = Promise.resolve();
let pending = 0;
// The process groups of builds running now, stopped when Hildegard exits so none outlives it.
const live = new Set<number>();
let exitHook = false;
const stopGroup = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
};

/** Whether a build is waiting or running, so an update waits for it. */
export const blenderBusy = () => pending > 0;

/**
 * model.glb as the build left it, read through one descriptor that never follows a link, so what is checked is what
 * is copied, even if something the build left running swaps the file. A BlenderError says what is wrong with it.
 */
function copyGlb(glb: string, out: string) {
  let fd: number;
  try {
    fd = openSync(glb, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    fd = -1;
  }
  const none = new BlenderError(
    'The build script ran but wrote no model.glb. Export the model to the --out folder it was given.',
  );
  if (fd < 0) throw none;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size < 20) throw none;
    if (st.size > MAX_MESH_BYTES)
      throw new BlenderError(`model.glb came out over ${MAX_MESH_BYTES / 1024 / 1024} MB.`);
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) !== 4 || head.toString('latin1') !== 'glTF')
      throw new BlenderError('model.glb isn’t a binary glTF.');
    mkdirSync(dirname(out), { recursive: true });
    rmSync(out, { force: true });
    const to = openSync(out, 'wx');
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (let at = 0, n = 0; at < st.size; at += n) {
        n = readSync(fd, buf, 0, Math.min(buf.length, st.size - at), at);
        if (n <= 0) break;
        writeSync(to, buf, 0, n);
      }
    } finally {
      closeSync(to);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Runs `script` (a path inside `work/src`) in Blender with `work` as the one folder it may write, and moves the
 * `model.glb` it writes into `work/out` to `out`. Throws BlenderError when it fails, writes no model, runs too long,
 * or `signal` stops it (the server closing). `queued: false` runs it beside the builds instead of in line with them.
 */
export function runBlender(
  b: Blender,
  work: string,
  script: string,
  out: string,
  opts: { hide?: string[]; timeoutMs?: number; params?: string; signal?: AbortSignal; queued?: boolean } = {},
): Promise<BlenderRun> {
  const hide = opts.hide ?? [homedir()];
  const ms = opts.timeoutMs ?? blenderTimeoutMs();
  const src = join(work, 'src');
  const scrub = (t: string) => scrubPaths(t, src, [], [work, ...hide]);
  const run = () =>
    new Promise<BlenderRun>((resolvePromise, reject) => {
      if (opts.signal?.aborted) return reject(new BlenderError('Hildegard stopped before the build ran.'));
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
      const limits = `ulimit -f ${Math.ceil((MAX_MESH_BYTES + 64 * 1024 * 1024) / 512)} 2>/dev/null; a0=$1; shift; if (exec -a "$a0" true) 2>/dev/null; then exec -a "$a0" "$0" "$@"; fi; exec "$0" "$@"`;
      const cmd = sandbox.wrap('/bin/sh', ['-c', limits, b.path, b.argv0 ?? b.path, ...args]);
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
      const pid = child.pid;
      if (pid) {
        live.add(pid);
        if (!exitHook) {
          exitHook = true;
          process.on('exit', () => {
            for (const p of live) stopGroup(p);
          });
        }
      }
      const onAbort = () => {
        if (pid) stopGroup(pid);
        settle(() => reject(new BlenderError('Hildegard stopped, and the build with it.')));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
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
        // Whatever the build left running goes with it, even when it ended well.
        if (pid) {
          stopGroup(pid);
          live.delete(pid);
        }
        opts.signal?.removeEventListener('abort', onAbort);
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
          try {
            copyGlb(join(outDir, 'model.glb'), out);
          } catch (e) {
            return reject(e);
          }
          resolvePromise({ out, seconds: Math.round((Date.now() - started) / 100) / 10, version: b.version });
        }),
      );
    });
  pending++;
  if (opts.queued === false)
    return run().finally(() => {
      pending--;
    });
  const next = queue.then(run, run).finally(() => {
    pending--;
  });
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
// A render that worked is kept. One that failed (a timeout under load) is tried again when asked 5 minutes later.
const cycles = new Set<string>();
const failed = new Map<string, number>();
const probing = new Map<string, Promise<boolean>>();

/** Whether Blender renders with Cycles on the CPU here, by rendering a 16 pixel cube in the sandbox. */
export async function cyclesRenders(b: Blender, hide?: string[], signal?: AbortSignal): Promise<boolean> {
  if (cycles.has(b.path)) return true;
  const work = mkdtempSync(join(tmpdir(), 'hg-blender-'));
  let ok = false;
  try {
    mkdirSync(join(work, 'src'));
    writeFileSync(join(work, 'src', 'build.py'), CYCLES_PROBE);
    await runBlender(b, work, 'build.py', join(work, 'probe.glb'), {
      hide,
      timeoutMs: 120_000,
      signal,
      queued: false,
    });
    ok = existsSync(join(work, 'out', 'probe.png'));
  } catch {
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (ok) cycles.add(b.path);
  return ok;
}

/**
 * What is known now of whether Cycles renders here, without waiting: null while the first render runs in the
 * background, false after one failed (another is started when asked 5 minutes after), true once one worked.
 */
export function cyclesKnown(b: Blender, hide?: string[], signal?: AbortSignal): boolean | null {
  if (cycles.has(b.path)) return true;
  const at = failed.get(b.path);
  if (!probing.has(b.path) && !signal?.aborted && (at === undefined || Date.now() - at >= 5 * 60_000))
    probing.set(
      b.path,
      cyclesRenders(b, hide, signal).then((ok) => {
        probing.delete(b.path);
        if (ok) failed.delete(b.path);
        else failed.set(b.path, Date.now());
        return ok;
      }),
    );
  return failed.has(b.path) ? false : null;
}

/**
 * The owner's word in `<data>/blender.json` on whether build scripts may run. With no file they are on. A file that
 * can't be read, isn't JSON, or holds anything but `"blenderScripts": "on"` or `"off"` turns them off, and `problem`
 * says why, so a mistyped "off" never leaves them running.
 */
export function blenderSetting(dataDir: string): { scripts: 'on' | 'off'; problem: string | null } {
  let text: string;
  try {
    text = readFileSync(join(dataDir, 'blender.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { scripts: 'on', problem: null };
    return { scripts: 'off', problem: 'blender.json can’t be read, so build scripts are off' };
  }
  try {
    const v = (JSON.parse(text) as { blenderScripts?: unknown } | null)?.blenderScripts;
    if (v === 'on' || v === 'off') return { scripts: v, problem: null };
  } catch {}
  return {
    scripts: 'off',
    problem:
      'blender.json isn’t valid (it must be {"blenderScripts": "on"} or {"blenderScripts": "off"}), so build scripts are off',
  };
}

export const blenderScripts = (dataDir: string) => blenderSetting(dataDir).scripts;

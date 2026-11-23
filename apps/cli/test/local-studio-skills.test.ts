// SPDX-License-Identifier: AGPL-3.0-only
// The Local Studio plugin's craft skills are made from skills/ by scripts/sync-local-studio-skills.mjs, never by hand,
// and its MCP command (local-studio/hildegard/bin/hildegard-mcp) runs the installed Hildegard's server or says how to
// install it.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSkillText } from '../../../mcp/src/skill-scan.ts';
import {
  CRAFT,
  drift,
  EDITS,
  expected,
  FILES,
  FIRST,
  firstBlock,
  GANTREL,
  GANTREL_COMMANDS,
  LEFT_OUT,
  OWN,
  PLUGIN,
  sync,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/sync-local-studio-skills.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const plugin = join(root, PLUGIN);
const toml = readFileSync(join(plugin, 'plugin.toml'), 'utf8');
const commands = [...toml.matchAll(/\[\[commands\]\]\s*\nname = "([^"]+)"[\s\S]*?skill = "([^"]+)"/g)].map(
  (m) => ({
    name: m[1]!,
    skill: m[2]!,
  }),
);
const unix = process.platform !== 'win32';

/** Every file under `dir`, as paths from it. */
function files(dir: string, sub = ''): string[] {
  return readdirSync(join(dir, sub), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(sub, e.name)) : [join(sub, e.name)],
  );
}

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A scratch repository holding only what the sync reads and writes. */
function scratch(): string {
  const repo = mkdtempSync(join(tmpdir(), 'hildegard-ls-sync-'));
  temps.push(repo);
  for (const s of CRAFT) cpSync(join(root, 'skills', s), join(repo, 'skills', s), { recursive: true });
  cpSync(plugin, join(repo, PLUGIN), { recursive: true });
  for (const { from } of FILES as { from: string }[]) cpSync(join(root, from), join(repo, from));
  return repo;
}

/** Flips one byte of the file at `rel` in `repo`. */
function flip(repo: string, rel: string, at = 0) {
  const p = join(repo, rel);
  const b = readFileSync(p);
  b[at] = (b[at]! ^ 0x01) & 0xff;
  writeFileSync(p, b);
}

describe('the Local Studio plugin’s craft skills', () => {
  it('are exactly what the sync makes of skills/', () => {
    expect(drift(root)).toEqual([]);
  });

  it('fail the check when one byte of a plugin copy changes, and the sync puts it back', () => {
    const repo = scratch();
    expect(drift(repo)).toEqual([]);
    for (const rel of [
      `${PLUGIN}/skills/hildegard-3d/SKILL.md`, // a copy with Local Studio edits in it
      `${PLUGIN}/skills/hildegard-photo-edit/scripts/fix.py`, // a plain copy
      `${PLUGIN}/icon.png`,
    ]) {
      flip(repo, rel, 40);
      const problems = drift(repo);
      expect(problems, rel).toHaveLength(1);
      expect(problems[0], rel).toContain(`${rel} differs`);
      const { wrote, problems: after } = sync(repo);
      expect(wrote).toEqual([rel]);
      expect(after).toEqual([]);
      expect(readFileSync(join(repo, rel))).toEqual(readFileSync(join(root, rel)));
    }
  });

  it('fail the check when skills/ changes until the sync runs', () => {
    const repo = scratch();
    flip(repo, 'skills/hildegard-sound/scripts/measure.py', 10);
    expect(drift(repo).join('\n')).toContain(`${PLUGIN}/skills/hildegard-sound/scripts/measure.py differs`);
    sync(repo);
    expect(drift(repo)).toEqual([]);
  });

  it('fail on a file or a skill the sync doesn’t make; the sync removes only files in its own skills', () => {
    const repo = scratch();
    const extra = `${PLUGIN}/skills/hildegard-film/scripts/extra.py`;
    writeFileSync(join(repo, extra), 'print(1)\n');
    mkdirSync(join(repo, PLUGIN, 'skills', 'hildegard-film', '__pycache__'));
    writeFileSync(join(repo, PLUGIN, 'skills', 'hildegard-film', '__pycache__', 'x.pyc'), 'x');
    mkdirSync(join(repo, PLUGIN, 'skills', 'hildegard-print'));
    writeFileSync(
      join(repo, PLUGIN, 'skills', 'hildegard-print', 'SKILL.md'),
      '---\nname: hildegard-print\n---\n',
    );
    const problems = drift(repo).join('\n');
    expect(problems).toContain(`${extra} isn't in skills/hildegard-film`);
    expect(problems).toContain('hildegard-film/__pycache__/x.pyc isn');
    expect(problems).toContain(`${PLUGIN}/skills/hildegard-print is neither`);
    const { removed, problems: after } = sync(repo);
    expect(removed.sort()).toEqual([extra, `${PLUGIN}/skills/hildegard-film/__pycache__/x.pyc`].sort());
    expect(existsSync(join(repo, PLUGIN, 'skills', 'hildegard-film', '__pycache__'))).toBe(false);
    // A folder it doesn't own stays for a person to delete.
    expect(existsSync(join(repo, PLUGIN, 'skills', 'hildegard-print', 'SKILL.md'))).toBe(true);
    expect(after).toHaveLength(1);
  });

  it('stop and name the edit when skills/ changes under it', () => {
    const repo = scratch();
    const src = join(repo, 'skills', 'hildegard-3d', 'SKILL.md');
    writeFileSync(src, readFileSync(src, 'utf8').replace('**hildegard-print**', '**hildegard-parts**'));
    expect(() => expected(repo)).toThrow(/EDITS\[2\] .*matches skills\/hildegard-3d\/SKILL\.md 0 times/);
    expect(drift(repo).join('\n')).toMatch(/EDITS\[2\]/);
    expect(() => sync(repo)).toThrow(/EDITS\[2\]/);
  });

  it('read CRLF line endings in skills/ and in the copy as LF', () => {
    const repo = scratch();
    for (const rel of ['skills/hildegard-art/SKILL.md', `${PLUGIN}/skills/hildegard-sound/SKILL.md`]) {
      const p = join(repo, rel);
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll('\n', '\r\n'));
    }
    expect(drift(repo)).toEqual([]);
  });

  it.skipIf(!unix)('refuse a link in skills/ or in the plugin', () => {
    const repo = scratch();
    symlinkSync('/etc/hostname', join(repo, 'skills', 'hildegard-web', 'references', 'out.md'));
    expect(() => expected(repo)).toThrow(/skills\/hildegard-web\/references\/out\.md is a link/);
    rmSync(join(repo, 'skills', 'hildegard-web', 'references', 'out.md'));
    const copy = join(repo, PLUGIN, 'skills', 'hildegard-art', 'SKILL.md');
    rmSync(copy);
    symlinkSync(join(root, PLUGIN, 'skills', 'hildegard-art', 'SKILL.md'), copy);
    expect(drift(repo).join('\n')).toContain('hildegard-art/SKILL.md is a link');
    expect(() => sync(repo)).toThrow(/is a link/);
  });

  it('ship the craft set, and leave out printing and rented GPUs', () => {
    const shipped = readdirSync(join(plugin, 'skills')).sort();
    expect(shipped).toEqual([...CRAFT, ...OWN].sort());
    for (const out of ['hildegard-print', 'hildegard-openscad', 'hildegard-cloud']) {
      expect(shipped).not.toContain(out);
      expect(LEFT_OUT[out], out).toBeTruthy();
    }
    for (const s of readdirSync(join(root, 'skills'), { withFileTypes: true }))
      if (s.isDirectory()) expect(CRAFT.includes(s.name) || s.name in LEFT_OUT, s.name).toBe(true);
    // No shipped text sends a model to a skill the plugin leaves out.
    for (const f of files(join(plugin, 'skills'))) {
      if (!/\.(md|py|json|html|css|svg)$/.test(f)) continue;
      const text = readFileSync(join(plugin, 'skills', f), 'utf8');
      expect(text, f).not.toMatch(/hildegard-(print|openscad|cloud)\b/);
    }
  });

  it('hand printing to Gantrel, else the mesh', () => {
    expect(GANTREL).toContain('Gantrel');
    expect(GANTREL).toMatch(/mesh file/);
    for (const c of GANTREL_COMMANDS) expect(GANTREL).toContain(c);
    for (const s of ['hildegard', 'hildegard-3d', 'hildegard-loop']) {
      const text = readFileSync(join(plugin, 'skills', s, 'SKILL.md'), 'utf8');
      expect(text, s).toContain('Gantrel');
      for (const c of GANTREL_COMMANDS) expect(text, s).toContain(c);
    }
  });

  it('open each craft command’s skill with what to run first', () => {
    const craftCommands = commands.filter((c) => CRAFT.includes(c.skill));
    expect(craftCommands.map((c) => c.skill).sort()).toEqual(Object.keys(FIRST).sort());
    for (const { name, skill } of craftCommands) {
      const text = readFileSync(join(plugin, 'skills', skill, 'SKILL.md'), 'utf8');
      // What the model sees: Local Studio strips the front matter.
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
      const firstScreen = body.split('\n').slice(0, 12).join('\n');
      expect(firstScreen, name).toMatch(/^# .+\n\n## In Local Studio\n/);
      expect(firstScreen, name).toMatch(/\nFirst (call|run|pick|write) /);
      expect(firstScreen, name).toMatch(/`(hildegard_status|loop_start|site_templates|python3 -B [^`]+)`/);
    }
  });

  it('add nothing an attack scan blocks, and no dashes', () => {
    const added = [
      ...Object.keys(FIRST).map((s) => firstBlock(s) as string),
      ...(EDITS as { replace: string }[]).map((e) => e.replace),
    ];
    for (const text of added) {
      expect(
        scanSkillText(text).filter((f) => f.severity === 'block'),
        text,
      ).toEqual([]);
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

describe('the Local Studio plugin’s MCP command', () => {
  const launcher = join(plugin, 'bin', 'hildegard-mcp');

  /** Runs the launcher with only `env`. */
  const run = (env: Record<string, string>) =>
    spawnSync('/bin/sh', [launcher], { env, encoding: 'utf8', input: '', timeout: 10_000 });

  /** A stand-in `hildegard` that says which one ran and with what. */
  function fake(dir: string, label: string) {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'hildegard');
    writeFileSync(p, `#!/bin/sh\necho "${label} $*"\n`, { mode: 0o755 });
    return p;
  }

  function home() {
    const h = mkdtempSync(join(tmpdir(), 'hildegard-ls-mcp-'));
    temps.push(h);
    return h;
  }

  it('is the [mcp] command, a file in the plugin, executable and ASCII', () => {
    expect(toml).toMatch(/^\[mcp\]\ncommand = "bin\/hildegard-mcp"$/m);
    expect(toml).toMatch(/^capabilities = \["mcp-server"\]$/m);
    const text = readFileSync(launcher, 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect([...text].filter((c) => c.charCodeAt(0) > 0x7f)).toEqual([]);
    if (unix) expect(statSync(launcher).mode & 0o111).toBe(0o111);
  });

  it.skipIf(!unix)('runs `hildegard mcp` from PATH', () => {
    const h = home();
    fake(join(h, 'bin'), 'path');
    const r = run({ PATH: `${join(h, 'bin')}:/usr/bin:/bin`, HOME: h });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('path mcp\n');
  });

  it.skipIf(!unix)('prefers HILDEGARD_BIN, and passes over one that can’t run', () => {
    const h = home();
    fake(join(h, 'bin'), 'path');
    const chosen = fake(join(h, 'chosen'), 'chosen');
    expect(run({ PATH: `${join(h, 'bin')}:/usr/bin:/bin`, HOME: h, HILDEGARD_BIN: chosen }).stdout).toBe(
      'chosen mcp\n',
    );
    writeFileSync(join(h, 'plain'), '#!/bin/sh\necho plain\n', { mode: 0o644 });
    expect(
      run({ PATH: `${join(h, 'bin')}:/usr/bin:/bin`, HOME: h, HILDEGARD_BIN: join(h, 'plain') }).stdout,
    ).toBe('path mcp\n');
  });

  it.skipIf(!unix)('finds the installer’s copy when PATH lacks it', () => {
    const h = home();
    fake(join(h, '.local', 'bin'), 'installed');
    expect(run({ PATH: '/usr/bin:/bin', HOME: h }).stdout).toBe('installed mcp\n');
    fake(join(h, 'xdg'), 'xdg');
    expect(run({ PATH: '/usr/bin:/bin', HOME: h, XDG_BIN_HOME: join(h, 'xdg') }).stdout).toBe('xdg mcp\n');
  });

  it.skipIf(!unix)('without Hildegard, says how to install it and exits, installing nothing', () => {
    const h = home();
    const r = run({ PATH: '/nonexistent', HOME: h });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(''); // an MCP client reads stdout as JSON-RPC
    expect(r.stderr).toContain('curl -fsSL https://dbaney.com/hildegard/install.sh | sh');
    expect(r.stderr).toContain('in a terminal yourself');
    // The install line appears only inside the message, never as a command the script runs.
    const lines = readFileSync(launcher, 'utf8').split('\n');
    for (const l of lines.filter((x) => /curl|install\.sh/.test(x) && !x.startsWith('#')))
      expect(l.trimStart().startsWith('"'), l).toBe(true);
    expect(readdirSync(h)).toEqual([]);
    // The craft commands it names are the plugin's.
    for (const c of r.stderr.match(/\/[a-z0-9-]+(?=[,)])/g) ?? [])
      expect(
        commands.some((x) => `/${x.name}` === c),
        c,
      ).toBe(true);
  });
});

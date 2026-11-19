// SPDX-License-Identifier: AGPL-3.0-only
// `hildegard make`, the command Local Studio's plugin runs: it waits for the job, saves the file, reviews it, and
// refuses to clone a voice. And `hildegard connect local-studio`, which puts the plugin where Local Studio reads it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, parseArgs, startServer } from '@hildegard/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hildegardEnv, main, run } from './harness.ts';

const root = join(import.meta.dirname, '..', '..', '..');
// The review runs Hildegard's Python checks (PyAV, numpy, Pillow), as CI installs them.
const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

// Each test runs the CLI one or more times, as the other CLI tests do: give them the same room.
describe('hildegard make', { timeout: 60_000 }, () => {
  it('refuses every way of asking to clone a voice, before anything reaches Hildegard', async () => {
    const hits: string[] = [];
    const standIn = createServer((req, res) => {
      hits.push(`${req.method} ${req.url} ${req.headers['user-agent'] ?? ''}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
    const home = mkdtempSync(join(tmpdir(), 'hg-make-clone-'));
    try {
      for (const ask of [
        ['clone', 'my voice'],
        ['voice', 'clone', 'my voice'],
        ['clone-voice', 'sample.wav'],
        ['voice-clone'],
        ['cloning'],
      ]) {
        const out = await hildegardEnv(home, { HILDEGARD_URL: url }, 'make', ...ask);
        expect(out.ok, ask.join(' ')).toBe(false);
        expect(out.needsOwner).toBe(true);
        expect(out.steps[0]).toMatchObject({ id: 'clone', status: 'needs-owner' });
        expect(out.message).toContain(`${url}/#/voice/clone`);
        expect(out.message).toMatch(/^Refused: an agent can’t clone a voice\. Nothing was sent\./);
      }
      // A shell sees the refusal as a failure, so an agent can't read it as done.
      const exit = await run(process.execPath, [main, 'make', 'clone', 'my voice'], {
        env: { ...process.env, HOME: home, HILDEGARD_URL: url },
      }).then(
        () => 0,
        (e: { code: number }) => e.code,
      );
      expect(exit).toBe(1);
      expect(hits).toEqual([]);
    } finally {
      standIn.close();
    }
  });

  it('has no way to start a clone in its source: no clone route, no consent session', () => {
    const src = readFileSync(join(root, 'apps', 'cli', 'src', 'make.ts'), 'utf8');
    expect(src).not.toMatch(/voiceRun\(\s*['"]clone/);
    expect(src).not.toMatch(/\/api\/voice\/(clone|consent)/);
    expect(src).not.toMatch(/\.(startConsent|consentSession|cloneVoice)\(/);
  });

  it('says plainly when Hildegard isn’t running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-make-off-'));
    const out = await hildegardEnv(
      home,
      { HILDEGARD_URL: 'http://127.0.0.1:9' },
      'make',
      'image',
      'a red barn',
    );
    expect(out.ok).toBe(false);
    expect(out.steps[0]).toMatchObject({ id: 'server', status: 'failed' });
    expect(out.message).toContain('hildegard start');
  });

  it('says an older Hildegard needs updating, not a bare 404, when it lacks the route', async () => {
    // As 0.1.17 does: health answers, POST /api/images is not a route there.
    const old = createServer((req, res) => {
      if (req.url === '/api/health')
        return res
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"ok":true,"version":"0.1.17"}');
      res.writeHead(404, { 'content-type': 'text/plain' }).end('404 Not Found');
    });
    await new Promise<void>((r) => old.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
    try {
      const home = mkdtempSync(join(tmpdir(), 'hg-make-old-'));
      const out = await hildegardEnv(home, { HILDEGARD_URL: url }, 'make', 'image', 'a red barn');
      expect(out.ok).toBe(false);
      expect(out.steps[0]).toMatchObject({ id: 'server', status: 'failed' });
      expect(out.steps[0]!.detail).toContain(`${url} (0.1.17) can’t “make image” yet`);
      expect(out.message).toContain('NEXT: tell the person to run `hildegard update`');
      expect(out.message).not.toContain('answered 404');
    } finally {
      old.close();
    }
  });

  it('answers a request it doesn’t know with the forms it takes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-make-usage-'));
    const out = await hildegardEnv(home, { HILDEGARD_URL: 'http://127.0.0.1:9' }, 'make', 'song', 'a hymn');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/There is no “make song”\.\nNEXT:/);
    expect(out.steps[0]!.detail).toContain('hildegard make image');
  });

  describe('against a running Hildegard', () => {
    let srv: Awaited<ReturnType<typeof startServer>>;
    const data = mkdtempSync(join(tmpdir(), 'hg-make-data-'));
    beforeAll(async () => {
      srv = await startServer(
        { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 },
        { fakeTickMs: 20, secrets: fileStore(join(data, 'secret.json')) },
      );
    });
    afterAll(() => srv?.close());
    const env = () => ({ HILDEGARD_URL: srv.url, HILDEGARD_PYTHON: python, PATH: process.env.PATH ?? '' });

    it('waits for an image, saves it, reviews it, and says what to do next', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hg-make-img-'));
      const outDir = join(home, 'made');
      const out = await hildegardEnv(
        home,
        env(),
        'make',
        'image',
        'a red barn in snow at dusk, low sun, 35mm',
        '--out',
        outDir,
      );
      expect(out.message).toMatch(/^Made 1 image: /);
      const files = out.files as string[];
      expect(files).toHaveLength(1);
      expect(files[0]!.startsWith(outDir)).toBe(true);
      expect(statSync(files[0]!).size).toBeGreaterThan(0);
      const reviews = out.reviews as { file: string; passed: boolean; summary: string }[];
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.file).toBe(files[0]);
      expect(reviews[0]!.summary).toBeTruthy();
      // The next step follows the verdict: hand the file over, or change one thing and try again.
      expect(out.message).toMatch(
        reviews[0]!.passed
          ? /\nNEXT: give the person the file path/
          : /failed review\.\nNEXT: change one thing/,
      );
      expect(out.ok).toBe(reviews[0]!.passed);
      expect(
        out.steps.some((s) => s.id === 'review' && /^Review (passed|FAILED): image-/.test(s.title ?? '')),
      ).toBe(true);
    });

    it('reports a render that fails, with no file and a failed result', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hg-make-oom-'));
      const out = await hildegardEnv(
        home,
        env(),
        'make',
        'image',
        'a red barn [fail:oom]',
        '--out',
        join(home, 'made'),
      );
      expect(out.ok).toBe(false);
      expect(out.files).toEqual([]);
      expect(out.message).toMatch(/^Nothing was made\./);
      expect(out.steps.find((s) => s.id === 'image')).toMatchObject({ status: 'failed' });
    });
  });
});

describe('hildegard connect local-studio', { timeout: 60_000 }, () => {
  it('puts the plugin where Local Studio reads it, updates it in place, and takes it out', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-ls-home-'));
    const lsData = join(home, 'ls-data');
    const env = { LOCAL_STUDIO_DATA_DIR: lsData };
    const plugin = join(lsData, 'plugins', 'hildegard');

    const on = await hildegardEnv(home, env, 'connect', 'local-studio');
    expect(on.ok).toBe(true);
    expect(on.steps[0]).toMatchObject({ id: 'local-studio', status: 'done', detail: plugin });
    // No Local Studio command line on an empty PATH: the check is skipped, never faked.
    expect(on.steps[1]).toMatchObject({ id: 'validate', status: 'skipped' });
    expect(readFileSync(join(plugin, 'plugin.toml'), 'utf8')).toMatch(/^id = "hildegard"$/m);
    expect(existsSync(join(plugin, 'skills', 'hildegard-image', 'SKILL.md'))).toBe(true);

    const again = await hildegardEnv(home, env, 'connect', 'local-studio');
    expect(again.steps[0]).toMatchObject({ title: 'Updated in Local Studio', status: 'done' });

    const off = await hildegardEnv(home, env, 'disconnect', 'local-studio');
    expect(off.ok).toBe(true);
    expect(existsSync(plugin)).toBe(false);
  });

  it('never replaces or removes another plugin that happens to be called hildegard', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-ls-other-'));
    const lsData = join(home, 'ls-data');
    const other = join(lsData, 'plugins', 'hildegard');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'plugin.toml'), 'id = "someone-else"\nversion = "1.0.0"\n');
    const env = { LOCAL_STUDIO_DATA_DIR: lsData };

    const on = await hildegardEnv(home, env, 'connect', 'local-studio');
    expect(on.ok).toBe(false);
    const off = await hildegardEnv(home, env, 'disconnect', 'local-studio');
    expect(off.ok).toBe(false);
    expect(readFileSync(join(other, 'plugin.toml'), 'utf8')).toContain('someone-else');
  });

  it('reports what Local Studio’s validator says about the copy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hg-ls-val-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'local-studio');
    writeFileSync(fake, '#!/bin/sh\necho "error: $3 is not valid" >&2\nexit 2\n', { mode: 0o755 });
    if (process.platform === 'win32') return;
    const out = await hildegardEnv(
      home,
      { LOCAL_STUDIO_DATA_DIR: join(home, 'ls-data'), LOCAL_STUDIO_CLI: fake },
      'connect',
      'local-studio',
    );
    expect(out.ok).toBe(false);
    expect(out.steps[1]).toMatchObject({ id: 'validate', status: 'failed' });
    expect(out.steps[1]!.detail).toContain('is not valid');
  });
});

describe('the Local Studio plugin', () => {
  const dir = join(root, 'local-studio', 'hildegard');
  const toml = readFileSync(join(dir, 'plugin.toml'), 'utf8');
  const commands = [...toml.matchAll(/\[\[commands\]\]\s*\nname = "([^"]+)"[\s\S]*?skill = "([^"]+)"/g)].map(
    (m) => ({
      name: m[1]!,
      skill: m[2]!,
    }),
  );

  it('is named for its folder and carries the release version', () => {
    expect(toml).toMatch(/^id = "hildegard"$/m);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    expect(toml).toMatch(new RegExp(`^version = "${version.replace(/\./g, '\\.')}"$`, 'm'));
  });

  it('asks for no capabilities: its skills run the hildegard command', () => {
    expect(toml).toMatch(/^capabilities = \[\]$/m);
    expect(toml).not.toMatch(/^\[mcp\]/m);
  });

  it('points every command at a skill it ships, and has no command for cloning', () => {
    expect(commands.map((c) => c.name).sort()).toEqual(
      ['clean-audio', 'design-voice', 'hildegard', 'image', 'speak', 'video'].sort(),
    );
    for (const c of commands)
      expect(existsSync(join(dir, 'skills', c.skill, 'SKILL.md')), c.skill).toBe(true);
    expect(toml).not.toMatch(/clone/i);
  });

  it('tells the agent in every voice skill that it never clones, and where the person does', () => {
    for (const skill of ['hildegard-media', 'hildegard-speech', 'hildegard-voice']) {
      const text = readFileSync(join(dir, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text, skill).toMatch(/[Nn]ever clone/);
      expect(text, skill).toMatch(/Voice › Clone/);
    }
  });
});

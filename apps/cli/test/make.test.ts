// SPDX-License-Identifier: AGPL-3.0-only
// `hildegard make`, the command Local Studio's plugin runs: it waits for the job, saves the file, reviews it, and
// refuses to clone a voice. And `hildegard connect local-studio`, which puts the plugin where Local Studio reads it.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCatalog } from '@hildegard/presets';
import { layout } from '@hildegard/runtime';
import { fileStore, parseArgs, startServer } from '@hildegard/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliEnv, hildegardEnv, hildegardWithStdin, main, run } from './harness.ts';

const root = join(import.meta.dirname, '..', '..', '..');
// The review runs Hildegard's Python checks (PyAV, numpy, Pillow): the Python CI installs them in, or, against an
// installed release (HILDEGARD_CLI is <data>/app/hildegard.mjs), the one that release installed.
const installed = process.env.HILDEGARD_CLI ? layout(dirname(dirname(process.env.HILDEGARD_CLI))).python : '';
const python =
  process.env.HILDEGARD_PYTHON ??
  (installed && existsSync(installed) ? installed : process.platform === 'win32' ? 'python' : 'python3');

// Each test runs the CLI one or more times, as the other CLI tests do: give them the same room.
describe('hildegard make', { timeout: 60_000 }, () => {
  it('refuses every way of asking to clone a voice, before anything reaches Hildegard', async () => {
    const hits: string[] = [];
    const standIn = createServer((req, res) => {
      // The CLI runs on Node; other programs on a developer's computer scan local ports (a Bun one asked for /v1/models).
      const ua = req.headers['user-agent'] ?? '';
      if (ua === 'node' || ua === '' || req.headers['x-hildegard'] !== undefined)
        hits.push(`${req.method} ${req.url} ${ua}`);
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
        env: { ...cliEnv(home), PATH: process.env.PATH ?? '', HILDEGARD_URL: url },
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
    const hadPython = process.env.HILDEGARD_PYTHON;
    beforeAll(async () => {
      // The server in this process cleans recordings with HILDEGARD_PYTHON when its data has no Python of its own.
      process.env.HILDEGARD_PYTHON = python;
      srv = await startServer(
        { ...parseArgs(['--fake-gpu', '--data', data]), port: 0 },
        { fakeTickMs: 20, secrets: fileStore(join(data, 'secret.json')) },
      );
    });
    afterAll(() => {
      srv?.close();
      if (hadPython === undefined) delete process.env.HILDEGARD_PYTHON;
      else process.env.HILDEGARD_PYTHON = hadPython;
    });
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

    it('never reads a file it couldn’t check as passed, and gives prompt advice without asking the owner', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hg-make-unchecked-'));
      const out = await hildegardEnv(
        home,
        { ...env(), HILDEGARD_PYTHON: join(home, 'no-python-here') },
        'make',
        'image',
        'a red barn in snow, 8k masterpiece',
        '--out',
        join(home, 'made'),
      );
      expect(out.files).toHaveLength(1);
      expect(out.reviews).toEqual([]);
      expect(out.steps.find((s) => s.id === 'review')).toMatchObject({ status: 'skipped' });
      expect(out.message).toMatch(
        /1 file couldn’t be checked here\.\nNEXT: .*Hildegard’s checks couldn’t run, so they should look at it themselves\./,
      );
      expect(out.message).not.toContain('NEXT: give the person the file path and say');
      // "8k" and "masterpiece" draw advice for the next try; that is not a question for the owner.
      expect(out.steps.find((s) => s.id === 'prompt')).toMatchObject({ status: 'skipped' });
      expect(out.needsOwner).toBe(false);
    });

    it('names a real video model and its install command when none is installed, and renders nothing', async () => {
      const catalog = await (await fetch(`${srv.url}/api/catalog`)).text();
      const asked: string[] = [];
      const bare = createServer((req, res) => {
        asked.push(`${req.method} ${req.url}`);
        const json = (body: string) => res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        if (req.url === '/api/catalog') return json(catalog);
        if (req.url === '/api/snapshot') return json('{"models":[]}');
        res.writeHead(500).end();
      });
      await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
      try {
        const home = mkdtempSync(join(tmpdir(), 'hg-make-nomodel-'));
        const out = await hildegardEnv(
          home,
          { HILDEGARD_URL: `http://127.0.0.1:${(bare.address() as AddressInfo).port}` },
          'make',
          'video',
          'a red barn in snow',
        );
        expect(out.ok).toBe(false);
        expect(out.steps[0]).toMatchObject({ id: 'model', status: 'failed' });
        expect(out.steps[0]!.detail).toMatch(/hildegard models install [a-z0-9][a-z0-9.-]+$/);
        expect(out.message).not.toContain('undefined');
        expect(asked.filter((a) => a.startsWith('POST'))).toEqual([]);
      } finally {
        bare.close();
      }
    });

    it('sends the camera move it is given, and refuses one Hildegard lacks before anything is sent', async () => {
      const catalog = await (await fetch(`${srv.url}/api/catalog`)).text();
      const video = (JSON.parse(catalog) as { models: { id: string; kind: string }[] }).models.find(
        (m) => m.kind === 'video',
      )!.id;
      const posted: unknown[] = [];
      const take = {
        id: 't1',
        number: 1,
        status: 'failed',
        quality: 'draft',
        width: 1,
        height: 1,
        seconds: 5,
        seed: 1,
      };
      const stub = createServer((req, res) => {
        const json = (body: unknown, code = 200) =>
          res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (req.url === '/api/catalog')
          return res.writeHead(200, { 'content-type': 'application/json' }).end(catalog);
        if (req.url === '/api/snapshot') return json({ models: [{ id: video, installed: true }] });
        if (req.method === 'POST' && req.url === '/api/shots') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            posted.push(JSON.parse(body));
            json({ project: { id: 'p1' }, shot: { id: 's1' }, takes: [take] }, 201);
          });
          return;
        }
        if (req.url === '/api/shots/s1') return json({ shot: { id: 's1' }, takes: [take] });
        res.writeHead(500).end();
      });
      await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
      try {
        const home = mkdtempSync(join(tmpdir(), 'hg-make-move-'));
        const url = { HILDEGARD_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}` };
        const bad = await hildegardEnv(home, url, 'make', 'video', 'a red barn in snow', '--move', 'zoomies');
        expect(bad.ok).toBe(false);
        expect(bad.message).toMatch(/--move is one of: static, dolly-in, /);
        expect(posted).toEqual([]);

        await hildegardEnv(
          home,
          url,
          'make',
          'video',
          'a red barn in snow, the door swings open',
          '--move',
          'dolly-in',
        );
        expect(posted).toHaveLength(1);
        expect((posted[0] as { request: { motion: unknown } }).request.motion).toEqual([
          { id: 'dolly-in', strength: 0.8 },
        ]);
      } finally {
        stub.close();
      }
    });

    it('speaks, designs and keeps a voice, and cleans a recording, each to a file it reviewed', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hg-make-voice-'));
      const out = join(home, 'made');
      const voices = await hildegardEnv(home, env(), 'make', 'voices');
      expect(voices.ok).toBe(true);
      expect(voices.message).toMatch(/^Voices: .*kokoro-heart/);

      const speech = await hildegardEnv(
        home,
        env(),
        'make',
        'speech',
        'The barn stood in the snow.',
        '--voice',
        'kokoro-heart',
        '--out',
        out,
      );
      expect(speech.message).toMatch(/^Spoke the script in kokoro-heart: /);
      const wav = (speech.files as string[])[0]!;
      expect(statSync(wav).size).toBeGreaterThan(0);
      expect(speech.reviews).toHaveLength(1);

      // As the /speak skill sends it: on stdin, so quotes and dollar signs reach Hildegard as written.
      const script = 'It costs $20. She said "go" and `left`.';
      const piped = await hildegardWithStdin(
        home,
        script,
        'make',
        'speech',
        '-',
        '--voice',
        'kokoro-heart',
        '--port',
        new URL(srv.url).port,
        '--out',
        out,
      );
      expect(piped.message).toMatch(/^Spoke the script in kokoro-heart: /);
      const sent = (await (await fetch(`${srv.url}/api/voice/jobs/${piped.job as string}`)).json()) as {
        request: unknown;
      };
      expect(JSON.stringify(sent.request)).toContain(JSON.stringify(script).slice(1, -1));

      const design = await hildegardEnv(
        home,
        env(),
        'make',
        'voice',
        'a warm older farmer, slow and kind',
        '--text',
        'The barn stood in the snow.',
        '--count',
        '2',
        '--out',
        out,
      );
      expect(design.files).toHaveLength(2);
      const job = design.job as string;
      expect(design.message).toContain(
        `NEXT: give the person the file paths to listen to, ask which one to keep`,
      );
      expect(design.message).toContain(`hildegard make voice keep ${job} <number> --name`);

      const keep = await hildegardEnv(home, env(), 'make', 'voice', 'keep', job, '2', '--name', 'Farmer');
      expect(keep.ok).toBe(true);
      expect(keep.message).toMatch(/^Kept “Farmer” as voice \S+\.\nNEXT: /);
      const listed = await hildegardEnv(home, env(), 'make', 'voices');
      expect(listed.message).toContain(keep.voice as string);

      const clean = await hildegardEnv(home, env(), 'make', 'clean', wav, '--out', out);
      expect(clean.message).toMatch(/^Cleaned the recording: /);
      expect((clean.files as string[])[0]).toMatch(/-clean\.wav$/);
      expect(clean.steps.find((s) => s.id === 'clean')).toMatchObject({ status: 'done' });
      expect(clean.reviews).toHaveLength(1);
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
    if (process.platform !== 'win32')
      expect(statSync(join(plugin, 'bin', 'hildegard-mcp')).mode & 0o777).toBe(0o755);

    const again = await hildegardEnv(home, env, 'connect', 'local-studio');
    expect(again.steps[0]).toMatchObject({ title: 'Updated in Local Studio', status: 'done' });

    const off = await hildegardEnv(home, env, 'disconnect', 'local-studio');
    expect(off.ok).toBe(true);
    expect(existsSync(plugin)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'installs the MCP command executable even when the shipped copy lost its execute bit',
    async () => {
      // A release whose launcher lost the bit on the way (a zip, a Windows-built archive): Local Studio couldn't run it.
      const home = mkdtempSync(join(tmpdir(), 'hg-ls-mode-'));
      const lsData = join(home, 'ls-data');
      const shipped = join(home, 'shipped');
      cpSync(join(root, 'local-studio'), join(shipped, 'local-studio'), { recursive: true });
      chmodSync(join(shipped, 'local-studio', 'hildegard', 'bin', 'hildegard-mcp'), 0o644);
      const on = await hildegardEnv(
        home,
        { LOCAL_STUDIO_DATA_DIR: lsData, HILDEGARD_RESOURCES: shipped },
        'connect',
        'local-studio',
      );
      expect(on.ok).toBe(true);
      const launcher = join(lsData, 'plugins', 'hildegard', 'bin', 'hildegard-mcp');
      expect(statSync(launcher).mode & 0o777).toBe(0o755);
    },
  );

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

    // Any plugin in that folder has the id hildegard, as Local Studio requires: without Hildegard's marker it stays.
    writeFileSync(join(other, 'plugin.toml'), 'id = "hildegard"\nversion = "9.0.0"\n');
    expect((await hildegardEnv(home, env, 'connect', 'local-studio')).ok).toBe(false);
    expect((await hildegardEnv(home, env, 'disconnect', 'local-studio')).ok).toBe(false);
    expect(readFileSync(join(other, 'plugin.toml'), 'utf8')).toContain('9.0.0');
    expect(existsSync(join(other, '.hildegard-plugin'))).toBe(false);
  });

  // A stand-in for Local Studio's command line that says what the test needs it to.
  const fakeValidator = (home: string, script: string) => {
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'local-studio');
    writeFileSync(fake, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return fake;
  };

  it.skipIf(process.platform === 'win32')(
    'installs nothing Local Studio’s validator refuses, and keeps the copy already there',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'hg-ls-val-'));
      const lsData = join(home, 'ls-data');
      const plugins = join(lsData, 'plugins');
      // As Local Studio refuses one: exit 1, `error:` lines on stdout.
      const refuse = fakeValidator(home, 'echo "error: $3 is not valid"\nexit 1');

      const first = await hildegardEnv(
        home,
        { LOCAL_STUDIO_DATA_DIR: lsData, LOCAL_STUDIO_CLI: refuse },
        'connect',
        'local-studio',
      );
      expect(first.ok).toBe(false);
      expect(first.steps[0]).toMatchObject({ id: 'validate', status: 'failed' });
      expect(first.steps[0]!.detail).toContain('is not valid');
      expect(first.message).toBe('Nothing was installed.');
      expect(existsSync(join(plugins, 'hildegard'))).toBe(false);

      // A copy that is there stays when the update is refused, and no half-copied folder is left beside it.
      const ok = await hildegardEnv(home, { LOCAL_STUDIO_DATA_DIR: lsData }, 'connect', 'local-studio');
      expect(ok.ok).toBe(true);
      writeFileSync(join(plugins, 'hildegard', 'marker'), 'first copy');
      const again = await hildegardEnv(
        home,
        { LOCAL_STUDIO_DATA_DIR: lsData, LOCAL_STUDIO_CLI: refuse },
        'connect',
        'local-studio',
      );
      expect(again.ok).toBe(false);
      expect(again.message).toMatch(/^Nothing was changed/);
      expect(readFileSync(join(plugins, 'hildegard', 'marker'), 'utf8')).toBe('first copy');
      expect(readdirSync(plugins)).toEqual(['hildegard']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads a validator that doesn’t know the command as no verdict, not a refusal',
    async () => {
      for (const [how, script] of [
        ['GLib', 'echo "Unknown option: plugin" >&2\nexit 2'],
        [
          'clap',
          'echo "error: unrecognized subcommand \'plugin\'" >&2\necho "Usage: local-studio" >&2\nexit 2',
        ],
        [
          'argparse',
          'echo "usage: local-studio" >&2\necho "local-studio: error: invalid choice: \'plugin\'" >&2\nexit 2',
        ],
      ] as const) {
        const home = mkdtempSync(join(tmpdir(), 'hg-ls-noverdict-'));
        const lsData = join(home, 'ls-data');
        const out = await hildegardEnv(
          home,
          { LOCAL_STUDIO_DATA_DIR: lsData, LOCAL_STUDIO_CLI: fakeValidator(home, script) },
          'connect',
          'local-studio',
        );
        expect(out.ok, how).toBe(true);
        expect(out.steps[1], how).toMatchObject({ id: 'validate', status: 'skipped' });
        expect(out.steps[1]!.detail, how).toContain('gave no verdict');
        expect(existsSync(join(lsData, 'plugins', 'hildegard', 'plugin.toml')), how).toBe(true);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'names the installed folder, not the staging one, in a pass',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'hg-ls-pass-'));
      const lsData = join(home, 'ls-data');
      const pass = fakeValidator(home, 'echo "OK $3"');
      const out = await hildegardEnv(
        home,
        { LOCAL_STUDIO_DATA_DIR: lsData, LOCAL_STUDIO_CLI: pass },
        'connect',
        'local-studio',
      );
      expect(out.ok).toBe(true);
      expect(out.steps[1]).toMatchObject({
        id: 'validate',
        status: 'done',
        detail: `OK ${join(lsData, 'plugins', 'hildegard')}`,
      });
    },
  );
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

  it('gives no word in the prompt-writing step that a small model copies into its prompt', () => {
    // The live /video smoke: with "Hildegard refuses both" in step 1, LFM2.5 8B wrote "A painter refuses to create a scene".
    for (const skill of ['hildegard-image', 'hildegard-video']) {
      const text = readFileSync(join(dir, 'skills', skill, 'SKILL.md'), 'utf8');
      const step1 = text.slice(text.indexOf('1. '), text.indexOf('2. '));
      expect(step1, skill).not.toMatch(/refuse/i);
    }
  });

  it('has /video pick a camera move from Hildegard’s own, since a shot without one holds still', () => {
    // The live /video smoke rendered a nearly still barn: with no move, the shot asks for a steady camera.
    const text = readFileSync(join(dir, 'skills', 'hildegard-video', 'SKILL.md'), 'utf8');
    expect(text).toContain('hildegard make video "<your prompt>" --move <move> --quality draft');
    const step2 = text.slice(text.indexOf('2. '), text.indexOf('3. '));
    const named = [...step2.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
    const known = new Set(loadCatalog().catalog.motions.map((m) => m.id));
    expect(named.length).toBeGreaterThan(5);
    for (const id of named) expect(known.has(id), id).toBe(true);
  });

  it('carries the marker that tells connect and disconnect the folder is Hildegard’s', () => {
    expect(existsSync(join(dir, '.hildegard-plugin'))).toBe(true);
  });

  it('hands the speech script over on stdin, never inside shell quotes', () => {
    // In double quotes, the shell changes $20 or "go" before Hildegard sees the script.
    for (const skill of ['hildegard-speech', 'hildegard-media']) {
      const text = readFileSync(join(dir, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text, skill).not.toMatch(/make speech "/);
      expect(text, skill).toContain("hildegard make speech - --voice <voice id> <<'SCRIPT'");
    }
  });

  it('asks only to run Hildegard’s MCP server: no question, screen or input capability', () => {
    expect(toml).toMatch(/^capabilities = \["mcp-server"\]$/m);
    expect(toml).toMatch(/^\[mcp\]\ncommand = "bin\/hildegard-mcp"$/m);
    // No tool rents a GPU or spends money, so nothing needs a question only the person can answer.
    expect(toml).not.toMatch(/ask-user|screen-capture|synthetic-input|site-secrets|accessibility/);
  });

  it('shows its name and a small icon on Local Studio’s consent sheet', () => {
    expect(toml).toMatch(/^name = "Hildegard"$/m);
    expect(toml).toMatch(/^icon = "icon.png"$/m);
    const png = readFileSync(join(dir, 'icon.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeLessThan(200 * 1024);
  });

  it('points every command at a skill it ships, and has no command for cloning', () => {
    expect(commands.map((c) => c.name).sort()).toEqual(
      [
        'clean-audio',
        'design-voice',
        'hildegard',
        'image',
        'speak',
        'video',
        // The craft skills, synced from skills/ (scripts/sync-local-studio-skills.mjs).
        '3d',
        'art',
        'design',
        'edit-video',
        'film',
        'loop',
        'motion',
        'music',
        'photo',
        'sound',
        'web',
      ].sort(),
    );
    for (const c of commands)
      expect(existsSync(join(dir, 'skills', c.skill, 'SKILL.md')), c.skill).toBe(true);
    expect(toml).not.toMatch(/clone/i);
  });

  it('names only its own command in each single-purpose skill, so a small model runs the right one', () => {
    // The live smoke: an 8B model under /video ran `make image`, the other command its skill named.
    const own: Record<string, string[]> = {
      'hildegard-image': ['image'],
      'hildegard-video': ['video'],
      'hildegard-speech': ['speech', 'voices'],
      'hildegard-voice': ['voice'],
      'hildegard-clean': ['clean'],
    };
    for (const [skill, kinds] of Object.entries(own)) {
      const text = readFileSync(join(dir, 'skills', skill, 'SKILL.md'), 'utf8');
      const named = new Set([...text.matchAll(/hildegard make ([a-z-]+)/g)].map((m) => m[1]));
      expect([...named].sort(), skill).toEqual([...kinds].sort());
    }
  });

  it('tells the agent in every voice skill that it never clones, and where the person does', () => {
    for (const skill of ['hildegard-media', 'hildegard-speech', 'hildegard-voice']) {
      const text = readFileSync(join(dir, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text, skill).toMatch(/[Nn]ever clone/);
      expect(text, skill).toMatch(/Voice › Clone/);
    }
  });
});

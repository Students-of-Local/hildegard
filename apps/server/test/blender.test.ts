// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Blender,
  blenderBusy,
  blenderFiles,
  blenderSetting,
  findBlender,
  looksLikeBlender,
  probeBlender,
  tracebackLine,
} from '../src/blender.ts';
import { fileStore, parseArgs, startServer } from '../src/index.ts';
import { Loops, sniff } from '../src/loop.ts';
import { freePort } from './harness.ts';

const blender = findBlender();
if (!blender)
  console.warn(
    'blender.test.ts: no Blender here (set HILDEGARD_BLENDER or put blender on PATH), so the tests that run build scripts skip.',
  );

const H = { 'content-type': 'application/json', 'x-hildegard': '1' };
const PASS = 'correct horse battery staple';
const BRIEF = {
  kind: 'model',
  title: 'Figurine',
  brief: { for: 'a desk figurine, 120 mm', what: 'a seated figure', specifics: ['a round head'] },
};
const script = (...lines: string[]) =>
  [
    '# hildegard: blender',
    'import bpy, os, sys',
    'out = sys.argv[sys.argv.index("--out") + 1]',
    'bpy.ops.wm.read_factory_settings(use_empty=True)',
    ...lines,
  ].join('\n');
const exportGlb = 'bpy.ops.export_scene.gltf(filepath=os.path.join(out, "model.glb"), export_yup=True)';
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

/** A request with any Host and headers, which fetch won't send. */
function raw(url: string, path: string, method: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; json: { code?: string; error?: string } }>((ok, fail) => {
    const req = request(`${url}${path}`, { method, headers }, (res) => {
      let t = '';
      res.on('data', (d) => {
        t += d;
      });
      res.on('end', () => ok({ status: res.statusCode ?? 0, json: JSON.parse(t || '{}') }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

interface Reply {
  code?: string;
  error?: string;
  round: {
    format: string;
    source: string;
    sheet: string | null;
    review: { info: Record<string, unknown>; checks: { id: string }[] };
  };
}

async function serve(opts: { blender?: Blender | null; args?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hg-blender-'));
  const srv = await startServer(
    {
      ...parseArgs(['--fake-gpu', '--data', dir, ...(opts.args ?? [])]),
      port: 0,
      hostPort: await freePort(),
    },
    { fakeTickMs: 20, secrets: fileStore(join(dir, 'secret.json')), blender: opts.blender },
  );
  const server = createMcpServer(new HildegardClient(srv.url));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'blender-test', version: '1.0.0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const start = async (base = srv.url, cookie?: string) => {
    const res = await fetch(`${base}/api/loops`, {
      method: 'POST',
      headers: { ...H, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(BRIEF),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const submit = async (id: string, src: string, base = srv.url, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/loops/${id}/rounds?note=build`, {
      method: 'POST',
      headers: { 'x-hildegard': '1', ...headers },
      body: src,
    });
    return { status: res.status, json: (await res.json()) as Reply };
  };
  const close = async () => {
    await client.close();
    await srv.close();
  };
  return { srv, dir, call, start, submit, close, tools: () => client.listTools() };
}

describe('reading a Blender build script', () => {
  it('knows one by its first line, and reads the line that failed from a traceback', () => {
    expect(looksLikeBlender('# hildegard: blender\nimport bpy')).toBe(true);
    expect(looksLikeBlender('import bpy\n# hildegard: blender')).toBe(false);
    expect(sniff(new TextEncoder().encode('# hildegard: blender\r\nimport bpy'))).toBe('py');
    expect(sniff(new TextEncoder().encode('# a comment\nv 1 2 3\n'))).toBe('obj');
    expect(
      tracebackLine(
        'Traceback (most recent call last):\n  File "build.py", line 12, in <module>\n    boom()\nValueError: no head\n',
      ),
    ).toBe('build.py line 12: ValueError: no head');
  });

  it.skipIf(process.platform === 'win32')(
    'finds a Blender installed after it first looked, without a restart',
    () => {
      const p = join(mkdtempSync(join(tmpdir(), 'hg-blender-late-')), 'blender');
      const env = { HILDEGARD_BLENDER: p, PATH: process.env.PATH };
      expect(findBlender(env)).toBeNull();
      writeFileSync(p, '#!/bin/sh\necho "Blender 5.2.2 LTS"\n', { mode: 0o755 });
      expect(findBlender(env)).toEqual({ path: realpathSync(p), version: '5.2.2 LTS' });
    },
  );

  it('turns build scripts off when blender.json can’t be read or isn’t exactly on or off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-blender-setting-'));
    const file = join(dir, 'blender.json');
    expect(blenderSetting(dir)).toEqual({ scripts: 'on', problem: null });
    for (const [text, scripts] of [
      ['{"blenderScripts": "on"}', 'on'],
      ['{"blenderScripts": "off"}', 'off'],
    ] as const) {
      writeFileSync(file, text);
      expect(blenderSetting(dir)).toEqual({ scripts, problem: null });
    }
    for (const text of [
      '{"blenderScripts": "off",}',
      '{"blenderScripts": false}',
      '{"blenderScripts": "Off"}',
      'false',
      '"Off"',
      '{}',
    ]) {
      writeFileSync(file, text);
      expect(blenderSetting(dir), text).toMatchObject({
        scripts: 'off',
        problem: expect.stringContaining('isn’t valid'),
      });
    }
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      writeFileSync(file, '{"blenderScripts": "on"}');
      chmodSync(file, 0o000);
      try {
        expect(blenderSetting(dir)).toMatchObject({
          scripts: 'off',
          problem: expect.stringContaining('can’t be read'),
        });
      } finally {
        chmodSync(file, 0o600);
      }
    }
  });

  it('looks only where HILDEGARD_BLENDER says when it is set', () => {
    // Even with a Blender on PATH, as there is when one was found.
    const path = blender ? dirname(blender.path) : process.env.PATH;
    expect(findBlender({ HILDEGARD_BLENDER: '/nowhere/blender', PATH: path })).toBeNull();
  });
});

describe('who may send a build script', { timeout: 60_000 }, () => {
  let s: Awaited<ReturnType<typeof serve>>;
  let owner: string;
  let remote: string;
  beforeAll(async () => {
    // No Blender: a round that gets past who may send it is refused as no_blender, one that doesn't as blender_remote.
    s = await serve({ blender: null, args: ['--allow-host', 'studio.example'] });
    remote = s.srv.hostedUrl()!;
    expect(
      (
        await fetch(`${s.srv.url}/api/people/owner`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
        })
      ).status,
    ).toBe(201);
    const res = await fetch(`${remote}/api/auth/signin`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name: 'Ada', passphrase: PASS }),
    });
    owner = res.headers.getSetCookie()[0]!.split(';')[0]!;
  });
  afterAll(() => s.close());
  const src = script('open("/tmp/never", "w")', exportGlb);

  it('lets this computer through, and only it', async () => {
    const id = await s.start();
    expect((await s.submit(id, src)).json.code).toBe('no_blender');
    expect(textOf(await s.call('blender_status'))).toContain('no_blender');
  });

  it('refuses the owner signed in through the link', async () => {
    const id = await s.start(remote, owner);
    const r = await s.submit(id, src, remote, { cookie: owner });
    expect(r).toMatchObject({ status: 403, json: { code: 'blender_remote' } });
    expect(r.json.error).toContain('GLB');
  });

  it('refuses a proxy on this computer, by its headers or the name it was reached at', async () => {
    const id = await s.start();
    const fwd = await s.submit(id, src, s.srv.url, { cookie: owner, 'x-forwarded-for': '100.64.0.9' });
    expect(fwd).toMatchObject({ status: 403, json: { code: 'blender_remote' } });
    const named = await raw(
      s.srv.url,
      `/api/loops/${id}/rounds`,
      'POST',
      {
        host: 'studio.example',
        'x-hildegard': '1',
      },
      src,
    );
    expect(named).toMatchObject({ status: 403, json: { code: 'blender_remote' } });
    const site = await s.submit(id, src, s.srv.url, { origin: 'https://studio.example' });
    expect(site).toMatchObject({ status: 403, json: { code: 'blender_remote' } });
  });

  it('refuses a page on Hildegard’s own address, a published site or a preview', async () => {
    const id = await s.start();
    const same = await s.submit(id, src, s.srv.url, { origin: s.srv.url });
    expect(same).toMatchObject({ status: 403, json: { code: 'blender_remote' } });
    const meta = await raw(
      s.srv.url,
      `/api/loops/${id}/rounds`,
      'POST',
      { host: new URL(s.srv.url).host, 'x-hildegard': '1', 'sec-fetch-site': 'same-origin' },
      src,
    );
    expect(meta).toMatchObject({ status: 403, json: { code: 'blender_remote' } });
    expect(readdirSync(join(s.dir, 'media', 'loops', id))).toEqual(['loop.json']);
  });

  it('refuses an MCP key, and an MCP call reached by another name', async () => {
    const key = (await (
      await fetch(`${s.srv.url}/api/auth/keys`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ name: 'Laptop' }),
      })
    ).json()) as { key: string };
    const client = new Client({ name: 'elsewhere', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${remote}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key.key}` } },
      }),
    );
    try {
      const started = textOf(
        (await client.callTool({
          name: 'loop_start',
          arguments: { kind: 'model', title: BRIEF.title, ...BRIEF.brief },
        })) as CallToolResult,
      );
      const id = /Loop (\w{16})/.exec(started)![1]!;
      const r = (await client.callTool({
        name: 'loop_submit',
        arguments: { loop_id: id, note: 'build', text: src },
      })) as CallToolResult;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('only when it comes from this computer');
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === 'loop_start')!.description).not.toContain('build script');
    } finally {
      await client.close();
    }
    const here = (await s.tools()).tools.find((t) => t.name === 'loop_start')!.description;
    expect(here).toContain('Blender build script whose first line is `# hildegard: blender`');
    const init = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'loop_submit', arguments: { loop_id: await s.start(), note: 'build', text: src } },
    });
    const mcp = await new Promise<string>((ok) => {
      const req = request(
        `${s.srv.url}/mcp`,
        {
          method: 'POST',
          headers: {
            host: 'studio.example',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          let t = '';
          res.on('data', (d) => {
            t += d;
          });
          res.on('end', () => ok(t));
        },
      );
      req.end(init);
    });
    expect(mcp).toContain('only when it comes from this computer');
  });

  it('turns build scripts off for everyone, this computer too', async () => {
    writeFileSync(join(s.dir, 'blender.json'), JSON.stringify({ blenderScripts: 'off' }));
    try {
      const id = await s.start();
      expect(await s.submit(id, src)).toMatchObject({ status: 403, json: { code: 'blender_off' } });
      writeFileSync(join(s.dir, 'blender.json'), '{"blenderScripts": "off",}');
      expect(await s.submit(id, src)).toMatchObject({ status: 403, json: { code: 'blender_off' } });
    } finally {
      writeFileSync(join(s.dir, 'blender.json'), JSON.stringify({ blenderScripts: 'on' }));
    }
  });

  it('never starts Blender for a round that didn’t say it came from this computer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-blender-loops-'));
    const marker = join(dir, 'ran');
    const loops = new Loops({
      dir,
      reviewModel: async () => ({ passed: true, checks: [], info: {} }) as never,
      renderBlender: async () => {
        writeFileSync(marker, 'x');
        return null;
      },
    });
    const l = loops.start(BRIEF as never);
    await expect(loops.submit(l.id, new TextEncoder().encode(src), 'build')).rejects.toThrow(
      /this computer itself/,
    );
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(join(dir, l.id))).toEqual(['loop.json']);
  });
});

describe('blender_status without Blender', { timeout: 60_000 }, () => {
  it('says no_blender and how to install it when HILDEGARD_BLENDER points at nothing', async () => {
    const was = process.env.HILDEGARD_BLENDER;
    process.env.HILDEGARD_BLENDER = join(tmpdir(), 'no-blender-here');
    const s = await serve();
    try {
      expect(textOf(await s.call('blender_status'))).toMatch(/no_blender\).*blender\.org/);
    } finally {
      if (was === undefined) delete process.env.HILDEGARD_BLENDER;
      else process.env.HILDEGARD_BLENDER = was;
      await s.close();
    }
  });
});

describe.skipIf(!blender)('a model loop built in Blender', { timeout: 600_000 }, () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    s = await serve();
  });
  afterAll(() => s.close());

  it('says the version and the path at once, and whether Cycles renders once it has looked', async () => {
    const asked = Date.now();
    const first = textOf(await s.call('blender_status'));
    expect(Date.now() - asked).toBeLessThan(2000);
    expect(first).toContain(`Blender ${blender!.version} at ${blender!.path}`);
    expect(first).toContain('is being checked');
    let t = first;
    for (let i = 0; i < 300 && t.includes('is being checked'); i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      t = textOf(await s.call('blender_status'));
    }
    expect(t).toContain('Cycles renders on the CPU here');
  });

  it('says why build scripts are off when blender.json isn’t valid', async () => {
    writeFileSync(join(s.dir, 'blender.json'), '{"blenderScripts": false}');
    try {
      expect(textOf(await s.call('blender_status'))).toContain('blender.json isn’t valid');
    } finally {
      writeFileSync(join(s.dir, 'blender.json'), '{"blenderScripts": "on"}');
    }
  });

  it('runs a Blender reached through a link, from its own folder', async () => {
    const link = join(mkdtempSync(join(tmpdir(), 'hg-blender-link-')), 'blender');
    symlinkSync(blender!.path, link);
    const b = probeBlender(link)!;
    expect(b.path).toBe(realpathSync(blender!.path));
    expect(blenderFiles(b.path)).toEqual(blenderFiles(realpathSync(blender!.path)));
    expect(blenderFiles(b.path)).not.toBeNull();
    const linked = await serve({ blender: b });
    try {
      const id = await linked.start();
      const r = await linked.submit(id, script('bpy.ops.mesh.primitive_cube_add(size=10)', exportGlb));
      expect(r.status, r.json.error).toBe(201);
    } finally {
      await linked.close();
    }
  });

  it('runs the build, then the normal model review on the GLB it wrote', async () => {
    const id = await s.start();
    const r = await s.submit(
      id,
      script(
        'bpy.ops.mesh.primitive_uv_sphere_add(radius=15, location=(0, 0, 45 + 0.7 * 15))',
        'bpy.ops.mesh.primitive_cylinder_add(radius=20, depth=45, location=(0, 0, 22.5))',
        'for o in bpy.context.scene.objects:',
        '    o.modifiers.new("sub", "SUBSURF").levels = 2',
        'bpy.ops.export_scene.gltf(filepath=os.path.join(out, "model.glb"), export_yup=True, export_apply=True)',
      ),
    );
    expect(r.status, JSON.stringify(r.json).slice(0, 800)).toBe(201);
    const round = r.json.round;
    expect(round.format).toBe('glb');
    expect(round.source).toMatch(/round-1\.py$/);
    expect(round.review.info.blender).toMatch(new RegExp(`^${blender!.version}, [\\d.]+ s$`));
    expect(round.review.checks.map((c) => c.id)).toContain('watertight');
    expect(round.sheet).toBeTruthy();
    expect(readdirSync(join(s.dir, 'media', 'loops', id)).filter((f) => f.endsWith('.src'))).toEqual([]);
  });

  it('stands a box that is tall in Blender’s z up in the review', async () => {
    const id = await s.start();
    const r = await s.submit(
      id,
      script(
        'bpy.ops.mesh.primitive_cube_add(size=1)',
        'bpy.context.object.scale = (10, 10, 40)',
        'bpy.ops.export_scene.gltf(filepath=os.path.join(out, "model.glb"), export_yup=True, export_apply=True)',
      ),
    );
    expect(r.status).toBe(201);
    const size = r.json.round.review.info.size as number[];
    expect(size[2]).toBeCloseTo(40, 0);
    expect(size[0]).toBeCloseTo(10, 0);
  });

  it('names the line and the error a build stopped at, with no path of this computer', async () => {
    const id = await s.start();
    const lines = script(...Array.from({ length: 7 }, () => 'pass'), 'raise ValueError("no head")');
    expect(lines.split('\n')[11]).toBe('raise ValueError("no head")');
    const r = await s.submit(id, lines);
    expect(r).toMatchObject({ status: 422, json: { code: 'blender_failed' } });
    expect(r.json.error).toContain('build.py line 12: ValueError: no head');
    expect(r.json.error).not.toContain(homedir());
    expect(r.json.error).not.toContain(s.dir);
  });

  it('says so when a build writes no model.glb', async () => {
    const id = await s.start();
    const r = await s.submit(id, script('print("done")'));
    expect(r).toMatchObject({ status: 422, json: { code: 'blender_failed' } });
    expect(r.json.error).toContain('wrote no model.glb');
  });

  it('writes nowhere but its own folders', async () => {
    const id = await s.start();
    const tag = randomBytes(6).toString('hex');
    const loopDir = join(s.dir, 'media', 'loops', id);
    const away = [
      join(tmpdir(), `hg-escape-${tag}`),
      join(dirname(s.dir), `hg-escape-${tag}`),
      join(loopDir, 'escape'),
    ];
    const tryWrite = (p: string) => `try:\n    open(${p}, "w").write("x")\nexcept OSError:\n    pass`;
    const r = await s.submit(
      id,
      script(
        tryWrite('"../escape"'),
        tryWrite('"../../escape"'),
        tryWrite('os.path.expanduser("~/x")'),
        ...away.map((p) => tryWrite(JSON.stringify(p))),
        'bpy.ops.mesh.primitive_cube_add(size=10)',
        exportGlb,
      ),
    );
    expect(r.status).toBe(201);
    for (const p of [...away, join(loopDir, '..', 'escape'), join(homedir(), 'x')])
      expect(existsSync(p), p).toBe(false);
    expect(readdirSync(loopDir).sort()).toEqual([
      'loop.json',
      'round-1.glb',
      'round-1.py',
      'round-1.sheet.jpg',
    ]);
  });

  it('stops a build at the time limit, with everything it started', async () => {
    const was = process.env.HILDEGARD_BLENDER_TIMEOUT;
    process.env.HILDEGARD_BLENDER_TIMEOUT = '25';
    const tag = `${4000 + Math.floor(Math.random() * 999)}.${Date.now() % 1000}`;
    try {
      const id = await s.start();
      const r = await s.submit(
        id,
        script('import subprocess, time', `subprocess.Popen(["sleep", "${tag}"])`, 'time.sleep(600)'),
      );
      expect(r).toMatchObject({ status: 422, json: { code: 'blender_failed' } });
      expect(r.json.error).toContain('longer than 25 s');
      await new Promise((ok) => setTimeout(ok, 1000));
      expect(
        spawnSync('pgrep', ['-f', `sleep ${tag}`])
          .stdout.toString()
          .trim(),
      ).toBe('');
    } finally {
      if (was === undefined) delete process.env.HILDEGARD_BLENDER_TIMEOUT;
      else process.env.HILDEGARD_BLENDER_TIMEOUT = was;
    }
  });
});

describe.skipIf(!blender)('a build when Hildegard stops', { timeout: 120_000 }, () => {
  it('is stopped with everything it started, and holds updates while it runs', async () => {
    const s = await serve();
    const tag = `${5000 + Math.floor(Math.random() * 999)}.${Date.now() % 1000}`;
    const pids = () =>
      spawnSync('pgrep', ['-f', `sleep ${tag}`])
        .stdout.toString()
        .trim();
    let closed = false;
    try {
      const id = await s.start();
      const sent = s
        .submit(
          id,
          script('import subprocess, time', `subprocess.Popen(["sleep", "${tag}"])`, 'time.sleep(600)'),
        )
        .catch(() => null);
      for (let i = 0; i < 120 && !pids(); i++) await new Promise((ok) => setTimeout(ok, 500));
      expect(pids()).not.toBe('');
      expect(blenderBusy()).toBe(true);
      await s.close();
      closed = true;
      await sent;
      await new Promise((ok) => setTimeout(ok, 1000));
      expect(pids()).toBe('');
      expect(blenderBusy()).toBe(false);
    } finally {
      if (!closed) await s.close();
    }
  });
});

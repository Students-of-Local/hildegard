// SPDX-License-Identifier: AGPL-3.0-only
// What anyone may send before signing in: at most 64 KiB, refused before a handler sees it.
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewInvite } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import type { Exec } from '../src/host.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const PASS = 'a long and private passphrase';
const CAP = 64 * 1024;
const REDIRECT = 'https://chat.example/oauth/callback';

const exec: Exec = async (_cmd, args) => ({
  ok: true,
  out:
    args[0] === 'status'
      ? JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'studio.example.ts.net.', TailscaleIPs: ['100.64.0.1'] },
        })
      : '{}',
});

let srv: Running;
let remote: string;
let invite: string;

interface Answer {
  status?: number;
  connection?: string;
  cookie?: string[];
}
/** A POST over node:http, which sends chunked with no Content-Length unless told one. No answer in 3 s is `{}`. */
const post = (url: string, headers: Record<string, string | number>, body: string | null): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers });
    const gone = setTimeout(() => {
      resolve({});
      req.destroy();
    }, 3000);
    req.on('response', (res) => {
      clearTimeout(gone);
      res.resume();
      resolve({
        status: res.statusCode,
        connection: res.headers.connection,
        cookie: res.headers['set-cookie'],
      });
    });
    req.on('error', reject);
    if (body === null) return req.flushHeaders();
    req.write(body);
    req.end();
  });
/** The same JSON, with spaces after it up to a size. */
const padded = (body: unknown, size: number) => JSON.stringify(body).padEnd(size, ' ');
const json = (path: string, body: unknown, base = srv.url, method = 'POST') =>
  fetch(base + path, { method, headers: H, body: JSON.stringify(body) });

beforeAll(async () => {
  const hostPort = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', mkdtempSync(join(tmpdir(), 'hg-cap-'))]), port: 0, hostPort },
    { fakeTickMs: 25, secrets: memoryStore(), exec, limits: { perName: 100, perClient: 1000 } },
  );
  expect((await json('/api/people/owner', { name: 'Ada', passphrase: PASS })).status).toBe(201);
  expect((await json('/api/host', {})).status).toBe(200);
  remote = srv.hostedUrl()!;
  const made = (await (await json('/api/people/invites', { role: 'director' })).json()) as NewInvite;
  invite = made.url.split('/#/invite/')[1]!;
}, 30_000);
afterAll(() => srv.close());

const PATHS = [
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
  '/oauth/authorize',
  '/api/auth/signin',
  '/api/auth/passphrase',
  '/api/auth/invite/not-a-token/accept',
];

describe('bodies sent before signing in', { timeout: 60_000 }, () => {
  it.each(PATHS)('refuses 6 MB at %s on its declared length, from here and over the link', async (path) => {
    for (const base of [srv.url, remote]) {
      const a = await post(base + path, { ...H, 'content-length': 6 * 1024 * 1024 }, null);
      expect(a, base).toMatchObject({ status: 413, connection: 'close' });
    }
  });

  // One byte over, so all of it is read: more would race the refusal, which Windows reports as a reset. The server
  // counts as it reads, so a longer body is refused at the same byte.
  it.each(PATHS)('refuses the same at %s in chunks, with no declared length', async (path) => {
    for (const base of [srv.url, remote])
      expect((await post(base + path, H, 'x'.repeat(CAP + 1))).status, base).toBe(413);
  });

  it('never runs the handler: nobody is signed in, nothing is registered, the invite is still good', async () => {
    const signin = { name: 'Ada', passphrase: PASS };
    const a = await post(`${remote}/api/auth/signin`, H, padded(signin, CAP + 1));
    expect(a).toMatchObject({ status: 413, cookie: undefined });
    const register = { redirect_uris: [REDIRECT] };
    // Registration answers with the client it saved, so a 413 here is a client not saved.
    expect((await post(`${remote}/oauth/register`, H, padded(register, CAP + 1))).status).toBe(413);
    const accept = { name: 'Grace', passphrase: PASS };
    const path = `/api/auth/invite/${invite}/accept`;
    expect((await post(remote + path, H, padded(accept, CAP + 1))).status).toBe(413);
    expect((await fetch(`${remote}/api/auth/invite/${invite}`)).status).toBe(200);
  });

  it('leaves everything up to the cap as it was, declared or in chunks', async () => {
    const signin = padded({ name: 'Ada', passphrase: PASS }, CAP);
    const register = padded({ redirect_uris: [REDIRECT] }, CAP);
    const lengths: Record<string, number>[] = [{}, { 'content-length': CAP }];
    for (const length of lengths) {
      const a = await post(`${remote}/api/auth/signin`, { ...H, ...length }, signin);
      expect(a.status).toBe(200);
      expect(a.cookie).toHaveLength(1);
      expect((await post(`${remote}/oauth/register`, { ...H, ...length }, register)).status).toBe(201);
    }
    const small = await post(`${remote}/oauth/token`, FORM, 'grant_type=refresh_token&client_id=a');
    expect(small.status).toBe(400);
    expect((await post(`${remote}/oauth/revoke`, FORM, 'token=none')).status).toBe(200);
    const accept = padded({ name: 'Grace', passphrase: PASS }, CAP);
    expect((await post(`${remote}/api/auth/invite/${invite}/accept`, H, accept)).status).toBe(201);
  });
});

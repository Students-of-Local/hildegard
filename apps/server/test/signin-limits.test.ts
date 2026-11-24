// SPDX-License-Identifier: AGPL-3.0-only
// Guessing passphrases over the link: ten tries at an account, whatever its name is spelled like and however many
// guesses are sent at once.
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewInvite } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { challengeOf } from '../src/grants.ts';
import type { Exec } from '../src/host.ts';
import { type Running, startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
const PASS = 'a long and private passphrase';
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

const dir = mkdtempSync(join(tmpdir(), 'hg-limits-'));
let srv: Running;
let remote: string;

const send = (path: string, body: unknown, headers: Record<string, string> = {}, base = remote) =>
  fetch(base + path, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) });
/** A sign-in over the link from one address, as Tailscale forwards it. */
const signIn = (name: string, passphrase: string, from: string) =>
  send('/api/auth/signin', { name, passphrase }, { 'x-forwarded-for': from });
/** A new person, invited, with the session their invite gave them. */
async function person(name: string) {
  const made = (await (
    await send('/api/people/invites', { role: 'director' }, {}, srv.url)
  ).json()) as NewInvite;
  const res = await send(`/api/auth/invite/${made.url.split('/#/invite/')[1]}/accept`, {
    name,
    passphrase: PASS,
  });
  expect(res.status).toBe(201);
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
}
const tally = (statuses: number[]) => {
  const n: Record<number, number> = {};
  for (const s of statuses) n[s] = (n[s] ?? 0) + 1;
  return n;
};
const times = (n: number) => [...Array(n).keys()];

beforeAll(async () => {
  const hostPort = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
  srv = await startServer(
    { ...parseArgs(['--fake-gpu', '--data', dir]), port: 0, hostPort },
    // As shipped: 10 tries at a name and 30 from an address, in 15 minutes.
    { fakeTickMs: 25, secrets: memoryStore(), exec },
  );
  expect((await send('/api/people/owner', { name: 'Ada', passphrase: PASS }, {}, srv.url)).status).toBe(201);
  expect((await send('/api/host', {}, {}, srv.url)).status).toBe(200);
  remote = srv.hostedUrl()!;
}, 30_000);
afterAll(() => srv.close());

describe('sign-in limits', { timeout: 60_000 }, () => {
  it('counts every spelling of a name together: ten tries from anywhere, then 429', async () => {
    await person('Zoë Smith');
    const spellings = ['Zoë', 'Zoë'].flatMap((z) => times(7).map((i) => `${z}${' '.repeat(i + 1)}Smith`));
    const got: number[] = [];
    for (const [i, name] of spellings.entries())
      got.push((await signIn(name, 'wrong', `203.0.113.${i + 1}`)).status);
    expect(got).toEqual([...Array(10).fill(401), ...Array(4).fill(429)]);
    expect((await signIn('zoë smith', PASS, '203.0.113.50')).status).toBe(429);
  });

  it('counts nothing when the right passphrase’s session can’t be saved', async () => {
    await person('Hilda');
    const file = join(dir, 'people', 'sessions.json');
    renameSync(file, `${file}.kept`);
    mkdirSync(join(file, 'full'), { recursive: true }); // a folder in its place: saving fails, as on a full disk
    try {
      for (let i = 0; i < 12; i++) expect((await signIn('Hilda', PASS, '203.0.113.80')).status).toBe(500);
    } finally {
      rmSync(file, { recursive: true });
      renameSync(`${file}.kept`, file);
    }
    expect((await signIn('Hilda', PASS, '203.0.113.80')).status).toBe(200);
  });

  it('checks at most ten guesses sent at once', async () => {
    await person('Grace');
    const all = times(60).map(() => signIn('Grace', 'wrong', '203.0.113.60'));
    expect(tally((await Promise.all(all)).map((r) => r.status))).toEqual({ 401: 10, 429: 50 });
    // Guesses past the limit are refused, not checked, so they don’t count against the address.
    expect((await signIn('Ada', PASS, '203.0.113.60')).status).toBe(200);
  });

  it('signs in after nine wrong tries, and any number of times when right', async () => {
    await person('Mary');
    for (const _ of times(9)) expect((await signIn('Mary', 'wrong', '203.0.113.70')).status).toBe(401);
    expect((await signIn('Mary', PASS, '203.0.113.70')).status).toBe(200);
    for (const _ of times(10)) expect((await signIn('Mary', PASS, '203.0.113.71')).status).toBe(200);
    // Right ones sent together are given back as each is checked; only ten may wait at once.
    for (const _ of times(4)) {
      const all = times(10).map(() => signIn('Mary', PASS, '203.0.113.72'));
      expect(tally((await Promise.all(all)).map((r) => r.status))).toEqual({ 200: 10 });
    }
  });

  it('checks at most ten current passphrases sent at once, and counts no right one', async () => {
    const cookie = await person('Hedy');
    const change = (current: string, next: string) =>
      send('/api/auth/passphrase', { current, next }, { cookie, 'x-forwarded-for': '203.0.113.80' });
    for (const _ of times(12)) expect((await change(PASS, 'short')).status).toBe(400);
    for (const _ of times(12)) expect((await change(PASS, PASS)).status).toBe(200);
    const all = times(60).map(() => change('wrong', PASS));
    expect(tally((await Promise.all(all)).map((r) => r.status))).toEqual({ 403: 10, 429: 50 });
  });

  it('checks at most ten guesses sent at once on the chatbot sign-in page', async () => {
    await person('Emmy Noether');
    const reg = await send('/oauth/register', { redirect_uris: [REDIRECT] });
    const { client_id } = (await reg.json()) as { client_id: string };
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-0123456789'),
      code_challenge_method: 'S256',
    });
    const page = await (await fetch(`${remote}/oauth/authorize?${query}`)).text();
    const request = /name="request" value="([^"]+)"/.exec(page)![1]!;
    const approve = (name: string, passphrase: string, from: string) =>
      fetch(`${remote}/oauth/authorize`, {
        method: 'POST',
        headers: { origin: remote, 'x-forwarded-for': from },
        body: new URLSearchParams({ request, name, passphrase, decision: 'allow' }),
        redirect: 'manual',
      });
    const all = times(60).map((i) =>
      approve(`Emmy${' '.repeat(1 + (i % 20))}Noether`, 'wrong', `203.0.113.${90 + (i % 20)}`),
    );
    const pages = await Promise.all(all.map(async (r) => (await r).text()));
    expect(pages.filter((p) => p.includes('That name and passphrase don’t match.'))).toHaveLength(10);
    expect(pages.filter((p) => p.includes('Too many tries.'))).toHaveLength(50);
    expect((await approve('Ada', PASS, '203.0.113.120')).status).toBe(303);
  });
});

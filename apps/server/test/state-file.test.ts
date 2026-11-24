// SPDX-License-Identifier: AGPL-3.0-only
// What was saved and can't be read back is never taken for empty, so the next save can't replace it.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from '@hildegard/presets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Choir } from '../src/choir.ts';
import { Grants } from '../src/grants.ts';
import { Likeness } from '../src/likeness.ts';
import { People } from '../src/people.ts';
import { Store } from '../src/store.ts';
import { memoryStore } from './helpers.ts';

const PASS = 'correct horse battery';
const fresh = () => mkdtempSync(join(tmpdir(), 'hg-state-'));
const put = (dir: string, path: string, text: string) => {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
/** What a file was set aside as, oldest first. */
const bad = (file: string) =>
  existsSync(dirname(file))
    ? readdirSync(dirname(file))
        .filter((n) => n.startsWith(`${basename(file)}.bad-`))
        .sort()
        .map((n) => join(dirname(file), n))
    : [];
const thrown = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

const store = (dir: string) => new Store(dir);
const people = (dir: string) => new People({ dataDir: dir });
const choir = (dir: string) => new Choir({ dataDir: dir, secrets: () => memoryStore(), onChange: () => {} });
const grants = (dir: string) =>
  new Grants({ dataDir: dir, person: (id) => ({ id, name: 'Ada', role: 'owner' }) });
const likeness = (dir: string) => new Likeness(dir);

const NEEDED: [string, (dir: string) => unknown][] = [
  ['state.json', store],
  ['people/people.json', people],
  ['likeness/consent.json', likeness],
];
const REST: [string, (dir: string) => unknown][] = [
  ['people/sessions.json', people],
  ['people/grants.json', grants],
  ['choir/sharing.json', choir],
  ['choir/devices.json', choir],
  ['choir/settings.json', choir],
];
const TRUNCATED = '{"version":1,"projects":[{"id":"old0","ti';

const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => logged.mockClear());

describe('a file that isn’t there', () => {
  it.each([...NEEDED, ...REST])('%s: counts as empty, and starts', (path, start) => {
    const dir = fresh();
    expect(start(dir)).toBeTruthy();
    expect(bad(join(dir, path))).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('a file cut short', () => {
  it.each(NEEDED)('%s: stops every start, and stays where it is, until repaired', (path, start) => {
    const dir = fresh();
    const file = put(dir, path, TRUNCATED);
    for (let i = 0; i < 3; i++) expect(thrown(() => start(dir))).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe(TRUNCATED);
    expect(bad(file)).toEqual([]);
    // Either way out: the bad file moved away, or a good one put in its place.
    renameSync(file, join(fresh(), 'old'));
    expect(start(dir)).toBeTruthy();
    put(dir, path, '{"version":1,"projects":[],"people":[],"invites":[],"pending":[],"given":[]}');
    put(dir, `${path}.bad-earlier`, TRUNCATED);
    expect(start(dir)).toBeTruthy();
  });

  it.each(
    NEEDED.flatMap(([path, start]) => ['null', '[]', '7', ''].map((text) => [path, text, start] as const)),
  )('%s holding %j: the same', (path, text, start) => {
    const dir = fresh();
    const file = put(dir, path, text);
    expect(thrown(() => start(dir))).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it.each(REST)('%s: is kept, logged with both names, and started without', (path, start) => {
    const dir = fresh();
    const file = put(dir, path, TRUNCATED);
    expect(start(dir)).toBeTruthy();
    const [kept] = bad(file);
    expect(readFileSync(kept!, 'utf8')).toBe(TRUNCATED);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toContain(file);
    expect(logged.mock.calls[0]![0]).toContain(kept);
  });

  it('keeps grants from a version it doesn’t know, too', () => {
    const dir = fresh();
    const file = put(dir, 'people/grants.json', '{"version":2,"grants":[]}');
    expect(grants(dir).list(null)).toEqual([]);
    expect(readFileSync(bad(file)[0]!, 'utf8')).toBe('{"version":2,"grants":[]}');
  });
});

describe('a file that can’t be read', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([...NEEDED, ...REST])(
    '%s without permission: stops the start, and is left as it was',
    (path, start) => {
      const dir = fresh();
      const file = put(dir, path, '{"whole":true}');
      chmodSync(file, 0o000);
      expect(thrown(() => start(dir))).toContain(file);
      chmodSync(file, 0o600);
      expect(readFileSync(file, 'utf8')).toBe('{"whole":true}');
      expect(bad(file)).toEqual([]);
    },
  );

  it.each([...NEEDED, ...REST])('%s on any other error: the same', (path, start) => {
    const dir = fresh();
    const file = join(dir, path);
    // A folder where the file should be: reading it fails, and not with ENOENT, for root and on Windows too.
    mkdirSync(file, { recursive: true });
    expect(thrown(() => start(dir))).toContain(file);
    expect(bad(file)).toEqual([]);
  });
});

describe('a whole file', () => {
  it('loads as it was saved', async () => {
    const dir = fresh();
    const s = store(dir);
    s.putProject({ id: 'old0', title: 'One' } as Project);
    s.flush();
    const p = people(dir);
    const owner = await p.setOwner('Ada', PASS);
    const signed = await p.signIn('Ada', PASS);
    const files = [join(dir, 'state.json'), join(dir, 'people/people.json')];
    const before = files.map((f) => readFileSync(f, 'utf8'));
    expect(store(dir).projects.get('old0')?.title).toBe('One');
    expect(people(dir).find('Ada')?.id).toBe(owner.id);
    expect(people(dir).authenticate(signed!.token)?.person.id).toBe(owner.id);
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(before);
  });
});

describe('the server', () => {
  it('says which file and exits, each time it is started', { timeout: 60_000 }, () => {
    const dir = fresh();
    const file = put(dir, 'state.json', TRUNCATED);
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [main, '--fake-gpu', '--data', dir, '--port', '0'], {
        encoding: 'utf8',
        timeout: 25_000,
        env: { ...process.env, HILDEGARD_SECRETS: 'file' },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(file);
    }
    expect(readFileSync(file, 'utf8')).toBe(TRUNCATED);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reading back what Hildegard saved. Only a file that isn't there counts as nothing saved yet: one that can't be read
 * is never taken for empty, since the next save would replace it.
 */
import { readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Moves a file that can't be understood out of the way of the next save. Returns where it went. */
export function setAside(file: string): string {
  const bad = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(file, bad);
  return bad;
}

/**
 * A saved file's JSON, or null when there is none yet. A file that isn't whole JSON is set aside under
 * `<name>.bad-<timestamp>`; any other trouble reading it (permissions, the disk) throws and moves nothing.
 *
 * `needed` is for what Hildegard mustn't start without: there, a file set aside throws, and keeps throwing at each
 * start until someone puts a good one back or moves the bad one away. A service that restarts by itself would
 * otherwise come up empty seconds later. Without `needed`, it is logged and counts as nothing saved.
 */
export function readState<T>(file: string, opts: { needed?: boolean } = {}): T | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT')
      throw new Error(`Hildegard can’t read ${file}, and left it as it is: ${err.message}`);
    const earlier = opts.needed ? lastSetAside(file) : null;
    if (earlier) throw new Error(needsRepair(file, earlier));
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const bad = setAside(file);
    if (opts.needed) throw new Error(needsRepair(file, bad));
    console.error(`${file} isn’t whole, so Hildegard kept it as ${bad} and goes on without it.`);
    return null;
  }
}

const needsRepair = (file: string, bad: string) =>
  `${file} isn’t whole, so Hildegard kept it as ${bad} and won’t start without it. Put a good copy back as ${file}, or move ${bad} to another folder to start empty.`;

function lastSetAside(file: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dirname(file));
  } catch {
    return null;
  }
  const last = names
    .filter((n) => n.startsWith(`${basename(file)}.bad-`))
    .sort()
    .at(-1);
  return last ? join(dirname(file), last) : null;
}

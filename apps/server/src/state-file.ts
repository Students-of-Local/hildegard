// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reading back what Hildegard saved. Only a file that isn't there counts as nothing saved yet: one that can't be read
 * is never taken for empty, since the next save would replace it.
 */
import { readFileSync, renameSync } from 'node:fs';

/** Moves a file that can't be understood out of the way of the next save. Returns where it went. */
export function setAside(file: string): string {
  const bad = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(file, bad);
  return bad;
}

/**
 * A saved file's JSON object, or null when there is none yet. Trouble reading it (permissions, the disk) throws and
 * moves nothing.
 *
 * A file that isn't a whole JSON object is set aside under `<name>.bad-<timestamp>`, logged, and counts as nothing
 * saved. `needed` is for what Hildegard mustn't start without: there, it throws and stays where it is, so a service
 * that restarts by itself is stopped each time until someone repairs the file or moves it away.
 */
export function readState<T extends object>(file: string, opts: { needed?: boolean } = {}): T | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw new Error(`Hildegard can’t read ${file}, and left it as it is: ${err.message}`);
  }
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as T;
  } catch {}
  if (opts.needed)
    throw new Error(
      `${file} isn’t whole, so Hildegard left it as it is and won’t start. Put a good copy in its place, or move it to another folder to start empty.`,
    );
  console.error(`${file} isn’t whole, so Hildegard kept it as ${setAside(file)} and goes on without it.`);
  return null;
}

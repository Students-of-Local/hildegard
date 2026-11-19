// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard connect local-studio`: puts Hildegard's Local Studio plugin (local-studio/hildegard: a manifest and its
 * skills) in the folder Local Studio reads plugins from, so /image, /video, /speak, /design-voice, /clean-audio and
 * /hildegard appear in its command palette. The plugin asks for no capabilities: its skills run `hildegard make`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resource, type Step } from '@hildegard/runtime';
import type { Ctx } from './commands.ts';
import { type Result, result } from './output.ts';

export const PLUGIN_ID = 'hildegard';

/** Where Local Studio looks for plugins: LOCAL_STUDIO_DATA_DIR/plugins, else ~/.local-studio/plugins. */
export function pluginsDir(env = process.env, home = homedir()): string {
  return env.LOCAL_STUDIO_DATA_DIR
    ? join(env.LOCAL_STUDIO_DATA_DIR, 'plugins')
    : join(home, '.local-studio', 'plugins');
}

/** The plugin as shipped with this Hildegard. */
export const pluginSource = () => resource(join('local-studio', PLUGIN_ID));

const isOurs = (dir: string) => {
  try {
    return /^id\s*=\s*"hildegard"\s*$/m.test(readFileSync(join(dir, 'plugin.toml'), 'utf8'));
  } catch {
    return false;
  }
};

/** Local Studio's own command line, when it is here and has `plugin validate` (the app of the same name doesn't). */
function validator(env = process.env): string | null {
  if (env.LOCAL_STUDIO_CLI) return existsSync(env.LOCAL_STUDIO_CLI) ? env.LOCAL_STUDIO_CLI : null;
  const name = process.platform === 'win32' ? 'local-studio.exe' : 'local-studio';
  for (const d of (env.PATH ?? '').split(delimiter).filter(Boolean))
    if (existsSync(join(d, name))) return join(d, name);
  return null;
}

function validate(dir: string): Step {
  const bin = validator();
  const title = 'Checked with Local Studio’s validator';
  if (!bin)
    return {
      id: 'validate',
      title: 'Not checked by Local Studio',
      status: 'skipped',
      detail:
        'Local Studio’s command line isn’t on PATH here. Local Studio checks the plugin itself when it lists commands.',
    };
  const r = spawnSync(bin, ['plugin', 'validate', dir], { encoding: 'utf8', timeout: 20_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status === 0) return { id: 'validate', title, status: 'done', detail: out };
  if (/unknown argument|usage:/i.test(out) && !/error:/i.test(out))
    return {
      id: 'validate',
      title: 'Not checked by Local Studio',
      status: 'skipped',
      detail: `${bin} has no plugin validator (an older Local Studio). Local Studio checks the plugin when it lists commands.`,
    };
  return { id: 'validate', title: 'Local Studio refused the plugin', status: 'failed', detail: out };
}

export function connectLocalStudio(_ctx: Ctx, off = false): Result {
  const dir = pluginsDir();
  const target = join(dir, PLUGIN_ID);
  if (off) {
    if (!existsSync(target))
      return result(
        [
          {
            id: 'local-studio',
            title: 'Local Studio',
            status: 'skipped',
            detail: 'The plugin isn’t installed.',
          },
        ],
        'Hildegard wasn’t in Local Studio.',
      );
    if (!isOurs(target))
      return result(
        [
          {
            id: 'local-studio',
            title: 'Left alone',
            status: 'failed',
            detail: `${target} isn’t Hildegard’s plugin, so it stays.`,
          },
        ],
        'Nothing was removed.',
      );
    rmSync(target, { recursive: true, force: true });
    return result(
      [{ id: 'local-studio', title: 'Removed from Local Studio', status: 'done', detail: target }],
      'Hildegard is out of Local Studio. Its commands leave the palette on the next list, with no restart.',
    );
  }
  let source: string;
  try {
    source = pluginSource();
  } catch (e) {
    return result(
      [
        {
          id: 'local-studio',
          title: 'The plugin is missing',
          status: 'failed',
          detail: (e as Error).message,
        },
      ],
      'Reinstall Hildegard.',
    );
  }
  if (existsSync(target) && !isOurs(target))
    return result(
      [
        {
          id: 'local-studio',
          title: 'Another plugin is called hildegard',
          status: 'failed',
          detail: `${target} holds a plugin that isn’t Hildegard’s. Move it, then connect again.`,
        },
      ],
      'Nothing was changed.',
    );
  // Copied beside the target and swapped in, so Local Studio never reads half a plugin.
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `.hildegard-install-${process.pid}`);
  const old = join(dir, `.hildegard-old-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  const had = existsSync(target);
  if (had) renameSync(target, old);
  try {
    renameSync(staging, target);
  } catch (e) {
    if (had) renameSync(old, target);
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  rmSync(old, { recursive: true, force: true });
  const steps: Step[] = [
    {
      id: 'local-studio',
      title: had ? 'Updated in Local Studio' : 'Installed in Local Studio',
      status: 'done',
      detail: target,
    },
    validate(target),
  ];
  return result(
    steps,
    'Hildegard is in Local Studio: /image, /video, /speak, /design-voice, /clean-audio and /hildegard. They appear on its next command list, with no restart. Cloning a voice stays in the Hildegard Studio, with the speaker’s consent.',
  );
}

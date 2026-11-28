// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const CHECK_DESIGN = join(repo, 'skills/hildegard-design/scripts/check_design.py');

const runPy = (args: string[]) => spawnSync(python, ['-B', CHECK_DESIGN, ...args], { encoding: 'utf8' });

describe('check_design.py', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hildegard-design-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('passes clean tokenized HTML/CSS and rejects slop patterns, raw hex/fonts, transition:all, 100vw, and missing paths', () => {
    const cleanHtml = join(dir, 'clean.html');
    writeFileSync(
      cleanHtml,
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Rye &amp; Salt</title>
<style>
:root {
  --bg: #f6f1e7;
  --ink: #1e1b18;
  --accent: #a63d28;
  --font-head: "Libre Caslon Display", serif;
  --font-body: "Libre Franklin", sans-serif;
}
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); font-family: var(--font-body); }
#bed { padding: 24px; }
h1 { font-family: var(--font-head); }
button { background: var(--accent); color: var(--bg); transition: transform 160ms ease-out; }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
</head>
<body><main id="bed"><h1>Rye and Salt Bakery</h1><button type="button">Order</button></main></body>
</html>`,
    );
    const rOk = runPy(['--html', cleanHtml, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);
    expect(JSON.parse(rOk.stdout).ok).toBe(true);

    // Missing path and empty directory must fail cleanly
    expect(runPy(['--html', join(dir, 'missing-dir'), '--json']).status).toBe(1);
    const emptyDir = join(dir, 'empty-html');
    mkdirSync(emptyDir, { recursive: true });
    expect(runPy(['--html', emptyDir, '--json']).status).toBe(1);

    // Slop HTML/CSS: raw hex outside :root, transition: all, 100vw, overflow-x: hidden, missing focus-visible/reduced-motion, purple-blue gradient, italic word in h1, emoji, filler copy
    const badHtml = join(dir, 'bad.html');
    writeFileSync(
      badHtml,
      `<!doctype html>
<html><head><style>
html, body { width: 100vw; overflow-x: hidden; color: #222222; font-family: Arial, sans-serif; }
.hero { background: linear-gradient(135deg, #6366f1, #3b82f6); }
button { transition: all 0.3s ease; }
</style></head>
<body><section class="hero"><h1>Baking <em>reimagined</em></h1><p>Unlock the power of bread \u{1F525}</p><button>Go</button></section></body></html>`,
    );
    const rBad = runPy(['--html', badHtml, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('css_tokens');
    expect(badIds).toContain('no_transition_all');
    expect(badIds).toContain('safe_overflow');
    expect(badIds).toContain('focus_visible');
    expect(badIds).toContain('reduced_motion');
    expect(badIds).toContain('no_slop_patterns');
  });

  it('validates DESIGN.md YAML token blocks, unique keys, token refs, and safe @path references', () => {
    const goodMd = join(dir, 'DESIGN.md');
    writeFileSync(
      goodMd,
      `---
version: alpha
name: Hearth Bakery
---

## Colors

\`\`\`yaml
colors:
  primary: "#1A1C1E"
  accent: "#B8422E"
\`\`\`

## Components

See \`@components/button.html\` for usage.

\`\`\`yaml
components:
  button:
    bg: "{colors.accent}"
\`\`\`
`,
    );
    const rOk = runPy(['--design-md', goodMd, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    // Duplicate top-level key, broken token ref, and path traversal @ref must fail
    const badMd = join(dir, 'BAD-DESIGN.md');
    writeFileSync(
      badMd,
      `---
name: Broken System
colors:
  primary: "#111111"
---

See \`@../../etc/passwd.txt\`.

\`\`\`yaml
colors:
  accent: "not a color 123"
components:
  card:
    bg: "{colors.missing_token}"
\`\`\`
`,
    );
    const rBad = runPy(['--design-md', badMd, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('unique_top_keys');
    expect(badIds).toContain('token_refs_valid');
    expect(badIds).toContain('external_refs_safe');
  });

  it('validates isometric mechanical illustration contracts and rejects sparse/unmounted/floating-line specs', () => {
    const goodIso = join(dir, 'iso-ok.json');
    writeFileSync(
      goodIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 45,
        elevation_deg: 30,
        tones: { lo: '#2b2d30', mid: '#5a5f66', hi: '#c5cbd3', lit: '#ffffff' },
        lit_count: 1,
        parts: [
          { group: 'base_plate', host: 'ground', count: 12 },
          { group: 'rails', host: 'base_plate', count: 14 },
          { group: 'mechanism', host: 'rails', count: 16 },
        ],
        depth_sorted: true,
        floating_line_ends: 0,
        closeup_4x_checked: true,
        themes_checked: ['dark', 'light'],
      }),
    );
    const rOk = runPy(['--iso', goodIso, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    const badIso = join(dir, 'iso-bad.json');
    writeFileSync(
      badIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 10,
        elevation_deg: 80,
        tones: { lo: '#222', mid: '#222', hi: '#999', lit: '#fff' },
        lit_count: 3,
        parts: [{ group: 'floating', host: '', count: 5 }],
        depth_sorted: false,
        floating_line_ends: 4,
        closeup_4x_checked: false,
        themes_checked: ['dark'],
      }),
    );
    const rBad = runPy(['--iso', badIso, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('camera_iso');
    expect(badIds).toContain('four_tone_ramp');
    expect(badIds).toContain('part_density');
    expect(badIds).toContain('depth_sorted');
    expect(badIds).toContain('line_ends_resolved');
    expect(badIds).toContain('closeup_4x_checked');
    expect(badIds).toContain('dual_theme_checked');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
a:focus-visible, #bed { outline: 2px solid var(--ink); }
main:has(#cafe) { padding: 16px; }
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

    // Inline style="" only and interactive HTML with no <style> must NOT silently pass
    const inlineOnly = join(dir, 'inline-only.html');
    writeFileSync(
      inlineOnly,
      '<!doctype html><html><body><div style="color:#ff0000; width:100vw; transition:all 0.2s"><button>Click</button></div></body></html>',
    );
    const rInline = runPy(['--html', inlineOnly, '--json']);
    expect(rInline.status).toBe(1);
    const inlineBad = JSON.parse(rInline.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(inlineBad).toContain('css_tokens');
    expect(inlineBad).toContain('no_transition_all');
    expect(inlineBad).toContain('safe_overflow');
    expect(inlineBad).toContain('focus_visible');
    expect(inlineBad).toContain('reduced_motion');

    const noCssInteractive = join(dir, 'no-css.html');
    writeFileSync(noCssInteractive, '<!doctype html><html><body><button>Bare</button></body></html>');
    const rNoCss = runPy(['--html', noCssInteractive, '--json']);
    expect(rNoCss.status).toBe(1);
    expect(
      JSON.parse(rNoCss.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('focus_visible');

    // Hardening: url(#fade), content:"#123", body .carousel {overflow-x:hidden}, border-top-color/var(--t-all), and typographic symbols ✕ ✓ ★ ✦ ❧ must PASS
    const edgeOk = join(dir, 'edge-ok.html');
    writeFileSync(
      edgeOk,
      `<!doctype html>
<html lang="en"><head><style>
:root { --bg: #f6f1e7; --ink: #1e1b18; --t-all: 160ms; }
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); }
body .carousel { overflow-x: hidden; }
.badge::before { content: "#123"; filter: url(#fade); }
button { transition: border-top-color var(--t-all) ease-out; }
button:focus-visible { outline: 2px solid var(--ink); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style></head>
<body><div class="carousel"><span class="badge">✓ ★ ✦ ❧ ✕</span><button>Go</button></div></body></html>`,
    );
    const rEdgeOk = runPy(['--html', edgeOk, '--json']);
    expect(rEdgeOk.status, rEdgeOk.stdout).toBe(0);

    // Hardening: CSS nesting outer raw color, [data-theme="dark"] .card raw color, minified @media body overflow-x:hidden, and bare transition shorthand must FAIL
    const nestedBad = join(dir, 'nested-bad.html');
    writeFileSync(
      nestedBad,
      `<!doctype html>
<html><head><style>
:root { --bg: #fff; --ink: #111; }
.card { color: #ff0000; &:hover { opacity: 0.8; } }
[data-theme="dark"] .card { background: #222222; }
@media(min-width:1px){body{overflow-x:hidden}}
button { transition: 200ms ease-out; }
button:focus-visible { outline: 2px solid var(--ink); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style></head><body><div class="card"><button>Act</button></div></body></html>`,
    );
    const rNested = runPy(['--html', nestedBad, '--json']);
    expect(rNested.status).toBe(1);
    const nestedBadIds = JSON.parse(rNested.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(nestedBadIds).toContain('css_tokens');
    expect(nestedBadIds).toContain('safe_overflow');
    expect(nestedBadIds).toContain('no_transition_all');
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
    expect(badIds).toContain('valid_color_tokens');
    expect(badIds).toContain('token_refs_valid');
    expect(badIds).toContain('external_refs_safe');

    // Duplicate top-level key INSIDE ONE block, cyclic/group/metadata refs, and extensionless/backslash/tilde/markdown-link @refs must fail
    const sameBlockDup = join(dir, 'SAME-BLOCK-DUP.md');
    writeFileSync(
      sameBlockDup,
      `---
name: Hearth
colors:
  primary: "{colors.primary}"
  accent: "{name}"
colors:
  secondary: "#123456"
components:
  card:
    bg: "{colors}"
    ref: "@../secret"
---

See \`@../../etc/passwd\`, \`@/etc/shadow\`, \`@~/.ssh/id_rsa.pub\`, \`@..\\..\\x.txt\`, and [spec](@../x.txt).
`,
    );
    const rDup = runPy(['--design-md', sameBlockDup, '--json']);
    expect(rDup.status).toBe(1);
    const dupOut = JSON.parse(rDup.stdout);
    const dupBad = dupOut.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
    expect(dupBad).toContain('unique_top_keys');
    expect(dupBad).toContain('token_refs_valid');
    expect(dupBad).toContain('external_refs_safe');
    const extCheck = dupOut.checks.find((c: { id: string }) => c.id === 'external_refs_safe');
    expect(extCheck.value.length).toBeGreaterThanOrEqual(6);

    // Hardening: bad color in FIRST of two duplicate colors: blocks, invalid "#12345"/"notacolor", zero-indented omitted list, nested color-mix, extensionless symlink @secret, trailing period @secret., and @C:..\secret
    const nestedMixMd = join(dir, 'NESTED-MIX.md');
    writeFileSync(
      nestedMixMd,
      `---
name: Mix System
omitted:
- spacing
colors:
  primary: "color-mix(in oklch, oklch(0.6 0.2 250) 70%, white)"
  accent: "#B8422E"
---
`,
    );
    const rMix = runPy(['--design-md', nestedMixMd, '--json']);
    expect(rMix.status, rMix.stdout).toBe(0);

    const extSub = join(dir, 'design-sub');
    mkdirSync(extSub, { recursive: true });
    const outsideTarget = join(dir, 'outside-secret.txt');
    writeFileSync(outsideTarget, 'top-secret');
    if (process.platform !== 'win32') {
      symlinkSync(outsideTarget, join(extSub, 'secret'));
    }
    const hardMd = join(extSub, 'HARD-DESIGN.md');
    writeFileSync(
      hardMd,
      `---
name: Hardened
colors:
  first_bad: "notacolor"
  short_hex: "#12345"
colors:
  second_ok: "#123456"
---

Check \`@C:..\\secret\`${process.platform !== 'win32' ? ' and see @secret.' : ''}.
`,
    );
    const rHard = runPy(['--design-md', hardMd, '--json']);
    expect(rHard.status).toBe(1);
    const hardOut = JSON.parse(rHard.stdout);
    const hardBad = hardOut.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
    expect(hardBad).toContain('unique_top_keys');
    expect(hardBad).toContain('valid_color_tokens');
    expect(hardBad).toContain('external_refs_safe');
    const badColorVals = hardOut.checks.find((c: { id: string }) => c.id === 'valid_color_tokens').value;
    expect(badColorVals.some((v: string) => v.includes('notacolor'))).toBe(true);
    expect(badColorVals.some((v: string) => v.includes('#12345'))).toBe(true);
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

    // Pre-render mode allows truthful closeup_4x_checked=false and themes_checked=[] while full mode rejects them
    const preRenderIso = join(dir, 'iso-prerender.json');
    writeFileSync(
      preRenderIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 45,
        elevation_deg: 30,
        tones: { lo: '#2b2d30', mid: '#5a5f66', hi: '#c5cbd3', lit: '#ffffff' },
        lit_count: 1,
        parts: [
          { group: 'base_plate', host: 'ground', count: 20 },
          { group: 'mechanism', host: 'base_plate', count: 22 },
        ],
        depth_sorted: true,
        closeup_4x_checked: false,
        themes_checked: [],
      }),
    );
    expect(runPy(['--iso', preRenderIso, '--pre-render', '--json']).status).toBe(0);
    expect(runPy(['--iso', preRenderIso, '--json']).status).toBe(1);

    // Missing tier, cyclic hosts, and dangling host "midair" must fail part_density
    for (const [label, payload] of [
      [
        'missing-tier',
        {
          azimuth_deg: 45,
          elevation_deg: 30,
          tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
          lit_count: 1,
          parts: [{ group: 'b', host: 'ground', count: 44 }],
          depth_sorted: true,
        },
      ],
      [
        'cyclic-host',
        {
          tier: 'figure',
          azimuth_deg: 45,
          elevation_deg: 30,
          tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
          lit_count: 1,
          parts: [
            { group: 'a', host: 'b', count: 22 },
            { group: 'b', host: 'a', count: 22 },
          ],
          depth_sorted: true,
        },
      ],
      [
        'dangling-host',
        {
          tier: 'figure',
          azimuth_deg: 45,
          elevation_deg: 30,
          tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
          lit_count: 1,
          parts: [{ group: 'a', host: 'midair', count: 44 }],
          depth_sorted: true,
        },
      ],
    ] as const) {
      const p = join(dir, `iso-${label}.json`);
      writeFileSync(p, JSON.stringify(payload));
      const r = runPy(['--iso', p, '--pre-render', '--json']);
      expect(r.status, `${label}: ${r.stdout}`).toBe(1);
      expect(
        JSON.parse(r.stdout)
          .checks.filter((c: { ok: boolean }) => !c.ok)
          .map((c: { id: string }) => c.id),
      ).toContain('part_density');
    }

    // Hardening: missing lit_count must FAIL four_tone_ramp; missing/malformed/directory --iso --json must emit JSON without traceback
    const noLitIso = join(dir, 'iso-no-lit.json');
    writeFileSync(
      noLitIso,
      JSON.stringify({
        tier: 'figure',
        azimuth_deg: 45,
        elevation_deg: 30,
        tones: { lo: '#111', mid: '#555', hi: '#aaa', lit: '#fff' },
        parts: [{ group: 'b', host: 'ground', count: 44 }],
        depth_sorted: true,
      }),
    );
    const rNoLit = runPy(['--iso', noLitIso, '--pre-render', '--json']);
    expect(rNoLit.status).toBe(1);
    expect(
      JSON.parse(rNoLit.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('four_tone_ramp');

    const malformedIso = join(dir, 'iso-malformed.json');
    writeFileSync(malformedIso, '{bad json');
    for (const badPath of [join(dir, 'does-not-exist.json'), dir, malformedIso]) {
      const rErr = runPy(['--iso', badPath, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });
});

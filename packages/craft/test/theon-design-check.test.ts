// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

    // Round-1 #209 highs + mediums:
    // 1. html[data-theme="dark"], :root[data-theme], minified @media/@layer {:root{--*}} must PASS css_tokens
    const themeRootOk = join(dir, 'theme-root-ok.html');
    writeFileSync(
      themeRootOk,
      `<!doctype html><html><head><style>
@layer base{:root[data-theme]{--bg:#fff;--ink:#111}}
@media(prefers-color-scheme:dark){html[data-theme="dark"]{--bg:#111;--ink:#eee}}
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); }
.empty-ov { overflow-x: ; }
</style></head><body><p>Clean</p></body></html>`,
    );
    expect(runPy(['--html', themeRootOk, '--json']).status).toBe(0);

    // 2. .app [data-theme="dark"], nested :root { .card { color:#f00 } }, body{overflow-x:hidden!important}, transition: 200ms ease-out !important, and ⚠️/❤️ must FAIL
    const r1Bad = join(dir, 'r1-bad.html');
    writeFileSync(
      r1Bad,
      `<!doctype html><html><head><style>
:root { --bg: #fff; --ink: #111; .card { color: #ff0000; } }
.app [data-theme="dark"] { color: #00ff00; }
body{overflow-x:hidden!important}
button { transition: 200ms ease-out !important; }
button:focus-visible { outline: 2px solid var(--ink); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style></head><body><div class="app"><div data-theme="dark"><p>Warn \u26A0\uFE0F \u2764\uFE0F</p><button>Go</button></div></div></body></html>`,
    );
    const rR1Bad = runPy(['--html', r1Bad, '--json']);
    expect(rR1Bad.status).toBe(1);
    const r1BadIds = JSON.parse(rR1Bad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(r1BadIds).toContain('css_tokens');
    expect(r1BadIds).toContain('safe_overflow');
    expect(r1BadIds).toContain('no_transition_all');
    expect(r1BadIds).toContain('no_slop_patterns');

    // Round-2 #209 high (second-F1): grouping at-rules nested inside style rules
    const r2NestedAtOk = join(dir, 'r2-nested-at-ok.html');
    writeFileSync(
      r2NestedAtOk,
      `<!doctype html><html><head><style>
:root { --bg: #fff; --ink: #111; @media (prefers-color-scheme: dark) { --bg: #111; --ink: #eee; } }
.modal { body { overflow-x: hidden; } }
body { background: var(--bg); color: var(--ink); }
</style></head><body><p>Clean</p></body></html>`,
    );
    expect(runPy(['--html', r2NestedAtOk, '--json']).status).toBe(0);

    const r2NestedAtBad = join(dir, 'r2-nested-at-bad.html');
    writeFileSync(
      r2NestedAtBad,
      `<!doctype html><html><head><style>
:root { --bg: #fff; --ink: #111; }
body { @media (max-width: 768px) { overflow-x: hidden; } }
</style></head><body><p>Bad</p></body></html>`,
    );
    const rR2Bad = runPy(['--html', r2NestedAtBad, '--json']);
    expect(rR2Bad.status).toBe(1);
    const r2BadIds = JSON.parse(rR2Bad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(r2BadIds).toContain('safe_overflow');
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

    // Round-1 #209 highs: YAML block lists of mappings must not crash, and @.., @./.., @.\.. must fail external_refs_safe
    const listMapMd = join(dir, 'LIST-MAP-DESIGN.md');
    writeFileSync(
      listMapMd,
      `---
name: List Map System
omitted:
- section: spacing
  reason: static
fonts:
  - family: Inter
    weight: 400
colors:
  primary: "#1A1C1E"
---
`,
    );
    const rListMap = runPy(['--design-md', listMapMd, '--json']);
    expect(rListMap.status, rListMap.stdout).toBe(0);

    const dotTravMd = join(dir, 'DOT-TRAV-DESIGN.md');
    writeFileSync(
      dotTravMd,
      `---
name: Dot Trav
colors:
  primary: "#1A1C1E"
---

Bad refs: \`@..\`, \`@./..\`, and \`@.\\..\`.
`,
    );
    const rDotTrav = runPy(['--design-md', dotTravMd, '--json']);
    expect(rDotTrav.status).toBe(1);
    const dotOut = JSON.parse(rDotTrav.stdout);
    const dotExt = dotOut.checks.find((c: { id: string }) => c.id === 'external_refs_safe');
    expect(dotExt.ok).toBe(false);
    expect(dotExt.value.length).toBe(3);

    // Round-2 #209 high (second-F2): quoted list-item keys and mapping under omitted must not raise TypeError or drop values
    const r2YamlMapMd = join(dir, 'R2-YAML-MAP.md');
    writeFileSync(
      r2YamlMapMd,
      `---
name: Quoted And Omitted Map
fonts:
  - "family": Inter
    weight: 400
omitted:
  colors: monochrome
---
`,
    );
    const rR2YamlMap = runPy(['--design-md', r2YamlMapMd, '--json']);
    expect(rR2YamlMap.status, rR2YamlMap.stdout).toBe(0);

    const r2YamlOmittedListMd = join(dir, 'R2-YAML-OMITTED-LIST.md');
    writeFileSync(
      r2YamlOmittedListMd,
      `---
name: Quoted Omitted List
omitted:
  - "section": colors
    reason: monochrome
  - note: extra
---
`,
    );
    const rR2YamlOmittedList = runPy(['--design-md', r2YamlOmittedListMd, '--json']);
    expect(rR2YamlOmittedList.status, rR2YamlOmittedList.stdout).toBe(0);
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
    const nonUtf8Iso = join(dir, 'iso-nonutf8.json');
    writeFileSync(nonUtf8Iso, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    for (const badPath of [join(dir, 'does-not-exist.json'), dir, malformedIso, nonUtf8Iso]) {
      const rErr = runPy(['--iso', badPath, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('validates animated line-art SVG ink contracts (--ink-anim) including planted-foot gait math and --pre-render', () => {
    const goodInk = join(dir, 'ink-ok.json');
    writeFileSync(
      goodInk,
      JSON.stringify({
        open_stroke_limbs: true,
        curved_lines: true,
        gait: {
          kind: 'walk',
          stride: 36,
          duty: 0.6,
          period_s: 1.0,
          scale: 0.5,
          travel_speed: 30.0,
          free_sine_walk: false,
        },
        skeleton_first_cloth: true,
        card_fixed_bg: true,
        palette_tokens: { ink: 'currentColor', paper_class: '.pp' },
        debug_stepping: { query_flag: '?debug', step_fn: 'window.__step', dt_s: 0.016667 },
        zoomed_strip_checked: true,
        day_cycle_checked: true,
      }),
    );
    const rOk = runPy(['--ink-anim', goodInk, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    // Pre-render mode passes without zoomed_strip_checked; full mode rejects it
    const preInk = join(dir, 'ink-prerender.json');
    writeFileSync(
      preInk,
      JSON.stringify({
        open_stroke_limbs: true,
        curved_lines: true,
        gait: {
          kind: 'run',
          stride: 32,
          duty: 0.4,
          period_s: 0.5,
          scale: 1.0,
          travel_speed: 160.0,
          free_sine_walk: false,
        },
        skeleton_first_cloth: true,
        card_fixed_bg: true,
        palette_tokens: { ink: 'currentColor', paper_class: '.pp' },
        debug_stepping: { query_flag: '?debug', step_fn: 'window.__step', dt_s: 0.016667 },
      }),
    );
    expect(runPy(['--ink-anim', preInk, '--pre-render', '--json']).status).toBe(0);
    expect(runPy(['--ink-anim', preInk, '--json']).status).toBe(1);

    // Skating travel_speed, free_sine_walk=true, wrong run duty >= 0.5, and bad debug dt_s must fail
    const badInk = join(dir, 'ink-bad.json');
    writeFileSync(
      badInk,
      JSON.stringify({
        open_stroke_limbs: false,
        curved_lines: false,
        gait: {
          kind: 'run',
          stride: 32,
          duty: 0.6,
          period_s: 0.5,
          scale: 1.0,
          travel_speed: 999.0,
          free_sine_walk: true,
        },
        skeleton_first_cloth: false,
        card_fixed_bg: false,
        palette_tokens: { ink: '#000', paper_class: 'pp' },
        debug_stepping: { query_flag: 'debug', step_fn: '', dt_s: 0.1 },
        zoomed_strip_checked: false,
        extra_key: 1,
      }),
    );
    const rBad = runPy(['--ink-anim', badInk, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('unknown_keys');
    expect(badIds).toContain('open_stroke_limbs');
    expect(badIds).toContain('curved_lines');
    expect(badIds).toContain('planted_foot_gait');
    expect(badIds).toContain('no_free_sine_walk');
    expect(badIds).toContain('skeleton_first_cloth');
    expect(badIds).toContain('card_fixed_bg');
    expect(badIds).toContain('ink_paper_tokens');
    expect(badIds).toContain('deterministic_debug_step');
    expect(badIds).toContain('zoomed_strip_checked');

    // Missing/malformed/non-UTF-8/dir --ink-anim returns JSON without traceback
    const nonUtf8 = join(dir, 'ink-nonutf8.json');
    writeFileSync(nonUtf8, Buffer.from([0xff, 0xfe]));
    for (const p of [join(dir, 'nope-ink.json'), dir, nonUtf8]) {
      const rErr = runPy(['--ink-anim', p, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('validates sakuga tactile UI VFX contracts (--sakuga) including 4 beats, volume squash, and --pre-render', () => {
    const goodSak = join(dir, 'sakuga-ok.json');
    writeFileSync(
      goodSak,
      JSON.stringify({
        control: 'button',
        plain_at_rest: true,
        immediate_state_change: true,
        beats: [
          { name: 'anticipation', effects: ['press_squash'] },
          { name: 'hit', effects: ['impact_burst', 'invert_frame'], sfx_word: 'DON!' },
          { name: 'follow_through', effects: ['smoke_puffs'] },
          { name: 'settle', effects: ['spring_settle'] },
        ],
        shared_clock_canvas: true,
        visual_rules: {
          flat_two_tone_outline: true,
          exit_by_shrink_not_fade: true,
          spring_driven: true,
          reduced_motion_keeps_state: true,
          volume_preserving_squash: { scale_x: 1.25, scale_y: 0.8 },
        },
        css_vars: { '--sk-ink': '#1a1a1f', '--sk-card': '#ffffff', '--sk-acc': '#e84a7f' },
        verification: {
          frame_strip_times_s: [0, 0.05, 0.12, 0.25, 0.45, 0.8],
          widths_px: [390, 1440],
          horizontal_overflow: false,
          keyboard_checked: true,
        },
      }),
    );
    const rOk = runPy(['--sakuga', goodSak, '--json']);
    expect(rOk.status, rOk.stdout).toBe(0);

    // Pre-render skips verification; full mode rejects missing verification
    const preSak = join(dir, 'sakuga-prerender.json');
    const prePayload = JSON.parse(readFileSync(goodSak, 'utf8'));
    delete prePayload.verification;
    writeFileSync(preSak, JSON.stringify(prePayload));
    expect(runPy(['--sakuga', preSak, '--pre-render', '--json']).status).toBe(0);
    expect(runPy(['--sakuga', preSak, '--json']).status).toBe(1);

    // Bad squash area (1.5*1.5), sfx on wrong beat, >2 effects per beat, token ref in css_vars, and missing phone width must fail
    const badSak = join(dir, 'sakuga-bad.json');
    writeFileSync(
      badSak,
      JSON.stringify({
        control: 'carousel',
        plain_at_rest: false,
        immediate_state_change: false,
        beats: [
          { name: 'anticipation', effects: ['a', 'b', 'c'], sfx_word: 'WHOOSH' },
          { name: 'hit', effects: ['burst'], sfx_word: 'DON!' },
          { name: 'follow_through', effects: [] },
          { name: 'settle', effects: [] },
        ],
        shared_clock_canvas: false,
        visual_rules: {
          flat_two_tone_outline: false,
          exit_by_shrink_not_fade: false,
          spring_driven: false,
          reduced_motion_keeps_state: false,
          volume_preserving_squash: { scale_x: 1.5, scale_y: 1.5 },
        },
        css_vars: { '--sk-ink': '{colors.ink}', '--sk-acc': 'notacolor' },
        verification: {
          frame_strip_times_s: [0, 0.2, 0.1],
          widths_px: [1440],
          horizontal_overflow: true,
          keyboard_checked: false,
        },
      }),
    );
    const rBad = runPy(['--sakuga', badSak, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('semantic_control');
    expect(badIds).toContain('plain_at_rest');
    expect(badIds).toContain('immediate_state_change');
    expect(badIds).toContain('sakuga_beats');
    expect(badIds).toContain('sakuga_sfx_on_hit');
    expect(badIds).toContain('shared_clock_canvas');
    expect(badIds).toContain('volume_preserving_squash');
    expect(badIds).toContain('css_var_theming');
    expect(badIds).toContain('stepped_frame_strip');
    expect(badIds).toContain('responsive_widths');
    expect(badIds).toContain('no_horizontal_overflow');
    expect(badIds).toContain('keyboard_checked');

    // Missing/malformed/non-UTF-8/dir --sakuga returns JSON without traceback
    const nonUtf8Sak = join(dir, 'sak-nonutf8.json');
    writeFileSync(nonUtf8Sak, Buffer.from([0xff, 0xfe]));
    for (const p of [join(dir, 'nope-sak.json'), dir, nonUtf8Sak]) {
      const rErr = runPy(['--sakuga', p, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('validates vector logo SVGs (--logo) for viewBox, security, outlined text, clearspace, 16px legibility, flat monochrome, and WCAG contrast', () => {
    // 1. Clean light-surface evenodd mark + benign <title>/<desc>/<metadata> must PASS
    const goodLight = join(dir, 'logo-light.svg');
    writeFileSync(
      goodLight,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <title>Hearth</title>
  <desc>Clean geometric brand mark</desc>
  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>Hearth Brand</rdf:Description></rdf:RDF></metadata>
  <path fill="#1A1C1E" fill-rule="evenodd" d="M 16 16 H 84 V 84 H 16 Z M 34 34 H 66 V 66 H 34 Z"/>
  <rect x="42" y="42" width="16" height="16" fill="#B8422E"/>
</svg>`,
    );
    expect(runPy(['--logo', goodLight, '--surface', '#FFFFFF', '--json']).status).toBe(0);
    expect(runPy(['--logo', goodLight, '--json']).status).toBe(0);

    // 2. Clean dark-surface inverse mark + universal currentColor mark must PASS
    const goodDark = join(dir, 'logo-dark.svg');
    writeFileSync(
      goodDark,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect x="12" y="12" width="40" height="40" fill="#F6F1E7"/>
  <circle cx="32" cy="32" r="10" fill="#F2B84B"/>
</svg>`,
    );
    expect(runPy(['--logo', goodDark, '--surface', '#111111', '--json']).status).toBe(0);
    expect(runPy(['--logo', goodDark, '--surface', '#FFFFFF', '--json']).status).toBe(1);

    const goodMono = join(dir, 'logo-mono.svg');
    writeFileSync(
      goodMono,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <polygon points="32,10 54,52 10,52" fill="currentColor"/>
</svg>`,
    );
    expect(runPy(['--logo', goodMono, '--surface', '#FFFFFF', '--json']).status).toBe(0);
    expect(runPy(['--logo', goodMono, '--surface', '#111111', '--json']).status).toBe(0);

    // 3. Live <text> rejected by default, allowed with --allow-draft-text
    const draftSvg = join(dir, 'logo-draft.svg');
    writeFileSync(
      draftSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <rect x="16" y="16" width="48" height="48" fill="#1A1C1E"/>
  <text x="80" y="50" fill="#1A1C1E">HEARTH</text>
</svg>`,
    );
    const rDraftFail = runPy(['--logo', draftSvg, '--json']);
    expect(rDraftFail.status).toBe(1);
    expect(
      JSON.parse(rDraftFail.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('logo_outlined_text');
    expect(runPy(['--logo', draftSvg, '--allow-draft-text', '--json']).status).toBe(0);

    // 4. Fake white-fill cutout hack (#1A1C1E + #FFFFFF) must FAIL logo_contrast on both light and dark
    const fakeCutout = join(dir, 'logo-fake-cutout.svg');
    writeFileSync(
      fakeCutout,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="34" fill="#1A1C1E"/>
  <circle cx="50" cy="50" r="14" fill="#FFFFFF"/>
</svg>`,
    );
    const rCut = runPy(['--logo', fakeCutout, '--json']);
    expect(rCut.status).toBe(1);
    expect(
      JSON.parse(rCut.stdout)
        .checks.filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toContain('logo_contrast');

    // 5. Security, aspect mismatch, hairline stroke, edge clip, gradient/filter, >3 inks, and >64 shapes must FAIL
    const badSvg = join(dir, 'logo-bad.svg');
    const manyRects = Array.from(
      { length: 65 },
      (_, i) => `<rect x="20" y="${20 + (i % 5)}" width="10" height="10" fill="#1A1C1E"/>`,
    ).join('');
    writeFileSync(
      badSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="100" onload="alert(1)">
  <defs><linearGradient id="g"/><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>
  <script>alert(1)</script>
  <image href="https://example.com/x.png" width="20" height="20"/>
  <rect x="0" y="0" width="100" height="100" fill="url(#g)" filter="url(#f)" stroke="#111111" stroke-width="1"/>
  <circle cx="30" cy="30" r="10" fill="#B8422E"/>
  <circle cx="50" cy="50" r="10" fill="#14532D"/>
  <circle cx="70" cy="70" r="10" fill="#1E3A8A"/>
  ${manyRects}
</svg>`,
    );
    const rBad = runPy(['--logo', badSvg, '--json']);
    expect(rBad.status).toBe(1);
    const badIds = JSON.parse(rBad.stdout)
      .checks.filter((c: { ok: boolean }) => !c.ok)
      .map((c: { id: string }) => c.id);
    expect(badIds).toContain('logo_viewbox');
    expect(badIds).toContain('logo_self_contained');
    expect(badIds).toContain('logo_complexity');
    expect(badIds).toContain('logo_micro_legibility');
    expect(badIds).toContain('logo_clearspace');
    expect(badIds).toContain('logo_monochrome_safe');
    expect(badIds).toContain('logo_palette_restraint');

    // 6. XML entity bomb, malformed XML, non-UTF-8, missing file, and directory must emit clean JSON without traceback
    const xxeSvg = join(dir, 'logo-xxe.svg');
    writeFileSync(xxeSvg, '<!DOCTYPE svg [<!ENTITY x "boom">]><svg viewBox="0 0 10 10"/>');
    const badXml = join(dir, 'logo-malformed.svg');
    writeFileSync(badXml, '<svg><unclosed></svg>');
    const nonUtf8 = join(dir, 'logo-nonutf8.svg');
    writeFileSync(nonUtf8, Buffer.from([0xff, 0xfe, 0x00]));
    for (const p of [xxeSvg, badXml, nonUtf8, join(dir, 'missing-logo.svg'), dir]) {
      const rErr = runPy(['--logo', p, '--json']);
      expect(rErr.status).toBe(1);
      expect(rErr.stderr).not.toContain('Traceback');
      expect(JSON.parse(rErr.stdout).ok).toBe(false);
    }
  });

  it('enforces strict flattened-logo contract, accurate SVG path/curve/transform geometry, paints, lengths, namespace, and pure wordmark drafts', () => {
    const failedIds = (svgText: string, extraArgs: string[] = [], name = 'case.svg') => {
      const p = join(dir, name);
      writeFileSync(p, svgText);
      const r = runPy(['--logo', p, ...extraArgs, '--json']);
      const parsed = JSON.parse(r.stdout);
      const bad = parsed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
      return { status: r.status, ok: parsed.ok, bad, checks: parsed.checks, stdout: r.stdout };
    };

    // 1. Compact svgo arc flags & compact numbers PASS; malformed/truncated/unknown/bad-flag paths FAIL; implicit repeated commands > 400 FAIL
    const compactArcOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path fill="#1A1C1E" d="M50 15a30 30 0 01-20 40A30 30 0 0180 80l-10-10 .5.5 1e-3 0Z"/>
</svg>`,
      [],
      'logo-compact-arc.svg',
    );
    expect(compactArcOk.status, compactArcOk.stdout).toBe(0);

    for (const [label, d] of [
      ['truncated-L', 'M 20 20 L 40'],
      ['unknown-cmd', 'M 20 20 X 40 40'],
      ['bad-arc-flag', 'M 20 20 A 30 30 0 2 1 80 80'],
      ['no-moveto', 'L 20 20 80 80'],
      ['trailing-after-z', 'M 20 20 L 80 80 Z 40 40'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" d="${d}"/></svg>`,
        [],
        `logo-bad-path-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_geometry');
    }

    const manyImplicit = Array.from(
      { length: 405 },
      (_, i) => `${20 + (i % 50)} ${20 + ((i * 3) % 50)}`,
    ).join(' ');
    const rImplicit = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" d="M 20 20 L ${manyImplicit} Z"/></svg>`,
      [],
      'logo-implicit-405.svg',
    );
    expect(rImplicit.status).toBe(1);
    expect(rImplicit.bad).toContain('logo_complexity');

    // 2. <line> must NEVER inherit default black fill; light stroke on dark surface PASSES
    const lineDark = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <line x1="20" y1="50" x2="80" y2="50" stroke="#F6F1E7" stroke-width="8"/>
</svg>`,
      ['--surface', '#111111'],
      'logo-line-dark.svg',
    );
    expect(lineDark.status, lineDark.stdout).toBe(0);

    // 3. Paints: rgba white cutout fails contrast; translucent rgba/#rrggbbaa/hsla fails monochrome; opaque hsl/#rrggbbaa/CSS named passes; unparsed paint fails
    const rgbaCutout = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="34" fill="#1A1C1E"/>
  <circle cx="50" cy="50" r="14" fill="rgba(255, 255, 255, 1)"/>
</svg>`,
      ['--surface', '#FFFFFF'],
      'logo-rgba-cutout.svg',
    );
    expect(rgbaCutout.status).toBe(1);
    expect(rgbaCutout.bad).toContain('logo_contrast');

    for (const [label, paint] of [
      ['rgba-half', 'rgba(26, 28, 30, 0.5)'],
      ['hex8-half', '#1A1C1E80'],
      ['hex4-half', '#1118'],
      ['hsla-half', 'hsla(210, 8%, 11%, 0.5)'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="${paint}"/></svg>`,
        [],
        `logo-trans-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_monochrome_safe');
    }

    const richColorsOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="16" y="16" width="30" height="30" fill="hsl(210, 10%, 12%)"/>
  <rect x="54" y="16" width="30" height="30" fill="#B8422EFF"/>
  <rect x="35" y="54" width="30" height="30" fill="midnightblue" stroke="rgba(255,255,255,0)"/>
</svg>`,
      ['--surface', '#FFFFFF'],
      'logo-rich-colors-ok.svg',
    );
    expect(richColorsOk.status, richColorsOk.stdout).toBe(0);

    for (const [label, paint] of [
      ['inherit', 'inherit'],
      ['context-fill', 'context-fill'],
      ['bogus', 'not-a-color'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="60" height="60" fill="#1A1C1E" stroke="${paint}" stroke-width="6"/>
</svg>`,
        [],
        `logo-unparsed-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_palette_restraint');
    }

    // 4. Strict flattened-logo contract & security: <style>, <use>, nested <svg>, SMIL, <?xml-stylesheet?>, data: URI, style url(), and opacity/fill-opacity/stroke-opacity < 1
    for (const [label, body, expectedCheck] of [
      [
        'style-tag',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.a{fill:#111}</style><rect class="a" x="20" y="20" width="60" height="60" fill="#111"/></svg>`,
        'logo_self_contained',
      ],
      [
        'use-tag',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><rect id="r" x="20" y="20" width="60" height="60"/></defs><use href="#r" fill="#111"/><rect x="20" y="20" width="60" height="60" fill="#111"/></svg>`,
        'logo_self_contained',
      ],
      [
        'nested-svg',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><svg x="10" y="10" width="80" height="80"><rect x="10" y="10" width="60" height="60" fill="#111"/></svg></svg>`,
        'logo_self_contained',
      ],
      [
        'smil-animate',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111"><animate attributeName="x" from="20" to="30" dur="1s"/></rect></svg>`,
        'logo_self_contained',
      ],
      [
        'smil-set',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111"><set attributeName="fill" to="#000"/></rect></svg>`,
        'logo_self_contained',
      ],
      [
        'xml-stylesheet',
        `<?xml-stylesheet type="text/css" href="evil.css"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111"/></svg>`,
        'logo_self_contained',
      ],
      [
        'data-uri-xlink',
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"><a xlink:href="data:image/svg+xml;base64,PHN2Zy8+"><rect x="20" y="20" width="60" height="60" fill="#111"/></a></svg>`,
        'logo_self_contained',
      ],
      [
        'style-url-data',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" style="background:url(data:image/png;base64,AA==)"/></svg>`,
        'logo_self_contained',
      ],
      [
        'style-url-local',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" style="clip-path:url(#c)"/></svg>`,
        'logo_self_contained',
      ],
      [
        'el-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" opacity="0.8"/></svg>`,
        'logo_monochrome_safe',
      ],
      [
        'group-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g opacity="0.5"><rect x="20" y="20" width="60" height="60" fill="#111"/></g></svg>`,
        'logo_monochrome_safe',
      ],
      [
        'fill-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#111" fill-opacity="0.6"/></svg>`,
        'logo_monochrome_safe',
      ],
      [
        'stroke-opacity',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><line x1="20" y1="50" x2="80" y2="50" stroke="#111" stroke-width="8" stroke-opacity="0.5"/></svg>`,
        'logo_monochrome_safe',
      ],
    ] as const) {
      const r = failedIds(body, [], `logo-flat-${label}.svg`);
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain(expectedCheck);
    }

    // 5. True Bezier & arc bounding boxes (control points outside 4% while curve stays inside PASS; reflected S/T and curve crossing margin FAIL)
    const cubicControlOutCurveIn = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#1A1C1E" d="M 20 50 C 20 0 80 0 80 50 L 80 80 L 20 80 Z"/>
</svg>`,
      [],
      'logo-cubic-in.svg',
    );
    expect(cubicControlOutCurveIn.status, cubicControlOutCurveIn.stdout).toBe(0);

    const quadControlOutCurveIn = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#1A1C1E" d="M 20 50 Q 50 -20 80 50 L 80 80 L 20 80 Z"/>
</svg>`,
      [],
      'logo-quad-in.svg',
    );
    expect(quadControlOutCurveIn.status, quadControlOutCurveIn.stdout).toBe(0);

    const smoothTReflectOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="none" stroke="#1A1C1E" stroke-width="6" d="M 15 50 Q 32.5 10 50 50 T 85 50"/>
</svg>`,
      [],
      'logo-smooth-t-ok.svg',
    );
    expect(smoothTReflectOk.status, smoothTReflectOk.stdout).toBe(0);

    const smoothTReflectOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="none" stroke="#1A1C1E" stroke-width="6" d="M 15 50 Q 32.5 -50 50 50 T 85 50"/>
</svg>`,
      [],
      'logo-smooth-t-out.svg',
    );
    expect(smoothTReflectOut.status).toBe(1);
    expect(smoothTReflectOut.bad).toContain('logo_clearspace');

    const smoothSReflectOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="none" stroke="#1A1C1E" stroke-width="6" d="M 15 50 C 25 20 40 -20 50 50 S 75 110 85 50"/>
</svg>`,
      [],
      'logo-smooth-s-out.svg',
    );
    expect(smoothSReflectOut.status).toBe(1);
    expect(smoothSReflectOut.bad).toContain('logo_clearspace');

    const arcBulgeOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#1A1C1E" d="M 30 30 A 45 45 0 1 1 70 30 Z"/>
</svg>`,
      [],
      'logo-arc-bulge-out.svg',
    );
    expect(arcBulgeOut.status).toBe(1);
    expect(arcBulgeOut.bad).toContain('logo_clearspace');

    // 6. Full 2D affine transforms (matrix, skewX, skewY, rotate) & exact rotated circle/ellipse/rect bboxes
    const rotatedCircleOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="#1A1C1E" transform="rotate(45 50 50)"/>
</svg>`,
      [],
      'logo-rot-circle-ok.svg',
    );
    expect(rotatedCircleOk.status, rotatedCircleOk.stdout).toBe(0);

    const rotatedEllipseOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="50" cy="50" rx="40" ry="15" fill="#1A1C1E" transform="rotate(90 50 50)"/>
</svg>`,
      [],
      'logo-rot-ellipse-ok.svg',
    );
    expect(rotatedEllipseOk.status, rotatedEllipseOk.stdout).toBe(0);

    const rotatedEllipseOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="50" cy="50" rx="48" ry="15" fill="#1A1C1E" transform="rotate(90 50 50)"/>
</svg>`,
      [],
      'logo-rot-ellipse-out.svg',
    );
    expect(rotatedEllipseOut.status).toBe(1);
    expect(rotatedEllipseOut.bad).toContain('logo_clearspace');

    const rotatedRectOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="#1A1C1E" transform="rotate(45 50 50)"/>
</svg>`,
      [],
      'logo-rot-rect-out.svg',
    );
    expect(rotatedRectOut.status).toBe(1);
    expect(rotatedRectOut.bad).toContain('logo_clearspace');

    const matrixSkewOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g transform="matrix(1 0 0 1 10 10) skewX(5) skewY(5)">
    <rect x="20" y="20" width="35" height="35" fill="#1A1C1E"/>
  </g>
</svg>`,
      [],
      'logo-matrix-skew-ok.svg',
    );
    expect(matrixSkewOk.status, matrixSkewOk.stdout).toBe(0);

    const matrixSkewOut = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="60" height="60" fill="#1A1C1E" transform="skewX(45)"/>
</svg>`,
      [],
      'logo-skew-out.svg',
    );
    expect(matrixSkewOut.status).toBe(1);
    expect(matrixSkewOut.bad).toContain('logo_clearspace');

    const badTransform = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="60" height="60" fill="#1A1C1E" transform="bogus(10)"/>
</svg>`,
      [],
      'logo-bad-transform.svg',
    );
    expect(badTransform.status).toBe(1);
    expect(badTransform.bad).toContain('logo_geometry');

    // 7. Strict SVG namespace: missing or wrong xmlns must fail logo_svg_valid
    for (const [label, rootTag] of [
      ['missing-xmlns', '<svg viewBox="0 0 100 100">'],
      ['wrong-xmlns', '<svg xmlns="http://example.com/svg" viewBox="0 0 100 100">'],
    ] as const) {
      const r = failedIds(
        `${rootTag}<rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
        [],
        `logo-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_svg_valid');
    }

    // 8. Percent and mm/pt lengths parsed cleanly (not coerced to 0); unparseable non-empty length fails logo_geometry
    const unitsOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
  <rect x="20%" y="20%" width="60%" height="60%" fill="#1A1C1E"/>
  <circle cx="50%" cy="50%" r="10pt" fill="#B8422E"/>
</svg>`,
      ['--surface', '#FFFFFF'],
      'logo-units-ok.svg',
    );
    expect(unitsOk.status, unitsOk.stdout).toBe(0);

    const mmRectOk = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="5mm" y="5mm" width="15mm" height="15mm" fill="#1A1C1E"/>
</svg>`,
      [],
      'logo-mm-ok.svg',
    );
    expect(mmRectOk.status, mmRectOk.stdout).toBe(0);

    const badLen = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="20" y="20" width="bogus" height="40" fill="#1A1C1E"/>
</svg>`,
      [],
      'logo-bad-len.svg',
    );
    expect(badLen.status).toBe(1);
    expect(badLen.bad).toContain('logo_geometry');

    // 9. --allow-draft-text pure <text> wordmark passes with flag and fails without flag
    const pureWordmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEARTH</text>
</svg>`;
    const rPureFail = failedIds(pureWordmarkSvg, [], 'logo-pure-wordmark.svg');
    expect(rPureFail.status).toBe(1);
    expect(rPureFail.bad).toContain('logo_outlined_text');
    expect(rPureFail.bad).toContain('logo_complexity');

    const rPureDraftOk = failedIds(pureWordmarkSvg, ['--allow-draft-text'], 'logo-pure-wordmark.svg');
    expect(rPureDraftOk.status, rPureDraftOk.stdout).toBe(0);

    // 10. viewBox with px units rejected; width="0" with no height rejected
    for (const [label, attrs] of [
      ['vb-units', 'viewBox="0 0 100px 100px"'],
      ['width-zero-only', 'viewBox="0 0 100 100" width="0"'],
      ['height-neg-only', 'viewBox="0 0 100 100" height="-10"'],
      ['width-unparseable', 'viewBox="0 0 100 100" width="auto"'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
        [],
        `logo-vb-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_viewbox');
    }
  }, 15_000);

  it('enforces strict SVG tag/namespace/attribute allowlist and round-2 logo hardening regressions', () => {
    const failedIds = (svgText: string, extraArgs: string[] = [], name = 'r2-case.svg') => {
      const p = join(dir, name);
      writeFileSync(p, svgText);
      const r = runPy(['--logo', p, ...extraArgs, '--json']);
      const parsed = JSON.parse(r.stdout);
      const bad = parsed.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
      return { status: r.status, ok: parsed.ok, bad, checks: parsed.checks, stdout: r.stdout };
    };

    // HIGH #1: URL-bearing presentation/reference attrs & disallowed container tags (<defs>/<clipPath>)
    for (const [label, attr] of [
      ['clip-path-url', 'clip-path="url(https://evil.example/a#c)"'],
      ['mask-url', 'mask="url(https://evil.example/a#m)"'],
      ['filter-url', 'filter="url(https://evil.example/a#f)"'],
      ['marker-start-url', 'marker-start="url(https://evil.example/a#mk)"'],
      ['cursor-url', 'cursor="url(https://evil.example/a.cur), auto"'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E" ${attr}/></svg>`,
        [],
        `logo-r2-h1-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }
    const defsClipRejected = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="c"><rect x="10" y="10" width="80" height="80"/></clipPath></defs><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-defs-clip.svg',
    );
    expect(defsClipRejected.status).toBe(1);
    expect(defsClipRejected.bad).toContain('logo_self_contained');

    // HIGH #2 + MEDIUM #13: Entity-obfuscated URI schemes & <a> links (javascript, https, mailto, blob)
    for (const [label, body] of [
      [
        'href-tab-js',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="java&#x09;script:alert(1)"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
      [
        'href-lf-https',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="h&#x0a;ttps://evil.example/x"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
      [
        'a-mailto',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="mailto:x@y.com"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
      [
        'a-blob',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a href="blob:https://example.com/1234"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></a></svg>`,
      ],
    ] as const) {
      const r = failedIds(body, [], `logo-r2-h2-${label}.svg`);
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }

    // HIGH #3: ANY inline style attribute rejected (CSS escapes, inline transform, CSS comments)
    for (const [label, styleVal] of [
      ['css-escape-url', '\\75rl(https://evil.example/x)'],
      ['css-escape-fill', 'fi\\6cl: #FFF'],
      ['css-escape-opacity', 'op\\61city: 0.3'],
      ['inline-transform', 'transform: scale(0.1)'],
      ['css-comment-opacity', '/* c */ opacity: 0.3'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E" style="${styleVal}"/></svg>`,
        [],
        `logo-r2-h3-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }

    // HIGH #4: Hairline filled paths & scaled filled paths fail logo_micro_legibility
    const hairlineBar = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" d="M 10 10 H 90 V 11 H 10 Z"/></svg>`,
      [],
      'logo-r2-h4-bar.svg',
    );
    expect(hairlineBar.status).toBe(1);
    expect(hairlineBar.bad).toContain('logo_micro_legibility');

    const scaledTinyPath = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#1A1C1E" transform="translate(50 50) scale(0.01)" d="M -30 -30 H 30 V 30 H -30 Z"/></svg>`,
      [],
      'logo-r2-h4-scaled.svg',
    );
    expect(scaledTinyPath.status).toBe(1);
    expect(scaledTinyPath.bad).toContain('logo_micro_legibility');

    const hairlinePoly = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon fill="#1A1C1E" points="10,10 90,10 90,11 10,11"/></svg>`,
      [],
      'logo-r2-h4-poly.svg',
    );
    expect(hairlinePoly.status).toBe(1);
    expect(hairlinePoly.bad).toContain('logo_micro_legibility');

    // MEDIUM #6: Inherited color property with currentColor
    for (const [label, body] of [
      [
        'svg-color-white',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" color="#FFFFFF"><rect x="20" y="20" width="60" height="60" fill="currentColor"/></svg>`,
      ],
      [
        'g-color-white',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g color="#FFFFFF"><rect x="20" y="20" width="60" height="60" fill="currentColor"/></g></svg>`,
      ],
    ] as const) {
      const r = failedIds(body, ['--surface', '#FFFFFF'], `logo-r2-m6-${label}.svg`);
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_contrast');
    }
    const plainCurrentColor = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="currentColor"/></svg>`,
      ['--surface', '#FFFFFF'],
      'logo-r2-m6-plain.svg',
    );
    expect(plainCurrentColor.status, plainCurrentColor.stdout).toBe(0);

    const badColorNone = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" color="none"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m6-color-none.svg',
    );
    expect(badColorNone.status).toBe(1);
    expect(badColorNone.bad).toContain('logo_palette_restraint');

    // MEDIUM #7: <tspan> inspected under --allow-draft-text, and <textPath> rejected outright
    const tspanWhite = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEA<tspan fill="#FFFFFF">RTH</tspan></text>
</svg>`,
      ['--allow-draft-text', '--surface', '#FFFFFF'],
      'logo-r2-m7-tspan-white.svg',
    );
    expect(tspanWhite.status).toBe(1);
    expect(tspanWhite.bad).toContain('logo_contrast');

    const tspanTranslucent = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEA<tspan opacity="0.5">RTH</tspan></text>
</svg>`,
      ['--allow-draft-text', '--surface', '#FFFFFF'],
      'logo-r2-m7-tspan-op.svg',
    );
    expect(tspanTranslucent.status).toBe(1);
    expect(tspanTranslucent.bad).toContain('logo_monochrome_safe');

    const tspanValid = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" text-anchor="middle" font-size="28" fill="#1A1C1E">HEA<tspan fill="#B8422E">RTH</tspan></text>
</svg>`,
      ['--allow-draft-text', '--surface', '#FFFFFF'],
      'logo-r2-m7-tspan-ok.svg',
    );
    expect(tspanValid.status, tspanValid.stdout).toBe(0);

    const textPathRejected = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80">
  <text x="120" y="52" font-size="24" fill="#1A1C1E"><textPath>HEARTH</textPath></text>
</svg>`,
      ['--allow-draft-text'],
      'logo-r2-m7-textpath.svg',
    );
    expect(textPathRejected.status).toBe(1);
    expect(textPathRejected.bad).toContain('logo_self_contained');

    // MEDIUM #8: Unrounded WCAG contrast comparison (#959595 on #FFFFFF is ~2.995 < 3.0)
    const borderlineContrast = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#959595"/></svg>`,
      ['--surface', '#FFFFFF'],
      'logo-r2-m8-959595.svg',
    );
    expect(borderlineContrast.status).toBe(1);
    expect(borderlineContrast.bad).toContain('logo_contrast');

    // MEDIUM #10: Non-SVG namespace child rejected outside <metadata>; malicious <metadata> child rejected; benign <metadata> allowed
    const foreignNsChild = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><xhtml:div xmlns:xhtml="http://www.w3.org/1999/xhtml"/><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m10-xhtml.svg',
    );
    expect(foreignNsChild.status).toBe(1);
    expect(foreignNsChild.bad).toContain('logo_self_contained');

    const evilMetadata = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><metadata><script>alert(1)</script></metadata><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m10-meta-script.svg',
    );
    expect(evilMetadata.status).toBe(1);
    expect(evilMetadata.bad).toContain('logo_self_contained');

    const evilMetadataUri = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><metadata><dc:link xmlns:dc="http://purl.org/dc/elements/1.1/" ref="h&#x0a;ttps://evil.example/x"/></metadata><rect x="20" y="20" width="60" height="60" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-m10-meta-uri.svg',
    );
    expect(evilMetadataUri.status).toBe(1);
    expect(evilMetadataUri.bad).toContain('logo_self_contained');

    // MEDIUM #11 & #12: display="none", visibility="hidden", mix-blend-mode="multiply" rejected
    for (const [label, attr] of [
      ['display-none', 'display="none"'],
      ['visibility-hidden', 'visibility="hidden"'],
      ['mix-blend-mode', 'mix-blend-mode="multiply"'],
    ] as const) {
      const r = failedIds(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" fill="#1A1C1E" ${attr}/></svg>`,
        [],
        `logo-r2-m11-${label}.svg`,
      );
      expect(r.status, label).toBe(1);
      expect(r.bad, label).toContain('logo_self_contained');
    }

    // LOW: <polygon> with > 400 vertices fails logo_complexity
    const polyPts = Array.from({ length: 405 }, (_, i) => {
      const ang = (i / 405) * Math.PI * 2;
      const x = (50 + 30 * Math.cos(ang)).toFixed(2);
      const y = (50 + 30 * Math.sin(ang)).toFixed(2);
      return `${x},${y}`;
    }).join(' ');
    const densePoly = failedIds(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="${polyPts}" fill="#1A1C1E"/></svg>`,
      [],
      'logo-r2-low-poly-405.svg',
    );
    expect(densePoly.status).toBe(1);
    expect(densePoly.bad).toContain('logo_complexity');
  }, 15_000);
});

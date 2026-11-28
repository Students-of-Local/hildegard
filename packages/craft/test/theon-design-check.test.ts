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
    // 1. Clean light-surface evenodd mark + non-rendered <defs><clipPath> must PASS
    const goodLight = join(dir, 'logo-light.svg');
    writeFileSync(
      goodLight,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <defs><clipPath id="c"><rect x="0" y="0" width="100" height="100"/></clipPath></defs>
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
});

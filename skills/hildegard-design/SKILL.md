---
name: hildegard-design
description: Use for a poster, flyer, social post, album or book cover, invitation, menu, sign, banner or logo - built in HTML and SVG at its exact size, rendered, and read back line by line.
---

# Design

A poster or post that a person would print, pin or share. It is built as one HTML file at its exact size (inline CSS
and SVG, fonts from Google Fonts), rendered to an image, and checked line by line before you hand it over. This skill
is all you need for it.

## Fast path

1. **Copy deck first.** Before any layout, write out every piece of text that will appear, copied from the brief:
   names, date, times, address, prices, lines the person wrote. Nothing else goes on the design. No tagline, slogan,
   "3 days only", "thank you for 70 years", year range, hashtag, web address or count that the person didn't give.
   Fix spelling, keep their words. If the brief gives too much text to fit, keep what a passer-by needs (what, when,
   where, the one reason to come) and put the rest in your reply as a suggestion.
2. **Rank it.** One headline, the thing someone must read from across the room. Two or three supporting lines. Then
   the details, small. Write the ranking next to the copy deck.
3. **Set the canvas.** The exact size asked for (a phone post 1080 x 1350, a square 1080 x 1080, a letter-size flyer
   1275 x 1650 at 150 dpi). Keep every word inside a safe margin of at least 6% of the short side.
4. **Pick two typefaces** and nothing more: one for the headline, one for everything else. Choose for the subject, and
   check the family is on Google Fonts:
   | Feel | Headline | Text |
   |---|---|---|
   | Church, community, heritage | Libre Caslon Display or Cormorant | Libre Franklin or Source Sans 3 |
   | Hardware, sale, sports, loud | Anton or Oswald | Archivo or Roboto Condensed |
   | Folk, farm, bluegrass, rustic | Alfa Slab One or Rye | Bitter or Cabin |
   | Wedding, formal, gala | Cormorant Garamond (600 or bolder) | Montserrat |
   | Kids, playful | Fredoka | Nunito |
   | Modern, tech, clean | DM Serif Display or Syne | Manrope or IBM Plex Sans |
5. **Pick three or four colors** from the subject's own world (harvest gold and barn red, hymnal navy and candle
   cream), plus one dark and one light for text. Text must stand out: dark on light or light on dark, never mid on mid.
6. **Size for a phone.** Most people see it as a thumbnail. Set the headline in a bold or heavier weight (never a
   thin or light display face), spanning at least 60% of the canvas width, at least three times the body text. The
   when and where (date, time, place) come second in size, never small. Body text at least 2.5% of the canvas
   height. Give the headline `text-wrap: balance`.
7. **Lay it out on a grid.** Use CSS grid or flex with `gap`, never absolute positions for text. Space separates the
   groups (headline, the when and where, the details); it never sits as an empty band. If a third of the canvas is
   empty, make the headline or the picture bigger.
8. **One picture, big, or none.** A picture earns its place at a real size: at least a third of the canvas, part of
   the layout, never a small icon floating in a frame. A simple SVG scene or shape that belongs to the subject (a lantern on a porch rail, a sheaf of wheat, a sun over a field) beats a busy illustration; no stick figures or faces
   drawn in code. Never put text over a busy picture.
9. **Render and read it back** (next section). Fix, render again, until every check passes.
10. **Deliver** the HTML file, the rendered PNG, and the copy deck. Say which typefaces and colors you used, and list
   anything from the brief you left off and why.

## Render and read it back

Render at the exact size:

```sh
chromium --headless=new --hide-scrollbars --window-size=1080,1350 --screenshot=design.png design.html
# or google-chrome / chrome / msedge with the same flags; or Playwright's page.screenshot()
npx playwright screenshot --viewport-size=1080,1350 "file://$PWD/design.html" design.png   # if no browser is installed
```

No browser and no Node (a chatbot)? Use the code tool's Chromium or Playwright if it has one. If nothing can render,
hand over the HTML, say plainly that it is unrendered and unchecked, and ask your user to open it and tell you what
they see.

Open `design.png` and look at it at full size. Then check each line, one at a time, against the copy deck:

- **Every line is whole.** No word cut off at an edge or behind another element (a line that ends "REGULAR-PR" is
  cut). No word broken across two lines unless it has a hyphen in the copy deck.
- **No stray characters.** No `&amp;`, `&`, `·`, quotes or bullets that aren't in the copy deck. An ampersand in a
  headline ("Fall & Festival") that the brief doesn't have is a bug.
- **Every copy-deck line appears once,** spelled the same, and nothing appears that isn't in the copy deck.
- **Inside the margin.** Nothing touches or crosses the safe margin.
- **The squint test.** Shrink the PNG to a quarter of its size: the headline, the date and the place must still read.
- **Contrast.** Small text at least 4.5 to 1 against what's behind it; large text at least 3 to 1.

If any check fails, fix the HTML (wider box, smaller size, shorter line, remove the extra) and render again. Never hand
over a design you haven't rendered and read.

## Craft that makes it good

- **One idea.** The design says one thing at a glance: what's happening, and why someone should care.
- **Alignment.** Pick one alignment (left is easiest to do well) and keep to it. Centered everything looks generic.
- **Scale contrast.** A big, confident headline and small, calm details. Medium-size everything is the mark of a
  template.
- **Specific over generic.** A real detail from the subject (the shop's founding year if the brief gives it, the
  barn's name, the street) beats a stock flourish. Leaves, sunbursts and swooshes are the clip art of 2026.
- **Numbers that matter, big.** A sale's "20%" or an event's date can be the headline if it is the reason to come.
- **Print and screen.** For print, keep 0.125 in bleed past the trim if asked and no text near it; for screen, check
  the design still reads at phone size.

## With Hildegard

With Hildegard linked, its image models can make a picture for the design (the **hildegard-art** skill): ask for the
picture alone, with room left for text, and place the text in HTML. Without Hildegard, use the image tool you have, or
your user's own picture, or an SVG shape (step 7). Either way, never ask an image model to write the words; it
misspells them.

## Anti-slop Floor and design.md token contract

Before rendering, run the static Floor linter `python3 scripts/check_design.py --html design.html` (and
`python3 scripts/check_design.py --design-md design.md` when maintaining a persistent visual identity). Every rule below
is enforced mechanically:

1. **All colours and fonts via `:root` tokens:** declare every colour (`--bg`, `--ink`, `--accent`) and font family
   (`--font-head`, `--font-body`) inside `:root { ... }`. Never write literal hex/rgb colours or raw `font-family`
   values outside `:root`; use `var(--*)` everywhere else.
2. **Motion safety:** never write `transition: all`, and never animate `width`, `height`, `top`, or `left`. Animate
   `transform` or `opacity` only, and always include `@media (prefers-reduced-motion: reduce)` when transitions or
   keyframes are present.
3. **Overflow and focus:** set `overflow-x: clip` on `html, body` (never `100vw` and never `overflow-x: hidden`). Give
   every interactive element (`button`, `a`, `input`) a visible `:focus-visible` style.
4. **No slop defaults:** never use purple-to-blue gradients, emoji as icons, a single italic word inside a roman heading
   (`<h1>Title <em>word</em></h1>`), or filler copy (`Lorem ipsum`, `Unlock the power of`, `reimagined`).

Minimal clean HTML/CSS Floor pattern:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Event Title</title>
<style>
:root {
  --bg: #f6f1e7;
  --ink: #1e1b18;
  --accent: #a63d28;
  --font-head: "Libre Caslon Display", serif;
  --font-body: "Libre Franklin", sans-serif;
}
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); font-family: var(--font-body); }
h1 { font-family: var(--font-head); }
a, button { background: var(--accent); color: var(--bg); transition: transform 160ms ease-out; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { a, button { transition: none; } }
</style></head>
<body><main><h1>Event Title</h1><p>Date and place.</p><button type="button">Register</button></main></body>
</html>
```

**Persistent `design.md` format:** embed tokens in YAML front matter (`---` ... `---`) and/or fenced `yaml` blocks with
unique top-level keys (`version`, `name`, `colors`, `typography`, `spacing`, `rounded`, `motion`, `components`; never
define the same top-level key twice). Start line 1 with `---` (no heading above `---`), define `colors:` once with quoted hex values (`"#1A1C1E"`), and cross-reference only keys defined in `colors:` with `{colors.primary}`, and keep any `` `@path/file.ext` `` external references relative inside the `design.md` folder:

````markdown
---
version: alpha
name: Brand Name
colors:
  primary: "#1A1C1E"
  surface: "#F6F1E7"
  accent: "#A63D28"
---

## Components

```yaml
components:
  button:
    bg: "{colors.primary}"
```
````


## Vector logos, brand marks, and favicon legibility

When asked for a logo, icon mark, monogram, or brand lockup, build clean, flattened, self-contained vector SVG geometry (never raster-wrapped `<image>` tags and never live `<text>` in final delivery) and verify every file mechanically with `python3 scripts/check_design.py --logo logo.svg` (add `--surface "#FFFFFF"` or `--surface "#111111"` for target-surface WCAG contrast, or `--allow-draft-text` only for early draft lockups):

1. **Construct real boolean geometry:** build marks from clean primitives and boolean operations (`skia-pathops` in Python or `paper.js` in JS; `vtracer` only when tracing rough sketches, then simplify). Never fake a hollow cutout by painting a white shape on top of a dark shape (it breaks dark mode); use a single `<path fill-rule="evenodd" d="..."/>` or boolean `difference` so the cutout is truly transparent.
2. **Outline final wordmarks:** never ship live `<text>` nodes in final delivery logo SVGs (fonts silently substitute on other machines). Convert glyphs to `<path>` outlines (`opentype.js` or `fonttools`) before final signoff; use `--allow-draft-text` only while iterating on draft lockups (including pure wordmark drafts).
3. **Strict flattened-logo contract, `viewBox`, clearspace, and 16 px micro-legibility:**
   - Always declare `xmlns="http://www.w3.org/2000/svg"` and an explicit 4-number unitless `viewBox="0 0 W H"` (plus positive `width`/`height` matching the aspect ratio when specified).
   - **Strict flattened SVG allowlist:** standalone SVG geometry and grouping tags only (`svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polygon`, `polyline`, `title`, `desc`, `metadata`; plus `text`/`tspan` only with `--allow-draft-text`) and direct presentation attributes only (`fill`, `stroke`, `stroke-width`, `transform`, `color`, etc.). Zero `style` attributes, zero `<style>`/`<use>`/`<defs>`/`<clipPath>`/`<mask>`/`<a>`/nested `<svg>`/SMIL/`<script>`/`<image>`/`<foreignObject>`/`<textPath>`, zero `href`/`src`/`on*`/`url(...)`/`display`/`visibility`/`mix-blend-mode`, zero `<?xml-stylesheet?>` or external/`data:` URIs, and zero non-SVG elements outside `<metadata>`.
   - **Transparent canvas only:** NEVER add a background `<rect>` filled with the surface color (`#FFFFFF` or `#111111`). Draw ONLY the mark's own high-contrast ink shapes.
   - **Hard checker thresholds (`check_design.py --logo`):** `>= 4%` clearspace on all four sides of `viewBox`, strokes and features (including filled path/polygon/polyline widths) `>= min(W, H) / 32` (`>= 0.5 px` at `16 px` favicon), `1..64` shapes, and `<= 400` executed path commands and polygon/polyline vertices.
   - **Recommended drafting margins:** aim for comfortable breathing room with `10%-15%` clearspace inset (keep every shape inside `15%..85%` of `W` and `H`, never touching `0`, `W`, or `H`) and `>= 8%` stroke width of `min(W, H)`. Remember: if `x` is `16` inside a `64` box, `width` must be `<= 32` (not `48`, because `16 + 48 = 64` hits the edge).
4. **Flat opaque brand palette and WCAG contrast:**
   - Use flat opaque fills/strokes only (zero gradients, drop-shadows, blur filters, `opacity` / `fill-opacity` / `stroke-opacity < 1`, or translucent alpha colors `0 < alpha < 1`) so the silhouette reads identically in 1-color monochrome.
   - Cap brand inks to `1..3` distinct valid CSS colors (`fill="currentColor"` for universal monochrome marks; never unparsed keywords like `inherit`). Every explicit ink must hit `>= 3.0:1` WCAG contrast against the target surface (light `#FFFFFF` or dark `#111111`), set directly via `fill="..."` / `stroke="..."` attributes (never emit the surface color itself as a fill).
5. **Optimize, raster-QA, and package:** clean output with `svgo` (preserving `viewBox`), raster-check at `16`, `32`, `64`, `256`, and `1024 px` on light, dark, and monochrome (`resvg` or headless Chromium), and deliver primary mark, monochrome inverse, horizontal/stacked lockups, and multi-size favicon/PNG exports (`sharp` / `favicons`).

Minimal clean vector logo patterns (adapt `viewBox`, colors, and geometry to the brief; checker requires `>= 4%` clearspace, drafting targets `10%-15%`):

```xml
<!-- Solid + evenodd hollow cutout mark (light surface #FFFFFF) -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path fill="#1A1C1E" fill-rule="evenodd" d="M 16 16 H 84 V 84 H 16 Z M 34 34 H 66 V 66 H 34 Z"/>
  <rect x="42" y="42" width="16" height="16" fill="#B8422E"/>
</svg>
```

```xml
<!-- Universal monochrome currentColor mark (works on light and dark) -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <polygon points="32,10 54,52 10,52" fill="currentColor"/>
</svg>
```

**Final SVG checklist before outputting (enforced by `check_design.py --logo` plus drafting targets):**
- **Flattened and transparent:** strict SVG tag/attribute allowlist with direct `fill`/`stroke` presentation attributes only (zero `style` attributes, `<style>`, `<use>`, `<defs>`, `<a>`, nested `<svg>`, SMIL, `display`/`visibility`/`mix-blend-mode`, `opacity < 1`, or `url(...)`/`data:` URIs) and NEVER draw a background `<rect>` filled with the surface color (`#FFFFFF` on light or `#111111` on dark).
- **Clearspace (hard floor `>= 4%`, drafting target `10%-15%`):** keep every shape inside `15%..85%` of `W` and `H` (e.g. `x = 20%` of `W`, `width = 60%` of `W`), and NEVER let any point, curve extremum, `cx + r`, `x + width`, or `y + height` breach the `4%` margin.
- **Strokes and cutouts (hard floor `>= min(W, H) / 32`, drafting target `>= 8%`):** use `stroke-width` at least `8%` of `min(W, H)` and keep `cx + r + stroke-width/2` inside `85%` of `W`. For hollow cutouts, use one `<path fill-rule="evenodd" d="..."/>`, never a white overlay shape.

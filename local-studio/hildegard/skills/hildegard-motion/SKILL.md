---
name: hildegard-motion
description: Use for animated video drawn in code - title cards, promos, explainers, kinetic type, data reveals, photo slideshows, lower thirds - from a spec, rendered and checked
---

# Motion: video drawn in code

## In Local Studio

The person's request is at the top of this message and after `</skill>`.

First pick the closest template in `<folder>/templates/` (the table below), copy it into your working folder (`cp <folder>/templates/promo.json promo.json`), change the copy, and run `python3 -B <folder>/scripts/motion.py promo.json --check` until it prints `result: clean`. Where this skill says `<skill>`, that is `<folder>`. If numpy or Pillow is missing, or neither ffmpeg nor PyAV is there, give the person the install line below and install nothing yourself.

`<folder>` is the folder on the "References are relative to" line above. Run its scripts as `python3 -B <folder>/scripts/<name>.py`, and a script of yours that imports from `<folder>/scripts` as `python3 -B yours.py`: `-B` keeps Python from writing into the plugin, which would turn Hildegard's tools off until the person allows them again.

Read **hildegard-craft** first for the bar. This skill makes video by writing a JSON spec: scenes, layers of text, shapes and
photos, and moves with names. `scripts/motion.py` checks the spec, draws every frame (anti-aliased, in sRGB) and encodes an
MP4. No GPU, no browser, no model. A weak model fills in a spec and gets a polished piece, because the script refuses the
mistakes weak models make: text off the edge, text too brief to read, low contrast, overlapping words.

Use it for graphics and type: title cards, promos, announcements, quotes and verses, data reveals, slideshows, lower thirds,
lyric and kinetic type. For footage use **hildegard-video-edit**; for generated shots use **hildegard-film**.

You need `python3` (3.10 or later), `numpy`, `Pillow`, and either `ffmpeg` on PATH or PyAV. Check once:

```sh
python3 -c "import numpy, PIL; print('ok')" && (command -v ffmpeg >/dev/null && echo "ffmpeg ok" || python3 -c "import av; print('av ok')")
```

If something is missing, say so and give the install line (`python3 -m pip install "numpy>=1.26" "pillow>=10.1" "av>=12"`; leave
out `"av>=12"` when `ffmpeg` is on PATH); do not install for the user. These are minimums, not pins: pip picks the newest
NumPy, Pillow and PyAV that the user's Python supports (NumPy 2.5 and PyAV 19 need Python 3.12). The script was run, and
its tests passed, on Python 3.10 with the minimums (NumPy 1.26.4, Pillow 10.1.0, PyAV 12.0.0), and on 3.10, 3.11, 3.12 and
3.13 with what that line installs today; say so if the user's versions are outside that. Fonts download once from Google Fonts (pinned, checked, cached) the first time a template needs them.

## FAST PATH (any model, start here)

1. **Pick the closest template** in `templates/` (table below). Never start from a blank file.
2. **Copy it** next to the user's files, for example `cp <skill>/templates/promo.json work/promo.json`.
3. **Change only three things**: the words, the colors, the timings. Keep the structure, the layer order, the fonts, the
   sizes and the move names unless a rule below says to change them.
4. **Check** until it prints `result: clean`:

   ```sh
   python3 -B <skill>/scripts/motion.py work/promo.json --check
   ```

   Read each line, do what its `Fix:` says, run it again. Do not use `--force` to get past a problem.
5. **Render** and **look**:

   ```sh
   python3 -B <skill>/scripts/motion.py work/promo.json work/promo.mp4 --preview work/promo-sheet.jpg
   ```

   Open the contact sheet (8 frames) and look at it. Check against "Looking at the sheet" below. Fix what is wrong in the
   spec, render again. For fast drafts add `--scale 0.5`.
6. **Deliver** `promo.mp4`, say what you checked (the `--check` result and the sheet), and say what you could not check
   (you cannot hear audio; motion is judged from frames).

| The request | Template | Length |
|---|---|---|
| a title, an opener, a name and role over a photo | `title-card.json` | 9 s |
| a short ad for an event, product, ministry or app | `promo.json` | 15 s |
| a verse, a quote, a line of poetry, a thought for the day | `quote-card.json` | 10 s |
| numbers that need to be seen: a chart and one takeaway | `data-reveal.json` | 10 s |
| photos with slow moves and captions, a memory reel | `slideshow.json` | 16 s |
| an announcement in big type, a lyric, one phrase per beat | `kinetic.json` | 13 s |

`templates/README.md` says exactly which words, colors and numbers each one takes. The photos in the slideshow, promo and
title card are `sample:` placeholders drawn in code. **Replace them with the user's photos** (`"file": "photos/one.jpg"`,
paths are relative to the spec) and say so in the delivery if you could not: a video that still shows sample landscapes is
not finished.

## Strict rules (weak models: these are not suggestions)

**Words.** Use only the words the brief gives you. Do not invent names, dates, prices, quotes, statistics or claims. If the
brief lacks a piece a template needs (a date, a place), ask the user, or cut that layer. Numbers in a chart are the user's
numbers, never rounded or made up. Scripture and quotations are word for word from a source you name.

**One idea per scene.** A scene says one thing. Two ideas are two scenes. No scene has more than about 12 words, and
`--check` warns past 3.6 words per second.

**Timing.** How long words must be fully on screen (animation time does not count):

| Words in the scene | At least | Comfortable |
|---|---|---|
| 1 to 3 | 1.5 s | 2.5 s |
| 4 to 6 | 2.0 s | 3.5 s |
| 7 to 10 | 3.0 s | 5.0 s |
| more than 10 | split the scene | |

The hard floor `--check` enforces is 0.25 s per word and never under 1.2 s. A whole video: 15 s for an ad, under 10 s for a
card, never longer than the words need. Hold the final frame 1 s with nothing moving (`--check` warns if you do not).

**Type sizes** are percent of the frame height, so they hold at any resolution:

| Use | `size` |
|---|---|
| a giant word or two (condensed fonts like Bebas Neue) | 16 to 34 |
| a title or headline | 8 to 13 |
| a subhead or a name | 4.5 to 6 |
| a line of body or a caption | 3.4 to 4.2 |
| the smallest anything may be | 3 |

At most three sizes in one scene. A headline is at least twice the size of the line under it. Text stays inside the 5%
safe margin on every side. Left-aligned or centered, never mixed in one scene.

**Color.** Two or three colors per video: a background, a text color, one accent. Text is light on dark or dark on light;
never mid-tone on mid-tone. On a photo, put a dark gradient under the text (the title-card template shows how) or use
`"dim"`. Contrast is checked: 4.5:1 for small text, 3:1 for large.

**Motion.**
- Ease every move. Every preset has a good default easing; do not set `linear` except for typing and counters.
- Nothing moves without a reason: an entrance shows what to read next, a camera move gives a photo life, a transition
  marks a change. Do not add spin, bounce or shake for energy.
- One entrance family per video, two at most (for example `rise` for headlines and `fade` for the line under).
- Entrances take 0.5 to 0.9 s. Stagger words 0.08 to 0.2 s apart. Camera moves are slow: a 10% push-in over 4 s.
- Transitions: `crossfade` (0.6 s) for mood and continuity, `slide` for a sequence of steps, `wipe` and `cut` for energy,
  `dip` for a hard break. Use one or two kinds in a video.
- Everything is on screen long enough to read before the next thing moves.

## Procedural camera, zoom, shake seams, and beat sync

When driving custom procedural animation or camera moves in Python/Pillow/canvas, verify the camera and sync contract with
`python3 -B <folder>/scripts/check_sync.py --camera camera.json` (and for continuous procedural animation without reading holds, check liveness/sync with `--video out.mp4`):

- **Deterministic seed and contact sheet:** pass an explicit integer `"seed"` and preview `"contact_sheet_frames"` (`8` to
  `16`, typically `10` or `12`) before final render.
- **Log-space zoom and mipmaps:** interpolate scale multiplicatively (`scale(u) = start_scale * (end_scale / start_scale) ** u`),
  never linearly, so apparent zoom speed stays uniform (for 3 steps `u = 0, 0.5, 1`, the midpoint is the geometric mean
  `sqrt(start_scale * end_scale)`). Clamp `|pan_x| <= max_pan_x` and `|pan_y| <= max_pan_y`, and pre-build at least
  `mipmap_levels: 4` area-filtered mipmaps to eliminate shimmer.
- **Seamless cyclic camera shake:** for a loop of `period_s` seconds, every frequency `f` in `"freqs_hz"` MUST satisfy
  `f * period_s == integer`. For ANY whole-second `period_s` (`1.0`, `2.0`, `3.0`, `4.0`, `5.0`), integer frequencies
  `[1.0, 2.0, 3.0]` (or `[1.0, 2.0]` when 2 frequencies are asked) ALWAYS satisfy `f * period_s == integer` seamlessly.
- **Absolute beat-to-frame math:** compute every cue frame independently as `frame = round(t * fps)` on the master clock,
  never by accumulating rounded step durations and never keeping another frame rate's numbers. Standard frame rates:
  - `24 fps`: `1.0 s = 24`, `0.5 s = 12`, `0.25 s = 6` frames.
  - `30 fps`: `1.0 s = 30`, `0.5 s = 15`, `0.1 s = 3` frames.
  - `60 fps`: `1.0 s = 60`, `0.5 s = 30`, `0.25 s = 15` frames.

Exact `check_sync.py --camera` JSON shape (include only the blocks the brief asks for):

```json
{
  "seed": 42,
  "contact_sheet_frames": 10,
  "fps": 30,
  "zoom": {
    "start_scale": 1.0,
    "end_scale": 4.0,
    "samples": [1.0, 2.0, 4.0],
    "pan_x": 0,
    "pan_y": 0,
    "max_pan_x": 50,
    "max_pan_y": 50,
    "mipmap_levels": 4
  },
  "shake": {
    "period_s": 2.0,
    "freqs_hz": [1.0, 2.0, 3.0]
  },
  "beats": [
    { "t": 0.5, "frame": 15 },
    { "t": 1.2, "frame": 36 },
    { "t": 2.7, "frame": 81 }
  ]
}
```

**Always recompute every number from the brief:** multiply each beat's `t` by the brief's `fps` (`frame = round(t * fps)`;
never keep 30-fps frame numbers when `fps` is 24 or 60), compute 3-step log zoom as `[start, sqrt(start * end), end]`,
and use integer `freqs_hz` (`[1.0, 2.0, 3.0]`) for whole-second `period_s`.

### Motion QA, closed-form renderAt(t), master timing, framing, and seams

Stills alone pass frozen renders. For code-directed films and continuous loops, verify rendered video with
`python3 -B <folder>/scripts/check_sync.py --video out.mp4 --max-freeze 0.5 --post-aac-lufs -14 --post-aac-peak -2.0` (catches
unintended freezes >= 0.5 s via `freezedetect` and measures `-14 LUFS` / `<= -2.0 dBTP` AFTER AAC encoding, because AAC
raises true peak), and verify the JSON contract with `python3 -B <folder>/scripts/check_sync.py --camera spec.json`:

- **Closed-form `renderAt(t)` (`"motion"`):** every animation and spring is a pure closed-form function of `t` with zero
  carried frame-to-frame velocity state (`"closed_form": true`) so preview and headless render never diverge. Replace
  vague adjectives with numeric damping ratios (`"dead_still": 1.0`, `"single_bounce": 0.8`, `"playful": 0.5`) and
  numeric easing curves (`"ease_in": "cubic-bezier(0.16, 1, 0.3, 1)"`, `"ease_out": "cubic-bezier(0.7, 0, 0.84, 0)"`)
  with exit duration 40 to 50% shorter than entrance (`ease_out_ms = 0.5 * ease_in_ms`).
- **Master `timing.json` clock (`"timing"`):** derive every cut and sound cue from one clock:
  `frames_per_beat = fps * 60 / bpm`. Every audio hit lands 1 frame after its visual event (`audio_frame = visual_frame + 1`).
  Seamless loops render frames `0..N-1` (`last_frame = total_frames - 1`, never `N`).
- **Framing and geometric planes (`"framing"`):** measure hero pixel width on stills before full render (`>= 170 px` at
  1080p for `"main"` shots, `>= 95 px` for `"wide"` shots, scaled by `frame_height / 1080`). Design clipping out with
  separate geometric planes (`"separate_planes": true`).
- **Seam vector law (`"seams"`):** keep an opaque stage ground (`"stage_bg_opaque": true`) to prevent white flashes at
  opacity dips. Each cut keeps the same `"axis"` (`"x"`, `"y"`, `"z"`) and signed direction (`exit_dir == entry_dir`,
  including Z `"push"` vs `"pull"`), cuts mid-motion (`"cut_mid_motion": true`), and never flips opposing directions on
  consecutive cuts without an explicit `"cause"`.

Optional `check_sync.py --camera` Motion QA blocks (top-level keys: `"seed"`, `"contact_sheet_frames"`, plus only the
blocks requested by the brief; omit unused blocks and recompute every number from the brief):

```json
{
  "seed": 10,
  "contact_sheet_frames": 10,
  "motion": {
    "closed_form": true,
    "feel": "dead_still",
    "damping_ratio": 1.0,
    "ease_in": "cubic-bezier(0.16, 1, 0.3, 1)",
    "ease_out": "cubic-bezier(0.7, 0, 0.84, 0)",
    "ease_in_ms": 600,
    "ease_out_ms": 300
  },
  "timing": {
    "fps": 60,
    "bpm": 120,
    "frames_per_beat": 30,
    "events": [{ "visual_frame": 30, "audio_frame": 31 }],
    "seamless_loop": true,
    "total_frames": 120,
    "last_frame": 119
  },
  "framing": {
    "separate_planes": true,
    "shots": [
      { "kind": "main", "hero_width_px": 190, "frame_height": 1080 },
      { "kind": "wide", "hero_width_px": 110, "frame_height": 1080 }
    ]
  },
  "seams": {
    "stage_bg_opaque": true,
    "transitions": [
      { "axis": "x", "exit_dir": "left", "entry_dir": "left", "cut_mid_motion": true },
      { "axis": "z", "exit_dir": "push", "entry_dir": "push", "cut_mid_motion": true }
    ]
  }
}
```

**Recompute every Motion QA field from the brief:**
- `motion`: set `"closed_form": true`, map `"dead_still" -> 1.0`, `"single_bounce" -> 0.8`, `"playful" -> 0.5`, use `cubic-bezier(...)` curves, and set `ease_out_ms = round(0.5 * ease_in_ms)`.
- `timing`: compute `frames_per_beat = fps * 60 / bpm` (60 fps / 120 BPM = 30; 24 fps / 120 BPM = 12; 30 fps / 150 BPM = 12), set every event's `"audio_frame"` to `visual_frame + 1` (never equal), and set `"last_frame": total_frames - 1` when `"seamless_loop": true`.
- `framing`: verify `hero_width_px >= 170 * (frame_height / 1080)` for `"main"` and `>= 95 * (frame_height / 1080)` for `"wide"`.
- `seams`: keep `"stage_bg_opaque": true`, match `"exit_dir" == "entry_dir"` (`"left"`, `"right"`, `"up"`, `"down"`, `"push"`, `"pull"`), and set `"cut_mid_motion": true`. Include only the blocks the brief asks for.

## What --check says, and what to do

| It says | Do this |
|---|---|
| `unknown field "colour"` | spell it as the message suggests; field names are in `references/spec.md` |
| text `runs off the edge` or `sits inside the 5% safe margin` | set `"box"` (the message says what) so it wraps, lower `size`, or move `x` and `y` toward the middle |
| `the word ... is wider than its box` | widen `box`, lower `size`, or use a shorter word |
| `is fully on screen for X s but N words need Y s` | lengthen the scene, or shorten its entrance, or cut words |
| `has contrast X:1 ... needs 4.5:1` | change the text color, add `"backing": {"color": "#00000099"}`, or `"dim": 0.4` on the photo |
| `overlaps ...` | move one with `y`, or show them at different times |
| `is covered by ...` | move the covering layer earlier in `layers` (the last layer is on top) |
| `has animation running until X s but the scene ends` | lengthen the scene or shorten the animation |
| `the camera move shows past the edge of the photo` | lower the camera `amount` |
| `duration says X but the scenes add up to Y` | set `duration` to Y (scene lengths minus transition overlaps) |
| `font "Inter" is missing` | needs the network once; or give a font file in `"fonts"` |

A message that still fails after two fixes: read the layer it names in `references/spec.md`, and change one thing at a time.

## Looking at the sheet

Open the `--preview` sheet and answer each, out loud, before you deliver:
1. Can I read every line at a glance? Is anything small, faint, cropped or crowded against an edge?
2. Does each frame look intended, or does a layer sit where it should not (a shape over a word, text on a busy part of a photo)?
3. Is the first frame good enough to be a thumbnail, and the last frame a clean hold?
4. Do the colors agree, and does the accent appear only where the eye should go?
5. Are the user's real words, names, dates and numbers on screen, spelled right? Compare to the brief letter by letter.

If any answer is no, fix the spec and render again. `hildegard review out.mp4 --sheet sheet.jpg` (when Hildegard is
connected) runs its technical checks on the file (exposure, color, loudness). A "frozen frame" warning on a hold you
chose is expected.

## Beyond the templates

Everything the script can draw is in `references/spec.md`: text with wrapping, letter spacing, shadow, outline and backing;
rectangles, circles, lines, polygons and paths; photos with cover or contain fit; a bar chart that takes real numbers;
counting numbers; typewriter and word-by-word text; keyframed moves with 21 named easings; crossfade, slide, wipe and dip
transitions; Ken Burns camera moves; SRT or inline captions; music with fades, mixed and normalized to -14 LUFS. A
weak model should add one of these to a template only when the brief needs it, and run `--check` after each change.

## Going further with code

For a strong model: when a request is past what a spec can say, work in code and keep the same checks.

**Extend `scripts/motion.py`.** It is one file in four stages: `compile_spec` (schema check with `references/spec.schema.json`,
then the `Compiler`: presets and tweens become `Seg` timelines), the `Renderer` (everything is drawn at 2x onto a patch and
reduced with a box filter, then composited on a float frame), the `Checker` (the `--check` rules, which render real frames
for contrast), and the encoders (`FfmpegSink`, `AvSink`). To add a layer type, add it in this order: its schema in
`spec.schema.json`, its `compile_*` method, its `draw_*` method in the Renderer, its rules in the Checker. Keep
`--hashes` identical across runs (no clocks, no unseeded randomness) and add a test to
`packages/craft/test/motion.test.ts` that fails without the change.

**Write your own renderer** when the picture needs real layout or a library: an HTML canvas page driven frame by frame with
Playwright, a Pillow or numpy generator, or a shader. `references/going-further.md` has a working Playwright capture loop,
a Pillow frame loop, and the ffmpeg line. Whatever you build, it keeps the same bars:
- text inside a 5% safe margin, measured, not eyeballed;
- text on screen at least 0.25 s per word (never under 1.2 s);
- contrast 4.5:1 for small text and 3:1 for large, measured on rendered pixels;
- no layer drawn over text; every move eased;
- deterministic: the same inputs give the same frame hashes;
- you look at an 8-frame contact sheet before you deliver (`--preview` makes one from a spec; make one by hand otherwise).

You can still use the checker on a hybrid: write the part a spec can express as a spec, check it, and render it for the
base layer, then composite your own frames over it with ffmpeg's `overlay`.

## Fonts and licenses

Fonts are Google Fonts under the SIL Open Font License, pinned to one google/fonts commit and verified by SHA-256 in
`scripts/motion.py` (`python3 -B <folder>/scripts/motion.py --fonts` lists them and what is cached). Nothing is bundled: a font
downloads once into a cache and is never fetched again while the cached file matches its pin. Pinned families: Inter,
Montserrat, Space Grotesk, Playfair Display, Lora, EB Garamond, Bebas Neue, Oswald, DM Serif Display, JetBrains Mono (Latin
text). Any other font is a file the user has the right to use, named in `"fonts"`.

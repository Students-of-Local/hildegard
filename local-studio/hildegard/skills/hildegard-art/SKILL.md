---
name: hildegard-art
description: Use when asked to create art, an image, illustration, key art, mood board or visual style with Hildegard's image models - for posters and covers with words, use hildegard-design.
---

# Making art

## In Local Studio

The person's request is at the top of this message and after `</skill>`.

First call the `hildegard_status` tool, then `list_presets` (section 1). If you have no Hildegard tools, write the art direction (section 2), then draw each prompt with bash the way the /image command does: `hildegard make image "<prompt>"`. It waits, saves the file and reviews it.

`<folder>` is the folder on the "References are relative to" line above. Run its scripts as `python3 -B <folder>/scripts/<name>.py`, and a script of yours that imports from `<folder>/scripts` as `python3 -B yours.py`: `-B` keeps Python from writing into the plugin, which would turn Hildegard's tools off until the person allows them again.

Hildegard's tools (`hildegard_status`, `loop_start` and the rest) are here once the person allows the Hildegard plugin in Local Studio's Settings, Plugins. If you don't have them, use this skill's way without Hildegard.

If you have **hildegard-craft**, read it first (`references/slop.md` here is its slop catalogue). Art is where slop is
most tempting: one vague prompt, one glossy result, "stunning". Treat the model as a fast, literal studio assistant
and do the art direction yourself.

## 1. What can make it

With Hildegard linked, call `hildegard_status` and `list_presets`. Without Hildegard, use the image tool you have (a
chatbot's own image generation, a model your user runs, or images they bring); sections 2 to 6 work the same, with the
camera and look written in plain words in the prompt, since the preset ids exist only in Hildegard.

- If an **image model** is listed, use it for stills. Hildegard’s own `make_image` tool draws and edits images locally,
  from words or up to four reference images, with the camera and look from `list_presets`. It never makes sexual
  content, and `no_real_person` is yours to set only when the references show no real person.
- If only **video models** are installed (LTX, Wan), make stills from video: direct a short shot that holds still
  (`motion: ["static"]`, `seconds: 2`, `quality: "final"`), review it, then take the sharpest frame from the finished
  file on the computer Hildegard runs on:

  ```sh
  ffmpeg -ss 1.0 -i take.mp4 -frames:v 1 -q:v 1 still.png
  ```

  Tell your user that's how the still was made and that it's limited to the video model's resolution (finals are
  1088 px high with LTX, 704 with Wan): fine for screens, small for print.

## 2. Direct before you generate

Write the brief (hildegard-craft, Gate 1) plus an **art direction** of five lines:

- **Idea:** the one thing it should say. A poster for a bakery's 50th year says "same bread, same hands".
- **Composition:** where the eye lands first, what's in the dark, the horizon line, how much empty space.
- **Palette:** three to five colours by name ("flour white, rye brown, oven red, slate"), or a palette preset.
- **Light:** source, direction, quality, time of day.
- **Material and mark:** what it should feel like it was made with (risograph, gouache, 16mm, linocut), described
  by qualities, never by a living artist's name.

## 3. A series, not a lottery

1. Write **three different prompts** that each answer the direction in a different way (a close detail, a wide
   scene, a symbolic still life). With Hildegard linked, lint each with `review_prompt`. Without it, check each
   against the slop catalogue (`references/slop.md`): no quality words ("8k", "masterpiece", "cinematic"), one idea,
   literal sentences, a concrete detail nobody would guess.
2. Render each as a draft with two takes.
3. Review every result (with Hildegard linked, `review_take`, or `hildegard review <file> --sheet` for stills).
   Without Hildegard, from your working folder (never `<folder>`), run `echo '{"path": "take-1.png", "sheet": "look-1.jpg"}' > spec.json` then
   `python3 -B <folder>/scripts/review_media.py spec.json` for the technical checks, and
   `python3 -B <folder>/scripts/contact_sheet.py sheet.png take-*.png --title "Round 1"` to put the takes side by side. Choose the
   one that says the idea most clearly, not the prettiest. Both scripts need Python packages: install them once with
   `python3 -m pip install pillow numpy av`. A still needs only Pillow and numpy for `review_media.py`, and only Pillow for `contact_sheet.py`. Without
   them, look at each image yourself against the critique questions and read its size with `ffprobe`.
4. Refine the chosen one: change one thing per round (the crop, the light, a detail), at most three rounds.

## 4. Critique, out loud

Before you show your user anything, answer in writing:

- What does the viewer see first, second, third? Is that the order the idea needs?
- What would a good human illustrator change? Do it, or say why not.
- What in it is a default the model chose for you (the glow, the centred subject, the generic face)? Replace it.
- Could this have been made for any client? If yes, it isn't finished: add something only this client has.

## 5. Finish

Generated images often need the finishing a designer would give them:

- Crop and straighten, then grade (the **hildegard-photo-edit** skill, if you have it: it is ImageMagick commands).
- **Type is added by hand, never generated.** Set titles in a real typeface with ImageMagick:

  ```sh
  magick art.png -gravity south -font "Source-Sans-3-Semibold" -pointsize 96 -fill "#F4EFE6" \
    -annotate +0+140 "FIFTY YEARS OF BREAD" poster.png
  ```

  Use a font your user has a license for (`magick -list font` shows installed ones). Keep text off faces and off
  the busiest part of the image; give it room.
- Export for where it goes (the hildegard-photo-edit skill, step 5: sRGB, the long side at 2048 px for the web).

## 6. Deliver

Give your user the file, the one-sentence idea, how it was made (model, still from video or not), and what you would
do next with more time. Never say a generated image is hand-made, and keep its AI label when it's published.

## Isometric mechanical and system illustrations

When asked for an isometric technical illustration or interactive explainer diagram, make **the physical object the
explanation** (a real instrument, rig, lock, plotter, valve manifold, or cabinet of drawers whose working IS the
concept, never floating labelled boxes or arrows). Before rendering, validate the geometry and density plan with
`python3 -B <folder>/scripts/check_design.py --iso iso.json --pre-render`. After rendering both themes and inspecting 4x close-ups
at junctions, run `python3 -B <folder>/scripts/check_design.py --iso iso.json` for full signoff (never set
`closeup_4x_checked: true` or populate `themes_checked` before rendering):

- **Camera (`azimuth_deg`, `elevation_deg`):** isometric azimuth in `35..60` deg (default `45`) and elevation in `20..50`
  deg (default `30`; higher up to `44` to look into an open vessel).
- **Four-tone directional shading (`tones`, `lit_count`):** distinct `"lo"` (base/feet), `"mid"` (structure), `"hi"`
  (subject), and exactly one `"lit"` focal accent (`"lit_count": 1`) so the eye goes straight to the moving part.
- **Density and mounting (`tier`, `parts`):** `"figure"` requires `>= 40` parts, `"hero"` `>= 80`, `"epic"` `>= 150`.
  Every part or part group must declare a non-empty `"host"` (what it sits on, starting from `"ground"` or `"base"`).
- **Geometry and visual audit:** verify painter's depth order (`"depth_sorted": true`), resolve every seam, tick, and
  texture line onto a stroke, dot, or outline (`"floating_line_ends": 0`), inspect 4x close-ups at every junction
  (`"closeup_4x_checked": true`), and verify both themes (`"themes_checked": ["dark", "light"]`).

Exact `check_design.py --iso` JSON shape (use ONLY these top-level keys; keep `parts` to 3 concise groups whose `count`
sums meet the tier: `figure` >= 40 e.g. 14+14+16=44, `hero` >= 80 e.g. 28+28+28=84, `epic` >= 150 e.g. 50+50+54=154):

```json
{
  "tier": "figure",
  "azimuth_deg": 45,
  "elevation_deg": 30,
  "tones": { "lo": "#2b2d30", "mid": "#5a5f66", "hi": "#c5cbd3", "lit": "#ffffff" },
  "lit_count": 1,
  "parts": [
    { "group": "base_plate", "host": "ground", "count": 14 },
    { "group": "frame_rails", "host": "base_plate", "count": 14 },
    { "group": "mechanism", "host": "frame_rails", "count": 16 }
  ],
  "depth_sorted": true,
  "floating_line_ends": 0,
  "closeup_4x_checked": true,
  "themes_checked": ["dark", "light"]
}
```


## Animated line-art SVG ink characters

When asked for an animated pen-and-ink SVG illustration or living scene component (walkers, runners, cyclists, day/night village cards), build mechanics first and verify the contract with `python3 -B <folder>/scripts/check_design.py --ink-anim ink.json --pre-render` before rendering and `python3 -B <folder>/scripts/check_design.py --ink-anim ink.json` after zoomed strip signoff:

- **Pen craft (`open_stroke_limbs`, `curved_lines`):** draw limbs as two open curved pen strokes with paper fill stopping short at the far end (never closed tubes), and bow every line slightly with rounded joints (never ruler-straight).
- **Planted-foot gait math (`gait`):** never animate walks with free-running sines (`"free_sine_walk": false`). Choose `"kind"` (`"walk"` or `"shuffle"` with `duty >= 0.5`, or `"run"` with `duty < 0.5`) and move the figure by exact `travel_speed = (stride / (duty * period_s)) * scale` so stance feet never slide.
- **Skeleton-first cloth (`skeleton_first_cloth`):** solve legs first even under a coat or kimono, then derive the hem and front/back edges from the forward knee and ankles; hang sleeves and bags on springs or pendulums.
- **Self-contained card and day/night tokens (`card_fixed_bg`, `palette_tokens`):** keep the scene as a self-contained card whose surrounding page background never shifts with time of day (`"card_fixed_bg": true`). Set `"ink": "currentColor"` and `"paper_class": ".pp"` so one palette swap retints day, sunset, and night cleanly.
- **Deterministic frame stepping (`debug_stepping`):** headless and background tabs throttle `requestAnimationFrame`. Expose `"query_flag": "?debug"` and `"step_fn": "window.__step"` advancing fixed `"dt_s"` (`<= 1/24`: `0.016667` for 60 fps, `0.033333` for 30 fps).
- **Post-render audit (`zoomed_strip_checked`, `day_cycle_checked`):** omit these when running `--pre-render`; set `"zoomed_strip_checked": true` only after inspecting zoomed 4x to 11x frame strips of every moving figure.

Exact `check_design.py --ink-anim` JSON shape (use ONLY these top-level keys):

```json
{
  "open_stroke_limbs": true,
  "curved_lines": true,
  "gait": {
    "kind": "walk",
    "stride": 18,
    "duty": 0.5,
    "period_s": 1.0,
    "scale": 1.0,
    "travel_speed": 36.0,
    "free_sine_walk": false
  },
  "skeleton_first_cloth": true,
  "card_fixed_bg": true,
  "palette_tokens": { "ink": "currentColor", "paper_class": ".pp" },
  "debug_stepping": { "query_flag": "?debug", "step_fn": "window.__step", "dt_s": 0.016667 },
  "zoomed_strip_checked": true,
  "day_cycle_checked": true
}
```

**Always recompute `gait.travel_speed` as a single plain decimal number (never copy `36.0`, never write operators or comments in JSON):**
- `duty` 0.5, `period_s` 1.0, `scale` 1.0: `travel_speed` is double the `stride`.
- `duty` 0.5, `period_s` 1.0, `scale` 0.5: `travel_speed` equals `stride` itself.
- `duty` 0.5, `period_s` 2.0, `scale` 1.0: `travel_speed` equals `stride` itself.
- `duty` 0.25, `period_s` 1.0, `scale` 1.0: `travel_speed` is four times the `stride`.
- Match the brief's exact `kind`, `stride`, `duty`, `period_s`, `scale`, and `dt_s`. Omit `zoomed_strip_checked` and `day_cycle_checked` on pre-render plans.

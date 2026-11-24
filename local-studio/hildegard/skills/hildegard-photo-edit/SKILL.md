---
name: hildegard-photo-edit
description: Use when asked to edit, fix, retouch, grade, crop, resize or animate a photo - tested Python tools (straighten, colour, crop, denoise, measure) and ImageMagick recipes for a professional result.
---

# Editing photos

## In Local Studio

The person's request is at the top of this message and after `</skill>`.

First run `python3 -B <folder>/scripts/fix.py <photo> out.jpg` with the flags the Fast path picks from the brief, then `python3 -B <folder>/scripts/measure.py out.jpg <photo>` and read each line. Never overwrite the original.

`<folder>` is the folder on the "References are relative to" line above. Run its scripts as `python3 -B <folder>/scripts/<name>.py`, and a script of yours that imports from `<folder>/scripts` as `python3 -B yours.py`: `-B` keeps Python from writing into the plugin, which would turn Hildegard's tools off until the person allows them again.

## FAST PATH: this skill is all you need

The scripts in this skill's `scripts/` folder do the measuring for you, so you never judge a tilt, a colour cast or a crop by eye.
Install once (Pillow and numpy; nothing else, no OpenCV): `python3 -m pip install pillow numpy`

```sh
# needs: python3 -m pip install pillow numpy
python3 -B <folder>/scripts/fix.py photo.jpg out.jpg --size 1600x900 --subject 0.5,0.45 --family h --max-bytes 400000
python3 -B <folder>/scripts/measure.py out.jpg photo.jpg
python3 -B <folder>/scripts/contact_sheet.py compare.png photo.jpg out.jpg       # then LOOK at compare.png
```

1. Work out from the brief: the exact size (or aspect), what the **subject** is and about where it sits, and whether the picture has a
   **horizon** (`--family h`) or **upright lines** such as a door, pole or building corner (`--family v`). Leave `--family` out when unsure.
2. Run `fix.py`. It straightens, crops, corrects colour, denoises and sharpens, in that order, and prints what it did.
3. Run `measure.py` on the result and read each line. Then look at the before and after sheet.
4. If something is off, **change one thing and run again**; never stack guesses. The flags: `--angle DEG` (the tilt, when `fix.py` said it
   could not measure it), `--wb none` or `--warmth +3` (the light should stay warm), `--exposure +0.5` or `-0.5` (stops), `--subject` (a better
   box), `--no-denoise` (the picture is clean and detailed), `--black none` (a silhouette or night scene should stay black).
5. Deliver `out.jpg` and say in a sentence what you changed and anything `fix.py` warned about. Never overwrite the original.

`fix.py` exit codes: 0 written; 2 refused (the subject cannot fit that shape: pick another aspect or give a smaller box); 1 error.

## Strict rules (for any model)

- **Never invent scenery.** No sky replacement, no gradient painted over a sky, no cloned or generated pixels, no added text, border or
  filter. These tools only turn, cut, multiply and curve the pixels the photo already has. A washed-out sky is brought back by lowering
  exposure, never by drawing a new one. The one exception is a plain background the brief asks for (Cut a product out, below).
- **No shell here, or your user runs the steps: don't hand over these script names.** They may not have this folder. Give the method as the
  ImageMagick or short Python in this file, whole, with the number each step must reach; name a script only as the shorter way.
- **Straighten by the measurement, never by eye.** `straighten.py` finds the tilt from the straight lines, turns the right way, and
  cuts to the largest rectangle with **no black wedges**. If it refuses ("not clear enough"), leave the photo as shot and say so, or give
  `--angle` only when a measurement (not a hunch) says what it is. A wrong turn makes a photo worse.
- **The crop must keep the subject named in the brief.** Pass it with `--subject`: two numbers are its centre, four are its box
  (left, top, right, bottom), as fractions (0 to 1) of the picture. `crop.py` never cuts that box and refuses if it cannot fit.
- **Correct colour from the picture, with limits.** `color.py` brings the light to neutral from the brightest unclipped pixels and holds back
  when those are strongly coloured (a red sign, a sunset sun). A warm evening photo should keep its warmth: if the report shows the
  picture was already warm on purpose, use `--wb none` or `--warmth +2`.
- **Sharpen last, once, under the noise ceiling.** `denoise_sharpen.py` measures noise before and after and never lets sharpening add
  more than 15 percent over the denoised picture. Halos along edges mean too much.
- **Exact size and file cap are part of the brief.** Use `--size WxH` and `--max-bytes N`; check the printed size.
- Work on copies in a new folder. Never touch your user's originals. Metadata, GPS included, is not copied into the output.
- If you have **hildegard-craft**, read it first (`references/slop.md` here is its slop catalogue). A good photo edit is mostly invisible:
  straight horizons, true colour, the eye going where it should. HDR glow, plastic skin, halos and crunchy saturation are photo slop.

## What each reading means

| `measure.py` line | Means | Fix |
| --- | --- | --- |
| tilt `+2.1` (counter-clockwise) | the horizon rises to the right by 2.1 degrees | `straighten.py` (or `fix.py`) |
| tilt unclear | no clear straight lines | leave it, or `--angle` from a real measurement |
| gray-world error over 0.2 | strong cast, or a scene that is one colour | `color.py --wb auto`; keep warm light with `--wb none` |
| mean luminance under 0.28 or over 0.65 | dark or bright | `color.py --exposure auto` |
| clipped highlights over 0.05 | blown | `color.py` lowers exposure (detail already lost stays lost) |
| clipped shadows over 0.08 | crushed | `color.py` opens the floor (`--black none` for silhouettes) |
| noise over 4 | grainy | `denoise_sharpen.py` |

## The scripts

Each is one file in `scripts/`, run with `--help` for every flag. They need Pillow and numpy
(`python3 -m pip install pillow numpy`), work on Windows, macOS and Linux, and print a plain message when a package is missing.

```sh
# needs: python3 -m pip install pillow numpy
python3 -B <folder>/scripts/straighten.py in.jpg level.jpg [--family h|v] [--angle DEG]     # prints "tilt found: -2.31 degrees ..."
python3 -B <folder>/scripts/color.py level.jpg graded.jpg [--wb auto|gray|white|none] [--exposure auto|+0.5] [--warmth +3]   # prints before and after
python3 -B <folder>/scripts/denoise_sharpen.py graded.jpg clean.jpg [--max-noise-increase 15]                              # prints noise in, denoised, out
python3 -B <folder>/scripts/crop.py clean.jpg final.jpg --aspect 4:5 --subject 0.6,0.4                                      # or --size 1080x1350; prints the crop box
python3 -B <folder>/scripts/measure.py final.jpg [reference.jpg]                                                           # tilt, cast, light, clipping, noise, SSIM
```

- `straighten.py`: an orientation-restricted Hough transform on the edge map. It prints the tilt, the lines it trusted and a confidence,
  and refuses below the confidence floor. A tilt under 0.6 degrees is left alone. Perspective (a building shot from below) is not tilt:
  when the horizontal and vertical lines disagree it refuses and asks you to name the family.
- `color.py`: white balance, exposure from the highlights (a dark picture goes up until its brightest 0.5 percent is just under white;
  blown ones come down), an opened shadow floor, and a gentle contrast curve only on a flat picture. No synthetic gradient, ever.
- `denoise_sharpen.py`: light non-local-means denoise, stronger on colour noise, then an unsharp mask on luma only with a soft threshold
  and a local limit against halos. It skips a clean photo.
- `crop.py`: the largest window of the shape, always holding the subject box with a margin, placed on a third (or the centre for a large
  subject) the way the picture already leans. With no `--subject` it guesses from a saliency map and says so: name the subject when you can.
- `measure.py`: numbers with a plain reading beside each. A reading is a hint (a sunset is meant to be warm), not a verdict.

## No Python: ImageMagick recipes

Commands are ImageMagick 7 (`magick`). With ImageMagick 6 write `convert`. Use these when Python is not available; they need the same
care: measure, change one thing, look. Check a result with `magick identify`, and by looking at it.

```sh
# Orientation and straighten (ANGLE: degrees to turn clockwise; read it from a measurement or a line you can see, not a guess)
magick in.jpg -auto-orient step1.jpg
ANGLE=2.1; W=$(magick step1.jpg -format %w info:); H=$(magick step1.jpg -format %h info:)
PCT=$(awk -v a=$ANGLE -v w=$W -v h=$H 'BEGIN{t=a*3.14159265/180; m=(w>h?w:h)/(w>h?h:w); printf "%.2f", 100/(cos(t)+m*sin(t))-0.5}')
magick step1.jpg -background black -rotate $ANGLE +repage -gravity center -crop ${PCT}%x${PCT}% +repage straight.jpg   # no black corners
# Crop to 4:5 around the subject's centre (CX,CY in pixels, read off the picture): the window is as tall as the picture, then slid sideways
W=$(magick straight.jpg -format %w info:); H=$(magick straight.jpg -format %h info:); CX=1500
CW=$(awk -v h=$H 'BEGIN{printf "%d", h*0.8}'); X=$(awk -v c=$CX -v w=$CW -v W=$W 'BEGIN{x=c-w/2; if(x<0)x=0; if(x>W-w)x=W-w; printf "%d", x}')
magick straight.jpg -crop ${CW}x${H}+${X}+0 +repage cropped.jpg              # check the subject is whole: look at it
# White balance from the picture: scale each channel so the means match (gray-world)
read R G B < <(magick in.jpg -format "%[fx:mean.r] %[fx:mean.g] %[fx:mean.b]" info:)
magick in.jpg -channel R -evaluate multiply $(awk -v a=$R -v b=$G -v c=$B 'BEGIN{m=(a+b+c)/3; print m/a}') \
  +channel -channel B -evaluate multiply $(awk -v a=$R -v b=$G -v c=$B 'BEGIN{m=(a+b+c)/3; print m/c}') +channel wb.jpg
# Exposure: pull the mean toward 0.45 (only when the picture is clearly dark or bright), never past clipping
G=$(magick wb.jpg -colorspace Gray -format "%[fx:log(mean)/log(0.45)]" info:); magick wb.jpg -gamma $G exposed.jpg
magick in.jpg -color-matrix "1.04 0 0  0 1 0  0 0 0.95" warmer.jpg           # nudge warmer (R up, B down) only for light that should be warm
magick in.jpg -level 3%,98%,1.05 leveled.jpg                                 # black point, white point, midtones
# Light denoise then sharpen (do not sharpen a noisy picture: halos and grit)
magick in.jpg -wavelet-denoise 2% -unsharp 0x0.75+0.5+0.02 sharp.jpg
```

Neutral greys (concrete, paper, a white shirt in shade) should read neutral unless the light is meant to be warm. Do not auto-level a night
scene or a misty one: its low contrast is the point. Turn saturation *down* more often than up: `magick in.jpg -modulate 100,88,100 out.jpg`.

## Look first

```sh
magick identify -verbose in.jpg | grep -E "Geometry|Colorspace|Quality|Orientation|icc:description"
python3 -B <folder>/scripts/measure.py in.jpg        # needs: python3 -m pip install pillow numpy
```

Note size, orientation and colour profile. Decide what the photo is *of* and what the edit is for (web, print, a start frame) before
touching it. Look at every result: with Hildegard installed, `hildegard review out.jpg --sheet look.jpg`; without it, from your working folder,
where spec.json and the sheet go, never `<folder>` (install the packages once with `python3 -m pip install pillow numpy av`; a photo needs only Pillow and numpy)
`echo '{"path": "out.jpg", "sheet": "look.jpg"}' > spec.json && python3 -B <folder>/scripts/review_media.py spec.json`. It prints each check (size,
highlights, shadows, contrast, colour) as pass, warn or fail. For before and after side by side, `python3 -B <folder>/scripts/contact_sheet.py compare.png in.jpg out.jpg`.

## Retouch, with restraint

- Remove temporary blemishes and dust; never change the shape of a face or a body, and never smooth skin to plastic.
- Small spots: a tiny local blur is enough:

```sh
magick in.jpg \( +clone -region 24x24+1310+842 -blur 0x3 \) -composite fixed.jpg
```

- Bigger repairs (a sign, a passer-by): say so to your user first. A documentary or news photo is never altered beyond exposure,
  colour and crop.

## Cut a product out onto white

Straighten and correct the colour first, cut out second: a cast is easier to see with the old background still there. This is the one
place pixels are replaced, and only because the brief asks for a plain background. Ask what changes the result (the shop's size, how much
of the frame the product fills, whether a soft shadow is allowed), or take square, 2000 px, 85 percent, no shadow, and say so.

1. **White balance from something grey, not from the product.** Auto white balance reads brown wood, brass or leather as a cast and drains
   it. Find paper, a white label, a steel sink or a plate's rim *under the same light* (a window's white edge is another light) and read it
   off. With nothing grey in the frame, use `color.py --wb none --warmth -3`, compare with the real object, and say the colour is judged.
2. **Cut on the full-size file.** `python3 -m pip install "rembg[cpu,cli]" pymatting`, then `rembg i -m birefnet-general graded.png cut.png`
   (the model downloads once, about 1 GB; `-m isnet-general-use` is smaller and softer at the edges). Look at the matte on magenta at 200
   percent: holes in pale wood grain, a missing rim, and the shadow kept as if it were the board are the usual faults. A hard product edge
   should be one to two pixels wide, so don't feather it more than half a pixel. Straight edges that wobble get a drawn mask instead.
3. **Take the old light out of the edge**, or a warm line rings the product: `estimate_foreground_ml` from pymatting on the edge pixels only.
4. **Put it on 255 and check every pixel**, never a few samples. Save the JPEG at 4:4:4, quality 92 or more, since 4:2:0 bleeds colour
   past the edge; then run the check on the JPEG, not on the PNG before it.

```python
# wb_patch.py in.jpg graded.png X Y W H     X Y W H: a patch that is really grey or white, in pixels
import io, sys, numpy as np
from PIL import Image, ImageCms, ImageOps
src, out, x, y, w, h = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7])
im = Image.open(src); icc = im.info.get("icc_profile"); im = ImageOps.exif_transpose(im).convert("RGB")
if icc: im = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.createProfile("sRGB"))   # phones shoot Display P3
a = np.asarray(im, float) / 255
lin = np.where(a <= .04045, a / 12.92, ((a + .055) / 1.055) ** 2.4)          # gains belong in linear light
patch = lin[y:y+h, x:x+w].reshape(-1, 3)
if patch.max() > .95 or patch.min() < .02: sys.exit("patch is clipped or black: pick another")
gain = patch.mean(0)[1] / patch.mean(0); lin = np.clip(lin * gain, 0, 1)     # green stays, red and blue move
srgb = np.where(lin <= .0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - .055)
print("gains R %.3f G 1 B %.3f" % (gain[0], gain[2]))
Image.fromarray((srgb * 255 + .5).astype("uint8")).save(out)
```

```python
# on_white.py graded.png cut.png out.jpg     composite, then read the JPEG back and judge it; exit 1 on a FIX
import sys, numpy as np
from PIL import Image
from pymatting import estimate_foreground_ml
rgb = np.asarray(Image.open(sys.argv[1]).convert("RGB"), float) / 255
al = np.asarray(Image.open(sys.argv[2]).split()[-1], float) / 255
edge = (al > 0) & (al < 1); fg = rgb.copy(); fg[edge] = estimate_foreground_ml(rgb, al)[edge]
comp = fg * al[..., None] + (1 - al[..., None])
Image.fromarray((np.clip(comp, 0, 1) * 255 + .5).astype("uint8")).save(sys.argv[3], quality=95, subsampling=0)
got = np.asarray(Image.open(sys.argv[3]).convert("RGB"), float); ok = True
def far(mask, n):                                                            # grow a mask by n pixels
    for _ in range(n):
        mask = mask | np.roll(mask, 1, 0) | np.roll(mask, -1, 0) | np.roll(mask, 1, 1) | np.roll(mask, -1, 1)
    return mask
def say(name, value, good):
    global ok; ok &= bool(good); print(f"{'OK ' if good else 'FIX'} {name}: {value}")
bg = ~far(al > .5, 8); inside = ~far(al < 1, 12)                             # 8 px from the product, smudges in the matte still count
say("background pixels under 255", int((got[bg].min(1) < 255).sum()), (got[bg] == 255).all())
say("product share of the frame", "%.0f%%" % (100 * (al > .5).mean()), .05 < (al > .5).mean() < .95)
fine = lambda im: np.diff(im.mean(2), axis=1)[inside[:, 1:]]   # pixel-to-pixel detail inside the product
kept = np.corrcoef(fine(got), fine(rgb * 255))[0, 1]; say("grain kept (smoothed or redrawn wood reads under 0.9)", "%.2f" % kept, kept > .9)
shift = np.abs(got[inside].mean(0) - rgb[inside].mean(0) * 255).max(); say("colour moved by the cutout", "%.1f of 255" % shift, shift < 2)
sys.exit(0 if ok else 1)
```

Resize after this check with Lanczos, sharpen once, and count the background again on the final file. Then look at it three ways: the edge at
200 percent on white and on black, the whole picture at phone size, and the wood beside the original. Say what no check can see: real
colour needs the real board next to a calibrated screen.

## People, buildings and print

The order: profile, lens, keystone, crop, overall light, each face, distractions, resize, sharpen. Anything that moves pixels comes before
anything painted on them.

- **A building leaning back is perspective, not tilt.** Read the ends of two upright edges and pull them 60 to 80 percent of the way to
  parallel; all the way stretches the people at the frame's edge and looks top-heavy. Measure after: the uprights as planned, and the
  outermost face's width over height changed by under 3 percent. Crop inside the empty corners, never fill them.
  `magick in.png -virtual-pixel black -distort Perspective "TLx,TLy TLx2,TLy  TRx,TRy TRx2,TRy  BLx,BLy BLx,BLy  BRx,BRy BRx,BRy" key.png`
- **A group is wider than tall**: nine people want 10x8, not 8x10; offer both when the brief says 8x10. No joint cut at the edge, no head
  within 5 percent of it.
- **Noon eyes**: overall shadows up a little (`color.py --exposure auto`, or a curve), then each face on its own. The socket over the cheek
  reads about 0.35 to 0.5 at noon; bring it to 0.6 to 0.75. At 1 it looks like a flash, and over one stop the noise shows.
- **A colour that steals the eye** is dulled, not removed: mask it by hue inside a drawn region (so no orange face or brick moves), take 60 to
  80 percent of its saturation and bring its brightness to the shirt beside it. Its cloth stays. Say it was done.
- **Print**: 8x10 at 300 ppi is 2400x3000; under 240 ppi say so before enlarging. Keep 0.25 inch (75 px) inside every edge for the trim.
  Labs want sRGB unless they send a profile; with one, soft-proof it. Prints come back darker than screens: middle tones up 5 to 8 percent,
  and a 4x6 test print first. Sharpen last at print size, a little past what looks right on screen.

```python
# faces.py in.png out.png  SOCKET CHEEK [SOCKET CHEEK ...]   each X,Y,W,H in pixels; lifts each socket toward its own cheek, exit 1 on a FIX
import sys, numpy as np
from PIL import Image, ImageFilter
a = np.asarray(Image.open(sys.argv[1]).convert("RGB"), float) / 255
lin = np.where(a <= .04045, a / 12.92, ((a + .055) / 1.055) ** 2.4); Y = lambda im: im @ [.2126, .7152, .0722]
box = [tuple(map(int, v.split(","))) for v in sys.argv[3:]]; ok = True
mean = lambda im, b: Y(im)[b[1]:b[1]+b[3], b[0]:b[0]+b[2]].mean()
for socket, cheek in zip(box[::2], box[1::2]):
    was = mean(lin, socket) / mean(lin, cheek); gain = min(.68 / was, 2) if was < .6 else 1          # one stop at most
    r = max(2, socket[3] // 4); m = np.zeros(Y(lin).shape)                                          # r: the feather, outside the socket
    m[max(0, socket[1]-r):socket[1]+socket[3]+r, max(0, socket[0]-r):socket[0]+socket[2]+r] = 255
    m = np.asarray(Image.fromarray(m.astype("uint8")).filter(ImageFilter.GaussianBlur(r / 2)), float)[..., None] / 255
    lin = np.clip(lin * (1 + (gain - 1) * m), 0, 1); now = mean(lin, socket) / mean(lin, cheek)
    good = .55 <= now <= .8; ok &= good; print("OK " if good else "FIX", socket, "socket over cheek %.2f to %.2f" % (was, now))
out = np.where(lin <= .0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - .055)
Image.fromarray((out * 255 + .5).astype("uint8")).save(sys.argv[2]); sys.exit(0 if ok else 1)
```

## Export

```sh
# For the web: sRGB, 2048 px long side, sharpened for the screen, GPS removed (a Pillow or scripts/ output has no metadata).
magick in.jpg -colorspace sRGB -resize "2048x2048>" -unsharp 0x0.75+0.6+0.02 -quality 88 \
  -define jpeg:sampling-factor=4:2:0 web.jpg
exiftool -gps:all= -overwrite_original web.jpg   # if exiftool is installed
# For print: full size, light sharpening, TIFF or maximum-quality JPEG.
magick in.jpg -unsharp 0x1+0.5+0.02 -quality 95 print.jpg
```

Keep enough pixels: 1080 px on the short side for the web, 3000+ for print. Crop to strengthen the subject (on a third, or centred for
symmetry), not to fill a format by habit.

## Change it with words (Hildegard)

To change a photo with words (a new sky, another colour, an object removed) rather than by hand: with Hildegard linked, its own
`make_image` tool edits up to four reference images locally. Set `no_real_person` only when the photo shows no real person; a real person
is drawn only as a character who has consented. It draws a new image from the photo, so use the tools above when the pixels must stay
exactly yours. Without Hildegard, use the image editor or model you have, with the same caution; the tools above need nothing else.

## Bring a photo to life (Hildegard)

A photo can be the first frame of a video shot: the camera starts on exactly that image. This needs a video model: with Hildegard
linked, the steps below; without it, hand your user the edited, cropped photo and one line saying what moves, for the video tool they have.

1. Edit the photo first (`fix.py`): its crop, light and colour become the shot's.
2. Crop to the shot's aspect (16:9, 9:16, 1:1, 4:3, 2.39:1) so nothing is squashed.
3. Follow **hildegard-film**: `direct_shot` with `start_frame_path` set to the edited file's absolute path, a prompt that describes the
   one thing that moves ("steam rises from the cup; her hand turns the page"), a subtle `motion` such as `dolly-in` at 0.3, and `takes: 2`.
   Review both with `review_take`.

Only animate photos of people who agreed to it. Never make someone appear to do or say what they didn't.

## Deliver

Run `measure.py` and the review on the export (`--final`, or `"final": true` in the spec, for the delivery bar), look at it at 100% and at
phone size, and tell your user what you changed. If you couldn't fix something (motion blur, focus missed, a tilt the lines could not
show), say so.

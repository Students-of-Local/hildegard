---
name: hildegard-video-edit
description: Cut clips into a reel with titles and music, edit or trim video, crossfades, grade, captions, reframe for vertical, mix sound and loudness with FFmpeg, checked with hildegard review.
---

# Editing video

## In Local Studio

The person's request is at the top of this message and after `</skill>`.

First run `python3 -B <folder>/scripts/cut_reel.py` as in the Fast path's step 4, with the person's clips, then `python3 -B <folder>/scripts/check_video.py out.mp4` with the brief's numbers. Every line must say OK.

`<folder>` is the folder on the "References are relative to" line above. Run its scripts as `python3 -B <folder>/scripts/<name>.py`, and a script of yours that imports from `<folder>/scripts` as `python3 -B yours.py`: `-B` keeps Python from writing into the plugin, which would turn Hildegard's tools off until the person allows them again.

## Fast path

A short film from long recordings (a screen, a talk, several cameras, an interview) starts at **section 8**, not here. When your user asks for a plan and commands to run on their own machine, the answer has to stand alone: plain FFmpeg, and each script you use pasted whole. They have none of the scripts in this folder, so name none of them.

This skill is all you need to cut clips into a finished piece with titles, a closing card and a music bed, and to check it. Don't write the filter graph by hand. Run `scripts/cut_reel.py` (Python 3, FFmpeg only), or, if you can deliver only one script, paste **Recipe D** and edit its first lines.

1. **Clean a voice recording:** `python3 -B <folder>/scripts/clean_voice.py in.wav out.wav --lufs -16` (the same script as in the **hildegard-sound** skill, whose SKILL.md also has it as a paste-in Recipe A).
2. **Music under speech:** `python3 -B <folder>/scripts/duck_mix.py voice.wav music.wav out.wav` (hildegard-sound's Recipe B is the paste-in version). With `--total` shorter than the voice it stops and says how many seconds over; it never cuts the voice. Raise `--total`, or add `--allow-overrun`.
3. **A radio spot:** `python3 -B <folder>/scripts/spot.py out.wav --music music.wav --sting sting.wav --lines a.wav b.wav c.wav --total 15` (hildegard-sound's Recipe C is the paste-in version). If the lines cannot fit `--total` it stops and says how many seconds over; it never cuts a line. Shorten the lines, raise `--total`, or add `--allow-overrun`.
4. **Cut clips into a reel with titles and music:**

```sh
python3 -B <folder>/scripts/cut_reel.py out.mp4 --size 1280x720 --fps 30 --fade 0.4 --total 25 \
  --clip clip_a.mp4@0.5-3.9 --clip clip_b.mp4@0.5-3.9 --clip clip_c.mp4@0.5-3.9 --clip clip_d.mp4@0.5-3.9 \
  --clip clip_a.mp4@6-9.4 --clip clip_b.mp4@5-8.4 --clip clip_c.mp4@3.5-6.9 --clip clip_d.mp4@4-7.4 \
  --music music.wav --lufs -16 --title "Hollis Creek Canoe Rental" --card "Open May to October - Rt 122, Hollis NH"
```

   `--clip FILE@IN-OUT` in seconds, in the order of the cut. Use every clip, and cut each one into two or more shots when the brief wants many cuts: a cut is a change of shot, so four clips used once make three. `--fade 0` gives hard cuts. A vertical clip sits whole over a blurred copy of itself, never stretched. `--total` trims the shots equally to an exact length. The title is a lower third near the start; the card is dark blue, never black.

### Check before you deliver

```sh
python3 -B <folder>/scripts/check_video.py out.mp4 --min 22 --max 28 --size 1280x720 --fps 30 --lufs -16 --cuts 5
```

Use the numbers from the brief. Every line must say `OK`: length in range, size and frame rate, H.264 and AAC, loudness within 1 LU of the target, true peak under -1 dBTP (`--peak` changes it), no black stretch over half a second, enough cuts (counted from the picture: crossfades count, motion inside one shot does not). Any `FIX` line says what to change; change it and run again. Then look at the picture: `python3 -B <folder>/scripts/contact_sheet.py sheet.png --video out.mp4 --every 2` (or, with Hildegard installed, `hildegard review out.mp4 --sheet sheet.jpg`), and read the titles on the sheet. With no Python, Recipe D prints the same checks at its end.

## Recipe D: cut clips into one piece (paste and edit)

Edit the lines up to `TMP=`: names, size, the `SHOTS` list (`"file in out"`), title, card text, music, target. Length = the sum of (out - in) + `CARDSECS` - `FADE` x the number of shots. Pick the points so it comes to the length you were asked for. It needs `ffmpeg`, `ffprobe`, `awk` and `sed`; the font comes from `fc-match`.

```bash
#!/usr/bin/env bash
# Cut clips into one piece: crossfades, a title, a closing card, a music bed at a loudness target. Edit the lines below, then run: bash edit.sh
# Length = sum of (out - in) + CARDSECS - FADE x (number of shots). Pick the in and out points so it comes to the length you were asked for.
set -euo pipefail
OUT=${OUT:-out.mp4}; W=1280; H=720; FPS=30; FADE=0.4; MUSIC=music.wav; TARGET=-16; PEAK=-1.5
TITLE="Hollis Creek Canoe Rental"; TITLE_AT=0.4; TITLE_SECS=3
CARD="Open May to October - Rt 122, Hollis NH"; CARDSECS=3      # a dark blue closing card, never black
SHOTS=("clip_a.mp4 0.5 3.9" "clip_b.mp4 0.5 3.9" "clip_c.mp4 0.5 3.9" "clip_d.mp4 0.5 3.9" "clip_a.mp4 6 9.4" "clip_b.mp4 5 8.4" "clip_c.mp4 3.5 6.9" "clip_d.mp4 4 7.4")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FONT=$(fc-match -f '%{file}' sans:bold 2>/dev/null || true)
for f in "$FONT" /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf "/System/Library/Fonts/Supplemental/Arial Bold.ttf" /Library/Fonts/Arial.ttf; do [ -f "$f" ] && { FONT=$f; break; }; done
N=${#SHOTS[@]}; IN=(); FC=""; DUR=()
# 1) every shot fitted to the frame (a clip of another shape sits whole over a blurred copy of itself, never stretched), same fps, joined with xfade
for i in $(seq 0 $((N-1))); do read -r F A B <<< "${SHOTS[$i]}"; D=$(awk -v a="$A" -v b="$B" 'BEGIN{print b-a}'); DUR+=("$D")
  IN+=(-ss "$A" -t "$D" -i "$F")
  FC="$FC[$i:v]fps=$FPS,split[b$i][f$i];[b$i]scale=$W:$H:force_original_aspect_ratio=increase,crop=$W:$H,boxblur=24:3[bg$i];[f$i]scale=$W:$H:force_original_aspect_ratio=decrease[fg$i];[bg$i][fg$i]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v$i];"
done
IN+=(-f lavfi -t "$CARDSECS" -i "color=c=0x16324f:s=${W}x${H}:r=$FPS"); FC="$FC[$N:v]format=yuv420p,setsar=1[v$N];"; DUR+=("$CARDSECS")
LAST=v0; ACC=${DUR[0]}
for i in $(seq 1 $N); do
  OFF=$(awk -v a="$ACC" -v f="$FADE" 'BEGIN{print a-f}')
  FC="$FC[$LAST][v$i]xfade=transition=fade:duration=$FADE:offset=$OFF[x$i];"; LAST="x$i"; ACC=$(awk -v o="$OFF" -v d="${DUR[$i]}" 'BEGIN{print o+d}')
done
LEN=$ACC
# 2) the title and the closing card text, burned in (text goes through files, so quotes and colons in it are safe)
printf '%s' "$TITLE" > "$TMP/t1.txt"; printf '%s' "$CARD" > "$TMP/t2.txt"
DT() { echo "drawtext=fontfile='$FONT':textfile='$1':fontcolor=white:fontsize=$2:x=(w-text_w)/2:y=$3:box=1:boxcolor=black@0.45:boxborderw=14:shadowcolor=black@0.6:shadowx=2:shadowy=2:enable='between(t,$4,$5)':alpha='min(1,(t-$4)/0.4)*min(1,($5-t)/0.4)'"; }
CS=$(awk -v l="$LEN" -v c="$CARDSECS" -v f="$FADE" 'BEGIN{print l-c+f+0.3}')
FC="$FC[$LAST]trim=duration=$LEN,setpts=PTS-STARTPTS,$(DT "$TMP/t1.txt" 54 'h*0.78' "$TITLE_AT" "$(awk -v a=$TITLE_AT -v s=$TITLE_SECS 'BEGIN{print a+s}')"),$(DT "$TMP/t2.txt" 40 '(h-text_h)/2' "$CS" "$(awk -v l=$LEN 'BEGIN{print l-0.2}')")[vout]"
ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -filter_complex "$FC" -map "[vout]" -r "$FPS" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -an "$TMP/silent.mp4"
# 3) the music bed: looped if short, cut to length, faded in and out, loudnorm in two passes
ffmpeg -hide_banner -loglevel error -y -stream_loop -1 -i "$MUSIC" -t "$LEN" -af "aformat=channel_layouts=stereo,afade=t=in:d=1,afade=t=out:st=$(awk -v l=$LEN 'BEGIN{print l-1.5}'):d=1.5" -ar 48000 -c:a pcm_f32le "$TMP/raw.wav"
M=$(ffmpeg -hide_banner -i "$TMP/raw.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
v() { printf '%s' "$M" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }
ffmpeg -hide_banner -loglevel error -y -i "$TMP/raw.wav" -af "loudnorm=I=$TARGET:TP=$PEAK:LRA=11:measured_I=$(v input_i):measured_TP=$(v input_tp):measured_LRA=$(v input_lra):measured_thresh=$(v input_thresh):offset=$(v target_offset):linear=true" -ar 48000 -c:a pcm_s16le "$TMP/bed.wav"
ffmpeg -hide_banner -loglevel error -y -i "$TMP/silent.mp4" -i "$TMP/bed.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -t "$LEN" -movflags +faststart "$OUT"
# 4) check: length, black frames over half a second, loudness. Fix and run again if any is off.
echo "length $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s"
ffmpeg -hide_banner -nostats -i "$OUT" -an -vf blackdetect=d=0.5:pix_th=0.1:pic_th=0.98 -f null - 2>&1 | grep black_start || echo "no black frames over half a second"
ffmpeg -hide_banner -nostats -i "$OUT" -vn -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | tail -2
```

If you have **hildegard-craft**, read it first (`references/slop.md` here is its slop catalogue). Editing is where
most slop is either made (transitions, filler, loud music) or removed. Your job is to make it shorter, clearer and
cleaner.

Work on copies. Never overwrite your user's originals; write to a new folder such as `edit/`. Every command below is
plain FFmpeg (any build from 5.0 up). Check a recipe's output and look at the sheet before moving on. With Hildegard
installed, that is `hildegard review <file> --sheet sheet.jpg`. Without Hildegard, it is
`python3 -B <folder>/scripts/contact_sheet.py sheet.png --video <file> --every 2` for the sheet, and for the technical checks
(exposure, frozen frames, flicker, colour, black frames, sound clipping; install the packages once with `python3 -m pip install pillow numpy av`; `check_video.py` and the sound scripts need none)
`echo '{"path": "<file>", "sheet": "sheet.jpg", "final": false, "film": true, "audio": true}' > spec.json` then
`python3 -B <folder>/scripts/review_media.py spec.json`.

## 0. Look first

```sh
ffprobe -v error -show_entries stream=codec_type,width,height,r_frame_rate,duration -of compact input.mp4
hildegard review input.mp4 --sheet input-sheet.jpg     # or: python3 -B <folder>/scripts/contact_sheet.py input-sheet.png --video input.mp4
```

Note the frame rate and size: everything you join must match them.

## 1. Cut

Cut on action (a hand moves, a head turns) or on a look; never in the middle of a word. Find times from the contact
sheet and by checking frames:

```sh
ffmpeg -ss 00:00:03.20 -i input.mp4 -frames:v 1 -q:v 2 check.jpg   # the frame at 3.2 s
```

Frame-accurate trim (re-encodes; `-ss` after `-i` for accuracy):

```sh
ffmpeg -i input.mp4 -ss 3.20 -to 7.85 -c:v libx264 -crf 17 -preset slow -c:a aac -b:a 192k cut.mp4
```

## 2. Assemble

Same size, frame rate and audio on every clip first. Keep the sound PCM until the last step: AAC parts leave a gap at every join.

```sh
ffmpeg -i clip.mp4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1" \
  -c:v libx264 -crf 14 -preset slow -c:a pcm_s16le -ar 48000 -ac 2 norm-1.mkv
```

In a shell loop that reads a list, every `ffmpeg` needs `-nostdin`, or it eats the rest of the list. Phone footage is often HDR
(`ffprobe -select_streams v -show_entries stream=color_transfer` says `arib-std-b67` or `smpte2084`); joined as it is, it looks gray. Convert it
first, before any scale or grade:

```sh
HDR="zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:param=0.6:peak=4.9:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
```

On test bars mobius put mid gray back where it started; hable, the usual copy, left it a third too dark.

(A clip without sound: add `-f lavfi -i anullsrc=r=48000:cl=stereo -shortest` as a second input.)

Join with straight cuts (the default; use it):

```sh
printf "file '%s'\n" norm-1.mkv norm-2.mkv norm-3.mkv > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy assembly.mkv
```

A dissolve only where time passes; half a second is plenty:

```sh
ffmpeg -i a.mp4 -i b.mp4 -filter_complex \
 "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=<A_LENGTH_MINUS_0.5>[v];[0:a][1:a]acrossfade=d=0.5[a]" \
 -map "[v]" -map "[a]" -c:v libx264 -crf 17 -c:a aac dissolve.mp4
```

No spins, glitches, flashes, zooms or wipes between shots. They are filler.

## 3. Grade

Grade toward what the brief asks, and usually *down*: generated footage is often oversaturated.

```sh
# Calm saturation, a touch more contrast, slightly warmer:
ffmpeg -i in.mp4 -vf "eq=saturation=0.85:contrast=1.05,colortemperature=temperature=6000" -c:a copy -crf 17 graded.mp4
# Lift the blacks for a softer, filmic print:
ffmpeg -i in.mp4 -vf "curves=all='0/0.04 0.5/0.5 1/0.97'" -c:a copy -crf 17 lifted.mp4
# A LUT, if your user has one:
ffmpeg -i in.mp4 -vf "lut3d=look.cube" -c:a copy -crf 17 lut.mp4
```

Match shots to each other: grade the most important shot first, then bring the others to it. Look at the contact
sheets side by side. The review's `colour` check failing means you pushed too far.

## 4. Steady, clean, sharp

```sh
# Stabilise handheld footage (two passes):
ffmpeg -i in.mp4 -vf vidstabdetect=shakiness=5:result=transforms.trf -f null -
ffmpeg -i in.mp4 -vf "vidstabtransform=input=transforms.trf:smoothing=20,unsharp=5:5:0.4" -c:a copy -crf 17 steady.mp4
# Flicker in generated footage (mild):
ffmpeg -i in.mp4 -vf deflicker=size=5 -c:a copy -crf 17 deflickered.mp4
# Noise, gently:
ffmpeg -i in.mp4 -vf hqdn3d=2:1:3:3 -c:a copy -crf 17 clean.mp4
```

Sharpen only a little (`cas=0.3` or `unsharp=5:5:0.4`). Halos are slop.

## 5. Reframe for vertical (9:16)

Don't squash; crop around the subject. Find where the subject is on the contact sheet (as a fraction of the width,
0 = left), then:

```sh
# Subject at about 40% across a 1920x1080 frame:
ffmpeg -i in.mp4 -vf "crop=ih*9/16:ih:(iw*0.40)-(ih*9/16)/2:0,scale=1080:1920" -c:a copy -crf 17 vertical.mp4
```

Clamp the x offset to between 0 and `iw-ih*9/16`. If the subject moves across the frame, cut it into parts with
different offsets rather than letting the subject leave the frame.

## 6. Captions

Write captions as SRT: at most two lines, about 42 characters a line (about 28 on a vertical video, or each line wraps
into two), on screen at least 1 second, broken at natural pauses. Then burn them in with a plain, readable style:

```sh
# Any 16:9 video. Keep the numbers as written: libass scales from PlayRes to the frame. Without PlayRes it uses a 288-line canvas.
ffmpeg -i in.mp4 -vf "subtitles=captions.srt:force_style='PlayResX=1920,PlayResY=1080,FontName=Source Sans 3,FontSize=56,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=4,Shadow=0,MarginV=90,MarginL=100,MarginR=100'" \
  -c:a copy -crf 17 captioned.mp4
# Any 9:16 video: higher, and off the right edge, so the app's own buttons and caption don't cover it
ffmpeg -i in.mp4 -vf "subtitles=captions.srt:force_style='PlayResX=1080,PlayResY=1920,FontName=Source Sans 3,FontSize=64,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=4,Shadow=0,MarginV=420,MarginL=80,MarginR=140'" \
  -c:a copy -crf 17 captioned-vertical.mp4
```

For another shape, set PlayRes to the video's size and scale the font size, outline and margins to match. Look at one
captioned frame at phone size before you call it done:
`ffmpeg -ss <time> -i captioned-vertical.mp4 -frames:v 1 -vf scale=420:-1 caption-check.png`. Check the words against the audio; a wrong caption is worse than none. With Hildegard linked, `transcribe` gives the words with
timings. Without Hildegard, if you can't transcribe the audio, ask your user for the script.

## 7. Sound

- **Fades at every audio cut** (5 to 20 ms) so nothing clicks: `afade=t=in:d=0.01,afade=t=out:st=<END-0.01>:d=0.01`.
- **Music under speech:** don't hand-write a sidechain graph. Use `scripts/duck_mix.py` (or Recipe B of the hildegard-sound skill). It
  drops the music 16 dB while the voice speaks and brings it back in pauses. (If you do write `sidechaincompress` yourself, split the
  voice with `asplit` first: a label can feed only one filter.)

- **Master the loudness last**, two passes, to about -14 LUFS with peaks under -1 dB:

```sh
ffmpeg -i mixed.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2> loud.txt
# The JSON at the end of loud.txt has input_i, input_tp, input_lra, input_thresh and target_offset. Put them in:
ffmpeg -i mixed.mp4 -af "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=<input_i>:measured_TP=<input_tp>:measured_LRA=<input_lra>:measured_thresh=<input_thresh>:offset=<target_offset>:linear=true" \
  -c:v copy -c:a aac -b:a 192k -ar 48000 master.mp4
```

Use -16 LUFS for speech-only pieces and podcasts. Print the second pass's JSON too: `"normalization_type": "dynamic"` means it could not reach
the target without pumping (a quiet mic with loud peaks). Then put `acompressor=threshold=-24dB:ratio=3:attack=5:release=120,alimiter=limit=0.8` first, and measure again.

## 8. A short film from long recordings

Ask for the one sentence a viewer should leave with: it picks the hook and which minutes survive. Say what was assumed and go on.

Write one line per span in `spans.txt` (`file in out [filter]`, seconds) and render with this. It snaps every cut to a whole frame, keeps the
sound PCM, and fails when frames are missing or picture and sound end apart:

```bash
#!/usr/bin/env bash
# Join spans of one or more recordings. spans.txt: file in out [filter for this span], one per line. Edit the settings.
set -euo pipefail
OUT=${OUT:-assembly.mkv}; FPS=${FPS:-30}; FIT=${FIT:-scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:-1:-1}
P=$(mktemp -d parts.XXXX); n=0
while read -r f a b vf; do
  n=$((n+1)); p=$(printf "$P/%03d.mkv" $n)
  read -r s d o < <(awk -v a="$a" -v b="$b" -v r="$FPS" 'BEGIN{x=int(a*r+.5); y=int(b*r+.5); printf "%.6f %.6f %.6f\n", x/r, (y-x)/r, (y-x)/r-.01}')   # whole frames
  ffmpeg -nostdin -v error -y -ss "$s" -t "$d" -i "$f" -vf "${vf:+$vf,}$FIT,fps=$FPS,setsar=1,format=yuv420p" \
    -af "aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo,afade=t=in:d=0.01,afade=t=out:st=$o:d=0.01,apad" \
    -t "$d" -c:v libx264 -crf 10 -preset fast -c:a pcm_s16le "$p"
  echo "file '$p'" >> "$P.txt"
done < spans.txt
ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$P.txt" -c copy "$OUT"     # PCM sound: AAC parts leave a gap at every join
v=$(ffprobe -v error -count_packets -select_streams v -show_entries stream=nb_read_packets -of csv=p=0 "$OUT" | tr -d ,)
a=$(ffmpeg -nostdin -v error -i "$OUT" -map 0:a -f s16le -ac 1 -ar 48000 - | wc -c)
w=$(awk -v r="$FPS" '{t+=int($3*r+.5)-int($2*r+.5)} END{print t}' spans.txt)
awk -v v="$v" -v a="$a" -v r="$FPS" -v w="$w" 'BEGIN{d=v/r-a/96000; if(d<0)d=-d; bad=(v!=w || d>1/r); printf "%s frames %d of %d, picture and sound end %.0f ms apart\n", bad?"FIX":"OK", v, w, d*1000; exit bad}'
```

Show your user the list (start, end, words, why it stays) before rendering: that is the cheap place to change the film. Then, whatever the film:

1. **Cut from the words.** Transcribe with word times (`faster-whisper` with `word_timestamps=True`, or Hildegard's `transcribe`) to `words.json`
   (`[{"w": "word,", "s": 1.23, "e": 1.60}]`), fix names by ear, cut 0.15 s outside the word edges. A cut that changes what someone meant is out.
2. **Captions come from the finished cut**, not the source, so their times are right: transcribe it again, fix the words, build the SRT with
   this, burn it with section 6.

```python
# python3 cap.py cut_words.json > captions.srt: lines of 3 to 6 words, broken at pauses and punctuation, at least 1 s on screen
import sys, json
W, L = json.load(open(sys.argv[1])), [[]]
for k, w in enumerate(W):
    L[-1].append(w); nxt = W[k+1]["s"] if k + 1 < len(W) else 1e9
    if len(L[-1]) >= 6 or sum(len(x["w"]) + 1 for x in L[-1]) > 24 or nxt - w["e"] > .5 or (w["w"][-1] in ".?!,;:" and len(L[-1]) > 2): L.append([])
L = [l for l in L if l]; T = lambda t: (lambda m: "%02d:%02d:%02d,%03d" % (m//3600000, m//60000 % 60, m//1000 % 60, m % 1000))(round(t*1000))
for n, l in enumerate(L, 1):
    end = max(l[-1]["e"] + .2, l[0]["s"] + 1); end = min(end, L[n][0]["s"]) if n < len(L) else end
    print(n, f"{T(l[0]['s'])} --> {T(end)}", " ".join(w["w"] for w in l), "", sep="\n")
```

### A screen recording to a vertical clip

Ask for the one sentence a viewer should leave with: it picks the hook and which minutes survive. List 5 to 7 spans, the strongest line first,
the result last. Waiting (a build, a search) goes, or is
rendered first at 4x (`setpts=PTS/4`, no sound) as a file of its own and listed as a span like any other.

1. **Choose the crop by letter height.** A 1440p screen squeezed to 1080 wide can't be read on a phone. Per span, crop the part being
   talked about and enlarge it: small letters (an x) need 18 px or more in the delivered frame. Crop width = 1080 x (source x height) / 18 at
   most, so text 11 px tall allows a 660 px window. When the action is wider than that, stack two windows, or re-show the line as text.
   Screen in the top 1080 x 1350, captions on the plain band under it, so they never cover code.
2. **Take the fan out with a sample of the fan.** Find a pause with `silencedetect`, then hand that second to `afftdn`:
   `highpass=f=80,asendcmd=c='2.8 afftdn sn start; 3.8 afftdn sn stop',afftdn=nr=18:nf=-40`. It only knows the noise from then on, so use a
   pause before the first span, or prepend it and trim. On a test recording this took a pause from 20 to 39 dB under the voice; `afftdn=tn=1`
   alone, which guesses, reached 24. Over `nr=20` voices go watery: listen. Then loudness (section 7), never before.

Checks that can fail, run on the delivered file:

```sh
F=clip.mp4
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration -of default=nw=1 $F
D=$(mktemp -d); ffmpeg -nostdin -v error -y -i $F -vf fps=1 $D/%03d.png                        # one frame a second
for p in $D/*.png; do                                                                        # letters: words with no tall letters, median px
  tesseract $p - --psm 6 tsv 2>/dev/null | awk -F'\t' '$11>60 && $12 ~ /^[acemnorsuvwxz]+$/ {print $10}' | sort -n |
  awk -v p=${p##*/} '{a[NR]=$1} END{if(NR) print p, a[int((NR+1)/2)]}'; done > $D.txt
awk '$2<18{print "FIX", $1, "letters", $2, "px"; b=1} END{if(!NR) print "FIX no text read in any frame: unchecked, look"; else if(!b) print "OK letters, frames read:", NR}' $D.txt
for p in $D/*.png; do tesseract $p - --psm 6 2>/dev/null |                                    # secrets: names the second, never prints the text
  grep -Eqi 'sk-|ghp_|AKIA|api.?key|secret|token|passw|PRIVATE KEY|[a-z0-9._]+@[a-z0-9-]+\.[a-z]{2,}|/(home|Users)/[a-z]+' && echo "LOOK second $p"; done
pause() { ffmpeg -hide_banner -ss $2 -t $3 -i $1 -af astats -f null - 2>&1 | awk '/Overall/{o=1} o&&/RMS level dB/{print $NF; exit}'; }
echo "pause $(pause $F 12.4 0.6) dB, voice $(pause $F 13.2 1.5) dB"                           # 30 dB or more apart; use your own times
```

Then four by eye and ear: a sheet with a frame at 0.5 s, 3 s, every splice and the end (the hook reads with the sound off, no crop cuts a line
of code); re-transcribe and compare with the captions (two words in a hundred off, and no name wrong); each burned caption against its
line; once through on headphones. OCR misses small or blurred text, so the secrets pass finds leaks and never proves there are none: look
at every span that shows a terminal, a `.env`, mail or a notification, and cut or cover it.

### Several cameras, not synced

1. Pick the one with the best sound as the main clock and use its sound all the way through, so a camera change is never heard. Find the
   others on it with this; it fails on a track that does not match, and shows drift (phones drift 20 to 100 ppm, 30 to 150 ms over 25 minutes):

```python
# python3 sync.py main.mp4 cam2.mp4 cam3.mp4: where each file starts on the main file's clock, and its drift. Needs ffmpeg and numpy.
import subprocess, sys, numpy as np
R = 8000
def load(p): return np.frombuffer(subprocess.run(["ffmpeg","-nostdin","-v","error","-i",p,"-vn","-ac","1","-ar",str(R),"-f","f32le","-"], stdout=subprocess.PIPE, check=True).stdout, np.float32)
def lag(a, b):                                    # GCC-PHAT: lag of b in a, and the peak over the best rival
    n = 1 << int(np.ceil(np.log2(len(a) + len(b)))); X = np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n))
    c = np.fft.irfft(X / (np.abs(X) + 1e-9), n); k = int(c.argmax()); top = c[k]; c[max(0, k - R//10):k + R//10] = 0
    return (k if k < len(a) else k - n) / R, top / c.max()
main, bad = load(sys.argv[1]), 0
for p in sys.argv[2:]:
    x = load(p); got = []; win = min(60, len(x)/R/3)
    for t in np.linspace(0, len(x)/R - win, 9):
        o, q = lag(main, x[int(t*R):int((t + win)*R)])
        if q > 1.6: got.append((t, o - t))
    if len(got) < 4: print("FIX", p, "matched in", len(got), "of 9 places: sync it by a clap or a word"); bad = 1; continue
    t, s = np.array(got).T
    keep = abs(s - np.median(s)) < .5; m, b = np.polyfit(t[keep], s[keep], 1); err = abs(s[keep] - (m*t[keep] + b)).max()*1000
    ok = keep.sum() >= 4 and err < 20; bad |= not ok
    print("OK " if ok else "FIX", p, f"starts {b:+.3f} s on the main clock, drift {m*1e6:+.0f} ppm ({m*1.5e6:+.0f} ms over 25 min), worst error {err:.0f} ms, {keep.sum()} of 9 places")
sys.exit(bad)
```

2. In `spans.txt` a shot from another camera at main time `t` is `(t - start) / (1 + drift x 0.000001)` on its own clock. Under 20 ppm, forget the drift.
   One `spans.txt` per scene, then one unbroken piece of the main sound under it, scenes joined on a breath or under music:
   `ffmpeg -nostdin -i assembly.mkv -ss SCENE_IN -t SCENE_LENGTH -i main.mov -map 0:v -map 1:a -c:v copy -c:a pcm_s16le -ar 48000 -ac 2 scene1.mkv`.
3. Convert HDR (section 2) before matching color. A portrait shot: crop to 16:9 when it is 4K and the faces allow it, else whole over a blurred copy.
   Grade the others to the main camera by a white shirt or wall they share.
4. People come to see one person. List everyone with a time in and out, give each about the same seconds and the same moment (the name, the
   water, the face coming up, the hug), and the same size of name card. Names come from your user, spelled by them. Children or anyone
   who asked not to be filmed: ask before the edit.
5. Music only under the opening, the turnover and the close; the words, the water and the applause stay. Ask which song they may use.

Check: the sync script on each scene against the main file (`OK`, and the start you meant); the picture of every other camera against the
sound at one hard moment (a splash, a clap); a frame either side of every camera change; a table of person, seconds, name card, and fail if anyone is missing or has under half the median.

### An interview, without putting words in someone's mouth

1. Spans stay in tape order, start and end on whole sentences, and keep the not, the if and the maybe. No cut inside a sentence to make it
   tidier, no answer under another question. Where time jumps, show it: a black second, a photo, or a card with the question.
2. Look at both channels (`astats`): one lav is often on the left only. `pan=mono|c0=c0` before anything else. `highpass=f=80`, then a gentle
   `afftdn` from a sampled pause if there is hiss.
3. **A clock tick stays.** Measured on a tick 26 dB down: `afftdn` took 4 dB, `adeclick` 1 to 2, a gate 14 but only in pauses, where its coming
   and going is worse than the clock. Join in pauses, and slide the in-point inside its pause so the next tick comes on the beat. No
   looped room tone under it: that doubles the ticks. If your user wants it gone, say what it costs.
4. `FPS=24 FIT=scale=1920:1080` for the span script, loudness -16, no music under the voice.

Checks: this must print no `FIX`, and each `LOOK` is heard with the minute around it; run it again on the delivered film's transcript. The
beat: `ffmpeg -ss JOIN-3 -t 6 -i film.wav -lavfi "highpass=f=2000,highpass=f=2000,showwavespic=s=1200x160:scale=sqrt" -frames:v 1 join.png`
shows ticks evenly spaced or not. Last, someone in the family who knows the story watches it before anyone else does.

```python
# python3 meaning.py words.json spans.txt [cut_words.json]: what the cut does to what was said. words.json: [{"w": "word,", "s": 1.23, "e": 1.60}, ...]
import sys, json, re, difflib
W = json.load(open(sys.argv[1])); S = [list(map(float, l.split()[1:3])) for l in open(sys.argv[2]) if l.strip()]; bad, kept = 0, []
txt = lambda i, j: " ".join(w["w"] for w in W[max(0, i):max(0, j)]); END = re.compile(r"[.?!][\"')]*$")
HEDGE = re.compile(r"n't\b|\b(not|no|never|if|unless|maybe|think|guess|probably|sometimes|only|almost|suppose|joking)\b", re.I)
for n, (a, b) in enumerate(S, 1):
    I = [k for k, w in enumerate(W) if w["s"] > a - .05 and w["e"] < b + .05]; fix, look = [], []
    if not I: print("FIX span", n, "holds no whole word"); bad = 1; continue
    i, j = I[0], I[-1] + 1; kept += W[i:j]
    if any(w["s"] < t - .02 and w["e"] > t + .02 for w in W for t in (a, b)): fix.append("cuts through a word")
    if i and not END.search(W[i-1]["w"]): fix.append("starts inside a sentence")
    if not END.search(W[j-1]["w"]): fix.append("ends inside a sentence")
    if n > 1 and a < S[n-2][1]: fix.append("is earlier on the tape than the span before it")
    if re.match(r"(but|unless|if|only|except|although|though|actually|well|no|not|maybe)\b", txt(j, j + 1), re.I): look.append("the next sentence takes it back or limits it")
    if re.match(r"(and|but|so|because|he|she|it|they|that|this|yes|no|yeah)\b", W[i]["w"], re.I): look.append("leans on what came before (who? which question?)")
    bad |= bool(fix); print(f"\nspan {n}: [{txt(i-12, i)}] {txt(i, j)} [{txt(j, j+12)}]", *["\n  FIX " + f for f in fix], *["\n  LOOK " + l for l in look], sep="")
if len(sys.argv) > 3:                                           # the delivered film, transcribed again, against the words you chose
    norm = lambda L: [re.sub(r"[^a-z0-9']", "", w["w"].lower()) for w in L]; A, B = norm(kept), norm(json.load(open(sys.argv[3])))
    d = [(A[p:q], B[r:s]) for t, p, q, r, s in difflib.SequenceMatcher(None, A, B, autojunk=False).get_opcodes() if t != "equal"]
    n = sum(max(len(p), len(q)) for p, q in d); hot = [x for x in d if HEDGE.search(" ".join(x[0] + x[1]))]
    bad |= n > .03*len(A) or bool(hot); print("\nFIX" if n > .03*len(A) or hot else "\nOK", f"{n} of {len(A)} words differ", *d[:20], *(["a not, if or maybe changed"] if hot else []))
sys.exit(bad)
```

## 9. Deliver

```sh
ffmpeg -i master.mp4 -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k final.mp4
hildegard review final.mp4 --final --film --audio --sheet final-sheet.jpg   # Hildegard installed
python3 -B <folder>/scripts/check_video.py final.mp4 --lufs -14 --size 1920x1080         # without Hildegard; then the sheet and spec.json checks above, with "final": true
```

Look at the sheet and listen through once. Then tell your user the path, the length, what you cut and why, and
anything you couldn't fix. Keep Hildegard's "made with" label in the file's metadata when the footage is generated.

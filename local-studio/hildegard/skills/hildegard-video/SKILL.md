---
name: hildegard-video
description: Render a short video shot on the person's own GPU with Hildegard, wait for it, check it, and give back the file and its contact sheet. Use when someone asks for a video, a clip, a shot, an animation of a scene, or to animate an image.
---

# Render a video shot with Hildegard

The person's request is the text after `</skill>` at the end of this message.

1. Write one prompt that says what happens, in order: who, what they do, where. One action is
   best for one shot. Leave camera words and quality words like "cinematic" or "4k" out of it.
   Only made-up people, and nothing sexual.
2. Pick one camera move. Without one the camera stands still and the clip looks like a photo.
   - `dolly-in`: closer to a face, a hand or a detail that matters
   - `pull-back-reveal`: show where they are
   - `truck-right`: alongside someone walking or something moving past
   - `arc-left`: around a person or an object
   - `crane-up`: rise above a place
   - `follow`: behind someone walking
   - `pan-reveal`: across a landscape or a room
   - `handheld`: close and raw, in the middle of the action
   - `static`: only when stillness is the point
   If none fits, use `dolly-in`.
3. Call the bash tool now with this command. Put your prompt between the quotes and your move
   after `--move`, and change nothing else. You need nothing more: no image, no file, no other
   command first.

       hildegard make video "<your prompt>" --move <move> --quality draft

   It waits until the video is rendered and checked, which takes minutes. Run it in the
   foreground. If you set a timeout, use 3600 seconds.
4. Read the output. `Video: <path>` is the file. `Contact sheet to look at:` is a picture of
   nine frames. `Review passed` means the checks passed. The last line starts with NEXT: do
   what it says.
5. If the review FAILED, change one thing, the prompt or the move, and run it again. After
   three tries, tell the person what is still wrong.
6. Answer with the video path, the contact sheet path, and one sentence on what happens.

Only if the person asked for it, add one of these to the command: `--seconds 8` for a longer
clip, `--aspect 9:16` for a vertical one, `--from <image file>` with an image file the person
named, or `--quality final` for the take they picked.

If bash says `hildegard: command not found`, tell the person to install Hildegard from
https://dbaney.com/hildegard/ and stop. Never install it yourself. If it says the video model
isn't installed, give the person the `hildegard models install` command it shows: only they may
accept a model's license.

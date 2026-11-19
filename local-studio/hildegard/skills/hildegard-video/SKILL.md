---
name: hildegard-video
description: Render a short video shot on the person's own GPU with Hildegard, wait for it, check it, and give back the file and its contact sheet. Use when someone asks for a video, a clip, a shot, an animation of a scene, or to animate an image.
---

# Render a video shot with Hildegard

The person's request is the text after `</skill>` at the end of this message.

1. Write one prompt that says what happens, in order: who, what they do, where. One action is
   best for one shot. Leave camera words and quality words like "cinematic" or "4k" out of it.
   No real people, and nothing sexual: Hildegard refuses both.
2. Run one command with the bash tool, in the foreground:

       hildegard make video "<your prompt>"

   Add `--seconds 5` for the length, `--aspect 9:16` for a vertical clip, and
   `--from <image path>` to start from an image (for example one `hildegard make image` made).
   Use `--quality draft` first; use `--quality final` only for the take the person picked.
   It waits until the video is rendered and checked. That takes minutes. Do not run it in the
   background and do not set a short timeout (if you must set one, use 3600 seconds).
3. Read the output. `Video: <path>` is the file. `Contact sheet to look at:` is a picture of
   nine frames. `Review passed` means the checks passed. The last line starts with NEXT: do
   what it says.
4. If the review FAILED, change one thing in the prompt and run it again. After three tries,
   tell the person what is still wrong.
5. Answer with the video path, the contact sheet path, and one sentence on what happens.

If bash says `hildegard: command not found`, tell the person to install Hildegard from
https://dbaney.com/hildegard/ and stop. Never install it yourself. If it says the video model
isn't installed, give the person the `hildegard models install` command it shows: only they may
accept a model's license.

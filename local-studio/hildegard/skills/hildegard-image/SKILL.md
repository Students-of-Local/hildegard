---
name: hildegard-image
description: Draw an image on the person's own GPU with Hildegard, wait for it, check it, and give back the file path. Use when someone asks for an image, a picture, a still, an illustration, a poster image or concept art.
---

# Draw an image with Hildegard

The person's request is the text after `</skill>` at the end of this message.

1. Write one prompt in plain, concrete words: who or what, doing what, where, in what light.
   Leave out quality words like "8k", "masterpiece" or "highly detailed". No real people, and
   nothing sexual: Hildegard refuses both.
2. Run one command with the bash tool, in the foreground:

       hildegard make image "<your prompt>"

   Add `--aspect 16:9` (or 9:16, 4:3, 2.39:1) if the person asked for a shape, and
   `--quality draft` for a quick look. It waits until the image is drawn and checked, which
   can take a minute or two. Do not run it in the background and do not set a short timeout.
3. Read the output. `Image: <path>` is the file. `Review passed` means the checks passed.
   The last line starts with NEXT: do what it says.
4. If the review FAILED, change the prompt once and run the command again. After three tries,
   tell the person what is still wrong.
5. Answer with the file path and one sentence on what the image shows.

If bash says `hildegard: command not found`, tell the person to install Hildegard from
https://dbaney.com/hildegard/ and stop. Never install it yourself. If it says Hildegard isn't
reachable, tell the person to run `hildegard start` and stop.

Never clone or imitate a real person's voice or face. If the person asks for that, tell them
cloning happens only in the Hildegard Studio, with that person's own consent.

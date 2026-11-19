---
name: hildegard-clean
description: Clean a voice recording with Hildegard (hum, rumble, clicks and noise down, level evened, loudness set) and give back the cleaned file and its check. Use when someone asks to clean, fix, denoise or level a recording, a voice memo, a podcast take or a voiceover.
---

# Clean a recording with Hildegard

The person's request is the text after `</skill>` at the end of this message. It names a
recording: a WAV, MP3, M4A, OGG, FLAC, WebM or MP4 file.

1. Find the file. If you can't, ask the person for its path.
2. Run one command with the bash tool, in the foreground:

       hildegard make clean "<path to the recording>"

   Add `--lufs -14` for a louder target (the default is -16 LUFS, right for speech). It waits
   until the cleaned copy is made and checked. The original is never changed.
3. Read the output. `Cleaned: <path>` is the new file, with its loudness and true peak. The
   last line starts with NEXT: do what it says.
4. Answer with the cleaned file's path and its loudness.

If bash says `hildegard: command not found`, tell the person to install Hildegard from
https://dbaney.com/hildegard/ and stop. Never install it yourself.

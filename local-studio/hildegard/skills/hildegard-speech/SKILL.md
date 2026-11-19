---
name: hildegard-speech
description: Turn a script into speech on the person's own GPU with Hildegard, in a voice from their library, and give back the audio file. Use when someone asks to read a script aloud, make a voiceover, narration or spoken audio.
---

# Speak a script with Hildegard

The person's request is the text after `</skill>` at the end of this message.

1. Run `hildegard make voices` with the bash tool. It lists the voices you may use. Pick the
   one the person named, or the one that fits the script.
2. Run this command with the bash tool, in the foreground. The word after `make` is
   `speech`; change only the words in quotes or angle brackets:

       hildegard make speech "<the script>" --voice <voice id>

   Separate paragraphs with a blank line. Add `--direction "warm, close to the mic"` for how
   to read it. It waits until the audio is made and checked.
3. Read the output. `Audio: <path>` is the file. The last line starts with NEXT: do what it
   says.
4. Answer with the audio path.

## Cloning is not yours to do

You can never clone a voice, and you must not try. If the person wants their own voice or
someone else's, tell them: open Voice › Clone in the Hildegard Studio. The person whose voice
it is reads a fresh consent line aloud there, and Hildegard checks it is really them. Once that
voice is in the library, `hildegard make voices` lists it and you may speak in it.

If bash says `hildegard: command not found`, tell the person to install Hildegard from
https://dbaney.com/hildegard/ and stop. Never install it yourself.

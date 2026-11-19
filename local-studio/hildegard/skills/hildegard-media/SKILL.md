---
name: hildegard-media
description: Make media on the person's own GPU with Hildegard, choosing the right hildegard make command for the request: images, video, speech, designed voices or a cleaned recording. Use when someone asks Hildegard for media and the kind isn't clear, or asks what Hildegard can make.
---

# Make media with Hildegard

The person's request is the text after `</skill>` at the end of this message.

Hildegard is the person's own studio. It runs on their GPU, nothing leaves their computers,
and every command below waits until the work is done, checks it, and prints the file paths.
Pick the one command that fits, run it with the bash tool in the foreground, and do what the
NEXT line at the end of its output says.

| They want | Run |
| --- | --- |
| an image | `hildegard make image "<what to draw>"` |
| a video clip | `hildegard make video "<what happens>" --move dolly-in` |
| a script read aloud | `hildegard make voices`, then the speech command below |
| a new, invented voice | `hildegard make voice "<description>" --text "<a line>"` |
| a recording cleaned | `hildegard make clean "<path>"` |

For speech, the script goes in on standard input, as it is, quotes and dollar signs too:

    hildegard make speech - --voice <voice id> <<'SCRIPT'
    <the script>
    SCRIPT

Rules:

- Never clone a voice. Only the person whose voice it is can, in the Hildegard Studio under
  Voice › Clone, by reading a consent line aloud. A voice they already cloned there shows in
  `hildegard make voices`, and you may speak in it.
- No real people in images or video, and nothing sexual. Hildegard refuses both.
- Never accept a model license or install anything for the person. When a command says a
  model isn't installed, show them the command it gives.
- If bash says `hildegard: command not found`, tell the person to install Hildegard from
  https://dbaney.com/hildegard/ and stop.

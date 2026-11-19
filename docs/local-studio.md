# Hildegard in Local Studio

Local Studio runs coding agents on local models. Hildegard's plugin for it adds six commands to its palette, each one a
short skill that a small model can follow:

| Command | What the agent runs | What comes back |
| --- | --- | --- |
| `/image` | `hildegard make image "<prompt>"` | `Image: <path>` and the review |
| `/video` | `hildegard make video "<prompt>" --move <camera move>` | `Video: <path>`, the review and a contact sheet |
| `/speak` | `hildegard make speech - --voice <id>`, the script on stdin | `Audio: <path>` and the review |
| `/design-voice` | `hildegard make voice "<description>" --text "<line>"` | the candidates, then `make voice keep` |
| `/clean-audio` | `hildegard make clean <file>` | `Cleaned: <path>` and the review |
| `/hildegard` | picks one of the above | |

## Install

Hildegard installed and running, then either:

```sh
hildegard connect local-studio            # copies the plugin and checks it with Local Studio's validator
local-studio plugin install <hildegard>/local-studio/hildegard   # or Local Studio's own installer
```

Both put it in `~/.local-studio/plugins/hildegard` (or `$LOCAL_STUDIO_DATA_DIR/plugins`). The commands appear on
Local Studio's next command list, with no restart. `hildegard disconnect local-studio` takes them out, and neither
command touches another plugin that happens to share the name.

The plugin asks for no capabilities and adds no MCP server: its skills run the `hildegard` command with the bash tool,
so it works with any Local Studio access mode that allows commands.

## How `hildegard make` behaves

`hildegard make` is for agents, so every run is one blocking command with one answer:

- It waits until the job is finished on the Hildegard server (a minute or two for an image, longer for video; up to
  `--wait-minutes`, 60 by default), printing progress on stderr.
- It saves what it made in `./hildegard-out` (`--out` to change it) and prints each path.
- It runs Hildegard's review on each file (the same checks as `hildegard review`; for video, the server's review of
  the take and its contact sheet). A failed review is a failed command.
- Its last line starts with `NEXT:` and says what to do: hand over the path, change one thing and try again, or tell
  the person what went wrong. Errors exit 1.
- `--json` prints `{ ok, needsOwner, steps[], message, files[], reviews[] }`.

It talks to the Hildegard at `HILDEGARD_URL`, else the one this computer runs.

## Cloning stays with the person

An agent can't clone a voice through this plugin, or through `hildegard make` at all. `hildegard make clone` (and
`voice clone`, `clone-voice`, `voice-clone`, `cloning`) is refused before anything reaches the server: it exits 1,
sends no request, and tells the agent to send the person to **Voice › Clone** in the Hildegard Studio, where they read
a fresh consent line aloud, live ([voice.md](voice.md)). A voice they cloned there shows in `hildegard make voices`,
and `/speak` can use it. `apps/cli/test/make.test.ts` holds that refusal in place.

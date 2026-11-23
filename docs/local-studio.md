# Hildegard in Local Studio

Local Studio runs coding agents on local models. Hildegard's plugin for it (`local-studio/hildegard`) adds seventeen
commands to its palette and Hildegard's tools. Six make media, each one a short skill that a small model can follow:

| Command | What the agent runs | What comes back |
| --- | --- | --- |
| `/image` | `hildegard make image "<prompt>"` | `Image: <path>` and the review |
| `/video` | `hildegard make video "<prompt>" --move <camera move>` | `Video: <path>`, the review and a contact sheet |
| `/speak` | `hildegard make speech - --voice <id>`, the script on stdin | `Audio: <path>` and the review |
| `/design-voice` | `hildegard make voice "<description>" --text "<line>"` | the candidates, then `make voice keep` |
| `/clean-audio` | `hildegard make clean <file>` | `Cleaned: <path>` and the review |
| `/hildegard` | picks one of the above | |

Eleven more are Hildegard's craft skills, the same ones the Claude Code plugin carries:

| Command | Skill | What it does |
| --- | --- | --- |
| `/film` | hildegard-film | plans a film, ad or reel shot by shot, and renders it |
| `/art` | hildegard-art | art direction, then a series of images, each one reviewed |
| `/sound` | hildegard-sound | cleans, mixes and masters audio with tested scripts |
| `/photo` | hildegard-photo-edit | straightens, crops, colors and retouches a photo, measured |
| `/edit-video` | hildegard-video-edit | cuts clips into a piece with titles, music and set loudness |
| `/3d` | hildegard-3d | models in 3D in rounds, checked from every side |
| `/web` | hildegard-web | builds a page in HTML and CSS, rendered and audited |
| `/loop` | hildegard-loop | make, look, critique and refine, one change per round |
| `/design` | hildegard-design | a poster, flyer, post, cover or sign at its exact size, read back line by line |
| `/music` | hildegard-music | music, sound effects and soundscapes from recipes, loudness checked |
| `/motion` | hildegard-motion | title cards, promos and kinetic type drawn in code, from a template |

The plugin also carries hildegard (the method for open-ended work), hildegard-blog (prose in a person's own voice),
hildegard-craft and hildegard-setup, which a model opens by name (`/skill:hildegard`). Every skill the hildegard
router names is in the plugin, so a small model never reaches for one that isn't there.

## The craft skills come from skills/

The plugin's copies are made by `node scripts/sync-local-studio-skills.mjs`, never edited by hand. It copies each skill
from `skills/` and changes only what Local Studio needs, all listed in the script:

- Each commanded skill opens with an "In Local Studio" block: the one tool or command to run first, for a small model.
  It also says to run the skill's scripts as `python3 -B <folder>/scripts/...`, since a Python cache written into the
  plugin's folder changes its hash, and Local Studio turns the tools off until the person allows them again.
- Printing goes to the Gantrel plugin. Where hildegard, hildegard-3d and hildegard-loop hand a part to
  hildegard-print, the copy says to use Gantrel's `/plan` and `/print` when Gantrel is installed, and to hand the
  person the mesh when it isn't. hildegard-print and hildegard-openscad stay out of the plugin.
- hildegard-blog runs its lint by the script's full path from the working folder, so a draft never lands in the
  plugin. hildegard-design renders with a browser already on the computer, and asks before `npx playwright`
  downloads one. hildegard-blog posts as a draft and publishes only on the person's word, as it does everywhere.
- hildegard-cloud stays out: a rented GPU costs money, and nothing in Local Studio should start one. hildegard-setup's
  line about it says so.

`apps/cli/test/local-studio-skills.test.ts` fails when a copy differs from what the sync makes, by a byte, and when
the plugin holds a file or a skill the sync doesn't make. After changing a skill in `skills/`, run the sync and commit
both.

## Install

Hildegard installed and running, then either:

```sh
hildegard connect local-studio            # copies the plugin and checks it with Local Studio's validator
local-studio plugin install <hildegard>/local-studio/hildegard   # or Local Studio's own installer
```

Both put it in `~/.local-studio/plugins/hildegard` (or `$LOCAL_STUDIO_DATA_DIR/plugins`). The commands appear on
Local Studio's next command list, with no restart. `hildegard disconnect local-studio` takes them out, and neither
command touches another plugin that happens to share the name.

The plugin asks for one capability, `mcp-server`: its `[mcp]` command, `bin/hildegard-mcp`, runs `hildegard mcp` from
the Hildegard installed on this computer (`HILDEGARD_BIN`, then `PATH`, then `~/.local/bin/hildegard`), the way
`plugin/mcp.mjs` does for Claude Code. It is plain `sh`, since Hildegard carries its own Node. Local Studio asks you
once, on its consent sheet, before it starts it; until then the commands still work, without the tools. If Hildegard
isn't installed, the server prints how to install it and exits; it never installs anything. No tool rents a GPU or
spends money, so the plugin asks no questions of its own (`ask-user`).

The six media skills run the `hildegard` command with the bash tool, so they work with any Local Studio access mode
that allows commands, tools or not.

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

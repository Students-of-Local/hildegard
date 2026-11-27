# Blender in the loop

A model loop takes a Blender build script as a round, the way it takes OpenSCAD source: Hildegard runs the script in
Blender, then checks and draws the `model.glb` it writes like any other model (`apps/server/src/blender.ts`). The
**hildegard-3d** skill carries `scripts/blender_kit.py`, a small bpy kit for building, exporting and rendering a
turntable by script.

## Sending a build

A round is a Python file whose first line is `# hildegard: blender`, or a folder (sent as a ZIP) with that
`build.py` at its top and anything it imports beside it, such as `blender_kit.py`, and an optional `params.json`.
Hildegard runs:

```sh
blender --background --factory-startup --python-exit-code 1 --python <round>/build.py -- --out <round>/out [--params <round>/params.json]
```

The script writes `model.glb` into `--out` (it may also write `model.stl`; only the GLB is checked). Export with
`export_yup=True`: glTF is Y up and Blender is Z up, and a model exported Z up lies on its back in every view.
`blender_status` (MCP) and `GET /api/blender` say whether Blender is here, its version, whether Cycles renders on the
CPU (unknown until a first check, which they start in the background and never wait for, is done), whether it runs
sandboxed, and the setting below. Hildegard looks for Blender at `HILDEGARD_BLENDER` (only there when it is set), then
on `PATH`, then `/Applications/Blender.app` on macOS, and runs the file a link there points to (Homebrew's `blender`
runs the .app it links to). A Blender installed while Hildegard runs is found without a restart. A build may run for
180 seconds (`HILDEGARD_BLENDER_TIMEOUT` changes it).

Failures come back as the loop's errors: `no_blender` (not installed), `blender_failed` (the script's line and
exception, a model.glb missing or not binary glTF, or the time limit), `blender_remote` and `blender_off` (below).

## Who may send one

A build script is a program with the rights of the server, unlike OpenSCAD source or a mesh, which Hildegard only
reads. So it runs only when the round comes from this computer itself (`runsHere` in `apps/server/src/access.ts`):

- the request is from this computer (`fromThisComputer`): a loopback socket, on the Studio's own listener (not the
  hosted one that Tailscale Serve, Funnel and tunnels forward to), with no proxy header (`Forwarded`,
  `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Tailscale-User-Login`); or an MCP call that itself arrived
  that way;
- its Host is a loopback name (`127.0.0.1`, `localhost`, `[::1]`), so a proxy on this computer that passes on the
  public name it was reached at is refused, and so is a name added with `--allow-host`;
- no browser page sent it: it has no `Origin` and no `Sec-Fetch-Site`, `Sec-Fetch-Dest` or `Sec-Fetch-User`, and no
  `Sec-Fetch-Mode` but the lone `cors` that Node's fetch adds. A page Hildegard serves itself (a published site under
  `/s/`, a preview) is someone else's code on this address, so it is refused like any other site.

Everything else is refused with `blender_remote` before Blender starts: anyone signed in (the owner too) on another
device, an MCP key or chatbot sign-in, `hildegard host`, a tunnel, a tailnet address, and paired devices (which reach
only `/api/node/*`). Anything the server can't place is refused, and so is the Studio in a browser. AI apps on this
computer pass: the stdio MCP server, an MCP call that arrived from this computer, and the CLI.

## The sandbox

The script runs in the sandbox OpenSCAD uses: bubblewrap on Linux, sandbox-exec on macOS. It has no network, reads
only the system and Blender's own files, and writes only the round's folder, which holds its home, temp folder,
`BLENDER_USER_CONFIG` and `BLENDER_USER_SCRIPTS`; with `--factory-startup` it never reads your Blender preferences or
add-ons. Its whole process group is stopped at the time limit, when the server closes, and when its process exits; an
update waits while a build runs. Where there is no sandbox (Windows, Linux without bubblewrap, a Blender inside a
hidden folder that isn't a Blender download), no build script runs: export a GLB and send that.

## The setting

`blenderScripts` in `<data>/blender.json` is `on` when there is no such file. `{"blenderScripts": "off"}` turns build
scripts off for every caller, this computer included (`blender_off`); exported models still go through. A file that
can't be read, isn't JSON, or holds anything but exactly `"on"` or `"off"` (`false`, `"Off"`, a trailing comma) turns
them off too, and `hildegard doctor` and `blender_status` say the file is unreadable or invalid. `hildegard doctor`
shows the setting and whether Blender can run sandboxed here.

## A live Blender over MCP

Hildegard installs no Blender add-on and doesn't drive a running Blender. Community add-ons such as `mcp-for-blender`
open a socket that takes Python from anything that can reach it, with no sign-in, so any program or web page on the
computer could run code through it. If you want one, install it yourself, keep it bound to `127.0.0.1`, start it only
while you use it, and treat every script an AI app sends it as yours to read first.

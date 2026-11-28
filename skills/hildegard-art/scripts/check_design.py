#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic anti-slop HTML/CSS linter, DESIGN.md schema checker, and isometric technical-art contract checker.

  python3 -B check_design.py --html FILE_OR_DIR [--json]
  python3 -B check_design.py --design-md DESIGN.md [--json]
  python3 -B check_design.py --iso ISO.json [--pre-render] [--json]

Pure Python 3 stdlib (zero external dependencies).
"""

import argparse
import json
import math
import os
import re
import sys

SKIP_DIRS = {"node_modules", ".git", "__pycache__", "dist", "build"}
HTML_EXTS = {".html", ".htm"}
CSS_EXTS = {".css"}
WEB_EXTS = HTML_EXTS | CSS_EXTS

CSS_COMMENT_RE = re.compile(r"/\*[\s\S]*?\*/")
STYLE_TAG_RE = re.compile(r"<style\b[^>]*>([\s\S]*?)</style>", re.I)
INLINE_STYLE_RE = re.compile(r'\bstyle\s*=\s*(?:"([^"]*)"|\'([^\']*)\')', re.I)
TRANSITION_ALL_RE = re.compile(r"\btransition(?:-property)?\s*:\s*[^;{}]*\ball\b", re.I)
LAYOUT_ANIM_RE = re.compile(r"\btransition(?:-property)?\s*:\s*[^;{}]*\b(width|height|top|left)\b", re.I)
VW_100_RE = re.compile(r"(?:width|min-width|max-width)\s*:\s*100vw\b", re.I)
OVERFLOW_HIDDEN_ROOT_RE = re.compile(r"(?:^|[}\s,])(?:html|body)[^{]*\{[^}]*overflow-x\s*:\s*hidden\b", re.I | re.S)
HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b")
RGB_COLOR_RE = re.compile(r"\b(?:rgba?|hsla?|oklch)\s*\(", re.I)
PURPLE_BLUE_GRAD_RE = re.compile(
    r"linear-gradient\([^)]*(?:#(?:[5-9a-d][0-9a-f][0-5][0-9a-f][a-f][0-9a-f]|6366f1|7c3aed|8b5cf6|a855f7)|purple|violet|indigo)[^)]*(?:#(?:[0-4][0-9a-f][5-9a-f][0-9a-f][c-f][0-9a-f]|3b82f6|2563eb|06b6d4)|blue|cyan)",
    re.I,
)
ITALIC_WORD_IN_HEADING_RE = re.compile(r"<h[1-6]\b[^>]*>[^<]*<(?:em|i)\b[^>]*>[^<\s]+</(?:em|i)>[^<]*</h[1-6]>", re.I)
SLOP_COPY_RE = re.compile(r"\b(?:lorem\s+ipsum|unlock\s+the\s+power\s+of|reimagined\b|elevate\s+your)\b", re.I)
INTERACTIVE_TAG_RE = re.compile(r"<(?:button|a\s+[^>]*href|input|select|textarea)\b", re.I)
HAS_MOTION_RE = re.compile(r"@keyframes\b|\b(?:transition|animation)\s*:", re.I)

YAML_FENCE_RE = re.compile(r"```yaml\s*\n([\s\S]*?)```", re.I)
TOKEN_REF_RE = re.compile(r"\{([a-zA-Z0-9_.-]+)\}")
EXT_REF_RE = re.compile(r"(?<![A-Za-z0-9_.+-])@([^\s`\"'()\[\]<>#,;]+)")
CSS_COLOR_VAL_RE = re.compile(
    r"^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color-mix)\([^)]+\)|transparent|[a-zA-Z]+|\{[a-zA-Z0-9_.-]+\})$"
)
METADATA_KEYS = {"version", "name", "description", "omitted"}
ISO_KNOWN_KEYS = {"tier", "azimuth_deg", "elevation_deg", "tones", "lit_count", "parts", "depth_sorted", "floating_line_ends", "closeup_4x_checked", "themes_checked"}
ISO_TIER_MIN = {"figure": 40, "hero": 80, "epic": 150}
ISO_ROOT_HOSTS = {"ground", "base", "bench", "floor", "stand"}


def _chk(cid, ok, value, limit, detail):
    return {"id": cid, "ok": bool(ok), "value": value, "limit": limit, "detail": detail}


def _has_emoji(text):
    for ch in text:
        cp = ord(ch)
        if (0x1F300 <= cp <= 0x1FAFF) or (0x2600 <= cp <= 0x27BF):
            return True
    return False


def _strip_token_blocks(css):
    """Return CSS with :root, [data-theme...], and @font-face blocks removed for literal-token checks."""
    out = []
    i, n = 0, len(css)
    while i < n:
        m = re.search(r"(?::root\b|\[data-theme[^\]]*\]|@font-face\b)[^{]*\{", css[i:], re.I)
        if not m:
            out.append(css[i:])
            break
        out.append(css[i : i + m.start()])
        j = i + m.end()
        depth = 1
        while j < n and depth > 0:
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
            j += 1
        i = j
    return "".join(out)


def _declaration_values(css):
    """Extract (property, value) pairs strictly inside innermost { ... } declaration bodies (never selectors)."""
    vals = []
    for body in re.findall(r"\{([^{}]*)\}", css):
        for decl in body.split(";"):
            if ":" not in decl:
                continue
            prop, val = decl.split(":", 1)
            prop = prop.strip().lower()
            if prop and re.fullmatch(r"[a-z-]+", prop):
                vals.append((prop, val.strip()))
    return vals


def check_html_path(target):
    if not os.path.exists(target):
        return {"ok": False, "checks": [_chk("html_path_exists", False, target, "existing file or directory", "HTML/CSS path does not exist")]}
    files = []
    if os.path.isfile(target):
        if os.path.splitext(target)[1].lower() in WEB_EXTS:
            files.append((target, os.path.basename(target)))
    elif os.path.isdir(target):
        for root, dirs, names in os.walk(target):
            dirs[:] = [d for d in sorted(dirs) if d not in SKIP_DIRS]
            for name in sorted(names):
                if os.path.splitext(name)[1].lower() in WEB_EXTS:
                    p = os.path.join(root, name)
                    files.append((p, os.path.relpath(p, target)))
    if not files:
        return {"ok": False, "checks": [_chk("html_files_scanned", False, 0, ">= 1 .html/.css file", f"no HTML or CSS files found under {target}")]}

    all_html = []
    all_css = []
    inline_css = []
    for path, _ in files:
        ext = os.path.splitext(path)[1].lower()
        text = open(path, encoding="utf-8", errors="replace").read()
        if ext in HTML_EXTS:
            all_html.append(text)
            for sm in STYLE_TAG_RE.finditer(text):
                all_css.append(sm.group(1))
            for im in INLINE_STYLE_RE.finditer(text):
                style_val = im.group(1) if im.group(1) is not None else im.group(2)
                if style_val and style_val.strip():
                    inline_css.append(f"inline-style {{ {style_val} }}")
        else:
            all_css.append(text)

    html_blob = "\n".join(all_html)
    css_blob = CSS_COMMENT_RE.sub(" ", "\n".join(all_css + inline_css))
    non_token_css = _strip_token_blocks(css_blob)

    checks = [_chk("html_files_scanned", True, len(files), ">= 1 .html/.css file", "HTML/CSS files audited")]

    if css_blob.strip():
        has_root_tokens = bool(re.search(r"(?::root|\[data-theme[^\]]*\])[^{]*\{[^}]*--[a-zA-Z0-9_-]+\s*:", css_blob, re.S))
        decls = _declaration_values(non_token_css)
        raw_colors = [c for _, v in decls for c in (HEX_COLOR_RE.findall(v) + RGB_COLOR_RE.findall(v))]
        raw_fonts = [
            v
            for prop, v in decls
            if prop == "font-family" and "var(" not in v and v.lower() not in ("inherit", "initial", "unset")
        ]
        token_ok = has_root_tokens and not raw_colors and not raw_fonts
        detail_val = "clean" if token_ok else {"has_root_tokens": has_root_tokens, "raw_colors": raw_colors[:5], "raw_fonts": raw_fonts[:5]}
        checks.append(_chk("css_tokens", token_ok, detail_val, "all colors and fonts via :root custom properties", "declare tokens in :root and reference them with var(--*)"))

        trans_all = bool(TRANSITION_ALL_RE.search(css_blob))
        layout_anim = bool(LAYOUT_ANIM_RE.search(css_blob))
        checks.append(_chk("no_transition_all", not trans_all and not layout_anim, "clean" if (not trans_all and not layout_anim) else {"transition_all": trans_all, "layout_prop": layout_anim}, "no transition:all or width/height/top/left animation", "animate transform/opacity only, never transition: all"))

        vw_bad = bool(VW_100_RE.search(css_blob))
        ov_hidden = bool(OVERFLOW_HIDDEN_ROOT_RE.search(css_blob))
        checks.append(_chk("safe_overflow", not vw_bad and not ov_hidden, "clean" if (not vw_bad and not ov_hidden) else {"100vw": vw_bad, "overflow_x_hidden": ov_hidden}, "no 100vw width or html/body overflow-x: hidden (use clip)", "use overflow-x: clip and avoid 100vw scrollbar overflow"))

        if HAS_MOTION_RE.search(css_blob):
            has_rm = "prefers-reduced-motion" in css_blob
            checks.append(_chk("reduced_motion", has_rm, has_rm, True, "animations include a prefers-reduced-motion fallback"))

    if INTERACTIVE_TAG_RE.search(html_blob):
        has_focus = ":focus-visible" in css_blob
        checks.append(_chk("focus_visible", has_focus, has_focus, True, "interactive controls define :focus-visible styling"))

    slop_hits = []
    if PURPLE_BLUE_GRAD_RE.search(css_blob):
        slop_hits.append("purple-blue-gradient")
    if ITALIC_WORD_IN_HEADING_RE.search(html_blob):
        slop_hits.append("italic-word-in-heading")
    m_copy = SLOP_COPY_RE.search(html_blob)
    if m_copy:
        slop_hits.append(f"slop-copy:{m_copy.group(0)}")
    if _has_emoji(html_blob):
        slop_hits.append("emoji-in-markup")
    checks.append(_chk("no_slop_patterns", not slop_hits, slop_hits or "clean", "[]", "no purple-blue gradients, emoji icons, italic-word headings, or filler copy"))

    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def _strip_yaml_comment(raw):
    in_sq = in_dq = False
    for i, ch in enumerate(raw):
        if ch == "'" and not in_dq:
            in_sq = not in_sq
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
        elif ch == "#" and not in_sq and not in_dq and (i == 0 or raw[i - 1].isspace()):
            if not re.match(r"#[0-9a-fA-F]{3,8}(?:\s|$)", raw[i:]):
                return raw[:i].rstrip()
    return raw.rstrip()


def _parse_simple_yaml(block):
    """Minimal stdlib YAML subset parser for DESIGN.md token blocks; returns (root, duplicate_top_keys)."""
    root = {}
    dup_top = []
    stack = [(-1, root)]
    for raw in block.splitlines():
        line = _strip_yaml_comment(raw)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if stripped.startswith("- "):
            item = stripped[2:].strip().strip("\"'")
            if item.startswith("section:"):
                item = item.split(":", 1)[1].strip().strip("\"'")
            if isinstance(parent, list):
                parent.append(item)
            continue
        if ":" not in stripped:
            continue
        key, rest = stripped.split(":", 1)
        key = key.strip().strip("\"'")
        val = rest.strip()
        if not isinstance(parent, dict):
            continue
        if parent is root and key in root:
            dup_top.append(key)
        if val == "":
            child = [] if key == "omitted" else {}
            parent[key] = child
            stack.append((indent, child))
        else:
            if val.startswith("[") and val.endswith("]"):
                parent[key] = [x.strip().strip("\"'") for x in val[1:-1].split(",") if x.strip()]
            else:
                parent[key] = val.strip("\"'")
    return root, dup_top


def _flatten_tokens(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                out[path] = v
                out.update(_flatten_tokens(v, path))
            else:
                out[path] = v
    return out


def _resolve_token_ref(start_key, ref, flat):
    """Resolve {ref} transitively, rejecting missing, group, metadata, and cyclic references."""
    seen = {start_key}
    cur = ref
    while True:
        if cur in seen:
            return None, "cycle", cur
        if cur in METADATA_KEYS:
            return None, "non-token", cur
        if cur not in flat:
            return None, "missing", cur
        seen.add(cur)
        val = flat[cur]
        if isinstance(val, dict):
            if start_key.startswith("components.") and "." in cur and val and all(not isinstance(x, dict) for x in val.values()):
                return val, "composite", cur
            return None, "group", cur
        if isinstance(val, list):
            return None, "group", cur
        if isinstance(val, str):
            m_full = re.fullmatch(r"\{([a-zA-Z0-9_.-]+)\}", val.strip())
            if m_full:
                cur = m_full.group(1)
                continue
        return val, "scalar", cur


def check_design_md(path):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("design_md_exists", False, path, "existing DESIGN.md file", "DESIGN.md file not found")]}
    text = open(path, encoding="utf-8", errors="replace").read()
    blocks = []
    if text.startswith("---\n") or text.startswith("---\r\n"):
        parts = re.split(r"^---\s*$", text, maxsplit=2, flags=re.M)
        if len(parts) >= 3:
            blocks.append(parts[1])
            body = parts[2]
        else:
            body = text
    else:
        body = text
    for m in YAML_FENCE_RE.finditer(body):
        blocks.append(m.group(1))

    merged = {}
    dup_keys = []
    all_color_maps = []
    for blk in blocks:
        parsed, block_dups = _parse_simple_yaml(blk)
        dup_keys.extend(block_dups)
        if isinstance(parsed.get("colors"), dict):
            all_color_maps.append(parsed["colors"])
        for k, v in parsed.items():
            if k in merged:
                dup_keys.append(k)
            else:
                merged[k] = v

    checks = []
    checks.append(_chk("yaml_blocks_present", bool(blocks), len(blocks), ">= 1 YAML token block", "DESIGN.md embeds YAML front matter or fenced yaml token blocks"))
    checks.append(_chk("unique_top_keys", not dup_keys, dup_keys or "unique", "[]", "each top-level schema key is defined at most once"))

    omitted = set(merged.get("omitted", [])) if isinstance(merged.get("omitted"), list) else set()
    has_name = isinstance(merged.get("name"), str) and bool(merged["name"].strip())
    has_colors = ("colors" in merged and isinstance(merged["colors"], dict) and bool(merged["colors"])) or ("colors" in omitted)
    checks.append(_chk("required_fields", has_name and has_colors, {"name": has_name, "colors_or_omitted": has_colors}, "name + colors (or omitted)", "DESIGN.md defines name and colors palette"))

    flat = _flatten_tokens(merged)
    bad_colors = []
    for cmap in all_color_maps:
        for k, v in _flatten_tokens(cmap, "colors").items():
            if isinstance(v, str) and not CSS_COLOR_VAL_RE.match(v.strip()):
                bad_colors.append(f"{k}={v}")
    checks.append(_chk("valid_color_tokens", not bad_colors, bad_colors or "valid", "[]", "color tokens use valid CSS color syntax or token references"))

    broken_refs = []
    for k, v in flat.items():
        if isinstance(v, str):
            for rm in TOKEN_REF_RE.finditer(v):
                ref = rm.group(1)
                resolved_val, kind, terminal = _resolve_token_ref(k, ref, flat)
                if resolved_val is None:
                    broken_refs.append(f"{k}->{{{ref}}}({kind})")
                elif k.startswith("colors.") and (kind != "scalar" or not terminal.startswith("colors.")):
                    broken_refs.append(f"{k}->{{{ref}}}(non-color)")
    checks.append(_chk("token_refs_valid", not broken_refs, broken_refs or "valid", "[]", "every {path.to.token} reference resolves to a non-cyclic token"))

    base_dir = os.path.realpath(os.path.dirname(os.path.abspath(path)))
    unsafe_ext = []
    for em in EXT_REF_RE.finditer(text):
        raw_ref = em.group(1)
        norm = raw_ref.replace("\\", "/")
        if norm.startswith("/") or norm.startswith("~") or re.match(r"^[A-Za-z]:/", norm) or ".." in norm.split("/"):
            unsafe_ext.append(raw_ref)
            continue
        if "/" in norm or "." in norm:
            resolved = os.path.realpath(os.path.join(base_dir, norm))
            if not (resolved == base_dir or resolved.startswith(base_dir + os.sep)):
                unsafe_ext.append(raw_ref)
    checks.append(_chk("external_refs_safe", not unsafe_ext, unsafe_ext or "safe", "[]", "external @path references stay inside the DESIGN.md directory"))

    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def check_iso_spec(spec, pre_render=False):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "iso spec must be a JSON object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - ISO_KNOWN_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized keys: {', '.join(unknown)}"))

    try:
        az = float(spec.get("azimuth_deg", -1))
        el = float(spec.get("elevation_deg", -1))
    except (TypeError, ValueError):
        az, el = -1.0, -1.0
    cam_ok = math.isfinite(az) and math.isfinite(el) and (35.0 <= az <= 60.0) and (20.0 <= el <= 50.0)
    checks.append(_chk("camera_iso", cam_ok, [az, el], "azimuth 35..60 deg, elevation 20..50 deg", "isometric camera projection angles"))

    tones = spec.get("tones")
    req_tones = {"lo", "mid", "hi", "lit"}
    tones_ok = (
        isinstance(tones, dict)
        and req_tones.issubset(tones.keys())
        and all(isinstance(tones[k], str) and bool(tones[k].strip()) for k in req_tones)
        and len({tones[k].strip().lower() for k in req_tones}) == 4
    )
    lit_count = spec.get("lit_count", 1)
    lit_ok = isinstance(lit_count, int) and not isinstance(lit_count, bool) and lit_count == 1
    checks.append(_chk("four_tone_ramp", tones_ok and lit_ok, {"tones": sorted(tones.keys()) if isinstance(tones, dict) else tones, "lit_count": lit_count}, "4 distinct tones (lo/mid/hi/lit) + lit_count == 1", "four-tone directional shading with one lit focal accent"))

    tier_raw = spec.get("tier")
    tier = tier_raw.strip().lower() if isinstance(tier_raw, str) else None
    min_parts = ISO_TIER_MIN.get(tier) if tier else None
    parts = spec.get("parts")
    if min_parts is None:
        checks.append(_chk("part_density", False, tier_raw, "figure|hero|epic", "explicit isometric tier required"))
    elif isinstance(parts, list):
        total_parts = 0
        unmounted = 0
        entries = []
        for p in parts:
            if not isinstance(p, dict):
                unmounted += 1
                continue
            c = p.get("count", 1)
            if not (isinstance(c, int) and not isinstance(c, bool) and c >= 1):
                unmounted += 1
                continue
            total_parts += c
            pid = str(p.get("group") or p.get("name") or "").strip().lower()
            host = str(p.get("host") or "").strip().lower()
            entries.append((pid, host, c))
        host_map = {pid: host for pid, host, _ in entries if pid}
        for pid, host, c in entries:
            if not host:
                unmounted += c
                continue
            cur = host
            seen = {pid} if pid else set()
            grounded = False
            while cur:
                if cur in ISO_ROOT_HOSTS:
                    grounded = True
                    break
                if cur in seen or cur not in host_map:
                    break
                seen.add(cur)
                cur = host_map[cur]
            if not grounded:
                unmounted += c
        checks.append(_chk("part_density", total_parts >= min_parts and unmounted == 0, {"count": total_parts, "unmounted": unmounted}, f">= {min_parts} grounded parts for {tier}", "dense recognizable machine where every part mounts transitively to ground/base without cycles"))
    else:
        checks.append(_chk("part_density", False, parts, f"list of >= {min_parts} part objects with host", "parts list required"))

    checks.append(_chk("depth_sorted", spec.get("depth_sorted") is True, spec.get("depth_sorted"), True, "painter's depth order verified"))
    if not pre_render:
        fl = spec.get("floating_line_ends", -1)
        fl_ok = isinstance(fl, int) and not isinstance(fl, bool) and fl == 0
        checks.append(_chk("line_ends_resolved", fl_ok, fl, 0, "every seam, tick, and texture line ends on a stroke, dot, or outline"))
        checks.append(_chk("closeup_4x_checked", spec.get("closeup_4x_checked") is True, spec.get("closeup_4x_checked"), True, "4x close-up audit performed at junctions"))
        themes = spec.get("themes_checked")
        themes_ok = isinstance(themes, list) and {"light", "dark"}.issubset({str(x).lower() for x in themes})
        checks.append(_chk("dual_theme_checked", themes_ok, themes, "['light', 'dark']", "verified in both dark and light paper themes"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="HTML/CSS file or directory to audit against anti-slop Floor rules")
    ap.add_argument("--design-md", help="DESIGN.md file to validate against token and reference schema")
    ap.add_argument("--iso", help="Isometric technical illustration contract JSON to verify")
    ap.add_argument("--pre-render", action="store_true", help="For --iso: validate pre-render geometry/density plan without requiring post-render audit flags")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if sum(bool(x) for x in (a.html, a.design_md, a.iso)) != 1:
        ap.error("provide exactly one of --html, --design-md, or --iso")
    if a.html:
        res = check_html_path(a.html)
    elif a.design_md:
        res = check_design_md(a.design_md)
    else:
        res = check_iso_spec(json.load(open(a.iso, encoding="utf-8")), pre_render=a.pre_render)

    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

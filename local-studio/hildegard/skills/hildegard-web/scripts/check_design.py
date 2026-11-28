#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic anti-slop HTML/CSS linter, DESIGN.md schema checker, art/VFX contract checker, and SVG logo checker.

  python3 -B check_design.py --html FILE_OR_DIR [--json]
  python3 -B check_design.py --design-md DESIGN.md [--json]
  python3 -B check_design.py --iso ISO.json [--pre-render] [--json]
  python3 -B check_design.py --ink-anim INK.json [--pre-render] [--json]
  python3 -B check_design.py --sakuga SAKUGA.json [--pre-render] [--json]
  python3 -B check_design.py --logo LOGO.svg [--allow-draft-text] [--surface #FFFFFF] [--json]

Pure Python 3 stdlib (zero external dependencies).
"""

import argparse
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

SKIP_DIRS = {"node_modules", ".git", "__pycache__", "dist", "build"}
HTML_EXTS = {".html", ".htm"}
CSS_EXTS = {".css"}
WEB_EXTS = HTML_EXTS | CSS_EXTS

CSS_COMMENT_RE = re.compile(r"/\*[\s\S]*?\*/")
STYLE_TAG_RE = re.compile(r"<style\b[^>]*>([\s\S]*?)</style>", re.I)
INLINE_STYLE_RE = re.compile(r'\bstyle\s*=\s*(?:"([^"]*)"|\'([^\']*)\')', re.I)
VW_100_RE = re.compile(r"(?:width|min-width|max-width)\s*:\s*100vw\b", re.I)
HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b")
RGB_COLOR_RE = re.compile(r"\b(?:rgba?|hsla?|oklch|oklab)\s*\(", re.I)
URL_FUNC_RE = re.compile(r"\burl\s*\([^)]*\)", re.I)
QUOTED_STR_RE = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'')
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
CSS_AT_RULES = {"media", "font-face", "import", "keyframes", "layer", "supports", "charset", "property", "container", "scope", "starting-style", "page"}
HEX_STRICT_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
COLOR_FUNC_PREFIX_RE = re.compile(r"^(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color-mix)\(", re.I)
CSS_NAMED_COLORS = {
    "transparent", "currentcolor", "black", "white", "silver", "gray", "grey", "maroon", "red", "purple",
    "fuchsia", "magenta", "green", "lime", "olive", "yellow", "navy", "blue", "teal", "aqua", "cyan",
    "orange", "aliceblue", "antiquewhite", "aquamarine", "azure", "beige", "bisque", "blanchedalmond",
    "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
    "cornsilk", "crimson", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
    "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon",
    "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet",
    "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
    "gainsboro", "ghostwhite", "gold", "goldenrod", "greenyellow", "honeydew", "hotpink", "indianred",
    "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue",
    "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink",
    "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
    "lightyellow", "limegreen", "linen", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
    "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred",
    "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite", "oldlace", "olivedrab", "orangered",
    "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
    "peru", "pink", "plum", "powderblue", "rebeccapurple", "rosybrown", "royalblue", "saddlebrown", "salmon",
    "sandybrown", "seagreen", "seashell", "sienna", "skyblue", "slateblue", "slategray", "slategrey", "snow",
    "springgreen", "steelblue", "tan", "thistle", "tomato", "turquoise", "violet", "wheat", "whitesmoke",
    "yellowgreen",
}
TIMING_KEYWORDS = {"ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end", "allow-discrete", "normal"}
LAYOUT_PROPS = {"width", "height", "top", "left"}
METADATA_KEYS = {"version", "name", "description", "omitted"}
ISO_KNOWN_KEYS = {"tier", "azimuth_deg", "elevation_deg", "tones", "lit_count", "parts", "depth_sorted", "floating_line_ends", "closeup_4x_checked", "themes_checked"}
ISO_TIER_MIN = {"figure": 40, "hero": 80, "epic": 150}
ISO_ROOT_HOSTS = {"ground", "base", "bench", "floor", "stand"}
INK_ANIM_KNOWN_KEYS = {"open_stroke_limbs", "curved_lines", "gait", "skeleton_first_cloth", "card_fixed_bg", "palette_tokens", "debug_stepping", "zoomed_strip_checked", "day_cycle_checked"}
INK_GAIT_KINDS = {"walk", "shuffle", "run"}
SAKUGA_KNOWN_KEYS = {"control", "plain_at_rest", "immediate_state_change", "beats", "shared_clock_canvas", "visual_rules", "css_vars", "verification"}
SAKUGA_CONTROLS = {"button", "toggle", "switch", "slider", "checkbox", "radio", "input", "tabs", "progress", "rating", "toast", "tooltip"}
SAKUGA_BEAT_ORDER = ("anticipation", "hit", "follow_through", "settle")
EMOJI_EXTRA_CPS = {0x26A0, 0x26A1, 0x2705, 0x2728, 0x274C, 0x2764}
ROOT_THEME_SEL_RE = re.compile(
    r"^(?::root(?:\[data-theme[^\]]*\])?|html(?:\[data-theme[^\]]*\])?|\[data-theme[^\]]*\])$",
    re.I,
)
GROUPING_AT_RULE_RE = re.compile(r"^@(?:media|supports|layer|container)(?:\s|\(|$)", re.I)
YAML_LIST_MAP_RE = re.compile(r'^("(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$')


def _chk(cid, ok, value, limit, detail):
    return {"id": cid, "ok": bool(ok), "value": value, "limit": limit, "detail": detail}


def _has_emoji(text):
    for ch in text:
        cp = ord(ch)
        if (0x1F300 <= cp <= 0x1FAFF) or cp in EMOJI_EXTRA_CPS:
            return True
    return False


def _is_valid_css_color(val):
    s = val.strip()
    if re.fullmatch(r"\{[a-zA-Z0-9_.-]+\}", s):
        return True
    if HEX_STRICT_RE.match(s):
        return True
    if s.lower() in CSS_NAMED_COLORS:
        return True
    if COLOR_FUNC_PREFIX_RE.match(s) and s.endswith(")"):
        depth = 0
        for idx, ch in enumerate(s):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth < 0 or (depth == 0 and idx != len(s) - 1):
                    return False
        return depth == 0
    return False


def _split_grouping_stack(sel_stack):
    """Return non-@ selectors when every @ frame in sel_stack is a grouping at-rule, else None."""
    non_at = []
    for frame in sel_stack:
        s = frame.strip()
        if not s:
            return None
        if s.startswith("@"):
            if not GROUPING_AT_RULE_RE.match(s):
                return None
        else:
            non_at.append(s)
    return non_at


def _is_root_theme_stack(sel_stack):
    """True iff sel_stack has one root/theme token selector plus optional grouping at-rules."""
    non_at = _split_grouping_stack(sel_stack)
    if non_at is None or len(non_at) != 1:
        return False
    parts = [p.strip() for p in non_at[0].split(",") if p.strip()]
    return bool(parts) and all(ROOT_THEME_SEL_RE.match(p) for p in parts)


def _is_html_body_stack(sel_stack):
    """True iff sel_stack has one non-@ selector targeting html or body plus optional grouping at-rules."""
    non_at = _split_grouping_stack(sel_stack)
    if non_at is None or len(non_at) != 1:
        return False
    parts = [p.strip().lower() for p in non_at[0].split(",") if p.strip()]
    return any(p in ("html", "body") for p in parts)


def _is_font_face_stack(sel_stack):
    return bool(sel_stack) and sel_stack[-1].strip().lower().startswith("@font-face")


def _iter_declarations(css):
    """Yield (sel_stack_tuple, prop, val) for declarations at any CSS nesting depth (never selectors)."""
    sel_stack = []
    buf = []
    in_sq = in_dq = False
    i, n = 0, len(css)
    while i < n:
        ch = css[i]
        if ch == "\\" and (in_sq or in_dq) and i + 1 < n:
            buf.append(ch)
            buf.append(css[i + 1])
            i += 2
            continue
        if ch == "'" and not in_dq:
            in_sq = not in_sq
            buf.append(ch)
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
            buf.append(ch)
        elif not in_sq and not in_dq and ch == "{":
            sel = "".join(buf).strip()
            sel_stack.append(sel)
            buf = []
        elif not in_sq and not in_dq and ch in (";", "}"):
            seg = "".join(buf).strip()
            buf = []
            if sel_stack and ":" in seg and not seg.startswith("@"):
                prop, val = seg.split(":", 1)
                prop = prop.strip().lower()
                if prop and re.fullmatch(r"(?:--[a-z0-9_-]+|[a-z-]+)", prop):
                    yield tuple(sel_stack), prop, val.strip()
            if ch == "}" and sel_stack:
                sel_stack.pop()
        else:
            buf.append(ch)
        i += 1


def _is_bad_transition(prop, val):
    """Return (transition_all_hit, layout_prop_hit) for transition / transition-property declarations."""
    t_all = False
    l_prop = False
    val_no_imp = re.sub(r"\s*!important\s*$", "", val, flags=re.I)
    # Strip var(...) and cubic-bezier(...) / steps(...) parens so tokens like var(--t-all) never false-match
    cleaned = re.sub(r"\b(?:var|cubic-bezier|steps)\s*\([^)]*\)", " ", val_no_imp, flags=re.I)
    for item in cleaned.split(","):
        s = item.strip().lower()
        if not s or s == "none":
            continue
        tokens = [tok for tok in re.split(r"\s+", s) if tok]
        if prop == "transition-property":
            for tok in tokens:
                if tok == "all":
                    t_all = True
                elif tok in LAYOUT_PROPS:
                    l_prop = True
            continue
        # transition shorthand: inspect non-time, non-easing property tokens
        prop_tokens = [
            tok
            for tok in tokens
            if tok not in TIMING_KEYWORDS and not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)m?s", tok)
        ]
        if not prop_tokens:
            # Bare timing shorthand (e.g. `transition: 200ms ease-out`) implicitly transitions `all`
            t_all = True
        for tok in prop_tokens:
            if tok == "all":
                t_all = True
            elif tok in LAYOUT_PROPS:
                l_prop = True
    return t_all, l_prop


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

    checks = [_chk("html_files_scanned", True, len(files), ">= 1 .html/.css file", "HTML/CSS files audited")]

    if css_blob.strip():
        all_decls = list(_iter_declarations(css_blob))
        has_root_tokens = False
        raw_colors = []
        raw_fonts = []
        trans_all = False
        layout_anim = False
        ov_hidden = False
        for sel_stack, prop, v in all_decls:
            is_root_theme = _is_root_theme_stack(sel_stack)
            is_font_face = _is_font_face_stack(sel_stack)
            if prop.startswith("--"):
                if is_root_theme:
                    has_root_tokens = True
                    continue
            if not is_font_face:
                if prop != "content":
                    scrubbed = QUOTED_STR_RE.sub(" ", URL_FUNC_RE.sub(" ", v))
                    raw_colors.extend(HEX_COLOR_RE.findall(scrubbed))
                    raw_colors.extend(RGB_COLOR_RE.findall(scrubbed))
                if prop == "font-family" and "var(" not in v and v.lower() not in ("inherit", "initial", "unset"):
                    raw_fonts.append(v)
            if prop in ("transition", "transition-property"):
                ta, lp = _is_bad_transition(prop, v)
                trans_all = trans_all or ta
                layout_anim = layout_anim or lp
            if prop == "overflow-x":
                ov_clean = re.sub(r"\s*!important\s*$", "", v, flags=re.I).strip().lower()
                ov_tokens = ov_clean.split()
                if ov_tokens and ov_tokens[0] == "hidden" and _is_html_body_stack(sel_stack):
                    ov_hidden = True

        token_ok = has_root_tokens and not raw_colors and not raw_fonts
        detail_val = "clean" if token_ok else {"has_root_tokens": has_root_tokens, "raw_colors": raw_colors[:5], "raw_fonts": raw_fonts[:5]}
        checks.append(_chk("css_tokens", token_ok, detail_val, "all colors and fonts via :root custom properties", "declare tokens in :root and reference them with var(--*)"))

        checks.append(_chk("no_transition_all", not trans_all and not layout_anim, "clean" if (not trans_all and not layout_anim) else {"transition_all": trans_all, "layout_prop": layout_anim}, "no transition:all or width/height/top/left animation", "animate transform/opacity only, never transition: all"))

        vw_bad = bool(VW_100_RE.search(css_blob))
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
    """Minimal stdlib YAML subset parser; returns (root, duplicate_top_keys, all_color_maps)."""
    root = {}
    dup_top = []
    color_maps = []
    stack = [(-1, root, None)]  # (indent, container, key_in_parent)
    for raw in block.splitlines():
        line = _strip_yaml_comment(raw)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if stripped.startswith("- "):
            # Support both 0-indented (same indent as parent key) and indented block lists (including lists of mappings)
            while len(stack) > 1 and indent < stack[-1][0]:
                stack.pop()
            if len(stack) > 1 and not isinstance(stack[-1][1], list) and indent <= stack[-1][0]:
                # Only pop a non-list item if its container was a previous list-item mapping
                if stack[-1][2] is None and isinstance(stack[-2][1], list):
                    stack.pop()
            _, container, k_in_parent = stack[-1]
            if (
                isinstance(container, dict)
                and container == {}
                and len(stack) > 1
                and k_in_parent is not None
                and isinstance(stack[-2][1], dict)
            ):
                lst = []
                stack[-2][1][k_in_parent] = lst
                stack[-1] = (stack[-1][0], lst, k_in_parent)
                container = lst
            item_raw = stripped[2:].strip()
            if isinstance(container, list):
                m_item = YAML_LIST_MAP_RE.match(item_raw)
                if m_item:
                    ik = m_item.group(1).strip().strip("\"'")
                    iv = (m_item.group(2) or "").strip().strip("\"'")
                    entry = {ik: iv} if iv else {ik: {}}
                    if k_in_parent == "omitted" and ik == "section" and iv:
                        container.append(iv)
                    else:
                        container.append(entry)
                    stack.append((indent + 1, entry, None))
                else:
                    container.append(item_raw.strip("\"'"))
            continue
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if not isinstance(parent, dict):
            continue
        if ":" not in stripped:
            continue
        key, rest = stripped.split(":", 1)
        key = key.strip().strip("\"'")
        val = rest.strip()
        if parent is root and key in root:
            dup_top.append(key)
        if val == "":
            child = {}
            if parent is root and key == "colors":
                color_maps.append(child)
            parent[key] = child
            stack.append((indent, child, key))
        else:
            if val.startswith("[") and val.endswith("]"):
                parent[key] = [x.strip().strip("\"'") for x in val[1:-1].split(",") if x.strip()]
            else:
                parent[key] = val.strip("\"'")
    return root, dup_top, color_maps


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
        parsed, block_dups, blk_colors = _parse_simple_yaml(blk)
        dup_keys.extend(block_dups)
        all_color_maps.extend(blk_colors)
        for k, v in parsed.items():
            if k in merged:
                dup_keys.append(k)
            else:
                merged[k] = v

    checks = []
    checks.append(_chk("yaml_blocks_present", bool(blocks), len(blocks), ">= 1 YAML token block", "DESIGN.md embeds YAML front matter or fenced yaml token blocks"))
    checks.append(_chk("unique_top_keys", not dup_keys, dup_keys or "unique", "[]", "each top-level schema key is defined at most once"))

    raw_omitted = merged.get("omitted")
    if isinstance(raw_omitted, list):
        omitted = {
            x if isinstance(x, str) else x.get("section", "")
            for x in raw_omitted
            if isinstance(x, str) or (isinstance(x, dict) and isinstance(x.get("section"), str))
        } - {""}
    elif isinstance(raw_omitted, dict):
        omitted = {k for k in raw_omitted.keys() if isinstance(k, str)}
    else:
        omitted = set()
    has_name = isinstance(merged.get("name"), str) and bool(merged["name"].strip())
    has_colors = ("colors" in merged and isinstance(merged["colors"], dict) and bool(merged["colors"])) or ("colors" in omitted)
    checks.append(_chk("required_fields", has_name and has_colors, {"name": has_name, "colors_or_omitted": has_colors}, "name + colors (or omitted)", "DESIGN.md defines name and colors palette"))

    flat = _flatten_tokens(merged)
    bad_colors = []
    for cmap in all_color_maps:
        for k, v in _flatten_tokens(cmap, "colors").items():
            if isinstance(v, str) and not _is_valid_css_color(v):
                bad_colors.append(f"{k}={v}")
    checks.append(_chk("valid_color_tokens", not bad_colors, bad_colors or "valid", "[]", "color tokens use valid CSS color syntax or token references"))

    broken_refs = []
    for cmap in all_color_maps:
        for k, v in _flatten_tokens(cmap, "colors").items():
            if isinstance(v, str):
                for rm in TOKEN_REF_RE.finditer(v):
                    ref = rm.group(1)
                    resolved_val, kind, terminal = _resolve_token_ref(k, ref, flat)
                    if resolved_val is None:
                        broken_refs.append(f"{k}->{{{ref}}}({kind})")
                    elif kind != "scalar" or not terminal.startswith("colors."):
                        broken_refs.append(f"{k}->{{{ref}}}(non-color)")
    for k, v in flat.items():
        if k.startswith("colors."):
            continue
        if isinstance(v, str):
            for rm in TOKEN_REF_RE.finditer(v):
                ref = rm.group(1)
                resolved_val, kind, _ = _resolve_token_ref(k, ref, flat)
                if resolved_val is None:
                    broken_refs.append(f"{k}->{{{ref}}}({kind})")
    checks.append(_chk("token_refs_valid", not broken_refs, broken_refs or "valid", "[]", "every {path.to.token} reference resolves to a non-cyclic token"))

    base_dir = os.path.realpath(os.path.dirname(os.path.abspath(path)))
    unsafe_ext = []
    for em in EXT_REF_RE.finditer(text):
        base_ref = em.group(1).rstrip(",;:!?")
        if not base_ref or base_ref.lower() in CSS_AT_RULES:
            continue
        cands = [base_ref]
        stripped_dot = base_ref.rstrip(".")
        if stripped_dot and stripped_dot != base_ref:
            cands.append(stripped_dot)
        for cand in cands:
            if cand.lower() in CSS_AT_RULES:
                continue
            norm = cand.replace("\\", "/")
            if norm.startswith("/") or norm.startswith("~") or re.match(r"^[A-Za-z]:", norm) or ".." in norm.split("/"):
                unsafe_ext.append(base_ref)
                break
            resolved = os.path.realpath(os.path.join(base_dir, norm))
            if not (resolved == base_dir or resolved.startswith(base_dir + os.sep)):
                unsafe_ext.append(base_ref)
                break
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
    lit_count = spec.get("lit_count")
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


def check_iso_file(path, pre_render=False):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("iso_file_exists", False, path, "existing JSON file", "iso spec path does not exist or is not a file")]}
    try:
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "checks": [_chk("iso_json_valid", False, str(exc), "valid JSON", "iso spec must be valid JSON")]}
    return check_iso_spec(spec, pre_render=pre_render)


def _finite_num(val):
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        f = float(val)
        return f if math.isfinite(f) else None
    return None


def _strict_int(val):
    return val if isinstance(val, int) and not isinstance(val, bool) else None


def check_ink_anim_spec(spec, pre_render=False):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "ink-anim spec must be a JSON object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - INK_ANIM_KNOWN_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized keys: {', '.join(unknown)}"))

    checks.append(_chk("open_stroke_limbs", spec.get("open_stroke_limbs") is True, spec.get("open_stroke_limbs"), True, "limbs drawn as two open curved strokes, never closed tubes"))
    checks.append(_chk("curved_lines", spec.get("curved_lines") is True, spec.get("curved_lines"), True, "joints rounded and edges slightly bowed, never ruler-straight"))

    gait = spec.get("gait")
    if not isinstance(gait, dict):
        checks.append(_chk("planted_foot_gait", False, gait, "gait object with kind/stride/duty/period_s/scale/travel_speed", "gait mechanics object required"))
    else:
        kind = gait.get("kind").strip().lower() if isinstance(gait.get("kind"), str) else ""
        stride = _finite_num(gait.get("stride"))
        duty = _finite_num(gait.get("duty"))
        period = _finite_num(gait.get("period_s"))
        scale = _finite_num(gait.get("scale", 1.0))
        speed = _finite_num(gait.get("travel_speed"))
        kind_ok = kind in INK_GAIT_KINDS
        duty_ok = duty is not None and (0.1 < duty < 0.95) and ((duty < 0.5) if kind == "run" else (duty >= 0.5))
        if kind_ok and duty_ok and None not in (stride, period, scale, speed) and stride > 0.0 and period > 0.0 and scale > 0.0:
            want = (stride / (duty * period)) * scale
            speed_ok = abs(speed - want) <= 1e-3 * max(1.0, abs(want))
            checks.append(_chk("planted_foot_gait", speed_ok, round(speed, 4), round(want, 4), "travel_speed == (stride / (duty * period_s)) * scale so stance feet stay planted"))
        else:
            checks.append(_chk("planted_foot_gait", False, gait, "valid kind (walk/shuffle/run), duty, stride, period_s, scale, and exact travel_speed", "planted-foot gait speed must match stride / (duty * period_s) * scale"))
        checks.append(_chk("no_free_sine_walk", gait.get("free_sine_walk") is False, gait.get("free_sine_walk"), False, "never animate walking figures with free-running sines"))

    checks.append(_chk("skeleton_first_cloth", spec.get("skeleton_first_cloth") is True, spec.get("skeleton_first_cloth"), True, "solve hidden legs first and derive garment hem from forward knee and ankles"))
    checks.append(_chk("card_fixed_bg", spec.get("card_fixed_bg") is True, spec.get("card_fixed_bg"), True, "self-contained card; page background around it never shifts with time of day"))

    pal = spec.get("palette_tokens")
    pal_ok = (
        isinstance(pal, dict)
        and isinstance(pal.get("ink"), str)
        and pal["ink"].strip().lower() == "currentcolor"
        and isinstance(pal.get("paper_class"), str)
        and pal["paper_class"].strip().startswith(".")
        and len(pal["paper_class"].strip()) >= 2
    )
    checks.append(_chk("ink_paper_tokens", pal_ok, pal, "{'ink': 'currentColor', 'paper_class': '.pp'}", "ink uses currentColor and paper uses a dedicated CSS class for clean day/night retinting"))

    dbg = spec.get("debug_stepping")
    if isinstance(dbg, dict):
        qf = dbg.get("query_flag")
        sfn = dbg.get("step_fn")
        dt = _finite_num(dbg.get("dt_s"))
        dbg_ok = (
            isinstance(qf, str)
            and qf.strip().startswith("?")
            and len(qf.strip()) >= 2
            and isinstance(sfn, str)
            and bool(sfn.strip())
            and dt is not None
            and 0.0 < dt <= (1.0 / 24.0) + 1e-6
        )
    else:
        dbg_ok = False
    checks.append(_chk("deterministic_debug_step", dbg_ok, dbg, "{'query_flag': '?debug', 'step_fn': 'window.__step', 'dt_s': <= 1/24}", "skip rAF in headless/background tabs and step exact fixed frames"))

    if not pre_render:
        checks.append(_chk("zoomed_strip_checked", spec.get("zoomed_strip_checked") is True, spec.get("zoomed_strip_checked"), True, "inspected zoomed 4x-11x frame strip of every moving figure"))
        if "day_cycle_checked" in spec:
            checks.append(_chk("day_cycle_checked", spec.get("day_cycle_checked") is True, spec.get("day_cycle_checked"), True, "contrast verified across day/sunset/night/dawn palette sweep"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def check_ink_anim_file(path, pre_render=False):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("ink_anim_file_exists", False, path, "existing JSON file", "ink-anim spec path does not exist or is not a file")]}
    try:
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "checks": [_chk("ink_anim_json_valid", False, str(exc), "valid JSON", "ink-anim spec must be valid JSON")]}
    return check_ink_anim_spec(spec, pre_render=pre_render)


def check_sakuga_spec(spec, pre_render=False):
    if not isinstance(spec, dict):
        return {"ok": False, "checks": [_chk("spec_object", False, type(spec).__name__, "JSON object", "sakuga spec must be a JSON object")]}
    checks = []
    unknown = sorted(set(spec.keys()) - SAKUGA_KNOWN_KEYS)
    if unknown:
        checks.append(_chk("unknown_keys", False, unknown, "[]", f"unrecognized keys: {', '.join(unknown)}"))

    ctrl = spec.get("control").strip().lower() if isinstance(spec.get("control"), str) else ""
    checks.append(_chk("semantic_control", ctrl in SAKUGA_CONTROLS, spec.get("control"), sorted(SAKUGA_CONTROLS), "built around a real semantic control with keyboard and focus support"))
    checks.append(_chk("plain_at_rest", spec.get("plain_at_rest") is True, spec.get("plain_at_rest"), True, "control stays plain at rest with no idle animation clutter"))
    checks.append(_chk("immediate_state_change", spec.get("immediate_state_change") is True, spec.get("immediate_state_change"), True, "functional state updates immediately; drawn VFX only decorate"))

    beats = spec.get("beats")
    beats_ok = False
    sfx_ok = False
    if isinstance(beats, list) and len(beats) == 4:
        names = []
        valid_beats = True
        sfx_beats = []
        for b in beats:
            if not isinstance(b, dict):
                valid_beats = False
                break
            bn = b.get("name").strip().lower() if isinstance(b.get("name"), str) else ""
            effs = b.get("effects")
            if not isinstance(effs, list) or not all(isinstance(e, str) and e.strip() for e in effs):
                valid_beats = False
                break
            min_e = 0 if bn == "settle" else 1
            if not (min_e <= len(effs) <= 2):
                valid_beats = False
                break
            names.append(bn)
            sw = b.get("sfx_word")
            if sw is not None:
                if not (isinstance(sw, str) and sw.strip()):
                    valid_beats = False
                    break
                sfx_beats.append(bn)
        beats_ok = valid_beats and tuple(names) == SAKUGA_BEAT_ORDER
        sfx_ok = valid_beats and len(sfx_beats) <= 1 and all(bn == "hit" for bn in sfx_beats)
    checks.append(_chk("sakuga_beats", beats_ok, beats, "ordered [anticipation, hit, follow_through, settle] with 1..2 effects/beat", "explicit 4-beat reaction with 1-2 effects per beat"))
    checks.append(_chk("sakuga_sfx_on_hit", sfx_ok, [b.get("name") for b in beats if isinstance(b, dict) and b.get("sfx_word")] if isinstance(beats, list) else beats, "<= 1 sfx_word, on hit beat only", "at most one sound-effect lettering word per reaction, landing on hit"))

    checks.append(_chk("shared_clock_canvas", spec.get("shared_clock_canvas") is True, spec.get("shared_clock_canvas"), True, "single shared overlay canvas and shared clock (later queue, no raw setTimeout)"))

    vr = spec.get("visual_rules")
    if not isinstance(vr, dict):
        checks.append(_chk("sakuga_visual_rules", False, vr, "visual_rules object", "visual_rules object required"))
    else:
        checks.append(_chk("flat_two_tone_outline", vr.get("flat_two_tone_outline") is True, vr.get("flat_two_tone_outline"), True, "two flat tones plus ink outline; no gradients or blur"))
        checks.append(_chk("exit_by_shrink_not_fade", vr.get("exit_by_shrink_not_fade") is True, vr.get("exit_by_shrink_not_fade"), True, "effects leave by shrinking or thinning, never by fading opacity"))
        checks.append(_chk("spring_driven", vr.get("spring_driven") is True, vr.get("spring_driven"), True, "hand-moved controls use spring physics with velocity-driven stretch"))
        checks.append(_chk("reduced_motion_keeps_state", vr.get("reduced_motion_keeps_state") is True, vr.get("reduced_motion_keeps_state"), True, "prefers-reduced-motion disables VFX while preserving functional state changes"))
        sq = vr.get("volume_preserving_squash")
        if isinstance(sq, dict):
            sx = _finite_num(sq.get("scale_x"))
            sy = _finite_num(sq.get("scale_y"))
            sq_ok = sx is not None and sy is not None and sx > 0.0 and sy > 0.0 and (abs(sx - 1.0) > 1e-3 or abs(sy - 1.0) > 1e-3) and abs(sx * sy - 1.0) <= 0.15
        else:
            sq_ok = False
        checks.append(_chk("volume_preserving_squash", sq_ok, sq, "scale_x * scale_y in [0.85, 1.15] with active squash/stretch", "squash keeps area/volume constant (shorter means wider)"))

    cv = spec.get("css_vars")
    cv_ok = (
        isinstance(cv, dict)
        and 2 <= len(cv) <= 8
        and all(
            isinstance(k, str)
            and k.startswith("--")
            and len(k) >= 4
            and isinstance(v, str)
            and not v.strip().startswith("{")
            and _is_valid_css_color(v)
            for k, v in cv.items()
        )
    )
    checks.append(_chk("css_var_theming", cv_ok, cv, "2..8 --* CSS custom properties with valid CSS colors", "host page :root CSS variables override control colors cleanly"))

    if not pre_render:
        ver = spec.get("verification")
        if not isinstance(ver, dict):
            checks.append(_chk("sakuga_verification", False, ver, "verification object", "frame-strip and responsive/keyboard verification required"))
        else:
            ts = ver.get("frame_strip_times_s")
            ts_nums = [_finite_num(x) for x in ts] if isinstance(ts, list) else []
            ts_ok = isinstance(ts, list) and len(ts_nums) >= 4 and all(x is not None and x >= 0.0 for x in ts_nums) and all(ts_nums[i] < ts_nums[i + 1] for i in range(len(ts_nums) - 1))
            checks.append(_chk("stepped_frame_strip", ts_ok, ts, ">= 4 strictly increasing timestamps in seconds", "stepped frame strip captured across anticipation, hit, follow-through, and settle"))
            ws = ver.get("widths_px")
            ws_ints = [_strict_int(x) for x in ws] if isinstance(ws, list) else []
            ws_ok = isinstance(ws, list) and all(x is not None and x >= 320 for x in ws_ints) and any(x <= 390 for x in ws_ints) and any(x >= 1024 for x in ws_ints)
            checks.append(_chk("responsive_widths", ws_ok, ws, "phone (<=390px) and desktop (>=1024px)", "verified at both phone and desktop widths"))
            checks.append(_chk("no_horizontal_overflow", ver.get("horizontal_overflow") is False, ver.get("horizontal_overflow"), False, "zero sideways scroll at phone width"))
            checks.append(_chk("keyboard_checked", ver.get("keyboard_checked") is True, ver.get("keyboard_checked"), True, "verified with Tab focus and keyboard activation"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def check_sakuga_file(path, pre_render=False):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("sakuga_file_exists", False, path, "existing JSON file", "sakuga spec path does not exist or is not a file")]}
    try:
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "checks": [_chk("sakuga_json_valid", False, str(exc), "valid JSON", "sakuga spec must be valid JSON")]}
    return check_sakuga_spec(spec, pre_render=pre_render)


LOGO_SHAPE_TAGS = {"path", "circle", "ellipse", "rect", "polygon", "polyline", "line"}
LOGO_FORBIDDEN_TAGS = {"script", "foreignobject", "link", "iframe", "embed", "object", "image"}
LOGO_TEXT_TAGS = {"text", "tspan", "textpath"}
LOGO_EFFECT_TAGS = {"filter", "fegaussianblur", "fedropshadow", "lineargradient", "radialgradient"}
LOGO_NAMED_RGB = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "red": (255, 0, 0),
    "green": (0, 128, 0),
    "blue": (0, 0, 255),
    "navy": (0, 0, 128),
    "teal": (0, 128, 128),
    "maroon": (128, 0, 0),
    "olive": (128, 128, 0),
    "purple": (128, 0, 128),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "silver": (192, 192, 192),
    "orange": (255, 165, 0),
    "gold": (255, 215, 0),
    "crimson": (220, 20, 60),
    "indigo": (75, 0, 130),
    "ivory": (255, 255, 240),
    "beige": (245, 245, 220),
    "linen": (250, 240, 230),
    "coral": (255, 127, 80),
}
SVG_PATH_TOKEN_RE = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
SVG_TRANSFORM_RE = re.compile(r"(translate|scale|rotate)\s*\(([^)]*)\)", re.I)


def _local_tag(tag):
    if not isinstance(tag, str):
        return ""
    if "}" in tag:
        tag = tag.rsplit("}", 1)[1]
    return tag.strip().lower()


def _parse_svg_len(val):
    if not isinstance(val, str):
        return None
    s = val.strip().lower()
    if s.endswith("px"):
        s = s[:-2].strip()
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def _parse_rgb_color(val):
    """Parse #rgb, #rrggbb, rgb(...), or common named color to (r, g, b) tuple; None if none/transparent/unparsed."""
    if not isinstance(val, str):
        return None
    s = val.strip().lower()
    if s in ("", "none", "transparent", "inherit", "initial", "unset"):
        return None
    if s == "currentcolor":
        return "currentColor"
    if s in LOGO_NAMED_RGB:
        return LOGO_NAMED_RGB[s]
    m3 = re.fullmatch(r"#([0-9a-f]{3})", s)
    if m3:
        h = m3.group(1)
        return (int(h[0] * 2, 16), int(h[1] * 2, 16), int(h[2] * 2, 16))
    m6 = re.fullmatch(r"#([0-9a-f]{6})", s)
    if m6:
        h = m6.group(1)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    mrgb = re.fullmatch(r"rgb\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)\)", s)
    if mrgb:
        out = []
        for g in mrgb.groups():
            g = g.strip()
            try:
                if g.endswith("%"):
                    v = float(g[:-1]) * 2.55
                else:
                    v = float(g)
            except ValueError:
                return None
            if not math.isfinite(v):
                return None
            out.append(max(0, min(255, int(round(v)))))
        return tuple(out)
    return None


def _rel_luminance(rgb):
    def ch(c):
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])


def _contrast_ratio(rgb1, rgb2):
    l1, l2 = _rel_luminance(rgb1), _rel_luminance(rgb2)
    hi, lo = (l1, l2) if l1 >= l2 else (l2, l1)
    return (hi + 0.05) / (lo + 0.05)


def _parse_inline_style_map(el):
    out = {}
    st = el.attrib.get("style", "")
    if st:
        for seg in st.split(";"):
            if ":" in seg:
                k, v = seg.split(":", 1)
                out[k.strip().lower()] = v.strip()
    return out


def _apply_transforms(pts, tf_chain):
    """Apply list of (kind, nums) transforms right-to-left (SVG order) to (x, y) points."""
    out = list(pts)
    for kind, nums in reversed(tf_chain):
        if kind == "translate" and len(nums) >= 1:
            tx = nums[0]
            ty = nums[1] if len(nums) >= 2 else 0.0
            out = [(x + tx, y + ty) for x, y in out]
        elif kind == "scale" and len(nums) >= 1:
            sx = nums[0]
            sy = nums[1] if len(nums) >= 2 else sx
            out = [(x * sx, y * sy) for x, y in out]
        elif kind == "rotate" and len(nums) >= 1:
            ang = math.radians(nums[0])
            cx = nums[1] if len(nums) >= 3 else 0.0
            cy = nums[2] if len(nums) >= 3 else 0.0
            ca, sa = math.cos(ang), math.sin(ang)
            out = [((x - cx) * ca - (y - cy) * sa + cx, (x - cx) * sa + (y - cy) * ca + cy) for x, y in out]
    return out


def _parse_transform_list(attr):
    if not attr:
        return []
    out = []
    for m in SVG_TRANSFORM_RE.finditer(attr):
        kind = m.group(1).lower()
        nums = [float(x) for x in re.findall(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", m.group(2))]
        if nums and all(math.isfinite(x) for x in nums):
            out.append((kind, nums))
    return out


def _path_points_and_cmds(d):
    """Return (points, cmd_count) from SVG path data d (handles all absolute and relative commands)."""
    tokens = SVG_PATH_TOKEN_RE.findall(d or "")
    pts = []
    cmds = 0
    cx = cy = sx = sy = 0.0
    cmd = None
    i = 0
    n = len(tokens)

    def next_f():
        nonlocal i
        if i >= n or tokens[i].isalpha():
            return None
        v = float(tokens[i])
        i += 1
        return v

    while i < n:
        tok = tokens[i]
        if tok.isalpha():
            cmd = tok
            cmds += 1
            i += 1
            if cmd in ("Z", "z"):
                cx, cy = sx, sy
                continue
        if cmd is None:
            i += 1
            continue
        if cmd in ("M", "m", "L", "l", "T", "t"):
            x, y = next_f(), next_f()
            if x is None or y is None:
                break
            cx, cy = (cx + x, cy + y) if cmd.islower() else (x, y)
            if cmd in ("M", "m"):
                sx, sy = cx, cy
                cmd = "l" if cmd == "m" else "L"
            pts.append((cx, cy))
        elif cmd in ("H", "h"):
            x = next_f()
            if x is None:
                break
            cx = cx + x if cmd == "h" else x
            pts.append((cx, cy))
        elif cmd in ("V", "v"):
            y = next_f()
            if y is None:
                break
            cy = cy + y if cmd == "v" else y
            pts.append((cx, cy))
        elif cmd in ("C", "c"):
            vals = [next_f() for _ in range(6)]
            if any(v is None for v in vals):
                break
            if cmd == "c":
                p1, p2, p3 = (cx + vals[0], cy + vals[1]), (cx + vals[2], cy + vals[3]), (cx + vals[4], cy + vals[5])
            else:
                p1, p2, p3 = (vals[0], vals[1]), (vals[2], vals[3]), (vals[4], vals[5])
            pts.extend([p1, p2, p3])
            cx, cy = p3
        elif cmd in ("S", "s", "Q", "q"):
            vals = [next_f() for _ in range(4)]
            if any(v is None for v in vals):
                break
            if cmd.islower():
                p1, p2 = (cx + vals[0], cy + vals[1]), (cx + vals[2], cy + vals[3])
            else:
                p1, p2 = (vals[0], vals[1]), (vals[2], vals[3])
            pts.extend([p1, p2])
            cx, cy = p2
        elif cmd in ("A", "a"):
            vals = [next_f() for _ in range(7)]
            if any(v is None for v in vals):
                break
            nx, ny = (cx + vals[5], cy + vals[6]) if cmd == "a" else (vals[5], vals[6])
            pts.append((nx, ny))
            cx, cy = nx, ny
        else:
            i += 1
    return pts, cmds


def check_logo_svg(path, allow_draft_text=False, surface=None):
    if not os.path.isfile(path):
        return {"ok": False, "checks": [_chk("logo_file_exists", False, path, "existing SVG file", "logo SVG path does not exist or is not a file")]}
    try:
        raw = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError) as exc:
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, str(exc), "readable UTF-8 SVG", "logo SVG must be readable UTF-8")]}
    if re.search(r"<!\s*ENTITY\b|<!\s*DOCTYPE\b[^>]*\b(?:SYSTEM|PUBLIC)\b", raw, re.I):
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, "XML entity/DTD declaration", "plain SVG without <!ENTITY> or external DTD", "reject XML entity and external DTD declarations in logo SVG")]}
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, str(exc), "valid XML/SVG", "logo SVG must parse cleanly as XML")]}
    if _local_tag(root.tag) != "svg":
        return {"ok": False, "checks": [_chk("logo_svg_valid", False, _local_tag(root.tag), "svg", "root element must be <svg>")]}

    checks = [_chk("logo_svg_valid", True, "valid", "valid <svg>", "SVG parsed cleanly")]

    # 1. Explicit clean viewBox and width/height aspect match
    vb_raw = root.attrib.get("viewBox", "").strip()
    vb_nums = [_parse_svg_len(t) for t in re.split(r"[\s,]+", vb_raw) if t] if vb_raw else []
    vb_ok = len(vb_nums) == 4 and all(v is not None for v in vb_nums) and vb_nums[2] > 0.0 and vb_nums[3] > 0.0
    if vb_ok:
        vb_x, vb_y, vb_w, vb_h = vb_nums
        w_attr = _parse_svg_len(root.attrib.get("width", ""))
        h_attr = _parse_svg_len(root.attrib.get("height", ""))
        if w_attr is not None and h_attr is not None:
            if w_attr <= 0.0 or h_attr <= 0.0:
                vb_ok = False
            else:
                ar_vb = vb_w / vb_h
                ar_wh = w_attr / h_attr
                if abs(ar_wh - ar_vb) / max(ar_vb, 1e-9) > 0.05:
                    vb_ok = False
    else:
        vb_x, vb_y, vb_w, vb_h = 0.0, 0.0, 100.0, 100.0
    checks.append(_chk("logo_viewbox", vb_ok, vb_raw or "missing", "4-number viewBox with positive dimensions matching width/height ratio", "explicit viewBox required so logo scales cleanly"))

    # Walk tree with inherited fill/stroke/stroke-width and transform chain
    security_hits = []
    text_hits = 0
    effect_hits = []
    shape_count = 0
    path_cmd_total = 0
    thin_features = []
    bbox = [float("inf"), float("inf"), float("-inf"), float("-inf")]
    colors_seen = set()
    has_current_color = False
    vb_short = min(vb_w, vb_h)
    min_feature = vb_short / 32.0

    def walk(el, inh_fill, inh_stroke, inh_sw, tf_chain, in_non_render=False):
        nonlocal text_hits, shape_count, path_cmd_total, has_current_color
        tag = _local_tag(el.tag)
        if tag in LOGO_FORBIDDEN_TAGS:
            security_hits.append(f"<{tag}>")
        if tag in LOGO_TEXT_TAGS and not in_non_render:
            text_hits += 1
        if tag in LOGO_EFFECT_TAGS:
            effect_hits.append(f"<{tag}>")
        if tag == "style" and el.text:
            if re.search(r"@import\b|url\s*\(\s*['\"]?(?:https?:|//|javascript:|data:)", el.text, re.I):
                security_hits.append("external-style-ref")

        style_map = _parse_inline_style_map(el)
        for k, v in el.attrib.items():
            kl = _local_tag(k)
            vl = (v or "").strip()
            if kl.startswith("on"):
                security_hits.append(f"attr:{kl}")
            if kl in ("href", "src") and re.match(r"^(?:javascript:|https?:|//|file:|data:text/html)", vl, re.I):
                security_hits.append(f"{kl}:{vl[:24]}")
            if kl == "filter" and vl.lower() not in ("", "none"):
                effect_hits.append(f"filter:{vl}")
        if "filter" in style_map and style_map["filter"].lower() != "none":
            effect_hits.append(f"style-filter:{style_map['filter']}")
        if "style" in el.attrib and re.search(r"url\s*\(\s*['\"]?(?:https?:|//|javascript:)", el.attrib["style"], re.I):
            security_hits.append("style-external-url")

        cur_fill = style_map.get("fill", el.attrib.get("fill", inh_fill))
        cur_stroke = style_map.get("stroke", el.attrib.get("stroke", inh_stroke))
        cur_sw_raw = style_map.get("stroke-width", el.attrib.get("stroke-width", inh_sw))
        cur_tf = tf_chain + _parse_transform_list(el.attrib.get("transform", ""))
        next_non_render = in_non_render or (tag in ("defs", "clippath", "mask", "symbol", "title", "desc", "metadata"))

        if tag in LOGO_SHAPE_TAGS and not next_non_render:
            shape_count += 1
            for prop_val in (cur_fill, cur_stroke):
                if isinstance(prop_val, str) and prop_val.strip().lower().startswith("url("):
                    effect_hits.append(f"paint:{prop_val.strip()}")
                parsed_c = _parse_rgb_color(prop_val)
                if parsed_c == "currentColor":
                    has_current_color = True
                elif isinstance(parsed_c, tuple):
                    colors_seen.add(parsed_c)

            tf_scale_x = tf_scale_y = 1.0
            for tk, tnums in cur_tf:
                if tk == "scale" and tnums:
                    tf_scale_x *= abs(tnums[0])
                    tf_scale_y *= abs(tnums[1] if len(tnums) >= 2 else tnums[0])
            eff_scale_min = min(tf_scale_x, tf_scale_y)
            eff_scale_max = max(tf_scale_x, tf_scale_y)

            stroke_active = isinstance(cur_stroke, str) and cur_stroke.strip().lower() not in ("", "none", "transparent")
            sw_val = _parse_svg_len(cur_sw_raw) if cur_sw_raw is not None else 1.0
            if sw_val is None:
                sw_val = 1.0
            eff_sw = sw_val * eff_scale_min
            if stroke_active and eff_sw < min_feature - 1e-6:
                thin_features.append(f"{tag}:stroke-width={round(eff_sw, 3)}<{round(min_feature, 3)}")
            pad = (sw_val * eff_scale_max / 2.0) if stroke_active else 0.0

            pts = []
            if tag == "rect":
                x = _parse_svg_len(el.attrib.get("x", "0")) or 0.0
                y = _parse_svg_len(el.attrib.get("y", "0")) or 0.0
                w = _parse_svg_len(el.attrib.get("width", "0")) or 0.0
                h = _parse_svg_len(el.attrib.get("height", "0")) or 0.0
                if w * tf_scale_x < min_feature - 1e-6 or h * tf_scale_y < min_feature - 1e-6:
                    thin_features.append(f"rect:{round(w * tf_scale_x, 2)}x{round(h * tf_scale_y, 2)}<{round(min_feature, 2)}")
                pts = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)]
            elif tag == "circle":
                cx = _parse_svg_len(el.attrib.get("cx", "0")) or 0.0
                cy = _parse_svg_len(el.attrib.get("cy", "0")) or 0.0
                r = _parse_svg_len(el.attrib.get("r", "0")) or 0.0
                if 2.0 * r * eff_scale_min < min_feature - 1e-6:
                    thin_features.append(f"circle:d={round(2 * r * eff_scale_min, 2)}<{round(min_feature, 2)}")
                pts = [(cx - r, cy - r), (cx + r, cy + r)]
            elif tag == "ellipse":
                cx = _parse_svg_len(el.attrib.get("cx", "0")) or 0.0
                cy = _parse_svg_len(el.attrib.get("cy", "0")) or 0.0
                rx = _parse_svg_len(el.attrib.get("rx", "0")) or 0.0
                ry = _parse_svg_len(el.attrib.get("ry", "0")) or 0.0
                if 2.0 * rx * tf_scale_x < min_feature - 1e-6 or 2.0 * ry * tf_scale_y < min_feature - 1e-6:
                    thin_features.append(f"ellipse:{round(2 * rx * tf_scale_x, 2)}x{round(2 * ry * tf_scale_y, 2)}<{round(min_feature, 2)}")
                pts = [(cx - rx, cy - ry), (cx + rx, cy + ry)]
            elif tag == "line":
                x1 = _parse_svg_len(el.attrib.get("x1", "0")) or 0.0
                y1 = _parse_svg_len(el.attrib.get("y1", "0")) or 0.0
                x2 = _parse_svg_len(el.attrib.get("x2", "0")) or 0.0
                y2 = _parse_svg_len(el.attrib.get("y2", "0")) or 0.0
                pts = [(x1, y1), (x2, y2)]
            elif tag in ("polygon", "polyline"):
                nums = [float(x) for x in re.findall(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", el.attrib.get("points", ""))]
                pts = [(nums[k], nums[k + 1]) for k in range(0, len(nums) - 1, 2)]
            elif tag == "path":
                ppts, cmds = _path_points_and_cmds(el.attrib.get("d", ""))
                path_cmd_total += cmds
                pts = ppts

            if pts:
                tpts = _apply_transforms(pts, cur_tf)
                for px, py in tpts:
                    bbox[0] = min(bbox[0], px - pad)
                    bbox[1] = min(bbox[1], py - pad)
                    bbox[2] = max(bbox[2], px + pad)
                    bbox[3] = max(bbox[3], py + pad)

        for child in list(el):
            walk(child, cur_fill, cur_stroke, cur_sw_raw, cur_tf, next_non_render)

    walk(root, "black", "none", None, [], False)

    checks.append(_chk("logo_self_contained", not security_hits, security_hits or "clean", "[]", "zero <script>, event handlers, <image>, <foreignObject>, or external URLs"))
    text_ok = allow_draft_text or text_hits == 0
    checks.append(_chk("logo_outlined_text", text_ok, text_hits if not text_ok else "outlined", "0 <text> nodes (or --allow-draft-text)", "convert wordmark glyphs to <path> outlines so logos never font-substitute"))
    comp_ok = (1 <= shape_count <= 64) and (path_cmd_total <= 400)
    checks.append(_chk("logo_complexity", comp_ok, {"shapes": shape_count, "path_cmds": path_cmd_total}, "1..64 shapes and <= 400 path commands", "clean vector geometry without bloated auto-trace soup"))
    checks.append(_chk("logo_micro_legibility", not thin_features, thin_features or "legible", f"strokes/features >= {round(min_feature, 3)} (>= 0.5px at 16px favicon)", "features survive 16px favicon downscale without vanishing"))

    if bbox[0] <= bbox[2] and bbox[1] <= bbox[3]:
        mx, my = 0.04 * vb_w, 0.04 * vb_h
        cs_ok = (
            bbox[0] >= vb_x + mx - 1e-6
            and bbox[1] >= vb_y + my - 1e-6
            and bbox[2] <= vb_x + vb_w - mx + 1e-6
            and bbox[3] <= vb_y + vb_h - my + 1e-6
        )
        cs_val = [round(v, 2) for v in bbox]
    else:
        cs_ok = False
        cs_val = "empty"
    checks.append(_chk("logo_clearspace", cs_ok, cs_val, f"within [{round(vb_x + 0.04*vb_w, 2)}, {round(vb_y + 0.04*vb_h, 2)}]..[{round(vb_x + 0.96*vb_w, 2)}, {round(vb_y + 0.96*vb_h, 2)}]", "keep >= 4% clearspace inside viewBox with zero clipped edges"))

    checks.append(_chk("logo_monochrome_safe", not effect_hits, effect_hits or "flat", "[]", "flat solid shapes without gradients, blur, or drop-shadow filters"))

    total_inks = len(colors_seen) + (1 if has_current_color else 0)
    pal_ok = 1 <= total_inks <= 3
    checks.append(_chk("logo_palette_restraint", pal_ok, total_inks, "1..3 distinct brand colors", "cap logo palette to at most 3 distinct flat brand inks"))

    if surface is not None:
        surf_rgb = _parse_rgb_color(surface)
        if not isinstance(surf_rgb, tuple):
            contrast_ok = False
            contrast_val = f"invalid surface {surface}"
        elif not colors_seen and has_current_color:
            contrast_ok = True
            contrast_val = "currentColor"
        else:
            ratios = [round(_contrast_ratio(c, surf_rgb), 2) for c in colors_seen]
            contrast_ok = bool(ratios) and all(r >= 3.0 for r in ratios)
            contrast_val = {"surface": surface, "min_ratio": min(ratios) if ratios else 0.0}
    else:
        if not colors_seen and has_current_color:
            contrast_ok = True
            contrast_val = "currentColor"
        else:
            light_ok = bool(colors_seen) and all(_contrast_ratio(c, (255, 255, 255)) >= 3.0 for c in colors_seen)
            dark_ok = bool(colors_seen) and all(_contrast_ratio(c, (17, 17, 17)) >= 3.0 for c in colors_seen)
            contrast_ok = light_ok or dark_ok
            min_l = round(min((_contrast_ratio(c, (255, 255, 255)) for c in colors_seen), default=0.0), 2)
            min_d = round(min((_contrast_ratio(c, (17, 17, 17)) for c in colors_seen), default=0.0), 2)
            contrast_val = {"min_on_light": min_l, "min_on_dark": min_d}
    checks.append(_chk("logo_contrast", contrast_ok, contrast_val, ">= 3.0:1 WCAG graphical contrast on light or dark surface (no fake white-fill cutouts)", "all logo inks meet >= 3:1 contrast on their target surface"))

    ok = bool(checks) and all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="HTML/CSS file or directory to audit against anti-slop Floor rules")
    ap.add_argument("--design-md", help="DESIGN.md file to validate against token and reference schema")
    ap.add_argument("--iso", help="Isometric technical illustration contract JSON to verify")
    ap.add_argument("--ink-anim", help="Line-art SVG ink animation contract JSON to verify")
    ap.add_argument("--sakuga", help="Sakuga tactile UI VFX control contract JSON to verify")
    ap.add_argument("--logo", help="Vector logo SVG file to validate against studio logo invariants")
    ap.add_argument("--allow-draft-text", action="store_true", help="For --logo: allow live <text> elements during early draft lockups")
    ap.add_argument("--surface", default=None, help="For --logo: target background color (e.g. #FFFFFF or #111111) for WCAG >= 3:1 contrast check")
    ap.add_argument("--pre-render", action="store_true", help="For --iso/--ink-anim/--sakuga: validate pre-render plan without requiring post-render audit flags")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    modes = (a.html, a.design_md, a.iso, a.ink_anim, a.sakuga, a.logo)
    if sum(bool(x) for x in modes) != 1:
        ap.error("provide exactly one of --html, --design-md, --iso, --ink-anim, --sakuga, or --logo")
    if a.html:
        res = check_html_path(a.html)
    elif a.design_md:
        res = check_design_md(a.design_md)
    elif a.iso:
        res = check_iso_file(a.iso, pre_render=a.pre_render)
    elif a.ink_anim:
        res = check_ink_anim_file(a.ink_anim, pre_render=a.pre_render)
    elif a.sakuga:
        res = check_sakuga_file(a.sakuga, pre_render=a.pre_render)
    else:
        res = check_logo_svg(a.logo, allow_draft_text=a.allow_draft_text, surface=a.surface)

    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

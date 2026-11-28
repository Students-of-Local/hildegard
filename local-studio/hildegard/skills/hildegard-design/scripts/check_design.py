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
EMOJI_EXTRA_CPS = {0x26A0, 0x26A1, 0x2705, 0x2728, 0x274C, 0x2764}
ROOT_THEME_SEL_RE = re.compile(
    r"^(?::root(?:\[data-theme[^\]]*\])?|html(?:\[data-theme[^\]]*\])?|\[data-theme[^\]]*\])$",
    re.I,
)


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


def _is_root_theme_stack(sel_stack):
    """True iff sel_stack is a pure root/theme token selector (optionally wrapped in @media/@layer/@supports)."""
    if not sel_stack:
        return False
    if any(not s.lstrip().startswith("@") for s in sel_stack[:-1]):
        return False
    inner = sel_stack[-1].strip()
    if not inner:
        return False
    parts = [p.strip() for p in inner.split(",") if p.strip()]
    return bool(parts) and all(ROOT_THEME_SEL_RE.match(p) for p in parts)


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
                if ov_tokens and ov_tokens[0] == "hidden":
                    parts = [p.strip().lower() for p in sel_stack[-1].split(",")]
                    if any(p in ("html", "body") for p in parts):
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
                if re.match(r"^[A-Za-z0-9_.-]+\s*:(?:\s|$)", item_raw):
                    ik, iv = item_raw.split(":", 1)
                    ik = ik.strip().strip("\"'")
                    iv = iv.strip().strip("\"'")
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

    omitted = set(merged.get("omitted", [])) if isinstance(merged.get("omitted"), list) else set()
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
        res = check_iso_file(a.iso, pre_render=a.pre_render)

    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
        print("RESULT: " + ("all checks pass" if res["ok"] else "FIX the lines above"))
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

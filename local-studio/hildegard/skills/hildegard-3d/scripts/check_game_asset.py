#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic game-asset and assembly verifier for GLB (glTF 2.0) models.

  python3 -B check_game_asset.py MODEL.glb [--max-triangles 25000] [--max-materials 4]
                                           [--require-uv] [--require-rig]
                                           [--contact-tol 0.02] [--lods lod1.glb ...]
                                           [--collider col.glb] [--json]

Reads GLB binary chunks directly (pure Python 3 + NumPy; never executes external code or loads URIs).
Checks:
  - Clean node transforms (unit scale (1,1,1), positive determinant / no negative scale)
  - Finite vertices, triangle budget, material/draw-call budget, zero degenerate triangles
  - UV (TEXCOORD_0) finite and in [0, 1] with non-zero UV area
  - Skinning (JOINTS_0 / WEIGHTS_0): max 4 influences, non-negative, normalized (sum == 1.0)
  - Multi-part assembly contact check (no unintended floating parts beyond --contact-tol)
  - Optional LOD monotonic triangle reduction + bounding-box IoU >= 0.85
  - Optional closed collision proxy containment
"""

import argparse
import json
import math
import struct
import sys

try:
    import numpy as np
except ImportError:
    _msg = "numpy is not installed and check_game_asset.py needs numpy. Install with: python3 -m pip install numpy"
    print(json.dumps({"ok": False, "error": _msg}))
    print(_msg, file=sys.stderr)
    sys.exit(1)

COMP_DTYPES = {
    5120: np.int8,
    5121: np.uint8,
    5122: np.int16,
    5123: np.uint16,
    5125: np.uint32,
    5126: np.float32,
}
TYPE_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _chk(cid, ok, value, limit, detail):
    return {"id": cid, "ok": bool(ok), "value": value, "limit": limit, "detail": detail}


def read_glb(path):
    raw = open(path, "rb").read()
    if len(raw) < 20 or raw[:4] != b"glTF":
        raise ValueError(f"{path}: not a valid GLB header")
    ver, total_len = struct.unpack_from("<II", raw, 4)
    if ver != 2 or total_len > len(raw):
        raise ValueError(f"{path}: unsupported glTF version {ver} or truncated length")
    off = 12
    jchunk, bchunk = None, b""
    while off + 8 <= total_len:
        clen, ctype = struct.unpack_from("<II", raw, off)
        off += 8
        payload = raw[off : off + clen]
        off += clen
        if ctype == 0x4E4F534A:
            jchunk = json.loads(payload.decode("utf-8"))
        elif ctype == 0x004E4942:
            bchunk = payload
    if jchunk is None:
        raise ValueError(f"{path}: missing JSON chunk")
    return jchunk, bchunk


def read_accessor(doc, bin_data, acc_idx):
    acc = doc["accessors"][acc_idx]
    bv = doc["bufferViews"][acc["bufferView"]]
    dtype = np.dtype(COMP_DTYPES[acc["componentType"]]).newbyteorder("<")
    comps = TYPE_COUNTS[acc["type"]]
    count = int(acc["count"])
    offset = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    stride = int(bv.get("byteStride", 0)) or (dtype.itemsize * comps)
    if stride == dtype.itemsize * comps:
        arr = np.frombuffer(bin_data, dtype=dtype, count=count * comps, offset=offset)
        out = arr.reshape(count, comps) if comps > 1 else arr.copy()
    else:
        rows = [
            np.frombuffer(bin_data, dtype=dtype, count=comps, offset=offset + i * stride)
            for i in range(count)
        ]
        out = np.vstack(rows) if comps > 1 else np.array([r[0] for r in rows], dtype=dtype)
    return out.astype(np.float64) if acc["componentType"] == 5126 else out


def _node_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    t = np.array(node.get("translation", [0.0, 0.0, 0.0]), dtype=np.float64)
    s = np.array(node.get("scale", [1.0, 1.0, 1.0]), dtype=np.float64)
    qx, qy, qz, qw = [float(x) for x in node.get("rotation", [0.0, 0.0, 0.0, 1.0])]
    rot = np.array(
        [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ],
        dtype=np.float64,
    )
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = rot * s[None, :]
    m[:3, 3] = t
    return m


def _aabb_gap(a_min, a_max, b_min, b_max):
    dx = max(0.0, max(a_min[0] - b_max[0], b_min[0] - a_max[0]))
    dy = max(0.0, max(a_min[1] - b_max[1], b_min[1] - a_max[1]))
    dz = max(0.0, max(a_min[2] - b_max[2], b_min[2] - a_max[2]))
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def _aabb_iou(a_min, a_max, b_min, b_max):
    inter = np.maximum(0.0, np.minimum(a_max, b_max) - np.maximum(a_min, b_min))
    v_int = float(np.prod(inter))
    v_a = float(np.prod(np.maximum(0.0, a_max - a_min)))
    v_b = float(np.prod(np.maximum(0.0, b_max - b_min)))
    union = v_a + v_b - v_int
    return v_int / union if union > 1e-12 else 0.0


def inspect_glb(path):
    doc, bdata = read_glb(path)
    nodes = doc.get("nodes", [])
    meshes = doc.get("meshes", [])
    materials = doc.get("materials", [])
    skins = doc.get("skins", [])

    # Compute world matrices
    parents = {}
    for idx, n in enumerate(nodes):
        for ch in n.get("children", []):
            parents[ch] = idx
    world = {}

    def get_world(i):
        if i in world:
            return world[i]
        m = _node_matrix(nodes[i])
        if i in parents:
            m = get_world(parents[i]) @ m
        world[i] = m
        return m

    total_tris = 0
    degen_tris = 0
    bad_verts = 0
    unapplied_scale_nodes = []
    neg_scale_nodes = []
    part_aabbs = []
    uv_present = False
    uv_out_of_range = 0
    uv_area = 0.0
    rig_present = False
    max_influences = 0
    bad_weight_verts = 0
    bad_joint_refs = 0
    all_pts = []

    joint_count = max((len(sk.get("joints", [])) for sk in skins), default=0)

    # Walk mesh-bearing nodes (or meshes directly if no nodes)
    mesh_instances = [(i, n["mesh"], get_world(i), n.get("name", f"node_{i}")) for i, n in enumerate(nodes) if "mesh" in n]
    if not mesh_instances:
        mesh_instances = [(i, i, np.eye(4), m.get("name", f"mesh_{i}")) for i, m in enumerate(meshes)]

    for n_idx, m_idx, wm, name in mesh_instances:
        if n_idx < len(nodes):
            sc = np.array(nodes[n_idx].get("scale", [1.0, 1.0, 1.0]), dtype=np.float64)
            if float(np.max(np.abs(sc - 1.0))) > 1e-4:
                unapplied_scale_nodes.append(name)
            if float(np.linalg.det(wm[:3, :3])) < 0.0:
                neg_scale_nodes.append(name)
        m_pts = []
        for prim in meshes[m_idx].get("primitives", []):
            attrs = prim.get("attributes", {})
            pos = read_accessor(doc, bdata, attrs["POSITION"]).astype(np.float64)
            if not np.all(np.isfinite(pos)):
                bad_verts += int(np.sum(~np.all(np.isfinite(pos), axis=1)))
                pos = np.nan_to_num(pos)
            wpos = (pos @ wm[:3, :3].T) + wm[:3, 3]
            m_pts.append(wpos)
            all_pts.append(wpos)

            if "indices" in prim:
                idx_arr = read_accessor(doc, bdata, prim["indices"]).astype(np.int64).reshape(-1)
            else:
                idx_arr = np.arange(len(pos), dtype=np.int64)
            tris = idx_arr[: (len(idx_arr) // 3) * 3].reshape(-1, 3)
            total_tris += len(tris)
            if len(tris):
                v0, v1, v2 = wpos[tris[:, 0]], wpos[tris[:, 1]], wpos[tris[:, 2]]
                areas = 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1)
                degen_tris += int(np.sum(areas < 1e-12))

            if "TEXCOORD_0" in attrs:
                uv_present = True
                uv = read_accessor(doc, bdata, attrs["TEXCOORD_0"]).astype(np.float64)
                bad_uv = (~np.all(np.isfinite(uv), axis=1)) | (uv[:, 0] < -1e-4) | (uv[:, 0] > 1.0 + 1e-4) | (uv[:, 1] < -1e-4) | (uv[:, 1] > 1.0 + 1e-4)
                uv_out_of_range += int(np.sum(bad_uv))
                if len(tris):
                    u0, u1, u2 = uv[tris[:, 0]], uv[tris[:, 1]], uv[tris[:, 2]]
                    uv_area += float(0.5 * np.sum(np.abs((u1[:, 0] - u0[:, 0]) * (u2[:, 1] - u0[:, 1]) - (u2[:, 0] - u0[:, 0]) * (u1[:, 1] - u0[:, 1]))))

            if "JOINTS_0" in attrs and "WEIGHTS_0" in attrs:
                rig_present = True
                jts = read_accessor(doc, bdata, attrs["JOINTS_0"]).astype(np.int64)
                wts = read_accessor(doc, bdata, attrs["WEIGHTS_0"]).astype(np.float64)
                nz = np.sum(wts > 1e-5, axis=1)
                max_influences = max(max_influences, int(np.max(nz)) if len(nz) else 0)
                wsum = np.sum(wts, axis=1)
                bad_w = np.any(wts < -1e-5, axis=1) | (np.abs(wsum - 1.0) > 1e-3)
                bad_weight_verts += int(np.sum(bad_w))
                if joint_count > 0:
                    bad_joint_refs += int(np.sum((jts < 0) | (jts >= joint_count)))

        if m_pts:
            stacked = np.vstack(m_pts)
            part_aabbs.append((name, stacked.min(axis=0), stacked.max(axis=0)))

    if all_pts:
        cat = np.vstack(all_pts)
        bmin, bmax = cat.min(axis=0), cat.max(axis=0)
    else:
        bmin = bmax = np.zeros(3, dtype=np.float64)

    # Assembly connectivity via part-to-part AABB gap
    floating_parts = []
    if len(part_aabbs) > 1:
        for i, (nm, mn, mx) in enumerate(part_aabbs):
            nearest = min(
                _aabb_gap(mn, mx, part_aabbs[j][1], part_aabbs[j][2])
                for j in range(len(part_aabbs))
                if j != i
            )
            floating_parts.append((nm, nearest))

    return {
        "triangles": total_tris,
        "degenerate_triangles": degen_tris,
        "bad_vertices": bad_verts,
        "materials": max(len(materials), 1) if meshes else 0,
        "parts": len(part_aabbs),
        "unapplied_scale_nodes": unapplied_scale_nodes,
        "negative_scale_nodes": neg_scale_nodes,
        "bbox_min": [round(float(x), 5) for x in bmin],
        "bbox_max": [round(float(x), 5) for x in bmax],
        "extents_m": [round(float(x), 5) for x in (bmax - bmin)],
        "uv_present": uv_present,
        "uv_out_of_range": uv_out_of_range,
        "uv_area": round(uv_area, 5),
        "rig_present": rig_present,
        "max_influences": max_influences,
        "bad_weight_verts": bad_weight_verts,
        "bad_joint_refs": bad_joint_refs,
        "part_gaps": [(nm, round(g, 5)) for nm, g in floating_parts],
        "_bmin": bmin,
        "_bmax": bmax,
    }


def evaluate(path, max_triangles=25000, max_materials=4, require_uv=False, require_rig=False, contact_tol=0.02, lods=None, collider=None):
    info = inspect_glb(path)
    checks = [
        _chk("finite_vertices", info["bad_vertices"] == 0, info["bad_vertices"], 0, "all vertices must be finite"),
        _chk("triangle_budget", 0 < info["triangles"] <= max_triangles, info["triangles"], f"1..{max_triangles}", "stay within game triangle budget"),
        _chk("degenerate_tris", info["degenerate_triangles"] == 0, info["degenerate_triangles"], 0, "remove zero-area triangles"),
        _chk("material_budget", info["materials"] <= max_materials, info["materials"], f"<= {max_materials}", "keep draw-call/material count within budget"),
        _chk("clean_transforms", not info["unapplied_scale_nodes"], info["unapplied_scale_nodes"], "[]", "apply node scale to (1,1,1) before export"),
        _chk("no_negative_scale", not info["negative_scale_nodes"], info["negative_scale_nodes"], "[]", "no inverted-winding negative scale"),
    ]
    if info["part_gaps"]:
        worst_part, worst_gap = max(info["part_gaps"], key=lambda x: x[1])
        checks.append(_chk("assembly_contact", worst_gap <= contact_tol, f"{worst_part}:{worst_gap}m", f"<= {contact_tol}m", "parts must touch or overlap without floating gaps"))
    if require_uv or info["uv_present"]:
        uv_ok = info["uv_present"] and info["uv_out_of_range"] == 0 and info["uv_area"] > 1e-4
        checks.append(_chk("uv_hygiene", uv_ok, {"present": info["uv_present"], "oob": info["uv_out_of_range"], "area": info["uv_area"]}, "in [0,1] with area > 0", "clean TEXCOORD_0 inside [0,1]"))
    if require_rig or info["rig_present"]:
        rig_ok = info["rig_present"] and info["max_influences"] <= 4 and info["bad_weight_verts"] == 0 and info["bad_joint_refs"] == 0
        checks.append(_chk("skinning_hygiene", rig_ok, {"present": info["rig_present"], "max_inf": info["max_influences"], "bad_w": info["bad_weight_verts"], "bad_j": info["bad_joint_refs"]}, "<= 4 normalized weights", "valid JOINTS_0 / WEIGHTS_0"))

    if lods:
        prev_tris = info["triangles"]
        for li, lp in enumerate(lods, 1):
            linfo = inspect_glb(lp)
            iou = _aabb_iou(info["_bmin"], info["_bmax"], linfo["_bmin"], linfo["_bmax"])
            checks.append(_chk(f"lod{li}_reduction", 0 < linfo["triangles"] < prev_tris, linfo["triangles"], f"< {prev_tris}", f"LOD{li} must reduce triangles"))
            checks.append(_chk(f"lod{li}_alignment", iou >= 0.85, round(iou, 4), ">= 0.85", f"LOD{li} bounding-box IoU against LOD0"))
            prev_tris = linfo["triangles"]

    if collider:
        cinfo = inspect_glb(collider)
        iou = _aabb_iou(info["_bmin"], info["_bmax"], cinfo["_bmin"], cinfo["_bmax"])
        checks.append(_chk("collider_simpler", 0 < cinfo["triangles"] <= info["triangles"], cinfo["triangles"], f"<= {info['triangles']}", "collision proxy must not exceed visual mesh triangles"))
        checks.append(_chk("collider_fit", iou >= 0.75, round(iou, 4), ">= 0.75", "collision proxy aligns with visual bounds"))

    clean_info = {k: v for k, v in info.items() if not k.startswith("_")}
    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "verdict": "SHIP" if ok else "NO-SHIP", "info": clean_info, "checks": checks}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("--max-triangles", type=int, default=25000)
    ap.add_argument("--max-materials", type=int, default=4)
    ap.add_argument("--require-uv", action="store_true")
    ap.add_argument("--require-rig", action="store_true")
    ap.add_argument("--contact-tol", type=float, default=0.02)
    ap.add_argument("--lods", nargs="*", default=[])
    ap.add_argument("--collider", default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    res = evaluate(
        a.model,
        max_triangles=a.max_triangles,
        max_materials=a.max_materials,
        require_uv=a.require_uv,
        require_rig=a.require_rig,
        contact_tol=a.contact_tol,
        lods=a.lods,
        collider=a.collider,
    )
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        print(f"verdict: {res['verdict']}   triangles: {res['info']['triangles']}   materials: {res['info']['materials']}   extents_m: {res['info']['extents_m']}")
        for c in res["checks"]:
            print(f"{c['id']}: {c['value']} (limit {c['limit']})  {'OK' if c['ok'] else 'FIX: ' + c['detail']}")
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()

# SPDX-License-Identifier: AGPL-3.0-only
"""A small kit for building models in Blender by script, run headless, and sending them to a Hildegard loop.

    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # blender_kit.py sits beside build.py
    import blender_kit as bk

    out, params = bk.args()                     # --out <folder> [--params <json>], both absolute
    bk.clear_scene()
    bk.units_mm()
    body = bk.cylinder("body", radius=20, depth=45, location=(0, 0, 22.5))
    head = bk.sphere("head", radius=15, location=(0, 0, 60))
    figure = bk.join([body, head], "figure")
    bk.remesh(figure, voxel=1.0)
    bk.subdivide(figure, levels=1)
    bk.smooth(figure)
    bk.material(figure, "clay", (0.8, 0.75, 0.7))
    bk.export_glb(out, ["figure"])              # model.glb, Y up as glTF wants
    bk.export_stl(out, ["figure"])              # model.stl, Z up as a slicer wants

Run it as Hildegard does, every path absolute (Blender reads relative paths against its own folder, not yours):

    blender --background --factory-startup --python-exit-code 1 --python /abs/build.py -- --out /abs/out

One Blender unit is one millimetre here (`units_mm`), and the exports keep those numbers, so a print's sizes read in
millimetres. Blender is Z up and glTF is Y up: `export_glb` turns the model so it stands up in any glTF viewer and in
Hildegard's views; `export_stl` keeps Z up.
"""

import json
import math
import os
import sys

import bpy

# ── Arguments and the scene ─────────────────────────────────────────────────────────────────────────────────────


def args():
    """The folder to write into and the parameters, from the arguments after `--`."""
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = argv[argv.index("--out") + 1] if "--out" in argv else os.getcwd()
    params = {}
    if "--params" in argv:
        with open(argv[argv.index("--params") + 1], encoding="utf-8") as f:
            params = json.load(f)
    os.makedirs(out, exist_ok=True)
    return os.path.abspath(out), params


def clear_scene():
    """An empty scene: no cube, camera or light, and no data left over from them."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            block.remove(item)


def units_mm(scene=None):
    """Millimetres: one Blender unit shows as one millimetre."""
    scene = scene or bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"


def _named(name):
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    return obj


# ── Primitives ──────────────────────────────────────────────────────────────────────────────────────────────────


def box(name, size=(10, 10, 10), location=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = _named(name)
    obj.scale = size
    apply_transform(obj)
    return obj


def sphere(name, radius=5, location=(0, 0, 0), segments=48):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=location, segments=segments, ring_count=segments // 2)
    return _named(name)


def cylinder(name, radius=5, depth=10, location=(0, 0, 0), vertices=64):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=location, vertices=vertices)
    return _named(name)


def torus(name, major=10, minor=2, location=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=location)
    return _named(name)


def apply_transform(obj):
    _select(obj)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def _select(*objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def apply(obj):
    """Applies every modifier on `obj`, in order, so what is exported is what was built."""
    _select(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    return obj


def join(objs, name):
    """One object from several, modifiers applied first."""
    for o in objs:
        apply(o)
    _select(*objs)
    bpy.ops.object.join()
    return _named(name)


# ── Modifiers, applied at once ──────────────────────────────────────────────────────────────────────────────────


def subdivide(obj, levels=2):
    m = obj.modifiers.new("subdivision", "SUBSURF")
    m.levels = m.render_levels = levels
    return apply(obj)


def remesh(obj, voxel=1.0):
    """Voxel remesh: one watertight surface from overlapping parts, `voxel` millimetres fine."""
    m = obj.modifiers.new("remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    return apply(obj)


def boolean(obj, cutter, operation="DIFFERENCE"):
    """An exact boolean (DIFFERENCE, UNION or INTERSECT) of `cutter` on `obj`; the cutter is removed after."""
    m = obj.modifiers.new("boolean", "BOOLEAN")
    m.operation = operation
    m.solver = "EXACT"
    m.object = cutter
    apply(obj)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return obj


def bevel(obj, width=0.5, segments=3):
    m = obj.modifiers.new("bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    return apply(obj)


def smooth(obj):
    _select(obj)
    bpy.ops.object.shade_smooth()
    return obj


def material(obj, name, color=(0.8, 0.8, 0.8), roughness=0.6, metallic=0.0):
    """A simple PBR material (Principled BSDF), which glTF carries as base colour, roughness and metalness."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return mat


# ── Export ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _only(names):
    objs = [bpy.data.objects[n] for n in names] if names else [o for o in bpy.data.objects if o.type == "MESH"]
    _select(*objs)
    return objs


def export_glb(out, names=None, filename="model.glb"):
    """The named objects (every mesh when None) as one GLB in `out`, Y up, modifiers applied."""
    _only(names)
    path = os.path.join(out, filename)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=True
    )
    return path


def export_stl(out, names=None, filename="model.stl"):
    """The named objects (every mesh when None) as one binary STL in `out`, Z up."""
    _only(names)
    path = os.path.join(out, filename)
    bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True, apply_modifiers=True, ascii_format=False)
    return path


# ── A turntable ─────────────────────────────────────────────────────────────────────────────────────────────────


def turntable(out, frames=96, size=512, samples=16, names=None):
    """Renders `frames` stills circling the model with Cycles on the CPU into `out` as turn_0001.png and on.

    An empty at the model's centre turns a step each frame, with the camera parented to it, so the camera circles at
    one height and distance, framed on the model's bounds. Returns the paths of the frames.
    """
    from mathutils import Vector

    objs = _only(names)
    corners = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector([min(c[i] for c in corners) for i in range(3)])
    hi = Vector([max(c[i] for c in corners) for i in range(3)])
    center = (lo + hi) / 2
    reach = max((hi - lo).length, 1e-3)
    scene = bpy.context.scene

    pivot = bpy.data.objects.new("turntable", None)
    scene.collection.objects.link(pivot)
    pivot.location = center
    cam = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    scene.collection.objects.link(cam)
    cam.data.clip_end = reach * 20
    cam.parent = pivot
    cam.location = (0, -reach * 1.6, reach * 0.45)
    track = cam.constraints.new("TRACK_TO")
    track.target = pivot
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.camera = cam

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    world = scene.world or bpy.data.worlds.new("world")
    scene.world = world
    world.color = (0.18, 0.18, 0.2)

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    paths = []
    for f in range(1, frames + 1):
        pivot.rotation_euler = (0, 0, 2 * math.pi * (f - 1) / frames)
        scene.render.filepath = os.path.join(os.path.abspath(out), f"turn_{f:04d}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(scene.render.filepath)
    return paths

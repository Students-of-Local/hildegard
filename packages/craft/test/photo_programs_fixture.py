# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic pictures for photo-programs.test.ts.

  python3 photo_programs_fixture.py make DIR     every picture the tests use
  python3 photo_programs_fixture.py ramp IN      JSON: the worst difference between channels on the highlight ramp
  python3 photo_programs_fixture.py changed A B  JSON: how far any pixel of the lit brow moved, and how far any inside the socket did"""
import json
import sys

import numpy as np
from PIL import Image, ImageFilter

W, H, SKIN, BROW, SOCKET = 900, 720, np.array([0.45, 0.33, 0.26]), np.s_[186:193, 297:363], np.s_[200:240, 300:360]


def enc(lin):
    lin = np.clip(lin, 0, 1)
    return (np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055) * 255 + 0.5).astype('uint8')


def make(d):
    Y, X = np.mgrid[:H, :W]
    rng = np.random.default_rng(1)

    def disc(r, blur, cx=450, cy=360):
        m = Image.fromarray((((X - cx) ** 2 + (Y - cy) ** 2) < r * r).astype('uint8') * 255)
        return np.asarray(m.filter(ImageFilter.GaussianBlur(blur)), float) / 255

    whole, wood = disc(300, 0.7), np.clip(np.array([150, 105, 60]) + rng.normal(0, 8, (H, W, 1)), 0, 255)
    photo = wood * whole[..., None] + np.array([120, 130, 150.0]) * (1 - whole[..., None])
    Image.fromarray(photo.astype('uint8')).save(f'{d}/photo.png')
    turned = Image.Exif()
    turned[274] = 6
    Image.fromarray(photo.astype('uint8')).save(f'{d}/turned.jpg', exif=turned)
    patch = np.minimum(whole, 1 - disc(60, 0.7) * 0.4)
    mattes = {
        'good': whole,
        'soft': disc(300, 6),
        'haze': np.maximum(whole, disc(340, 8) * 0.2),
        'crumb': np.maximum(whole, disc(8, 0.7, 40, 40)),
        'second': np.maximum(whole, disc(60, 0.7, 70, 70)),
        'thin': np.minimum(whole, 1 - disc(60, 0.7) * 0.04),
        'hollow': patch,
    }
    for name, m in mattes.items():
        Image.fromarray(np.dstack([photo, m * 255]).astype('uint8'), 'RGBA').save(f'{d}/{name}.png')
    # a neutral highlight falling off under warm light, over a grey patch
    ramp = np.linspace(1.6, 0.2, 800)[None, :, None] * np.ones((300, 1, 1)) * np.array([1.25, 1, 0.74])
    ramp[200:] = 0.3 * np.array([1.25, 1, 0.74])
    Image.fromarray(enc(ramp)).save(f'{d}/ramp.png')
    # a face with a shaded socket under a lit brow
    for name, depth in (('noon', 0.6), ('deep', 0.9)):
        oval = np.clip(1.3 - np.hypot((X[:600] - 330) / 33, (Y[:600] - 220) / 23), 0, 0.3) / 0.3
        f = SKIN * (1 - depth * oval[..., None])
        f[BROW] = SKIN * 1.9
        Image.fromarray(enc(f)).save(f'{d}/{name}.png')


def changed(a, b):
    d = np.abs(np.asarray(Image.open(b), int) - np.asarray(Image.open(a), int))
    return {'brow': int(d[BROW].max()), 'socket': int(d[SOCKET].max())}


if __name__ == '__main__':
    if sys.argv[1] == 'make':
        make(sys.argv[2])
    elif sys.argv[1] == 'ramp':
        row = np.asarray(Image.open(sys.argv[2]), int)[50]
        print(json.dumps({'worst': int((row.max(1) - row.min(1)).max())}))
    else:
        print(json.dumps(changed(sys.argv[2], sys.argv[3])))

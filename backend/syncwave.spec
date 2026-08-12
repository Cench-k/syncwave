# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the SyncWave desktop build.

onedir, not onefile: the payload is ~350MB of native libraries, and onefile
would re-extract all of it to a temp folder on every launch.

`ffmpeg/` and `static/` are collected by build-dist.bat before this runs; both
are optional here so the spec still works for a quick backend-only build.
"""
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

HERE = Path(os.getcwd())

datas, binaries, hiddenimports = [], [], []

# faster-whisper's weights live in ctranslate2 (native) and its VAD in
# onnxruntime (native + a bundled .onnx asset), neither of which PyInstaller
# finds by following imports alone.
for pkg in ("faster_whisper", "ctranslate2", "onnxruntime", "tokenizers", "huggingface_hub"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # pragma: no cover - build-time diagnostic
        print(f"[spec] skip {pkg}: {exc}")

# uvicorn resolves its protocol/loop implementations by string at runtime.
hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["app.main", "app.capcut", "app.aligner", "app.cleanup"]

if (HERE / "static").is_dir():
    datas.append((str(HERE / "static"), "static"))
else:
    print("[spec] static/ 없음 — 건너뜁니다")

# ffmpeg deliberately stays OUT of the bundle. Listing it under datas made
# PyInstaller scan those DLLs and copy them to _internal/ as well, shipping
# ~118MB twice. build-dist.bat drops the folder beside the exe instead, which
# desktop.py already looks for.

a = Analysis(
    ["desktop.py"],
    pathex=[str(HERE)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Pulled in transitively but unused here, and each costs tens of MB.
    excludes=["tkinter", "matplotlib", "scipy", "pandas", "PIL", "pytest", "aeneas"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SyncWave",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="SyncWave",
)

# PyInstaller spec for the Locus engine. Build with: npm run build:engine
# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

# pymobiledevice3 imports many modules lazily (by name), so static analysis misses them.
# Its CLI layer (and the IPython/xonsh shells it pulls in) is never used by the engine.
hiddenimports = collect_submodules(
    "pymobiledevice3",
    filter=lambda name: ".cli" not in name and not name.endswith("__main__"),
)
hiddenimports += collect_submodules("pmd_pytcp")
hiddenimports += collect_submodules("pytun_pmd3")
hiddenimports += collect_submodules("developer_disk_image")

datas = []
for pkg in ("pymobiledevice3", "developer_disk_image", "pmd_pytcp", "pytun_pmd3", "ipsw_parser"):
    datas += collect_data_files(pkg)
# Several dependencies call importlib.metadata.version() on themselves at import time.
datas += copy_metadata("pymobiledevice3", recursive=True)

a = Analysis(
    ["engine.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["IPython", "xonsh", "jedi", "tkinter", "matplotlib", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="locus-engine",
    console=True,  # stdio is the IPC channel; Electron spawns it hidden (windowsHide)
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="locus-engine", upx=False)

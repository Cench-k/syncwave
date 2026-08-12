"""Fetch the ffmpeg binaries that ship inside the desktop package.

Uses BtbN's LGPL *shared* build: ffmpeg.exe is half a megabyte and the codec
DLLs come to ~128MB, against ~213MB for a single statically linked exe. ffplay
is skipped — it is 17MB of video player this app never invokes.

Run from the repo root; writes into backend/ffmpeg/.
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = ("https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/"
       "ffmpeg-master-latest-win64-lgpl-shared.zip")
SKIP = {"ffplay.exe"}
DEST = Path(__file__).resolve().parent.parent / "backend" / "ffmpeg"
# Everything the app actually exercises: mp3/wav in and out, and the filters
# used to re-time and place segments.
REQUIRED_ENCODERS = ("libmp3lame", "pcm_s16le")
REQUIRED_FILTERS = ("atempo", "aresample")


def download(url: str) -> bytes:
    print(f"내려받는 중: {url}")
    with urllib.request.urlopen(url, timeout=600) as r:
        total = int(r.headers.get("Content-Length") or 0)
        buf, got = io.BytesIO(), 0
        while chunk := r.read(1 << 20):
            buf.write(chunk)
            got += len(chunk)
            if total:
                print(f"\r  {got / 1048576:6.1f} / {total / 1048576:.1f} MB", end="")
        print()
        return buf.getvalue()


def extract(blob: bytes, dest: Path) -> int:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    n = 0
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for name in z.namelist():
            if "/bin/" not in name or name.endswith("/"):
                continue
            base = os.path.basename(name)
            if base in SKIP:
                continue
            with z.open(name) as src, (dest / base).open("wb") as out:
                shutil.copyfileobj(src, out)
            n += 1
    return n


def verify(exe: Path) -> None:
    """Fail now rather than when a user's first alignment silently misbehaves."""
    def probe(flag: str) -> str:
        return subprocess.run([str(exe), "-hide_banner", flag],
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace").stdout

    encoders, filters = probe("-encoders"), probe("-filters")
    missing = [e for e in REQUIRED_ENCODERS if e not in encoders]
    missing += [f for f in REQUIRED_FILTERS if f" {f} " not in filters]
    if missing:
        raise SystemExit(f"[!] 이 ffmpeg 빌드에 없는 기능: {', '.join(missing)}")


def main() -> int:
    count = extract(download(URL), DEST)
    exe = DEST / "ffmpeg.exe"
    if not exe.is_file():
        raise SystemExit("[!] 압축 안에 ffmpeg.exe 가 없습니다")
    verify(exe)
    size = sum(f.stat().st_size for f in DEST.iterdir()) / 1048576
    print(f"완료: {DEST}  ({count}개 파일, {size:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

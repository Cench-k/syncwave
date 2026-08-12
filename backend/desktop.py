"""Entry point for the packaged desktop build.

Everything here runs before `app.main` is imported, because that module reads
its paths from the environment at import time.

A frozen build differs from a source checkout in three ways that matter:
  * `sys._MEIPASS` is a read-only extraction directory, so temp files and the
    model cache have to live somewhere else — under %LOCALAPPDATA%.
  * ffmpeg is shipped alongside the exe rather than installed system-wide, so
    its folder goes on PATH.
  * The frontend bundle travels inside the package.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

APP_NAME = "SyncWave"


def bundle_dir() -> Path:
    """Where our read-only resources live."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def data_dir() -> Path:
    """Writable per-user location for the model cache and scratch files."""
    root = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    d = Path(root) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def free_port(preferred: int = 8000) -> int:
    for port in (preferred, 8001, 8002, 8010, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("사용 가능한 포트를 찾지 못했습니다")


def configure() -> None:
    base = bundle_dir()
    data = data_dir()

    # ffmpeg ships next to the exe; prefer ours over anything on the system.
    for candidate in (base / "ffmpeg", Path(sys.executable).parent / "ffmpeg"):
        if (candidate / "ffmpeg.exe").is_file():
            os.environ["PATH"] = str(candidate) + os.pathsep + os.environ.get("PATH", "")
            break

    os.environ["SYNCWAVE_LOCAL"] = "1"
    os.environ.setdefault("SYNCWAVE_STATIC_DIR", str(base / "static"))
    os.environ.setdefault("SYNCWAVE_TEMP_DIR", str(data / "temp"))
    # Keep the Whisper download out of the bundle so an upgrade doesn't
    # re-download it, and so the package itself stays shippable.
    os.environ.setdefault("HF_HOME", str(data / "models"))
    os.environ.setdefault("WHISPER_MODEL", "small")
    os.environ.setdefault("WHISPER_DEVICE", "cpu")
    os.environ.setdefault("WHISPER_COMPUTE", "int8")


def main() -> None:
    configure()
    port = free_port()
    url = f"http://127.0.0.1:{port}"

    print(f"  {APP_NAME}")
    print(f"  {url}")
    print(f"  모델: {os.environ['WHISPER_MODEL']}   저장 위치: {data_dir()}")
    print("  이 창을 닫으면 종료됩니다.\n")

    def open_when_up() -> None:
        # Poll rather than sleep a fixed amount: first start has to import
        # torch-sized libraries and can take a while on a cold disk.
        deadline = time.time() + 60
        while time.time() < deadline:
            with socket.socket() as s:
                s.settimeout(0.5)
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    webbrowser.open(url)
                    return
            time.sleep(0.3)

    threading.Thread(target=open_when_up, daemon=True).start()

    import uvicorn  # imported after configure() so app.main sees the env

    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()

"""SyncWave FastAPI backend.

Endpoints:
  POST /align     — multipart upload (audio, script, lang) → aligned blocks JSON
  GET  /health    — liveness check
  GET  /          — static frontend (when STATIC_DIR exists)
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

# Ensure espeak-ng is on PATH for the aeneas subprocess calls.
_ESPEAK_DIR = r"C:\Program Files\eSpeak NG"
if os.path.isdir(_ESPEAK_DIR) and _ESPEAK_DIR not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _ESPEAK_DIR + os.pathsep + os.environ.get("PATH", "")

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydub import AudioSegment

from .aligner import align
from .cleanup import sweep_temp


BASE_DIR = Path(__file__).resolve().parent.parent
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)
STATIC_DIR = BASE_DIR / "static"

APP_USER = os.environ.get("APP_USER", "")
APP_PASS = os.environ.get("APP_PASS", "")
AUTH_ENABLED = bool(APP_PASS)

MAX_AUDIO_BYTES = 50 * 1024 * 1024  # 50 MB

_jobs: dict[str, dict[str, Any]] = {}
_executor = ThreadPoolExecutor(max_workers=2)
ALLOWED_AUDIO_EXT = {".mp3", ".wav"}
ALLOWED_SCRIPT_EXT = {".txt"}
ALLOWED_LANGS = {"ko", "ja"}


scheduler = BackgroundScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.add_job(lambda: sweep_temp(TEMP_DIR), "interval", hours=1)
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="SyncWave", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)


_basic = HTTPBasic(auto_error=False)


def require_auth(creds: HTTPBasicCredentials | None = Depends(_basic)):
    if not AUTH_ENABLED:
        return
    if creds is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Authentication required",
            headers={"WWW-Authenticate": "Basic"},
        )
    user_ok = secrets.compare_digest(creds.username, APP_USER) if APP_USER else True
    pass_ok = secrets.compare_digest(creds.password, APP_PASS)
    if not (user_ok and pass_ok):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )


@app.get("/health")
async def health():
    return {"status": "ok"}


def _ext(name: str) -> str:
    return Path(name).suffix.lower()


@app.post("/align", dependencies=[Depends(require_auth)])
async def align_endpoint(
    audios: list[UploadFile] = File(...),
    script: UploadFile = File(...),
    lang: str = Form(...),
):
    if lang not in ALLOWED_LANGS:
        raise HTTPException(400, f"lang must be one of {ALLOWED_LANGS}")
    if not audios:
        raise HTTPException(400, "at least one audio file required")
    for a in audios:
        if _ext(a.filename) not in ALLOWED_AUDIO_EXT:
            raise HTTPException(400, f"audio must be .mp3 or .wav: {a.filename}")
    if _ext(script.filename) not in ALLOWED_SCRIPT_EXT:
        raise HTTPException(400, "script must be .txt")

    job_id = uuid.uuid4().hex
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir()
    parts_dir = job_dir / "parts"
    parts_dir.mkdir()
    combined_path = job_dir / "combined.mp3"
    script_path = job_dir / "script.txt"

    try:
        total = 0
        part_paths: list[Path] = []
        for i, a in enumerate(audios):
            part_path = parts_dir / f"{i:04d}{_ext(a.filename)}"
            with part_path.open("wb") as f:
                while chunk := await a.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise HTTPException(413, "combined audio exceeds 50MB limit")
                    f.write(chunk)
            part_paths.append(part_path)

        list_path = job_dir / "concat.txt"
        list_path.write_text(
            "".join(f"file '{p.as_posix()}'\n" for p in part_paths),
            encoding="utf-8",
        )
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(list_path), "-c", "copy", str(combined_path),
            ],
            capture_output=True, text=True,
        )
        list_path.unlink(missing_ok=True)
        if proc.returncode != 0 or not combined_path.exists():
            combined: AudioSegment | None = None
            for p in part_paths:
                seg = AudioSegment.from_file(p)
                combined = seg if combined is None else combined + seg
            assert combined is not None
            combined.export(combined_path, format="mp3")

        shutil.rmtree(parts_dir, ignore_errors=True)

        script_bytes = await script.read()
        try:
            script_text = script_bytes.decode("utf-8")
        except UnicodeDecodeError:
            script_text = script_bytes.decode("utf-8-sig", errors="replace")
        normalized = "\n".join(
            line.strip() for line in script_text.splitlines() if line.strip()
        )
        if not normalized:
            raise HTTPException(400, "script is empty after normalization")
        script_path.write_text(normalized, encoding="utf-8")

    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(500, f"upload failed: {e}") from e

    # Run Whisper alignment in background so the HTTP connection doesn't time out.
    _jobs[job_id] = {"status": "pending"}

    def _run():
        try:
            blocks = align(str(combined_path), str(script_path), lang)
            try:
                script_path.unlink()
            except OSError:
                pass
            _jobs[job_id] = {"status": "done", "blocks": blocks}
        except Exception as exc:
            shutil.rmtree(job_dir, ignore_errors=True)
            _jobs[job_id] = {"status": "error", "error": str(exc)}

    _executor.submit(_run)
    return JSONResponse({"job_id": job_id, "status": "pending"})


@app.get("/status/{job_id}", dependencies=[Depends(require_auth)])
async def get_status(job_id: str):
    if not _JOB_ID_RE.match(job_id):
        raise HTTPException(400, "invalid job_id")
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job["status"] == "done":
        return JSONResponse({
            "status": "done",
            "blocks": job["blocks"],
            "audio_url": f"/audio/{job_id}",
        })
    if job["status"] == "error":
        raise HTTPException(500, f"alignment failed: {job['error']}")
    return JSONResponse({"status": "pending"})


_JOB_ID_RE = re.compile(r"^[a-f0-9]{32}$")


@app.get("/audio/{job_id}", dependencies=[Depends(require_auth)])
async def get_combined_audio(job_id: str):
    if not _JOB_ID_RE.match(job_id):
        raise HTTPException(400, "invalid job_id")
    audio_path = TEMP_DIR / job_id / "combined.mp3"
    if not audio_path.is_file():
        raise HTTPException(404, "audio expired or not found")
    return FileResponse(audio_path, media_type="audio/mpeg", filename="combined.mp3")


# Serve the built frontend (Next.js static export) at the root.
# Mount last so API routes take precedence.
if STATIC_DIR.is_dir():
    if AUTH_ENABLED:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.responses import Response

        class StaticAuthMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                path = request.url.path
                if (
                    path == "/health"
                    or path.startswith("/align")
                    or path.startswith("/status/")
                    or path.startswith("/audio/")
                ):
                    return await call_next(request)
                auth = request.headers.get("authorization", "")
                if not auth.lower().startswith("basic "):
                    return Response(
                        "Authentication required",
                        status_code=401,
                        headers={"WWW-Authenticate": "Basic"},
                    )
                import base64
                try:
                    decoded = base64.b64decode(auth.split(" ", 1)[1]).decode("utf-8")
                    user, _, pw = decoded.partition(":")
                except Exception:
                    return Response("Invalid auth header", status_code=401)
                user_ok = (
                    secrets.compare_digest(user, APP_USER) if APP_USER else True
                )
                pass_ok = secrets.compare_digest(pw, APP_PASS)
                if not (user_ok and pass_ok):
                    return Response(
                        "Invalid credentials",
                        status_code=401,
                        headers={"WWW-Authenticate": "Basic"},
                    )
                return await call_next(request)

        app.add_middleware(StaticAuthMiddleware)

    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

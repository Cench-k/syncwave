"""SyncWave FastAPI backend.

Endpoints:
  POST /align     — multipart upload (audio, script, lang) → aligned blocks JSON
  GET  /health    — liveness check
  GET  /          — static frontend (when STATIC_DIR exists)
"""
from __future__ import annotations

import os
import secrets
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

# Ensure espeak-ng is on PATH for the aeneas subprocess calls.
_ESPEAK_DIR = r"C:\Program Files\eSpeak NG"
if os.path.isdir(_ESPEAK_DIR) and _ESPEAK_DIR not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _ESPEAK_DIR + os.pathsep + os.environ.get("PATH", "")

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles

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
    audio: UploadFile = File(...),
    script: UploadFile = File(...),
    lang: str = Form(...),
):
    if lang not in ALLOWED_LANGS:
        raise HTTPException(400, f"lang must be one of {ALLOWED_LANGS}")
    if _ext(audio.filename) not in ALLOWED_AUDIO_EXT:
        raise HTTPException(400, "audio must be .mp3 or .wav")
    if _ext(script.filename) not in ALLOWED_SCRIPT_EXT:
        raise HTTPException(400, "script must be .txt")

    job_id = uuid.uuid4().hex
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir()
    audio_path = job_dir / f"audio{_ext(audio.filename)}"
    script_path = job_dir / "script.txt"

    try:
        size = 0
        with audio_path.open("wb") as f:
            while chunk := await audio.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_AUDIO_BYTES:
                    raise HTTPException(413, "audio exceeds 50MB limit")
                f.write(chunk)

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

        blocks = align(str(audio_path), str(script_path), lang)
        return JSONResponse({"job_id": job_id, "blocks": blocks})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"alignment failed: {e}") from e
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


# Serve the built frontend (Next.js static export) at the root.
# Mount last so API routes take precedence.
if STATIC_DIR.is_dir():
    if AUTH_ENABLED:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.responses import Response

        class StaticAuthMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                path = request.url.path
                if path == "/health" or path.startswith("/align"):
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

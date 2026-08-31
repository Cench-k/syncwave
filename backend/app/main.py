"""SyncWave FastAPI backend.

Endpoints:
  POST /align     — multipart upload (audio, script, lang) → aligned blocks JSON
  GET  /health    — liveness check
  GET  /          — static frontend (when STATIC_DIR exists)

Local-only (registered only when SYNCWAVE_LOCAL is set — see LOCAL_MODE):
  GET  /capcut/projects        — CapCut drafts on this machine
  GET  /capcut/projects/{name} — fps, duration, speech files, text tracks
  POST /capcut/align           — align a script against a draft's timeline audio
  POST /capcut/write           — write finished subtitles into the draft
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
# Overridable so a packaged build can point these at a writable location —
# inside a PyInstaller bundle __file__ lives in a read-only extraction dir.
TEMP_DIR = Path(os.environ.get("SYNCWAVE_TEMP_DIR") or (BASE_DIR / "temp"))
TEMP_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR = Path(os.environ.get("SYNCWAVE_STATIC_DIR") or (BASE_DIR / "static"))

APP_USER = os.environ.get("APP_USER", "")
APP_PASS = os.environ.get("APP_PASS", "")
AUTH_ENABLED = bool(APP_PASS)

MAX_AUDIO_BYTES = 50 * 1024 * 1024  # 50 MB

# The CapCut routes read and write files anywhere on the host, so they must
# never exist on the hosted deployment. Opt in explicitly; the Dockerfile that
# builds the HuggingFace Space does not set this.
LOCAL_MODE = os.environ.get("SYNCWAVE_LOCAL", "").lower() in {"1", "true", "yes", "on"}

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
    return {"status": "ok", "local": LOCAL_MODE}


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
        payload = {
            "status": "done",
            "blocks": job["blocks"],
            "audio_url": f"/audio/{job_id}",
        }
        if "capcut" in job:
            payload["capcut"] = job["capcut"]
        return JSONResponse(payload)
    if job["status"] == "error":
        raise HTTPException(500, f"alignment failed: {job['error']}")
    return JSONResponse({"status": "pending"})


_JOB_ID_RE = re.compile(r"^[a-f0-9]{32}$")


# ---------------------------------------------------------------------------
# CapCut integration (local machine only)
#
# Aligning against the original TTS mp3 gives times on the source clock, but a
# CapCut timeline is a re-cut of that file — silences dropped, speed changed,
# pieces moved — so the two clocks drift apart (27s on a measured project).
# Instead of mapping between them afterwards, /capcut/align rebuilds the audio
# exactly as the timeline plays it and aligns against that, so the result is
# already on the timeline clock and can be written straight back.

if LOCAL_MODE:
    from . import capcut

    def _capcut_error(exc: Exception) -> HTTPException:
        return HTTPException(400, str(exc))

    @app.get("/capcut/projects", dependencies=[Depends(require_auth)])
    async def capcut_projects():
        try:
            return {"root": str(capcut.draft_root()), "projects": capcut.list_projects()}
        except capcut.CapCutError as e:
            raise _capcut_error(e) from e

    @app.get("/capcut/projects/{name}", dependencies=[Depends(require_auth)])
    async def capcut_project(name: str, timeline: str | None = None,
                             audio_track: int | None = None):
        try:
            draft, _ = capcut.load_draft(name, timeline=timeline)
            info = capcut.project_info(draft, track_index=audio_track)
            # A project can hold several timelines; without this the UI can
            # only ever see the main one.
            info["timelines"] = capcut.list_timelines(name)
            info["timeline"] = timeline
            return info
        except capcut.CapCutError as e:
            raise _capcut_error(e) from e

    @app.post("/capcut/align", dependencies=[Depends(require_auth)])
    async def capcut_align(
        project: str = Form(...),
        script: UploadFile = File(...),
        lang: str = Form(...),
        timeline: str = Form(""),
        audio_track: int = Form(-1),
    ):
        if lang not in ALLOWED_LANGS:
            raise HTTPException(400, f"lang must be one of {ALLOWED_LANGS}")
        if _ext(script.filename) not in ALLOWED_SCRIPT_EXT:
            raise HTTPException(400, "script must be .txt")
        try:
            draft, _ = capcut.load_draft(project, timeline=timeline or None)
        except capcut.CapCutError as e:
            raise _capcut_error(e) from e

        job_id = uuid.uuid4().hex
        job_dir = TEMP_DIR / job_id
        job_dir.mkdir()
        # Named combined.mp3 so /audio/{job_id} serves it like any other job,
        # letting the waveform editor play the reconstruction it aligned to.
        audio_path = job_dir / "combined.mp3"
        script_path = job_dir / "script.txt"

        try:
            raw = await script.read()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("utf-8-sig", errors="replace")
            normalized = "\n".join(l.strip() for l in text.splitlines() if l.strip())
            if not normalized:
                raise HTTPException(400, "script is empty after normalization")
            script_path.write_text(normalized, encoding="utf-8")
        except HTTPException:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise
        except Exception as e:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise HTTPException(500, f"script read failed: {e}") from e

        _jobs[job_id] = {"status": "pending"}

        def _run():
            try:
                built = capcut.build_speech_audio(
                    draft, str(audio_path),
                    track_index=audio_track if audio_track >= 0 else None,
                )
                blocks = align(str(audio_path), str(script_path), lang)
                try:
                    script_path.unlink()
                except OSError:
                    pass
                _jobs[job_id] = {"status": "done", "blocks": blocks, "capcut": built}
            except Exception as exc:
                shutil.rmtree(job_dir, ignore_errors=True)
                _jobs[job_id] = {"status": "error", "error": str(exc)}

        _executor.submit(_run)
        return JSONResponse({"job_id": job_id, "status": "pending"})

    @app.get("/capcut/styles", dependencies=[Depends(require_auth)])
    async def capcut_styles():
        """Recent projects whose subtitle style can be copied."""
        return {"styles": capcut.style_candidates()}

    @app.post("/capcut/write", dependencies=[Depends(require_auth)])
    async def capcut_write(payload: dict):
        project = payload.get("project")
        blocks = payload.get("blocks")
        if not project or not isinstance(blocks, list):
            raise HTTPException(400, "project and blocks are required")
        try:
            return capcut.inject_subtitles(
                project,
                blocks,
                replace_track=payload.get("replace_track") or None,
                track_name=payload.get("track_name") or "SyncWave",
                force=bool(payload.get("force")),
                style_from=payload.get("style_from") or None,
                timeline=payload.get("timeline") or None,
            )
        except capcut.EditorOpenError as e:
            # 409 so the client can offer "close CapCut and retry" rather than
            # showing this as a generic failure.
            raise HTTPException(409, str(e)) from e
        except capcut.CapCutError as e:
            raise _capcut_error(e) from e
        except Exception as e:
            raise HTTPException(500, f"자막 쓰기 실패: {e}") from e

    @app.get("/capcut/verify/{name}", dependencies=[Depends(require_auth)])
    async def capcut_verify(name: str, track: str = "SyncWave", timeline: str | None = None):
        """Is the track we wrote still there?

        CapCut rewrites an open project from memory on its own schedule, which
        silently discards our work minutes after a successful write. This lets
        the UI check instead of the user discovering it later.
        """
        try:
            draft, _ = capcut.load_draft(name, timeline=timeline)
        except capcut.CapCutError as e:
            raise _capcut_error(e) from e
        found = [
            t for t in draft.get("tracks", [])
            if t.get("type") == "text" and t.get("name") == track
        ]
        return {
            "present": bool(found),
            "segments": sum(len(t.get("segments", [])) for t in found),
            "editor_running": bool(capcut.running_editors()),
        }


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

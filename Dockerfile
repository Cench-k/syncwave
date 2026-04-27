# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build the Next.js static export ----------
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Same-origin API calls in production (empty base → relative URLs).
ENV NEXT_PUBLIC_API_BASE=""

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


# ---------- Stage 2: Python backend with faster-whisper ----------
FROM python:3.11-slim AS backend

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/.cache/huggingface \
    WHISPER_MODEL=medium \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE=int8

# ffmpeg for audio decode/concat. No more aeneas/espeak/build chain.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --upgrade pip \
    && pip install \
        fastapi==0.115.0 \
        "uvicorn[standard]==0.32.0" \
        python-multipart==0.0.12 \
        pydub==0.25.1 \
        apscheduler==3.10.4 \
        "faster-whisper==1.0.3" \
        requests

# Whisper model is fetched lazily on first /align call (cached at HF_HOME
# for the container's lifetime). Pre-downloading at build time blew past
# HF Spaces' build timeout — first user pays ~3min one-time stall instead.

COPY backend/app ./app

# Static frontend bundle from stage 1.
COPY --from=frontend-builder /app/out ./static

# HuggingFace Spaces expects the app on port 7860.
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]

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


# ---------- Stage 2: Python backend with aeneas ----------
FROM python:3.11-slim AS backend

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AENEAS_WITH_CEW=False

# System deps for aeneas: compiler, espeak-ng (TTS), ffmpeg (audio decode).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ffmpeg \
        espeak-ng \
        libespeak-ng-dev \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apk/lists/* /var/lib/apt/lists/*

WORKDIR /app

# Install numpy<2 first so aeneas's setup.py can find numpy headers.
# Pin setuptools<70 — 74+ removed legacy Compiler signature that numpy.distutils still uses.
RUN pip install --upgrade pip \
    && pip install "setuptools==68.2.2" "wheel" \
    && pip install "numpy<2"

# Build aeneas from source with the setup.py patch (line 198 outer-bracket bug).
RUN curl -L -o /tmp/aeneas.tar.gz https://files.pythonhosted.org/packages/source/a/aeneas/aeneas-1.7.3.0.tar.gz \
    && tar -xzf /tmp/aeneas.tar.gz -C /tmp \
    && sed -i "s|\[misc_util\.get_numpy_include_dirs()\]|misc_util.get_numpy_include_dirs()|" /tmp/aeneas-1.7.3.0/setup.py \
    && pip install /tmp/aeneas-1.7.3.0 --no-build-isolation \
    && rm -rf /tmp/aeneas*

# Remaining backend deps (skip numpy/aeneas — already installed above).
RUN pip install \
        fastapi==0.115.0 \
        "uvicorn[standard]==0.32.0" \
        python-multipart==0.0.12 \
        pydub==0.25.1 \
        apscheduler==3.10.4

COPY backend/app ./app

# Static frontend bundle from stage 1.
COPY --from=frontend-builder /app/out ./static

# HuggingFace Spaces expects the app on port 7860.
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]

"""Forced alignment via Whisper word timestamps + line fuzzy matching.

Pipeline:
  1. faster-whisper transcribes the audio with word-level timestamps.
  2. Each user-provided script line is matched to a span of Whisper words
     using Needleman-Wunsch global alignment over normalized words.
  3. Each line gets the start time of its first matched word and the end
     time of its last matched word. Unmatched lines are interpolated.

Replaces the previous aeneas+espeak-ng pipeline, which had poor accuracy
for Korean/Japanese due to espeak's robotic synthesis being a bad DTW
reference for natural speech.
"""
from __future__ import annotations

import re
import threading
import unicodedata
from typing import List, Optional

from faster_whisper import WhisperModel


# Model is loaded lazily on first /align call and cached for the process
# lifetime. medium/int8 = ~750MB on disk, ~1.5GB RAM, decent KO/JA accuracy
# on CPU. Override via env if needed.
import os
_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "medium")
_MODEL_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
_MODEL_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")

_MODEL: Optional[WhisperModel] = None
_MODEL_LOCK = threading.Lock()


def _get_model() -> WhisperModel:
    global _MODEL
    if _MODEL is None:
        with _MODEL_LOCK:
            if _MODEL is None:
                _MODEL = WhisperModel(
                    _MODEL_SIZE,
                    device=_MODEL_DEVICE,
                    compute_type=_MODEL_COMPUTE,
                )
    return _MODEL


LANG_TO_WHISPER = {"ko": "ko", "ja": "ja"}


def _normalize(text: str) -> str:
    """Lowercase, NFKC, strip punctuation/symbols. Used for word matching."""
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"[\s　]+", " ", text)
    # Drop punctuation but keep CJK chars and alphanumerics.
    text = re.sub(r"[^\w぀-ヿ㐀-䶿一-鿿가-힯]", "", text)
    return text.strip()


def _word_similarity(a: str, b: str) -> float:
    """Character bigram Jaccard similarity — robust for Korean/Japanese morphology."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # Single-char words: fall back to exact match only.
    if len(a) == 1 or len(b) == 1:
        return 1.0 if a[0] == b[0] else 0.0
    bg_a = {a[i:i + 2] for i in range(len(a) - 1)}
    bg_b = {b[i:i + 2] for i in range(len(b) - 1)}
    return len(bg_a & bg_b) / len(bg_a | bg_b)


def _needleman_wunsch(a: List[str], b: List[str]) -> List[int]:
    """Global alignment of word sequences a→b. Returns mapping[i] = j or -1."""
    n, m = len(a), len(b)
    if n == 0:
        return []
    if m == 0:
        return [-1] * n

    GAP = -0.5
    MISMATCH_THRESHOLD = 0.2  # below this, treat as mismatch (-0.5)
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    trace = [[0] * (m + 1) for _ in range(n + 1)]  # 0=diag, 1=up, 2=left

    for i in range(1, n + 1):
        score[i][0] = score[i - 1][0] + GAP
        trace[i][0] = 1
    for j in range(1, m + 1):
        score[0][j] = score[0][j - 1] + GAP
        trace[0][j] = 2

    for i in range(1, n + 1):
        ai = a[i - 1]
        score_prev = score[i - 1]
        score_cur = score[i]
        trace_cur = trace[i]
        for j in range(1, m + 1):
            sim = _word_similarity(ai, b[j - 1])
            if sim < MISMATCH_THRESHOLD:
                sim = -0.5
            d = score_prev[j - 1] + sim
            u = score_prev[j] + GAP
            l = score_cur[j - 1] + GAP
            if d >= u and d >= l:
                score_cur[j] = d
                trace_cur[j] = 0
            elif u >= l:
                score_cur[j] = u
                trace_cur[j] = 1
            else:
                score_cur[j] = l
                trace_cur[j] = 2

    mapping = [-1] * n
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and trace[i][j] == 0:
            # Only keep the mapping if it was a real match (sim above threshold).
            if _word_similarity(a[i - 1], b[j - 1]) >= MISMATCH_THRESHOLD:
                mapping[i - 1] = j - 1
            i -= 1
            j -= 1
        elif i > 0 and (j == 0 or trace[i][j] == 1):
            i -= 1
        else:
            j -= 1
    return mapping


def _interpolate_unmatched(
    blocks_with_times: List[dict],
    audio_duration: float,
) -> List[dict]:
    """Fill in start/end for blocks whose words didn't align to any Whisper word."""
    n = len(blocks_with_times)
    if n == 0:
        return blocks_with_times

    # Pass 1: forward-fill by anchoring to neighbors.
    for i, b in enumerate(blocks_with_times):
        if b["start"] is not None:
            continue
        # Find prev anchor
        prev_end = 0.0
        for k in range(i - 1, -1, -1):
            if blocks_with_times[k]["end"] is not None:
                prev_end = blocks_with_times[k]["end"]
                break
        # Find next anchor
        next_start = audio_duration
        next_idx = n
        for k in range(i + 1, n):
            if blocks_with_times[k]["start"] is not None:
                next_start = blocks_with_times[k]["start"]
                next_idx = k
                break
        # Distribute proportionally over the gap by character-length weight.
        gap = max(0.0, next_start - prev_end)
        # Indices needing fill in [i .. next_idx-1]
        unfilled = list(range(i, next_idx))
        weights = [max(1, len(blocks_with_times[k]["text"])) for k in unfilled]
        total_w = sum(weights)
        cursor = prev_end
        for k, w in zip(unfilled, weights):
            slice_len = gap * (w / total_w)
            blocks_with_times[k]["start"] = cursor
            blocks_with_times[k]["end"] = cursor + slice_len
            cursor += slice_len
    return blocks_with_times


ENERGY_HOP = 0.01          # seconds per RMS frame
SPEECH_FLOOR_DB = -40.0    # dBFS; below this a frame counts as silence
MIN_VOICED_FRAMES = 3      # a run this long is speech, not a click
INNER_PAUSE_FRAMES = 25    # 0.25s of silence inside one "word" = two utterances


def _refine_with_energy(words: List[dict], audio_path: str) -> None:
    """Pull word edges out of the silence Whisper smears them into.

    Whisper starts a word where the previous one ended, so the pause before a
    line is charged to its first word. On 1001 (3) that put 30 of 88 lines
    0.3–1.0s early — `물도 좀 마시고` at 51.52s, spoken at 54.07s. Here a start
    sitting in silence moves forward to the first voiced frame, and an end
    sitting in silence moves back to the last one, never past the word's
    other edge. Words already on speech are untouched.
    """
    try:
        import numpy as np
        from faster_whisper.audio import decode_audio
        sr = 16000
        audio = decode_audio(audio_path, sampling_rate=sr)
    except Exception:
        return
    hop = int(sr * ENERGY_HOP)
    n = len(audio) // hop
    if n == 0:
        return
    frames = audio[: n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    voiced = 20 * np.log10(np.maximum(rms, 1e-10)) > SPEECH_FLOOR_DB
    # Require a short run so a stray click doesn't count as an onset.
    run = np.convolve(voiced.astype(int), np.ones(MIN_VOICED_FRAMES, int), "full")
    onset_ok = run[MIN_VOICED_FRAMES - 1:] == MIN_VOICED_FRAMES  # run starting here
    offset_ok = run[:n] == MIN_VOICED_FRAMES                      # run ending here

    for k, w in enumerate(words):
        a = max(0, min(n - 1, int(w["start"] / ENERGY_HOP)))
        b = max(a + 1, min(n, int(np.ceil(w["end"] / ENERGY_HOP))))
        # A start may move up to where the next word begins: Whisper sometimes
        # ends a word before it is even spoken (`물도` 51.52–52.80, heard 54.07).
        nxt = int(words[k + 1]["start"] / ENERGY_HOP) if k + 1 < len(words) else n
        reach = max(b, min(n, nxt))
        # A word doesn't contain a long pause. When one does, Whisper has
        # stretched it back over the previous line's tail (`물도 좀 마시고`
        # began at 51.52s on the end of `네, 그렇게 할게요`, then 2.3s of
        # silence) — start after the last pause.
        span = voiced[a:b]
        silent_run = np.convolve((~span).astype(int), np.ones(INNER_PAUSE_FRAMES, int), "valid")
        pauses = np.flatnonzero(silent_run == INNER_PAUSE_FRAMES)
        if pauses.size:
            after = a + pauses[-1] + INNER_PAUSE_FRAMES
            hits = np.flatnonzero(onset_ok[after:reach])
            if hits.size:
                a = after + hits[0]
        if not voiced[a]:
            hits = np.flatnonzero(onset_ok[a:reach])
            if hits.size:
                a += hits[0]
        if a * ENERGY_HOP > w["start"]:
            w["start"] = a * ENERGY_HOP
            w["end"] = max(w["end"], w["start"] + 0.1)
            b = max(a + 1, min(n, int(np.ceil(w["end"] / ENERGY_HOP))))
        if not voiced[b - 1]:
            lo = max(a, int(w["start"] / ENERGY_HOP))
            hits = np.flatnonzero(offset_ok[lo:b])
            if hits.size:
                w["end"] = (lo + hits[-1] + 1) * ENERGY_HOP


def align(audio_path: str, script_path: str, lang: str) -> List[dict]:
    """Run Whisper-based forced alignment.

    `lang` is "ko" or "ja". Script must be plain text with one block per line
    (already normalized by the caller).
    """
    whisper_lang = LANG_TO_WHISPER.get(lang)
    if not whisper_lang:
        raise ValueError(f"Unsupported language: {lang}")

    model = _get_model()

    segments_iter, info = model.transcribe(
        audio_path,
        language=whisper_lang,
        word_timestamps=True,
        vad_filter=True,
        beam_size=1,
        condition_on_previous_text=False,
    )

    whisper_words: List[dict] = []
    for seg in segments_iter:
        for w in seg.words or []:
            text = (w.word or "").strip()
            if not text:
                continue
            whisper_words.append({
                "text": text,
                "norm": _normalize(text),
                "start": float(w.start),
                "end": float(w.end),
            })

    _refine_with_energy(whisper_words, audio_path)

    audio_duration = float(getattr(info, "duration", 0.0) or 0.0)
    if whisper_words and audio_duration <= 0:
        audio_duration = whisper_words[-1]["end"]

    with open(script_path, encoding="utf-8") as f:
        script_lines = [ln.strip() for ln in f.read().splitlines() if ln.strip()]

    if not script_lines:
        return []

    # Tokenize each script line into normalized words; remember ownership.
    script_norm_words: List[str] = []
    line_ranges: List[tuple] = []
    for line in script_lines:
        words = [_normalize(w) for w in re.split(r"\s+", line) if w.strip()]
        words = [w for w in words if w]
        s = len(script_norm_words)
        script_norm_words.extend(words)
        line_ranges.append((s, len(script_norm_words)))

    if not script_norm_words or not whisper_words:
        # Nothing to align — give every line equal share of audio duration.
        per = max(audio_duration, 0.001) / len(script_lines)
        return [
            {
                "index": i,
                "start": round(i * per, 3),
                "end": round((i + 1) * per, 3),
                "text": line,
            }
            for i, line in enumerate(script_lines)
        ]

    whisper_norm = [w["norm"] for w in whisper_words]
    mapping = _needleman_wunsch(script_norm_words, whisper_norm)

    blocks_with_times: List[dict] = []
    for line_idx, (s, e) in enumerate(line_ranges):
        first_w = next(
            (mapping[i] for i in range(s, e) if mapping[i] >= 0), None
        )
        last_w = next(
            (mapping[i] for i in range(e - 1, s - 1, -1) if mapping[i] >= 0),
            None,
        )
        start = whisper_words[first_w]["start"] if first_w is not None else None
        end = whisper_words[last_w]["end"] if last_w is not None else None
        # Guard against zero-length blocks
        if start is not None and end is not None and end <= start:
            end = start + 0.1
        blocks_with_times.append({
            "index": line_idx,
            "start": start,
            "end": end,
            "text": script_lines[line_idx],
        })

    blocks_with_times = _interpolate_unmatched(blocks_with_times, audio_duration)

    MIN_DURATION = 0.5  # seconds — prevents SRT players from dropping near-zero blocks
    result = []
    for b in blocks_with_times:
        start = round(b["start"] or 0.0, 3)
        end = round(b["end"] or start + MIN_DURATION, 3)
        if end - start < MIN_DURATION:
            end = round(start + MIN_DURATION, 3)
        result.append({"index": b["index"], "start": start, "end": end, "text": b["text"]})
    return result

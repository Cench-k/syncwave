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

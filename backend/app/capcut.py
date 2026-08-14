"""CapCut draft integration — local use only.

Lets SyncWave align a script against a CapCut project without the user having
to export audio from CapCut first, and write the finished subtitles straight
into the project's timeline.

Why this exists: aligning against the original TTS mp3 produces times on the
*source* clock, but the timeline is a re-cut of that file — silences removed,
speed changed, pieces reordered. On a measured project the two clocks drift
apart by up to 27s. Rather than mapping between the clocks after the fact, we
rebuild the audio exactly as the timeline plays it and align against that, so
the result is already on the timeline clock.

Draft facts this relies on (verified against CapCut International 9.x drafts):
  * All times are integer microseconds.
  * `materials.audios` holds one entry *per segment*, so materials must be
    grouped by file path, never by id (a 64-piece narration appears as 64
    separate material entries pointing at the same file).
  * `type` distinguishes the user's own audio ("extract_music") from CapCut's
    stock effects ("sound"). Only the former carries narration, and narration
    is routinely spread over several TTS files.
  * A text segment references one `materials.texts` entry plus a
    `materials.material_animations` entry via `extra_material_refs`.
  * The visible string lives in `texts[].content` as an embedded JSON document
    whose `styles[].range` must span the text length or the styling only
    applies to part of the line.
"""
from __future__ import annotations

import copy
import json
import math
import os
import shutil
import subprocess
import time
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional

US = 1_000_000  # CapCut stores every timestamp in microseconds

# Audio the user brought in themselves. CapCut's own library effects are
# tagged "sound" and must stay out of the speech reconstruction.
SPEECH_TYPES = {"extract_music", "music", "record"}

DEFAULT_DRAFT_ROOT = Path(
    os.environ.get("CAPCUT_DRAFT_ROOT")
    or (Path(os.environ.get("LOCALAPPDATA", "")) / "CapCut/User Data/Projects/com.lveditor.draft")
)


class CapCutError(RuntimeError):
    pass


class EditorOpenError(CapCutError):
    """CapCut is running, so anything we write would be overwritten."""


def _uid() -> str:
    return str(uuid.uuid4()).upper()


# --------------------------------------------------------------------------
# Reading


def draft_root() -> Path:
    return DEFAULT_DRAFT_ROOT


def list_projects(root: Optional[Path] = None) -> List[dict]:
    """Every draft folder that actually holds a project, newest first."""
    root = Path(root or draft_root())
    if not root.is_dir():
        raise CapCutError(f"CapCut 드래프트 폴더를 찾을 수 없습니다: {root}")
    out = []
    for entry in root.iterdir():
        content = entry / "draft_content.json"
        if not (entry.is_dir() and content.is_file()):
            continue
        out.append({
            "name": entry.name,
            "modified": content.stat().st_mtime,
            "size": content.stat().st_size,
        })
    out.sort(key=lambda r: r["modified"], reverse=True)
    return out


def project_dir(name: str, root: Optional[Path] = None) -> Path:
    root = Path(root or draft_root())
    # Draft names are user-controlled; keep the resolved path inside the root.
    target = (root / name).resolve()
    if root.resolve() not in target.parents and target != root.resolve():
        raise CapCutError("잘못된 프로젝트 이름입니다")
    if not (target / "draft_content.json").is_file():
        raise CapCutError(f"프로젝트를 찾을 수 없습니다: {name}")
    return target


def load_draft(name: str, root: Optional[Path] = None) -> tuple[dict, Path]:
    path = project_dir(name, root) / "draft_content.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f), path


def speech_segments(draft: dict, types: Iterable[str] = SPEECH_TYPES) -> Dict[str, List[dict]]:
    """Spoken-audio segments grouped by source file path, timeline-ordered."""
    types = set(types)
    mats = {m["id"]: m for m in draft.get("materials", {}).get("audios", [])}
    by_path: Dict[str, List[dict]] = defaultdict(list)
    for track in draft.get("tracks", []):
        if track.get("type") != "audio":
            continue
        for seg in track.get("segments", []):
            mat = mats.get(seg.get("material_id"))
            if not mat or mat.get("type") not in types:
                continue
            path = (mat.get("path") or "").replace("\\", "/")
            if not path:
                continue
            tgt = seg.get("target_timerange") or {}
            src = seg.get("source_timerange") or {}
            by_path[path].append({
                "tl": tgt.get("start", 0) / US,
                "tldur": tgt.get("duration", 0) / US,
                "src": src.get("start", 0) / US,
                "srcdur": src.get("duration", 0) / US,
                "speed": float(seg.get("speed") or 1.0),
                "volume": float(seg.get("volume", 1.0)),
            })
    for segs in by_path.values():
        segs.sort(key=lambda s: s["tl"])
    return dict(by_path)


def project_info(draft: dict) -> dict:
    speech = speech_segments(draft)
    files = []
    for path, segs in sorted(speech.items(), key=lambda kv: -sum(s["tldur"] for s in kv[1])):
        files.append({
            "path": path,
            "name": os.path.basename(path),
            "segments": len(segs),
            "coverage": round(sum(s["tldur"] for s in segs), 3),
            "exists": os.path.exists(path),
            "speeds": sorted({round(s["speed"], 3) for s in segs}),
        })
    text_tracks = []
    for i, track in enumerate(draft.get("tracks", [])):
        if track.get("type") == "text":
            text_tracks.append({
                "index": i,
                "id": track.get("id"),
                "name": track.get("name") or "",
                "segments": len(track.get("segments", [])),
            })
    return {
        "fps": draft.get("fps"),
        "duration": round(draft.get("duration", 0) / US, 3),
        "canvas": draft.get("canvas_config") or {},
        "speech_files": files,
        "text_tracks": text_tracks,
    }


# --------------------------------------------------------------------------
# Rebuilding the timeline audio


def _atempo_chain(speed: float) -> List[float]:
    """ffmpeg's atempo accepts 0.5–2.0 per stage; decompose anything outside."""
    stages, remaining = [], speed
    while remaining > 2.0:
        stages.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        stages.append(0.5)
        remaining /= 0.5
    stages.append(remaining)
    return stages


SILENCE_FLOOR_DB = -80.0


def build_speech_audio(draft: dict, out_path: str, only_paths: Optional[Iterable[str]] = None) -> dict:
    """Render the spoken track exactly as the timeline plays it.

    Each segment is cut from its source file, re-timed for the segment's speed
    and laid onto a silent bed at its timeline position. The result shares the
    timeline's clock, so alignment output needs no remapping afterwards.

    Segments are cut one ffmpeg call at a time rather than as a single big
    filter_complex. Referencing one input from dozens of atrim branches makes
    ffmpeg split and buffer that stream, and on a 64-piece narration it
    silently produced an 83ms file of pure silence — which the aligner then
    "aligned" into evenly spaced nonsense. One short call per segment costs a
    few seconds next to Whisper and cannot fail that way.
    """
    speech = speech_segments(draft)
    if only_paths is not None:
        wanted = set(only_paths)
        speech = {p: s for p, s in speech.items() if p in wanted}
    missing = [p for p in speech if not os.path.exists(p)]
    if missing:
        raise CapCutError("음성 파일을 찾을 수 없습니다: " + ", ".join(os.path.basename(p) for p in missing))
    if not speech:
        raise CapCutError("이 프로젝트에서 음성 트랙을 찾지 못했습니다")

    total = draft.get("duration", 0) / US
    if total <= 0:
        total = max(s["tl"] + s["tldur"] for segs in speech.values() for s in segs)

    from pydub import AudioSegment  # local import: only this path needs it

    timeline = AudioSegment.silent(duration=int(round(total * 1000)), frame_rate=44100)
    work = Path(out_path).with_suffix(".parts")
    work.mkdir(exist_ok=True)
    placed = 0
    try:
        for path, segs in speech.items():
            for i, seg in enumerate(segs):
                if seg["srcdur"] <= 0:
                    continue
                piece = work / f"{abs(hash(path)) % 10**8}_{i}.wav"
                # -ss/-t before -i seeks on the input, so each call decodes
                # only its own slice and the inputs stay independent.
                cmd = ["ffmpeg", "-y", "-v", "error",
                       "-ss", f"{seg['src']:.6f}", "-t", f"{seg['srcdur']:.6f}",
                       "-i", path]
                if abs(seg["speed"] - 1.0) > 1e-6:
                    chain = ",".join(f"atempo={s:.6f}" for s in _atempo_chain(seg["speed"]))
                    cmd += ["-filter:a", chain]
                cmd += ["-ar", "44100", "-ac", "1", str(piece)]
                proc = subprocess.run(cmd, capture_output=True, text=True,
                                      encoding="utf-8", errors="replace")
                if proc.returncode != 0 or not piece.exists():
                    raise CapCutError(
                        f"음성 조각 추출 실패 ({os.path.basename(path)} @{seg['src']:.2f}s): "
                        + (proc.stderr or "")[-300:]
                    )
                # format="wav" makes pydub use its own wav reader; without it
                # it shells out to ffprobe to sniff the format, which would
                # mean shipping a second 200MB binary in the desktop build.
                audio = AudioSegment.from_file(piece, format="wav")
                if abs(seg["volume"] - 1.0) > 1e-6 and seg["volume"] > 0:
                    audio = audio + (20 * math.log10(seg["volume"]))
                timeline = timeline.overlay(audio, position=int(round(seg["tl"] * 1000)))
                placed += 1
                piece.unlink(missing_ok=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if placed == 0:
        raise CapCutError("재구성할 음성 조각이 없습니다")

    fmt = Path(out_path).suffix.lstrip(".").lower() or "wav"
    timeline.export(out_path, format="mp3" if fmt == "mp3" else fmt)

    # A silent result means the rebuild went wrong; catching it here beats
    # handing the aligner nothing and getting evenly spaced subtitles back.
    if timeline.max_dBFS < SILENCE_FLOOR_DB:
        raise CapCutError("재구성된 음성이 무음입니다 — 드래프트의 음성 경로를 확인해주세요")

    return {
        "segments": placed,
        "files": [os.path.basename(p) for p in speech],
        "duration": round(len(timeline) / 1000, 3),
        # Where each piece of speech audio starts on the timeline. Those cuts
        # were made by hand at line boundaries, so they anchor subtitle starts
        # better than Whisper's word timestamps — the caller snaps to them.
        "boundaries": segment_boundaries(speech),
    }


def segment_boundaries(speech: Dict[str, List[dict]]) -> List[float]:
    """Sorted timeline positions where a piece of speech audio *starts*.

    Segment ends are deliberately excluded. They sit at the far side of the
    silence the editor trimmed — median 0.2s and up to 1s on a measured
    project — so a subtitle snapping to one would appear well before its line
    is spoken. Including them also barely helped: 64 of 92 blocks landed on a
    cut versus 63 with starts alone.
    """
    return sorted({
        round(s["tl"], 4)
        for segs in speech.values()
        for s in segs
        if s["tldur"] > 0
    })


# --------------------------------------------------------------------------
# Writing subtitles back


def _find_style_template(draft: dict) -> Optional[tuple[dict, dict]]:
    """An existing subtitle to clone, so the user's font and placement survive.

    Prefers the most-used text material in the project — that is the body
    subtitle style rather than a one-off title.
    """
    texts = {m["id"]: m for m in draft.get("materials", {}).get("texts", [])}
    counts: Dict[str, int] = defaultdict(int)
    seg_for: Dict[str, dict] = {}
    for track in draft.get("tracks", []):
        if track.get("type") != "text":
            continue
        for seg in track.get("segments", []):
            mid = seg.get("material_id")
            if mid in texts:
                counts[mid] += 1
                seg_for.setdefault(mid, seg)
    if not counts:
        return None
    # Group identical styles: cloning any one of a 92-subtitle track is fine,
    # so rank by how many segments share that material's font/size signature.
    best_mid = max(counts, key=lambda m: counts[m])
    return seg_for[best_mid], texts[best_mid]


def _borrow_style_template(
    root: Optional[Path], skip: str, limit: int = 20
) -> Optional[tuple[dict, dict]]:
    """Find a subtitle style in the user's other recent projects.

    A project that has never had subtitles has nothing to copy, and the
    built-in default is a plain white box that looks nothing like the rest of
    their work. Their previous project almost always has the font, size and
    placement they actually use, so borrow from there.
    """
    try:
        projects = list_projects(root)
    except CapCutError:
        return None
    for entry in projects[:limit]:
        if entry["name"] == skip:
            continue
        try:
            other, _ = load_draft(entry["name"], root)
        except (CapCutError, json.JSONDecodeError, OSError):
            continue
        found = _find_style_template(other)
        if found:
            return found
    return None


def _set_text(material: dict, text: str) -> None:
    """Replace the visible string, keeping every style attribute intact."""
    raw = material.get("content") or ""
    try:
        doc = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        doc = {}
    doc["text"] = text
    styles = doc.get("styles")
    if isinstance(styles, list):
        for st in styles:
            # range must span the whole string or the styling stops partway.
            if isinstance(st, dict):
                st["range"] = [0, len(text)]
    material["content"] = json.dumps(doc, ensure_ascii=False)
    material["base_content"] = ""


def _default_text_material(text: str) -> dict:
    """Minimal subtitle material for projects with no existing text to copy."""
    return {
        "id": _uid(),
        "type": "subtitle",
        "content": json.dumps({
            "text": text,
            "styles": [{
                "fill": {"content": {"render_type": "solid", "solid": {"color": [1, 1, 1]}}},
                "strokes": [{"content": {"render_type": "solid", "solid": {"color": [0, 0, 0]}},
                             "width": 0.06, "mode": 0}],
                "size": 16,
                "range": [0, len(text)],
            }],
        }, ensure_ascii=False),
        "base_content": "",
        "alignment": 1,
        "font_size": 16.0,
        "text_color": "#ffffff",
        "border_color": "#000000",
        "border_width": 0.08,
        "border_alpha": 1.0,
        "line_spacing": 0.02,
        "letter_spacing": 0.0,
        "text_alpha": 1.0,
        "global_alpha": 1.0,
        "background_alpha": 1.0,
        "line_max_width": 0.82,
        "typesetting": 0,
        "line_feed": 1,
        "check_flag": 15,
        "add_type": 2,
        "words": {"start_time": [], "end_time": [], "text": []},
    }


def _default_text_segment(material_id: str, anim_id: str, start_us: int, dur_us: int) -> dict:
    return {
        "id": _uid(),
        "source_timerange": None,
        "target_timerange": {"start": start_us, "duration": dur_us},
        "render_timerange": {"start": 0, "duration": 0},
        "speed": 1.0,
        "volume": 1.0,
        "last_nonzero_volume": 1.0,
        "visible": True,
        "clip": {
            "scale": {"x": 1.0, "y": 1.0},
            "rotation": 0.0,
            "transform": {"x": 0.0, "y": -0.45},
            "flip": {"vertical": False, "horizontal": False},
            "alpha": 1.0,
        },
        "uniform_scale": {"on": True, "value": 1.0},
        "material_id": material_id,
        "extra_material_refs": [anim_id],
        "render_index": 14000,
        "track_render_index": 1,
        "keyframe_refs": [],
        "common_keyframes": [],
        "enable_adjust": False,
        "enable_lut": False,
        "is_placeholder": False,
        "template_scene": "default",
        "source": "segmentsourcenormal",
        "group_id": "",
        "caption_info": None,
    }


CAPCUT_PROCESSES = ("CapCut.exe", "JianyingPro.exe")


def running_editors() -> List[str]:
    """Which CapCut processes are alive right now.

    CapCut holds the whole project in memory and rewrites draft_content.json
    on its own schedule. Writing while it is open therefore looks like it
    worked and then silently loses everything: on one real project we wrote
    subtitles at 10:33, CapCut opened at 10:58 and overwrote the file at
    10:59, leaving no text track behind. A warning in the dialog was not
    enough, so the write refuses outright.
    """
    if os.name != "nt":
        return []
    found = []
    for name in CAPCUT_PROCESSES:
        try:
            proc = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError:
            continue
        if name.lower() in (proc.stdout or "").lower():
            found.append(name)
    return found


def editor_started_at() -> Optional[float]:
    """Epoch seconds of the earliest running CapCut process, if we can tell."""
    if os.name != "nt":
        return None
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "(Get-Process CapCut,JianyingPro -ErrorAction SilentlyContinue "
             "| Sort-Object StartTime | Select-Object -First 1)"
             ".StartTime.ToUniversalTime().Ticks"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        ticks = int((proc.stdout or "").strip())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    # .NET ticks are 100ns units since year 1; epoch is 621355968000000000.
    # ToUniversalTime() matters: StartTime is local, and treating those ticks
    # as UTC put the process nine hours in the future here, which made every
    # project look older than CapCut and so "not open".
    return (ticks - 621_355_968_000_000_000) / 10_000_000


def project_looks_open(path: Path) -> Optional[bool]:
    """Is CapCut most likely holding *this* project open?

    CapCut locks nothing and records no "current project" anywhere we can
    read, but it does rewrite the open project's draft_content.json while it
    runs. So a file touched after CapCut started is almost certainly the one
    on screen, and every other project is safe to write to. Returns None when
    the process start time is unavailable, in which case callers should treat
    a running editor as unsafe.
    """
    started = editor_started_at()
    if started is None:
        return None
    try:
        return path.stat().st_mtime >= started
    except OSError:
        return None


def backup_draft(path: Path) -> Path:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = path.with_name(f"draft_content.{stamp}.syncwave-backup.json")
    shutil.copy2(path, dest)
    return dest


def inject_subtitles(
    name: str,
    blocks: List[dict],
    *,
    root: Optional[Path] = None,
    replace_track: Optional[str] = None,
    track_name: str = "SyncWave",
    force: bool = False,
) -> dict:
    """Write `blocks` (seconds, timeline clock) into the project as a text track.

    Always backs up draft_content.json first. `replace_track` names an existing
    text track id to overwrite instead of adding one. Refuses while CapCut is
    running unless `force`, because CapCut would overwrite the result from its
    own in-memory copy.
    """
    if not blocks:
        raise CapCutError("쓸 자막이 없습니다")

    draft_path = project_dir(name, root) / "draft_content.json"
    warning = None
    if not force and running_editors():
        state = project_looks_open(draft_path)
        if state is False:
            # Some other project is on screen; this one is safe to touch, but
            # say so because opening it later without restarting CapCut can
            # still resurrect a stale in-memory copy.
            warning = ("캡컷이 실행 중이지만 이 프로젝트는 열려 있지 않은 것으로 보입니다. "
                       "쓰기 후 캡컷을 완전히 종료했다가 다시 열어주세요.")
        else:
            raise EditorOpenError(
                "이 프로젝트가 캡컷에서 열려 있는 것 같습니다."
                if state
                else "캡컷이 실행 중입니다 (어느 프로젝트가 열렸는지 확인할 수 없었습니다)."
            )

    draft, path = load_draft(name, root)
    backup = backup_draft(path)

    total_us = draft.get("duration", 0)
    template = _find_style_template(draft)
    style_source = "project"
    if template is None:
        template = _borrow_style_template(root, skip=name)
        style_source = "borrowed" if template else "default"

    materials = draft.setdefault("materials", {})
    texts = materials.setdefault("texts", [])
    animations = materials.setdefault("material_animations", [])

    # Resolve everything in integer microseconds — the unit CapCut actually
    # stores. Doing it in float seconds and rounding afterwards let a block
    # trimmed to zero length become a 1µs segment that overlapped its
    # neighbour by exactly one tick.
    cues = []
    for b in sorted(blocks, key=lambda x: x["start"]):
        text = (b.get("text") or "").strip()
        if not text:
            continue
        cues.append([max(0, int(round(float(b["start"]) * US))),
                     int(round(float(b["end"]) * US)),
                     text])

    clipped = 0
    if total_us:
        for c in cues:
            if c[1] > total_us:
                c[1] = total_us
                clipped += 1

    # CapCut stacks overlapping captions on one track and shows only one of
    # them, so never write an overlap. The frontend shaping layer already
    # guarantees this, but the aligner's minimum-block-length rule can push a
    # block's end past its neighbour's start, and this is a public entry point.
    overlaps = 0
    for i in range(len(cues) - 1):
        if cues[i][1] > cues[i + 1][0]:
            cues[i][1] = cues[i + 1][0]
            overlaps += 1

    # Anything with no room left would be an invisible caption; report rather
    # than write a degenerate segment.
    dropped = [c[2] for c in cues if c[1] <= c[0]]
    cues = [c for c in cues if c[1] > c[0]]

    new_texts, new_anims, segments = [], [], []
    for start_us, end_us, text in cues:
        dur_us = end_us - start_us

        anim = {"id": _uid(), "type": "sticker_animation", "animations": [],
                "multi_language_current": "none"}
        if template:
            tpl_seg, tpl_mat = template
            mat = copy.deepcopy(tpl_mat)
            mat["id"] = _uid()
            _set_text(mat, text)
            seg = copy.deepcopy(tpl_seg)
            seg["id"] = _uid()
            seg["material_id"] = mat["id"]
            seg["target_timerange"] = {"start": start_us, "duration": dur_us}
            seg["extra_material_refs"] = [anim["id"]]
            seg["keyframe_refs"] = []
            seg["common_keyframes"] = []
        else:
            mat = _default_text_material(text)
            seg = _default_text_segment(mat["id"], anim["id"], start_us, dur_us)
        new_texts.append(mat)
        new_anims.append(anim)
        segments.append(seg)

    tracks = draft.setdefault("tracks", [])
    replaced = False
    if replace_track:
        for track in tracks:
            if track.get("type") == "text" and track.get("id") == replace_track:
                _drop_track_materials(draft, track)
                track["segments"] = segments
                replaced = True
                break
        if not replaced:
            raise CapCutError("교체할 자막 트랙을 찾지 못했습니다")
    else:
        tracks.append({
            "id": _uid(),
            "type": "text",
            "flag": 1,
            "attribute": 0,
            "name": track_name,
            "is_default_name": False,
            "segments": segments,
        })

    texts.extend(new_texts)
    animations.extend(new_anims)

    _atomic_write(path, draft)
    return {
        "written": len(segments),
        "backup": backup.name,
        "replaced": replaced,
        "clipped": clipped,
        "overlaps_trimmed": overlaps,
        "dropped": dropped,
        "track_name": track_name,
        "warning": warning,
        # "project" = cloned this project's own subtitles, "borrowed" = copied
        # from another recent project, "default" = plain built-in style.
        "style_source": style_source,
    }


def _drop_track_materials(draft: dict, track: dict) -> None:
    """Remove materials belonging to a track we are about to overwrite."""
    dead_texts = {s.get("material_id") for s in track.get("segments", [])}
    dead_extra = {r for s in track.get("segments", []) for r in (s.get("extra_material_refs") or [])}
    mats = draft.get("materials", {})
    if dead_texts:
        mats["texts"] = [m for m in mats.get("texts", []) if m.get("id") not in dead_texts]
    if dead_extra:
        mats["material_animations"] = [
            m for m in mats.get("material_animations", []) if m.get("id") not in dead_extra
        ]


def _atomic_write(path: Path, data: dict) -> None:
    """Write via a temp file so a crash cannot leave a half-written draft."""
    tmp = path.with_suffix(".syncwave.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)

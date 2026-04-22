"""Forced alignment using aeneas.

Wraps aeneas's ExecuteTask API to align a script (.txt, one block per line)
to an audio file (.mp3/.wav). Returns a list of {index, start, end, text}.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from typing import List

from aeneas.executetask import ExecuteTask
from aeneas.runtimeconfiguration import RuntimeConfiguration
from aeneas.task import Task
from aeneas.ttswrappers.espeakngttswrapper import ESPEAKNGTTSWrapper

# espeak-ng supports Korean and Japanese, but aeneas's wrapper omits them.
# Inject the mappings so task_language=kor/jpn resolves to the right voice codes.
ESPEAKNGTTSWrapper.LANGUAGE_TO_VOICE_CODE.setdefault("kor", "ko")
ESPEAKNGTTSWrapper.LANGUAGE_TO_VOICE_CODE.setdefault("jpn", "ja")
ESPEAKNGTTSWrapper.LANGUAGE_TO_VOICE_CODE.setdefault("ko", "ko")
ESPEAKNGTTSWrapper.LANGUAGE_TO_VOICE_CODE.setdefault("ja", "ja")


LANG_MAP = {
    "ko": "kor",
    "ja": "jpn",
}


def _espeak_ng_path() -> str:
    """Locate the espeak-ng executable."""
    found = shutil.which("espeak-ng") or shutil.which("espeak-ng.exe")
    if found:
        return found
    default = r"C:\Program Files\eSpeak NG\espeak-ng.exe"
    if os.path.exists(default):
        return default
    raise RuntimeError("espeak-ng executable not found in PATH")


@dataclass
class AlignedBlock:
    index: int
    start: float
    end: float
    text: str

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
        }


def align(audio_path: str, script_path: str, lang: str) -> List[dict]:
    """Run forced alignment and return aligned blocks.

    `lang` is "ko" or "ja". Script must be plain text with one block per line.
    """
    aeneas_lang = LANG_MAP.get(lang)
    if not aeneas_lang:
        raise ValueError(f"Unsupported language: {lang}")

    config_string = (
        f"task_language={aeneas_lang}|"
        "is_text_type=plain|"
        "os_task_file_format=json"
    )

    rconf = RuntimeConfiguration()
    rconf[RuntimeConfiguration.TTS] = "espeak-ng"
    rconf[RuntimeConfiguration.TTS_PATH] = _espeak_ng_path()

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as tmp:
        sync_map_path = tmp.name

    try:
        task = Task(config_string=config_string)
        task.audio_file_path_absolute = audio_path
        task.text_file_path_absolute = script_path
        task.sync_map_file_path_absolute = sync_map_path

        ExecuteTask(task, rconf=rconf).execute()
        task.output_sync_map_file()

        import json
        with open(sync_map_path, "r", encoding="utf-8") as f:
            sync_map = json.load(f)

        blocks: List[AlignedBlock] = []
        for i, fragment in enumerate(sync_map.get("fragments", [])):
            text_lines = fragment.get("lines", [])
            text = " ".join(line for line in text_lines if line).strip()
            if not text:
                continue
            blocks.append(
                AlignedBlock(
                    index=i,
                    start=float(fragment["begin"]),
                    end=float(fragment["end"]),
                    text=text,
                )
            )
        return [b.to_dict() for b in blocks]
    finally:
        if os.path.exists(sync_map_path):
            os.unlink(sync_map_path)

"""Periodic temp directory cleanup."""
import os
import time
from pathlib import Path


def sweep_temp(temp_dir: Path, max_age_seconds: int = 3600) -> int:
    """Delete files in temp_dir older than max_age_seconds. Returns count removed."""
    if not temp_dir.exists():
        return 0
    now = time.time()
    removed = 0
    for entry in temp_dir.iterdir():
        try:
            age = now - entry.stat().st_mtime
            if age <= max_age_seconds:
                continue
            if entry.is_file():
                entry.unlink()
                removed += 1
            elif entry.is_dir():
                for sub in entry.rglob("*"):
                    if sub.is_file():
                        sub.unlink()
                entry.rmdir()
                removed += 1
        except OSError:
            continue
    return removed

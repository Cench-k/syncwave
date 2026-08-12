import { Block } from "./types";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// Decompose from a single integer millisecond count. Rounding the fractional
// part separately (the previous approach) let 5.9997s render as
// "00:00:05,1000" — a four-digit field that editors either reject outright or
// parse as a wrong time.
function tsSrt(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function tsVtt(seconds: number): string {
  return tsSrt(seconds).replace(",", ".");
}

// SRT cues must be in chronological order and numbered accordingly; a block
// dragged past its neighbour in the editor would otherwise export out of
// sequence and confuse strict parsers.
function chronological(blocks: Block[]): Block[] {
  return [...blocks].sort((a, b) => a.start - b.start || a.index - b.index);
}

export function toSrt(blocks: Block[]): string {
  return chronological(blocks)
    .map(
      (b, i) =>
        `${i + 1}\n${tsSrt(b.start)} --> ${tsSrt(b.end)}\n${b.text}\n`
    )
    .join("\n");
}

export function toVtt(blocks: Block[]): string {
  const body = chronological(blocks)
    .map(
      (b) => `${tsVtt(b.start)} --> ${tsVtt(b.end)}\n${b.text}\n`
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function download(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 10);
  return `${pad(m)}:${pad(s)}.${ms}`;
}

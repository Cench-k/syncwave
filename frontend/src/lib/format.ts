import { Block } from "./types";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function tsSrt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function tsVtt(seconds: number): string {
  return tsSrt(seconds).replace(",", ".");
}

export function toSrt(blocks: Block[]): string {
  return blocks
    .map(
      (b, i) =>
        `${i + 1}\n${tsSrt(b.start)} --> ${tsSrt(b.end)}\n${b.text}\n`
    )
    .join("\n");
}

export function toVtt(blocks: Block[]): string {
  const body = blocks
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

/**
 * Subtitle segment shaping.
 *
 * Whisper gives us the exact instant the last matched word stops sounding,
 * which makes a technically-correct but unusable subtitle track: every block
 * ends mid-breath and a hole opens until the next one starts. Measured on a
 * real 125s CapCut project, the raw output left 81 gaps totalling 19.3s —
 * 15% of the video with nothing on screen — which the user was closing by
 * hand, one block at a time.
 *
 * This module turns raw alignment edges into a broadcast-shaped track:
 * gaps closed, minimum on-screen time enforced, edges snapped to the
 * editor's frame grid.
 *
 * The caller always shapes the raw track, never a shaped one — `blocks` in
 * Workspace stays the untouched alignment result and shaping is a pure
 * transform recomputed on every settings change. Re-applying is in fact a
 * no-op for every block except the first, whose lead-in has no preceding
 * block to floor against and would creep earlier by `leadIn` each pass.
 */
import { Block } from "./types";

export interface ShapeOptions {
  enabled: boolean;
  /** "close" = extend each block to meet the next one; "keep" = leave holes. */
  gapMode: "close" | "keep";
  /** Frames of breathing room to leave between blocks when closing gaps. */
  gapFrames: number;
  /** Never extend a block by more than this many seconds. 0 = unlimited. */
  maxExtend: number;
  /** Minimum time a block stays on screen, seconds. */
  minDuration: number;
  /** Pull each start earlier by this many seconds so the first syllable isn't clipped. */
  leadIn: number;
  /** Snap every edge to this frame grid. null = leave as-is. */
  fps: number | null;
  /** Stretch the final block to the end of the audio. */
  tailToEnd: boolean;
}

export const FPS_CHOICES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

// 60fps is what the overwhelming majority of this workflow's CapCut projects
// use (299 of 356 surveyed; 53 at 30fps, 4 at 24fps), so it is the default.
// Set the frame rate to match the project you are importing into — a mismatch
// just means the editor re-snaps, which is what we are trying to avoid.
export const DEFAULT_SHAPE: ShapeOptions = {
  enabled: true,
  gapMode: "close",
  gapFrames: 0,
  maxExtend: 1.5,
  minDuration: 0.8,
  leadIn: 0.05,
  fps: 60,
  tailToEnd: false,
};

/** Starting points per target editor and project frame rate. */
export const PRESETS: Record<string, Partial<ShapeOptions>> = {
  // Flush blocks with no gap, matching the hand-edited section of the
  // reference CapCut project: nothing on screen ever blinks off.
  capcut60: { gapMode: "close", gapFrames: 0, maxExtend: 1.5, minDuration: 0.8, fps: 60 },
  capcut24: { gapMode: "close", gapFrames: 0, maxExtend: 1.5, minDuration: 0.8, fps: 24 },
  // A one-frame hole is the broadcast convention: the eye needs a blink to
  // register that the subtitle changed rather than merely re-wrapped.
  premiere30: { gapMode: "close", gapFrames: 1, maxExtend: 1.2, minDuration: 0.9, fps: 30 },
  youtube: { gapMode: "close", gapFrames: 0, maxExtend: 2.0, minDuration: 1.0, fps: null },
  raw: { gapMode: "keep", gapFrames: 0, maxExtend: 0, minDuration: 0, leadIn: 0, fps: null },
};

const EPS = 1e-6;

function snap(v: number, fps: number | null): number {
  if (!fps) return v;
  return Math.round(v * fps) / fps;
}

/**
 * Apply shaping. `blocks` is the raw alignment output and is never mutated.
 * `audioDuration` (0 if unknown) clamps the tail.
 */
export function shapeBlocks(
  blocks: Block[],
  opts: ShapeOptions,
  audioDuration = 0
): Block[] {
  if (!opts.enabled || blocks.length === 0) return blocks;

  // Work in timeline order; restore the caller's order at the end so the
  // script list keeps its original numbering.
  const order = blocks.map((b, i) => i);
  order.sort((a, b) => blocks[a].start - blocks[b].start || a - b);
  const seq = order.map((i) => ({ ...blocks[i] }));

  const fps = opts.fps;
  const frame = fps ? 1 / fps : 0;
  const gapSec = opts.gapMode === "close" ? opts.gapFrames * frame : 0;
  let hardTail = audioDuration > 0 ? audioDuration : seq[seq.length - 1].end;
  // Floor the tail onto the frame grid, otherwise the last block gets clamped
  // to a raw duration like 125.083s and lands off-grid after everything else
  // was snapped. Floor, not round, so we never claim time past the audio.
  if (fps) hardTail = Math.floor(hardTail * fps) / fps;

  // 1. Lead-in: start a touch early so the onset consonant isn't cut off.
  //    Never reach back past where the previous block already ended.
  for (let i = 0; i < seq.length; i++) {
    const floor = i === 0 ? 0 : seq[i - 1].end;
    seq[i].start = Math.max(floor, seq[i].start - opts.leadIn);
  }

  // 2. Close gaps — the core fix. Extend (never shrink) each end toward the
  //    next start, capped by maxExtend so a long dramatic pause stays empty
  //    instead of one subtitle hanging on screen for ten seconds.
  if (opts.gapMode === "close") {
    for (let i = 0; i < seq.length - 1; i++) {
      let target = seq[i + 1].start - gapSec;
      if (opts.maxExtend > 0) {
        target = Math.min(target, seq[i].end + opts.maxExtend);
      }
      if (target > seq[i].end) seq[i].end = target;
    }
    // The final block is deliberately excluded: there is no hole after it,
    // only trailing silence. Stretching it is a separate intent, spelled
    // `tailToEnd` — otherwise every export would quietly grow a tail.
  }

  // 3. Minimum on-screen time. A 0.5s block holding 9 characters is
  //    unreadable; give it room without stealing the next block's start.
  if (opts.minDuration > 0) {
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].end - seq[i].start >= opts.minDuration - EPS) continue;
      const ceiling =
        i === seq.length - 1 ? hardTail : seq[i + 1].start - gapSec;
      seq[i].end = Math.min(seq[i].start + opts.minDuration, ceiling);
      // If even that doesn't fit, the neighbours are genuinely back-to-back;
      // leave the block short rather than overlapping.
      if (seq[i].end <= seq[i].start) seq[i].end = seq[i].start + (frame || 0.04);
    }
  }

  if (opts.tailToEnd && hardTail > seq[seq.length - 1].end) {
    seq[seq.length - 1].end = hardTail;
  }

  // 4. Hard overlap guard. Editors handle overlapping caption clips badly —
  //    Premiere stacks them, CapCut silently drops one.
  for (let i = 0; i < seq.length - 1; i++) {
    const max = seq[i + 1].start - gapSec;
    if (seq[i].end > max) seq[i].end = max;
  }

  // 5. Snap to the frame grid last, so what we export is bit-identical to
  //    what the NLE shows after import (it would snap anyway, silently).
  if (fps) {
    for (const b of seq) {
      b.start = snap(b.start, fps);
      b.end = snap(b.end, fps);
    }
    // Snapping can round two edges onto the same frame; re-separate.
    for (let i = 0; i < seq.length - 1; i++) {
      const max = seq[i + 1].start - gapSec;
      if (seq[i].end > max + EPS) seq[i].end = max;
    }
    for (const b of seq) {
      if (b.end - b.start < frame) b.end = b.start + frame;
    }
  }

  // 6. Clamp to the audio. Tidy float noise at 1e-9 rather than 1e-6: a 24fps
  //    frame is 1/24 = 0.041666…s, and rounding that to six decimals walks
  //    every edge off the frame grid we just snapped it onto.
  const tidy = (v: number) => Math.round(v * 1e9) / 1e9;
  for (const b of seq) {
    if (b.start < 0) b.start = 0;
    if (hardTail > 0 && b.end > hardTail) b.end = hardTail;
    if (b.end <= b.start) b.end = b.start + (frame || 0.04);
    b.start = tidy(b.start);
    b.end = tidy(b.end);
  }

  const result = new Array<Block>(blocks.length);
  order.forEach((origIdx, seqIdx) => {
    result[origIdx] = seq[seqIdx];
  });
  return result;
}

export interface ShapeStats {
  gapCount: number;
  gapTotal: number;
  shortCount: number;
  maxCps: number;
}

/** Diagnostics shown next to the export controls, before and after shaping. */
export function shapeStats(blocks: Block[], minDuration = 0.8): ShapeStats {
  const seq = [...blocks].sort((a, b) => a.start - b.start);
  let gapCount = 0;
  let gapTotal = 0;
  for (let i = 1; i < seq.length; i++) {
    const g = seq[i].start - seq[i - 1].end;
    if (g > 0.001) {
      gapCount++;
      gapTotal += g;
    }
  }
  let shortCount = 0;
  let maxCps = 0;
  for (const b of seq) {
    const dur = b.end - b.start;
    if (dur < minDuration) shortCount++;
    const chars = b.text.replace(/[\s\n]/g, "").length;
    if (dur > 0) maxCps = Math.max(maxCps, chars / dur);
  }
  return { gapCount, gapTotal, shortCount, maxCps };
}

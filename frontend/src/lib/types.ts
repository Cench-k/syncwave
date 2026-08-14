export type Lang = "ko" | "ja";

export interface Block {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface AlignResponse {
  job_id: string;
  blocks: Block[];
  audio_url: string;
  capcut?: CapCutBuildInfo;
}

/** What the backend rebuilt from a CapCut draft in order to align against it. */
export interface CapCutBuildInfo {
  segments: number;
  files: string[];
  duration: number;
  /** Timeline positions where each piece of speech audio starts. */
  boundaries: number[];
}

export interface CapCutProject {
  name: string;
  modified: number;
  size: number;
}

export interface CapCutSpeechFile {
  path: string;
  name: string;
  segments: number;
  coverage: number;
  exists: boolean;
  speeds: number[];
}

export interface CapCutTextTrack {
  index: number;
  id: string;
  name: string;
  segments: number;
}

export interface CapCutProjectInfo {
  fps: number | null;
  duration: number;
  canvas: { width?: number; height?: number; ratio?: string };
  speech_files: CapCutSpeechFile[];
  text_tracks: CapCutTextTrack[];
}

/** A subtitle look that can be cloned, as CapCut's inspector shows it. */
export interface CapCutStyle {
  project: string;
  modified: number;
  font: string;
  size: number | null;
  color: string;
  border: string;
  x: number;
  y: number;
}

export interface CapCutWriteResult {
  written: number;
  backup: string;
  replaced: boolean;
  clipped: number;
  overlaps_trimmed: number;
  /** Lines with no room left on the timeline, so nothing was written for them. */
  dropped: string[];
  track_name: string;
  /** Set when CapCut was running but this project appeared to be closed. */
  warning: string | null;
  /** "project" | "borrowed" | "default" | "project:<name>" when explicitly chosen. */
  style_source: string;
}

export interface SavedSession {
  fileName: string;
  audioName: string;
  lang: Lang;
  blocks: Block[];
  savedAt: number;
}

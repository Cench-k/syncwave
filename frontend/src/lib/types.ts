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
}

export interface SavedSession {
  fileName: string;
  audioName: string;
  lang: Lang;
  blocks: Block[];
  savedAt: number;
}

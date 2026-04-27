"use client";
import { useRef, useState } from "react";
import { SavedSession } from "@/lib/types";

interface Props {
  session: SavedSession;
  onResume: (audio: File) => void;
  onDiscard: () => void;
}

function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "방금 전";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.floor(hrs / 24)}일 전`;
}

export default function ResumePanel({ session, onResume, onDiscard }: Props) {
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function pick(file: File | null) {
    if (!file) return;
    if (!/\.(mp3|wav)$/i.test(file.name)) {
      setError("음성 파일(.mp3 / .wav)만 가능합니다");
      return;
    }
    if (file.name !== session.audioName) {
      // Soft warning — proceed anyway, but blocks may misalign with different audio.
      const ok = confirm(
        `저장된 음성: ${session.audioName}\n선택한 음성: ${file.name}\n\n파일명이 달라요. 그래도 복구할까요?`
      );
      if (!ok) return;
    }
    setError(null);
    onResume(file);
  }

  return (
    <div className="max-w-2xl mx-auto mt-6 p-5 rounded-xl border border-accent/40 bg-accent/5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium">💾 이전 작업이 저장되어 있습니다</div>
          <div className="text-xs text-muted mt-0.5">
            {session.audioName} · {session.blocks.length}개 블록 ·{" "}
            {session.lang === "ko" ? "한국어" : "일본어"} · {relTime(session.savedAt)}
          </div>
        </div>
        <button
          onClick={onDiscard}
          className="text-xs text-muted hover:text-white px-2 py-1"
        >
          삭제
        </button>
      </div>
      <div className="flex gap-2 items-center">
        <button
          onClick={() => inputRef.current?.click()}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-bg font-medium"
        >
          음성 다시 올리고 복구
        </button>
        <span className="text-xs text-muted">
          (저장된 자막/싱크는 그대로 복원됩니다)
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,audio/*"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

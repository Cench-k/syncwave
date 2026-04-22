"use client";
import { useRef, useState } from "react";
import { Lang } from "@/lib/types";

interface Props {
  onSubmit: (audio: File, script: File, lang: Lang) => void;
  disabled?: boolean;
}

export default function UploadPanel({ onSubmit, disabled }: Props) {
  const [audio, setAudio] = useState<File | null>(null);
  const [script, setScript] = useState<File | null>(null);
  const [lang, setLang] = useState<Lang>("ko");
  const [drag, setDrag] = useState(false);
  const audioRef = useRef<HTMLInputElement>(null);
  const scriptRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    for (const f of Array.from(e.dataTransfer.files)) {
      if (/\.(mp3|wav)$/i.test(f.name)) setAudio(f);
      else if (/\.txt$/i.test(f.name)) setScript(f);
    }
  }

  const ready = audio && script && !disabled;

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={handleDrop}
        className={`rounded-2xl border-2 border-dashed p-12 text-center transition ${
          drag ? "border-accent bg-accent/5" : "border-border bg-panel"
        }`}
      >
        <p className="text-lg mb-2">대본(.txt)과 음성(.mp3/.wav)을 끌어다 놓으세요</p>
        <p className="text-sm text-muted mb-6">최대 50MB · 1~30분 분량</p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => audioRef.current?.click()}
            className="px-4 py-2 rounded-lg bg-panel border border-border hover:border-accent"
          >
            {audio ? `🎵 ${audio.name}` : "음성 선택"}
          </button>
          <button
            onClick={() => scriptRef.current?.click()}
            className="px-4 py-2 rounded-lg bg-panel border border-border hover:border-accent"
          >
            {script ? `📄 ${script.name}` : "대본 선택"}
          </button>
        </div>
        <input
          ref={audioRef}
          type="file"
          accept=".mp3,.wav,audio/*"
          className="hidden"
          onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
        />
        <input
          ref={scriptRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          onChange={(e) => setScript(e.target.files?.[0] ?? null)}
        />
      </div>

      <div className="mt-6 flex items-center justify-between">
        <div className="flex gap-2">
          {(["ko", "ja"] as Lang[]).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-4 py-2 rounded-lg text-sm border ${
                lang === l
                  ? "bg-accent text-bg border-accent"
                  : "bg-panel border-border text-muted hover:text-white"
              }`}
            >
              {l === "ko" ? "한국어" : "일본어"}
            </button>
          ))}
        </div>
        <button
          disabled={!ready}
          onClick={() => audio && script && onSubmit(audio, script, lang)}
          className="px-6 py-2 rounded-lg bg-accent text-bg font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
        >
          싱크 맞추기
        </button>
      </div>

      <p className="text-xs text-muted text-center mt-8">
        🔒 작업 완료 즉시 서버 데이터 영구 삭제
      </p>
    </div>
  );
}

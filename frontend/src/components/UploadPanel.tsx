"use client";
import { useRef, useState } from "react";
import { Lang } from "@/lib/types";

interface Props {
  onSubmit: (audios: File[], script: File, lang: Lang) => void;
  disabled?: boolean;
}

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

export default function UploadPanel({ onSubmit, disabled }: Props) {
  const [audios, setAudios] = useState<File[]>([]);
  const [script, setScript] = useState<File | null>(null);
  const [lang, setLang] = useState<Lang>("ko");
  const [drag, setDrag] = useState(false);
  const audioRef = useRef<HTMLInputElement>(null);
  const scriptRef = useRef<HTMLInputElement>(null);

  const totalBytes = audios.reduce((s, f) => s + f.size, 0);
  const overSize = totalBytes > MAX_TOTAL_BYTES;

  function addAudios(files: File[]) {
    const valid = files.filter((f) => /\.(mp3|wav)$/i.test(f.name));
    if (!valid.length) return;
    // De-dupe by name+size; preserve insertion order for new ones.
    setAudios((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}|${f.size}`));
      const merged = [...prev];
      for (const f of valid) {
        const key = `${f.name}|${f.size}`;
        if (!seen.has(key)) {
          merged.push(f);
          seen.add(key);
        }
      }
      // Initial sort by natural filename order to handle 1.mp3, 2.mp3, ... 10.mp3
      return merged.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      );
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    const files = Array.from(e.dataTransfer.files);
    const audioFiles = files.filter((f) => /\.(mp3|wav)$/i.test(f.name));
    const scriptFile = files.find((f) => /\.txt$/i.test(f.name));
    if (audioFiles.length) addAudios(audioFiles);
    if (scriptFile) setScript(scriptFile);
  }

  function move(idx: number, dir: -1 | 1) {
    setAudios((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  function remove(idx: number) {
    setAudios((prev) => prev.filter((_, i) => i !== idx));
  }

  const ready = audios.length > 0 && script && !disabled && !overSize;

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={handleDrop}
        className={`rounded-2xl border-2 border-dashed p-10 text-center transition ${
          drag ? "border-accent bg-accent/5" : "border-border bg-panel"
        }`}
      >
        <p className="text-lg mb-2">대본(.txt)과 음성(.mp3/.wav)을 끌어다 놓으세요</p>
        <p className="text-sm text-muted mb-1">합계 최대 50MB · 1~30분 분량</p>
        <p className="text-xs text-accent/80 mb-6">
          💡 대본의 <b>줄바꿈(Enter)</b>이 자막 블록 1개의 기준이 됩니다 (빈 줄은 무시) ·
          음성 여러 개는 순서대로 이어붙여 정렬합니다
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => audioRef.current?.click()}
            className="px-4 py-2 rounded-lg bg-panel border border-border hover:border-accent"
          >
            🎵 음성 추가{audios.length > 0 ? ` (${audios.length})` : ""}
          </button>
          <button
            onClick={() => scriptRef.current?.click()}
            className="px-4 py-2 rounded-lg bg-panel border border-border hover:border-accent"
          >
            {script ? `📄 ${script.name}` : "📄 대본 선택"}
          </button>
        </div>
        <input
          ref={audioRef}
          type="file"
          accept=".mp3,.wav,audio/*"
          multiple
          className="hidden"
          onChange={(e) => {
            addAudios(Array.from(e.target.files ?? []));
            // reset so the same file can be re-picked after removal
            if (audioRef.current) audioRef.current.value = "";
          }}
        />
        <input
          ref={scriptRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          onChange={(e) => setScript(e.target.files?.[0] ?? null)}
        />
      </div>

      {audios.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-panel/50">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border text-xs text-muted">
            <span>
              음성 {audios.length}개 · 합계 {formatSize(totalBytes)}{" "}
              {overSize && (
                <span className="text-red-400 ml-1">(50MB 초과)</span>
              )}
            </span>
            <button
              onClick={() => setAudios([])}
              className="text-muted hover:text-white"
            >
              모두 지우기
            </button>
          </div>
          <ul className="divide-y divide-border">
            {audios.map((f, i) => (
              <li
                key={`${f.name}-${f.size}-${i}`}
                className="flex items-center gap-2 px-4 py-2 text-sm"
              >
                <span className="font-mono text-xs text-muted w-6">
                  {i + 1}.
                </span>
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-xs text-muted">{formatSize(f.size)}</span>
                <button
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="px-1.5 py-0.5 text-xs border border-border rounded disabled:opacity-30 hover:border-accent"
                  title="위로"
                >
                  ▲
                </button>
                <button
                  onClick={() => move(i, 1)}
                  disabled={i === audios.length - 1}
                  className="px-1.5 py-0.5 text-xs border border-border rounded disabled:opacity-30 hover:border-accent"
                  title="아래로"
                >
                  ▼
                </button>
                <button
                  onClick={() => remove(i)}
                  className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300"
                  title="삭제"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
          onClick={() => ready && onSubmit(audios, script!, lang)}
          className="px-6 py-2 rounded-lg bg-accent text-bg font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
        >
          싱크 맞추기
        </button>
      </div>

      <p className="text-xs text-muted text-center mt-8">
        🔒 작업 완료 즉시 서버 데이터 영구 삭제 (합쳐진 음성은 1시간 내 자동 삭제)
      </p>
    </div>
  );
}

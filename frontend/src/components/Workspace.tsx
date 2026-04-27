"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Block, Lang } from "@/lib/types";
import { toSrt, toVtt, download, formatTime } from "@/lib/format";
import { saveSession, clearSession } from "@/lib/storage";
import { useToast } from "./Toast";
import Waveform, { WaveControls } from "./Waveform";
import ScriptList from "./ScriptList";

interface Props {
  audioFile: File;
  initialBlocks: Block[];
  lang: Lang;
  onReset: () => void;
}

const NUDGE = 0.1;

export default function Workspace({
  audioFile,
  initialBlocks,
  lang,
  onReset,
}: Props) {
  const [blocks, setBlocks] = useState<Block[]>(initialBlocks);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);
  const controlsRef = useRef<WaveControls | null>(null);
  const toast = useToast();

  const audioUrl = useMemo(() => URL.createObjectURL(audioFile), [audioFile]);
  useEffect(() => () => URL.revokeObjectURL(audioUrl), [audioUrl]);

  const activeIndex = useMemo(() => {
    const hit = blocks.find(
      (b) => currentTime >= b.start && currentTime < b.end
    );
    return hit?.index ?? null;
  }, [blocks, currentTime]);

  // Autosave to localStorage every minute (with toast)
  useEffect(() => {
    const id = setInterval(() => {
      saveSession({
        fileName: audioFile.name.replace(/\.[^.]+$/, ""),
        audioName: audioFile.name,
        lang,
        blocks,
        savedAt: Date.now(),
      });
      toast.show("💾 자동 저장됨");
    }, 60_000);
    return () => clearInterval(id);
  }, [blocks, audioFile, lang, toast]);

  // Warn before leaving
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const updateBlock = useCallback(
    (index: number, patch: Partial<Block>) => {
      setBlocks((prev) =>
        prev.map((b) => (b.index === index ? { ...b, ...patch } : b))
      );
    },
    []
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Nudge active block by 0.1s: Shift = start edge, Alt = end edge
      if ((e.shiftKey || e.altKey) && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        if (activeIndex == null) return;
        const dir = e.code === "ArrowRight" ? 1 : -1;
        const block = blocks.find((b) => b.index === activeIndex);
        if (!block) return;
        e.preventDefault();
        if (e.shiftKey) {
          const start = Math.max(0, Math.min(block.end - 0.05, block.start + dir * NUDGE));
          updateBlock(activeIndex, { start });
        } else {
          const end = Math.max(block.start + 0.05, block.end + dir * NUDGE);
          updateBlock(activeIndex, { end });
        }
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        controlsRef.current?.playPause();
        setPlaying((p) => !p);
      } else if (e.code === "ArrowLeft") {
        controlsRef.current?.seek(currentTime - 5);
      } else if (e.code === "ArrowRight") {
        controlsRef.current?.seek(currentTime + 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTime, activeIndex, blocks, updateBlock]);

  const handleJump = (index: number) => {
    const b = blocks.find((x) => x.index === index);
    if (b) controlsRef.current?.playRegion(b.start, b.end);
  };

  const baseName = audioFile.name.replace(/\.[^.]+$/, "");

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-panel">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (confirm("새 작업을 시작하시겠습니까?")) {
                clearSession();
                onReset();
              }
            }}
            className="text-muted hover:text-white text-sm"
          >
            ← 새 작업
          </button>
          <div className="text-sm font-mono">{audioFile.name}</div>
          <div className="text-xs text-muted">{blocks.length}개 블록</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => download(`${baseName}.srt`, toSrt(blocks))}
            className="px-3 py-1.5 text-sm rounded bg-accent text-bg font-medium"
          >
            .srt 다운로드
          </button>
          <button
            onClick={() => download(`${baseName}.vtt`, toVtt(blocks))}
            className="px-3 py-1.5 text-sm rounded border border-border hover:border-accent"
          >
            .vtt
          </button>
        </div>
      </header>

      {/* Waveform */}
      <section className="px-6 py-4 border-b border-border bg-panel/50">
        <Waveform
          audioUrl={audioUrl}
          blocks={blocks}
          activeIndex={activeIndex}
          onReady={(d) => setDuration(d)}
          onTimeUpdate={setCurrentTime}
          onRegionEdit={(idx, start, end) => updateBlock(idx, { start, end })}
          onRegionClick={(idx) => handleJump(idx)}
          registerControls={(c) => (controlsRef.current = c)}
        />

        {/* Transport */}
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={() => {
              controlsRef.current?.playPause();
              setPlaying((p) => !p);
            }}
            className="px-4 py-1.5 rounded bg-accent text-bg font-medium"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            onClick={() => controlsRef.current?.seek(currentTime - 5)}
            className="px-2 py-1.5 text-sm border border-border rounded hover:border-accent"
          >
            ⟲ 5s
          </button>
          <button
            onClick={() => controlsRef.current?.seek(currentTime + 5)}
            className="px-2 py-1.5 text-sm border border-border rounded hover:border-accent"
          >
            5s ⟳
          </button>
          <div className="flex gap-1 ml-2">
            {[1.0, 1.25, 1.5].map((r) => (
              <button
                key={r}
                onClick={() => {
                  controlsRef.current?.setRate(r);
                  setRate(r);
                }}
                className={`px-2 py-1 text-xs rounded ${
                  rate === r
                    ? "bg-accent text-bg"
                    : "border border-border text-muted hover:text-white"
                }`}
              >
                {r}x
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[11px] text-muted hidden md:inline">
              Shift+◀▶ 시작 0.1s · Alt+◀▶ 끝 0.1s
            </span>
            <span className="font-mono text-sm text-muted">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        </div>
      </section>

      {/* Script list */}
      <section className="flex-1 min-h-0">
        <ScriptList
          blocks={blocks}
          activeIndex={activeIndex}
          onJump={handleJump}
          onTextChange={(idx, text) => updateBlock(idx, { text })}
        />
      </section>
    </div>
  );
}

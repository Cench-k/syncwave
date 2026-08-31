"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Block, Lang } from "@/lib/types";
import { toSrt, toVtt, download, formatTime } from "@/lib/format";
import { ShapeOptions, DEFAULT_SHAPE, shapeBlocks } from "@/lib/shape";
import { saveSession, clearSession, loadShape, saveShape } from "@/lib/storage";
import { useToast } from "./Toast";
import Waveform, { WaveControls } from "./Waveform";
import ScriptList from "./ScriptList";
import ExportPanel from "./ExportPanel";
import CapCutWriteButton from "./CapCutWriteButton";

interface Props {
  audioFile: File;
  initialBlocks: Block[];
  lang: Lang;
  onReset: () => void;
  /** Set when the alignment came from a CapCut project, enabling write-back. */
  capcutProject?: string | null;
  /** Which of the project's timelines the alignment came from. */
  capcutTimeline?: string | null;
  /** Timeline positions where CapCut cut the speech audio, for edge snapping. */
  cuts?: number[];
}

const NUDGE = 0.1;

export default function Workspace({
  audioFile,
  initialBlocks,
  lang,
  onReset,
  capcutProject = null,
  capcutTimeline = null,
  cuts = [],
}: Props) {
  const [blocks, setBlocks] = useState<Block[]>(initialBlocks);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);
  const [shape, setShape] = useState<ShapeOptions>(DEFAULT_SHAPE);
  const [showPanel, setShowPanel] = useState(false);
  const [preview, setPreview] = useState(true);
  const controlsRef = useRef<WaveControls | null>(null);
  const toast = useToast();

  // Shaping settings are a per-user preference, not per-session data.
  useEffect(() => {
    const saved = loadShape();
    if (saved) setShape(saved);
  }, []);

  const patchShape = useCallback((patch: Partial<ShapeOptions>) => {
    setShape((prev) => {
      const next = { ...prev, ...patch };
      saveShape(next);
      return next;
    });
  }, []);

  // Create and revoke in one effect. Deriving the URL from useMemo and
  // revoking it from a separate effect breaks under StrictMode's dev
  // double-mount: the cleanup revokes the URL, the remount finds useMemo's
  // deps unchanged and hands back the now-dead URL, and wavesurfer silently
  // fetches nothing. Tying both to the same effect re-creates it on remount.
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(audioFile);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audioFile]);

  // `blocks` stays the raw alignment result so edits and re-shaping never
  // compound; shaping is a pure view/export transform on top of it.
  const shaped = useMemo(
    () => shapeBlocks(blocks, shape, duration, cuts),
    [blocks, shape, duration, cuts]
  );
  const view = preview ? shaped : blocks;

  const activeIndex = useMemo(() => {
    const hit = view.find(
      (b) => currentTime >= b.start && currentTime < b.end
    );
    return hit?.index ?? null;
  }, [view, currentTime]);

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

  const shiftAll = useCallback((delta: number) => {
    setBlocks((prev) => {
      // Clamp so the earliest block's start never goes below 0.
      const minStart = Math.min(...prev.map((b) => b.start));
      const applied = Math.max(delta, -minStart);
      if (applied === 0) return prev;
      return prev.map((b) => ({
        ...b,
        start: b.start + applied,
        end: b.end + applied,
      }));
    });
  }, []);

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
    const b = view.find((x) => x.index === index);
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
            onClick={() => setShowPanel((v) => !v)}
            className={`px-3 py-1.5 text-sm rounded border ${
              showPanel ? "border-accent text-accent" : "border-border hover:border-accent"
            }`}
          >
            ⚙ 구간 다듬기
          </button>
          {capcutProject && (
            <CapCutWriteButton
              project={capcutProject}
              timeline={capcutTimeline}
              blocks={shaped}
              onDone={(m) => toast.show(`✅ ${m}`)}
            />
          )}
          <button
            onClick={() => download(`${baseName}.srt`, toSrt(shaped))}
            className={`px-3 py-1.5 text-sm rounded font-medium ${
              capcutProject
                ? "border border-border hover:border-accent"
                : "bg-accent text-bg"
            }`}
          >
            .srt 다운로드
          </button>
          <button
            onClick={() => download(`${baseName}.vtt`, toVtt(shaped))}
            className="px-3 py-1.5 text-sm rounded border border-border hover:border-accent"
          >
            .vtt
          </button>
        </div>
      </header>

      {showPanel && (
        <section className="px-6 py-3 border-b border-border bg-panel/80">
          <ExportPanel
            raw={blocks}
            shaped={shaped}
            opts={shape}
            onChange={patchShape}
            preview={preview}
            onPreviewChange={setPreview}
            cuts={cuts}
          />
        </section>
      )}

      {/* Waveform */}
      <section className="px-6 py-4 border-b border-border bg-panel/50">
        {audioUrl ? (
          <Waveform
            audioUrl={audioUrl}
            blocks={view}
            activeIndex={activeIndex}
            onReady={(d) => setDuration(d)}
            onTimeUpdate={setCurrentTime}
            onRegionEdit={(idx, start, end) => updateBlock(idx, { start, end })}
            onRegionClick={(idx) => handleJump(idx)}
            registerControls={(c) => (controlsRef.current = c)}
          />
        ) : (
          <div className="h-[120px] flex items-center justify-center text-muted text-sm">
            음성 불러오는 중…
          </div>
        )}

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

        {/* Global shift — bulk offset for whole subtitle track */}
        <div className="flex items-center gap-2 mt-2 text-xs">
          <span className="text-muted">전체 자막 보정:</span>
          {[-0.5, -0.1, +0.1, +0.5].map((d) => (
            <button
              key={d}
              onClick={() => shiftAll(d)}
              className="px-2 py-0.5 border border-border rounded hover:border-accent text-muted hover:text-white"
              title={`모든 자막을 ${d > 0 ? "+" : ""}${d}초 이동`}
            >
              {d > 0 ? "+" : ""}
              {d}s
            </button>
          ))}
          <span className="text-muted/60 ml-1 hidden md:inline">
            (전체가 일정하게 밀려있을 때 사용)
          </span>
        </div>
      </section>

      {/* Script list */}
      <section className="flex-1 min-h-0">
        <ScriptList
          blocks={view}
          activeIndex={activeIndex}
          onJump={handleJump}
          onTextChange={(idx, text) => updateBlock(idx, { text })}
        />
      </section>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import UploadPanel from "@/components/UploadPanel";
import Workspace from "@/components/Workspace";
import StatusOverlay from "@/components/StatusOverlay";
import ResumePanel from "@/components/ResumePanel";
import CapCutPanel from "@/components/CapCutPanel";
import { Block, Lang, SavedSession } from "@/lib/types";
import {
  alignFiles,
  alignAgainstCapCut,
  fetchCombinedAudio,
  isLocalBackend,
  pingHealth,
} from "@/lib/api";
import { loadSession, clearSession } from "@/lib/storage";

type Phase =
  | { kind: "home" }
  | { kind: "warming" }
  | { kind: "aligning" }
  | {
      kind: "workspace";
      audio: File;
      blocks: Block[];
      lang: Lang;
      capcutProject?: string | null;
      capcutTimeline?: string | null;
      cuts?: number[];
    }
  | { kind: "error"; message: string };

type Mode = "file" | "capcut";

export default function Home() {
  const [phase, setPhase] = useState<Phase>({ kind: "home" });
  const [savedSession, setSavedSession] = useState<SavedSession | null>(null);
  const [local, setLocal] = useState(false);
  const [mode, setMode] = useState<Mode>("file");
  const [lang, setLang] = useState<Lang>("ko");

  useEffect(() => {
    setSavedSession(loadSession());
    // The CapCut tab only makes sense against a backend running on this
    // machine; the hosted deployment does not register those routes at all.
    isLocalBackend().then(setLocal);
  }, []);

  async function handleCapCutSubmit(
    project: string,
    script: File,
    l: Lang,
    timeline: string | null
  ) {
    setPhase({ kind: "aligning" });
    try {
      const res = await alignAgainstCapCut(project, script, l, timeline);
      const audio = await fetchCombinedAudio(res.audio_url, `${project}.mp3`);
      setPhase({
        kind: "workspace",
        audio,
        blocks: res.blocks,
        lang: l,
        capcutProject: project,
        capcutTimeline: timeline,
        cuts: res.capcut?.boundaries ?? [],
      });
    } catch (e: unknown) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleSubmit(audios: File[], script: File, lang: Lang) {
    setPhase({ kind: "warming" });
    const ok = await pingHealth();
    if (!ok) {
      setPhase({ kind: "error", message: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." });
      return;
    }
    setPhase({ kind: "aligning" });
    try {
      const res = await alignFiles(audios, script, lang);
      // Use the script filename (or first audio) as the base name for downloads.
      const baseName =
        audios.length === 1
          ? audios[0].name
          : `${audios[0].name.replace(/\.[^.]+$/, "")}_combined.mp3`;
      const combined = await fetchCombinedAudio(res.audio_url, baseName);
      setPhase({ kind: "workspace", audio: combined, blocks: res.blocks, lang });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: msg });
    }
  }

  if (phase.kind === "workspace") {
    return (
      <Workspace
        audioFile={phase.audio}
        initialBlocks={phase.blocks}
        lang={phase.lang}
        capcutProject={phase.capcutProject}
        capcutTimeline={phase.capcutTimeline}
        cuts={phase.cuts}
        onReset={() => setPhase({ kind: "home" })}
      />
    );
  }

  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold">
          <span className="text-accent">Sync</span>Wave
        </h1>
      </header>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full">
          <h2 className="text-3xl font-bold text-center mb-2">
            대본을 음성에 맞춰 정렬합니다
          </h2>
          <p className="text-muted text-center mb-10">
            한국어·일본어 · 1~30분 분량 지원
          </p>

          {local && (
            <div className="max-w-2xl mx-auto mb-4 flex gap-1 p-1 rounded-lg bg-panel border border-border">
              {(
                [
                  ["file", "음성 파일 올리기"],
                  ["capcut", "캡컷 프로젝트"],
                ] as [Mode, string][]
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 px-4 py-2 rounded text-sm ${
                    mode === m ? "bg-accent text-bg font-medium" : "text-muted hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {local && mode === "capcut" ? (
            <CapCutPanel
              lang={lang}
              onLangChange={setLang}
              onSubmit={handleCapCutSubmit}
              disabled={phase.kind === "warming" || phase.kind === "aligning"}
            />
          ) : (
            <UploadPanel
              onSubmit={handleSubmit}
              disabled={phase.kind === "warming" || phase.kind === "aligning"}
            />
          )}

          {savedSession && phase.kind === "home" && mode === "file" && (
            <ResumePanel
              session={savedSession}
              onResume={(audio) =>
                setPhase({
                  kind: "workspace",
                  audio,
                  blocks: savedSession.blocks,
                  lang: savedSession.lang,
                })
              }
              onDiscard={() => {
                clearSession();
                setSavedSession(null);
              }}
            />
          )}

          {phase.kind === "error" && (
            <div className="max-w-2xl mx-auto mt-6 p-4 rounded-lg bg-red-950/30 border border-red-900 text-red-300 text-sm">
              {phase.message}
            </div>
          )}
        </div>
      </div>

      {phase.kind === "warming" && (
        <StatusOverlay
          message="서버 연결 중..."
          detail="무료 티어 서버는 휴면 상태에서 깨어나는 데 최대 1분이 걸릴 수 있습니다."
        />
      )}
      {phase.kind === "aligning" && (
        <StatusOverlay
          message="음성과 대본을 정렬 중..."
          detail="Whisper 기반 정렬: 10분 음성 ≈ 2~5분, 30분 음성 ≈ 8~15분 소요됩니다."
        />
      )}
    </main>
  );
}

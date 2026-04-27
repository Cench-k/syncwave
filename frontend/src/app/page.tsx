"use client";
import { useEffect, useState } from "react";
import UploadPanel from "@/components/UploadPanel";
import Workspace from "@/components/Workspace";
import StatusOverlay from "@/components/StatusOverlay";
import ResumePanel from "@/components/ResumePanel";
import { Block, Lang, SavedSession } from "@/lib/types";
import { alignFiles, pingHealth } from "@/lib/api";
import { loadSession, clearSession } from "@/lib/storage";

type Phase =
  | { kind: "home" }
  | { kind: "warming" }
  | { kind: "aligning" }
  | { kind: "workspace"; audio: File; blocks: Block[]; lang: Lang }
  | { kind: "error"; message: string };

export default function Home() {
  const [phase, setPhase] = useState<Phase>({ kind: "home" });
  const [savedSession, setSavedSession] = useState<SavedSession | null>(null);

  useEffect(() => {
    setSavedSession(loadSession());
  }, []);

  async function handleSubmit(audio: File, script: File, lang: Lang) {
    setPhase({ kind: "warming" });
    const ok = await pingHealth();
    if (!ok) {
      setPhase({ kind: "error", message: "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." });
      return;
    }
    setPhase({ kind: "aligning" });
    try {
      const res = await alignFiles(audio, script, lang);
      setPhase({ kind: "workspace", audio, blocks: res.blocks, lang });
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
          <UploadPanel
            onSubmit={handleSubmit}
            disabled={phase.kind === "warming" || phase.kind === "aligning"}
          />

          {savedSession && phase.kind === "home" && (
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
          detail="오디오 길이에 따라 30초~수 분이 소요됩니다."
        />
      )}
    </main>
  );
}

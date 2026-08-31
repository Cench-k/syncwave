"use client";
import { useEffect, useState } from "react";
import { CapCutProject, CapCutProjectInfo, Lang } from "@/lib/types";
import { listCapCutProjects, getCapCutProject } from "@/lib/api";

interface Props {
  lang: Lang;
  onLangChange: (l: Lang) => void;
  onSubmit: (
    project: string,
    script: File,
    lang: Lang,
    timeline: string | null,
    audioTrack: number | null
  ) => void;
  disabled?: boolean;
}

function when(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function CapCutPanel({ lang, onLangChange, onSubmit, disabled }: Props) {
  const [projects, setProjects] = useState<CapCutProject[] | null>(null);
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [info, setInfo] = useState<CapCutProjectInfo | null>(null);
  const [timeline, setTimeline] = useState<string>("");
  const [audioTrack, setAudioTrack] = useState<number | null>(null);
  const [script, setScript] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);

  useEffect(() => {
    listCapCutProjects()
      .then((r) => {
        setProjects(r.projects);
        setRoot(r.root);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  // Picking a project resets the timeline; picking a timeline reloads the
  // audio/subtitle summary for that timeline specifically.
  useEffect(() => {
    setTimeline("");
    setAudioTrack(null);
  }, [selected]);

  useEffect(() => {
    if (!selected) {
      setInfo(null);
      return;
    }
    setLoadingInfo(true);
    setError(null);
    getCapCutProject(selected, timeline || null, audioTrack)
      .then((i) => {
        setInfo(i);
        if (audioTrack === null && i.audio_track !== null) setAudioTrack(i.audio_track);
        // Default to the main timeline so the label matches what we read.
        if (!timeline && i.timelines.length > 1) {
          const main = i.timelines.find((t) => t.is_main) ?? i.timelines[0];
          setTimeline(main.id);
        }
      })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoadingInfo(false));
  }, [selected, timeline, audioTrack]);

  const missing = info?.speech_files.filter((f) => !f.exists) ?? [];
  const ready = Boolean(selected && script && info && info.speech_files.length > 0 && !missing.length);

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="rounded-2xl border border-border bg-panel p-6">
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="font-semibold">캡컷 프로젝트에 바로 자막 넣기</h3>
          <span className="text-[11px] text-muted">로컬 전용</span>
        </div>
        <p className="text-xs text-muted mb-4">
          타임라인에서 실제로 들리는 음성을 드래프트에서 재구성해 정렬하므로,
          캡컷에서 음성을 내보내실 필요가 없습니다. <b className="text-muted">대본만</b> 주시면 됩니다.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded bg-red-950/30 border border-red-900 text-red-300 text-xs">
            {error}
          </div>
        )}

        {projects === null && !error && (
          <div className="text-sm text-muted py-4">프로젝트 목록 읽는 중…</div>
        )}

        {projects && (
          <>
            <label className="block text-xs text-muted mb-1">
              프로젝트 <span className="text-muted/50">({projects.length}개 · 최근 수정순)</span>
            </label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={disabled}
              className="w-full bg-bg border border-border rounded px-2 py-2 text-sm focus:border-accent outline-none mb-1"
            >
              <option value="">— 선택하세요 —</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} · {when(p.modified)}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted/50 mb-4 truncate" title={root}>
              {root}
            </p>
          </>
        )}

        {info && info.timelines.length > 1 && (
          <>
            <label className="block text-xs text-muted mb-1">
              타임라인{" "}
              <span className="text-muted/50">
                이 프로젝트에 {info.timelines.length}개 있습니다
              </span>
            </label>
            <select
              value={timeline}
              onChange={(e) => setTimeline(e.target.value)}
              disabled={disabled}
              className="w-full bg-bg border border-border rounded px-2 py-2 text-sm focus:border-accent outline-none mb-4"
            >
              {info.timelines.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_main ? " (메인)" : ""} · {t.duration.toFixed(1)}초 · 음성{" "}
                  {t.audio_segments}조각 · 자막 {t.text_segments}개
                </option>
              ))}
            </select>
          </>
        )}

        {info && info.audio_tracks.length > 1 && (
          <>
            <label className="block text-xs text-muted mb-1">
              음향 트랙{" "}
              <span className="text-muted/50">
                영상 바로 아래 트랙이 내레이션입니다 · 아래쪽은 BGM·효과음
              </span>
            </label>
            <select
              value={audioTrack ?? ""}
              onChange={(e) => setAudioTrack(Number(e.target.value))}
              disabled={disabled}
              className="w-full bg-bg border border-border rounded px-2 py-2 text-sm focus:border-accent outline-none mb-4"
            >
              {info.audio_tracks.map((t) => (
                <option key={t.index} value={t.index}>
                  {t.position === 0 ? "영상 바로 아래" : `아래에서 ${t.position + 1}번째`} ·{" "}
                  {t.segments}조각 · 음성 {t.speech_segments}개
                  {t.files.length ? ` · ${t.files[0].slice(0, 26)}` : " · 효과음만"}
                </option>
              ))}
            </select>
          </>
        )}

        {loadingInfo && <div className="text-sm text-muted py-2">프로젝트 읽는 중…</div>}

        {info && (
          <div className="mb-4 text-xs border border-border rounded p-3 bg-bg/40">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted mb-2 font-mono">
              <span>{info.fps ?? "?"} fps</span>
              <span>{info.duration.toFixed(2)}초</span>
              {info.canvas?.width && (
                <span>
                  {info.canvas.width}×{info.canvas.height}
                </span>
              )}
              <span>자막 트랙 {info.text_tracks.length}개</span>
            </div>
            {info.speech_files.length === 0 ? (
              <p className="text-red-300">
                음성 트랙을 찾지 못했습니다. 캡컷에서 넣은 음성(효과음 제외)이 있어야 합니다.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {info.speech_files.map((f) => (
                  <li key={f.path} className={f.exists ? "text-muted" : "text-red-300"}>
                    <span className="font-mono">
                      {f.segments}조각 {f.coverage.toFixed(1)}초
                      {f.speeds.some((s) => s !== 1) && ` ${f.speeds.join("/")}배속`}
                    </span>{" "}
                    {f.name}
                    {!f.exists && " — 파일 없음"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <label className="block text-xs text-muted mb-1">대본 (.txt)</label>
        <div className="flex items-center gap-3 mb-4">
          <label className="px-4 py-2 rounded-lg bg-bg border border-border hover:border-accent cursor-pointer text-sm">
            📄 대본 선택
            <input
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              disabled={disabled}
              onChange={(e) => setScript(e.target.files?.[0] ?? null)}
            />
          </label>
          <span className="text-sm text-muted truncate">
            {script ? script.name : "선택된 파일 없음"}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {(["ko", "ja"] as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => onLangChange(l)}
                disabled={disabled}
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
            disabled={!ready || disabled}
            onClick={() => script && onSubmit(selected, script, lang, timeline || null, audioTrack)}
            className="px-6 py-2 rounded-lg bg-accent text-bg font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
          >
            정렬 시작
          </button>
        </div>
      </div>
    </div>
  );
}

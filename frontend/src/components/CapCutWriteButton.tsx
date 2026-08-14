"use client";
import { useEffect, useState } from "react";
import { Block, CapCutProjectInfo, CapCutStyle, CapCutWriteResult } from "@/lib/types";
import {
  EditorOpenError,
  getCapCutProject,
  listCapCutStyles,
  verifyCapCutTrack,
  writeCapCutSubtitles,
} from "@/lib/api";

const STYLE_KEY = "syncwave:styleFrom";

interface Props {
  project: string;
  blocks: Block[];
  onDone: (msg: string) => void;
}

export default function CapCutWriteButton({ project, blocks, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<CapCutProjectInfo | null>(null);
  const [replace, setReplace] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CapCutWriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [confirmedClosed, setConfirmedClosed] = useState(false);
  const [styles, setStyles] = useState<CapCutStyle[]>([]);
  const [styleFrom, setStyleFrom] = useState("");

  useEffect(() => {
    if (!open) return;
    setError(null);
    getCapCutProject(project)
      .then(setInfo)
      .catch((e) => setError(String(e.message || e)));
    listCapCutStyles()
      .then((s) => {
        setStyles(s);
        // Reuse whatever they picked last; the automatic guess is only
        // "newest project with subtitles", which can be a different format.
        const saved = localStorage.getItem(STYLE_KEY) || "";
        if (saved && s.some((x) => x.project === saved)) setStyleFrom(saved);
      })
      .catch(() => setStyles([]));
  }, [open, project]);

  async function write() {
    setBusy(true);
    setError(null);
    setBlocked(null);
    setCheck(null);
    try {
      const r = await writeCapCutSubtitles({
        project,
        blocks,
        replace_track: replace || null,
        track_name: "SyncWave",
        force: confirmedClosed,
        style_from: styleFrom || null,
      });
      if (styleFrom) localStorage.setItem(STYLE_KEY, styleFrom);
      setResult(r);
      onDone(`캡컷에 자막 ${r.written}개 기록됨`);
      // CapCut can save over us seconds later, so check without being asked.
      setTimeout(() => void verify(), 6000);
    } catch (e: unknown) {
      if (e instanceof EditorOpenError) setBlocked(e.message);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setCheck("확인 중…");
    try {
      const v = await verifyCapCutTrack(project);
      setCheck(
        v.present
          ? `자막 ${v.segments}개가 그대로 있습니다.` +
              (v.editor_running ? " (캡컷이 아직 실행 중입니다)" : "")
          : "자막이 사라졌습니다 — 캡컷이 덮어썼습니다. 캡컷을 완전히 종료한 뒤 다시 쓰세요."
      );
    } catch (e: unknown) {
      setCheck(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <button
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
        className="px-3 py-1.5 text-sm rounded bg-accent text-bg font-medium"
      >
        캡컷에 쓰기
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-panel p-5 text-sm">
            <h3 className="font-semibold mb-1">캡컷 프로젝트에 자막 쓰기</h3>
            <p className="text-xs text-muted mb-4 font-mono">{project}</p>

            {error && (
              <div className="mb-3 p-3 rounded bg-red-950/30 border border-red-900 text-red-300 text-xs">
                {error}
              </div>
            )}

            {result ? (
              <div className="space-y-3">
                <div className="p-3 rounded bg-emerald-950/30 border border-emerald-900 text-emerald-300 text-xs space-y-1">
                  <div>자막 {result.written}개를 {result.replaced ? "교체" : "새 트랙으로 추가"}했습니다.</div>
                  {result.overlaps_trimmed > 0 && (
                    <div>겹치던 자막 {result.overlaps_trimmed}개를 다듬었습니다.</div>
                  )}
                  {result.clipped > 0 && (
                    <div>프로젝트 길이를 넘던 자막 {result.clipped}개를 잘랐습니다.</div>
                  )}
                  {result.dropped?.length > 0 && (
                    <div className="text-amber-300">
                      자리가 없어 빠진 자막 {result.dropped.length}개:{" "}
                      {result.dropped.slice(0, 3).join(" / ")}
                      {result.dropped.length > 3 && " …"}
                    </div>
                  )}
                  <div>
                    {result.style_source === "project" && "스타일: 이 프로젝트의 기존 자막을 따랐습니다."}
                    {result.style_source === "borrowed" && "스타일: 이 프로젝트엔 자막이 없어 최근 다른 프로젝트에서 가져왔습니다."}
                    {result.style_source === "default" && "스타일: 참고할 자막이 없어 기본 스타일로 넣었습니다."}
                    {result.style_source.startsWith("project:") &&
                      `스타일: ${result.style_source.slice(8)} 에서 복제했습니다.`}
                  </div>
                  <div className="text-emerald-400/70 font-mono">백업: {result.backup}</div>
                </div>
                {result.warning && (
                  <div className="p-3 rounded bg-amber-950/20 border border-amber-900/60 text-amber-200/90 text-xs">
                    {result.warning}
                  </div>
                )}
                <p className="text-xs text-muted">
                  캡컷을 열어 확인하세요. 캡컷이 켜져 있었다면 <b>완전히 종료했다가 다시</b>{" "}
                  여세요 — 메모리에 든 예전 상태로 저장하면서 방금 쓴 자막을 덮어씁니다.
                </p>
                {check && (
                  <p className="text-xs font-mono text-muted border border-border rounded p-2">
                    {check}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={verify}
                    className="px-4 py-1.5 rounded border border-border text-muted hover:text-white"
                  >
                    남아있는지 확인
                  </button>
                  <button
                    onClick={() => setOpen(false)}
                    className="px-4 py-1.5 rounded bg-accent text-bg font-medium"
                  >
                    닫기
                  </button>
                </div>
              </div>
            ) : (
              <>
                {blocked ? (
                  <div className="mb-3 p-3 rounded bg-red-950/30 border border-red-900 text-red-200 text-xs space-y-2">
                    <p className="whitespace-pre-line">{blocked}</p>
                    <p className="text-red-300/70">
                      캡컷이 이 프로젝트를 열고 있으면, 나중에 저장하면서 방금 쓴 자막을 통째로
                      덮어씁니다. 실제로 그런 사고가 있었습니다.
                    </p>
                    <label className="flex items-start gap-2 pt-1 cursor-pointer text-red-100">
                      <input
                        type="checkbox"
                        checked={confirmedClosed}
                        onChange={(e) => setConfirmedClosed(e.target.checked)}
                        className="accent-accent mt-0.5"
                      />
                      <span>
                        캡컷에서 <b>이 프로젝트를 닫았습니다</b> — 그대로 진행
                        <span className="block text-red-300/60">
                          캡컷이 켜져 있어도, 이 프로젝트만 안 열려 있으면 안전합니다.
                          확실하지 않으면 캡컷을 완전히 종료하세요.
                        </span>
                      </span>
                    </label>
                  </div>
                ) : (
                  <div className="mb-3 p-3 rounded bg-amber-950/20 border border-amber-900/60 text-amber-200/90 text-xs">
                    쓰기 전에 <b>캡컷에서 이 프로젝트를 닫아주세요.</b> 다른 프로젝트가 열려
                    있는 건 괜찮습니다. 원본은 자동으로 백업됩니다.
                  </div>
                )}

                <label className="block text-xs text-muted mb-1">쓰는 방식</label>
                <select
                  value={replace}
                  onChange={(e) => setReplace(e.target.value)}
                  className="w-full bg-bg border border-border rounded px-2 py-1.5 text-sm focus:border-accent outline-none mb-4"
                >
                  <option value="">새 자막 트랙으로 추가 (안전)</option>
                  {info?.text_tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      기존 트랙 교체: {t.name || "(이름 없음)"} — 자막 {t.segments}개
                    </option>
                  ))}
                </select>

                <label className="block text-xs text-muted mb-1">자막 스타일</label>
                <select
                  value={styleFrom}
                  onChange={(e) => setStyleFrom(e.target.value)}
                  className="w-full bg-bg border border-border rounded px-2 py-1.5 text-sm focus:border-accent outline-none mb-1"
                >
                  <option value="">
                    자동 (이 프로젝트의 기존 자막 → 없으면 최근 프로젝트)
                  </option>
                  {styles.map((s) => (
                    <option key={s.project} value={s.project}>
                      {s.project} · {s.font || "기본"} {s.size ?? "?"} · y={s.y}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted/60 mb-4">
                  글꼴·크기·색·테두리·위치를 고른 프로젝트의 자막에서 그대로 복제합니다.
                  자동은 포맷이 다른 프로젝트를 집을 수 있으니, 한 번 골라두면 다음에도 기억합니다.
                </p>

                <p className="text-xs text-muted mb-4">자막 {blocks.length}개를 씁니다.</p>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setOpen(false)}
                    disabled={busy}
                    className="px-4 py-1.5 rounded border border-border text-muted hover:text-white"
                  >
                    취소
                  </button>
                  <button
                    onClick={write}
                    disabled={busy || (Boolean(blocked) && !confirmedClosed)}
                    className="px-4 py-1.5 rounded bg-accent text-bg font-medium disabled:opacity-40"
                  >
                    {busy ? "쓰는 중…" : blocked ? "확인했음 · 쓰기" : "쓰기"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

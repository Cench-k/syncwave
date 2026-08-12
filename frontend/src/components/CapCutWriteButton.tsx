"use client";
import { useEffect, useState } from "react";
import { Block, CapCutProjectInfo, CapCutWriteResult } from "@/lib/types";
import { getCapCutProject, writeCapCutSubtitles } from "@/lib/api";

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

  useEffect(() => {
    if (!open) return;
    setError(null);
    getCapCutProject(project)
      .then(setInfo)
      .catch((e) => setError(String(e.message || e)));
  }, [open, project]);

  async function write() {
    setBusy(true);
    setError(null);
    try {
      const r = await writeCapCutSubtitles({
        project,
        blocks,
        replace_track: replace || null,
        track_name: "SyncWave",
      });
      setResult(r);
      onDone(`캡컷에 자막 ${r.written}개 기록됨`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
                  <div className="text-emerald-400/70 font-mono">백업: {result.backup}</div>
                </div>
                <p className="text-xs text-muted">
                  캡컷이 켜져 있었다면 <b>완전히 종료했다가 다시 여세요.</b> 캡컷은 프로젝트를
                  메모리에 들고 있어서, 그대로 두면 저장할 때 방금 쓴 자막을 덮어씁니다.
                </p>
                <div className="flex justify-end">
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
                <div className="mb-3 p-3 rounded bg-amber-950/20 border border-amber-900/60 text-amber-200/90 text-xs">
                  쓰기 전에 <b>캡컷에서 이 프로젝트를 닫아주세요.</b> 켜둔 채로 쓰면 캡컷이
                  나중에 저장하면서 덮어씁니다. 원본은 자동으로 백업됩니다.
                </div>

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

                <p className="text-xs text-muted mb-4">
                  자막 {blocks.length}개를 씁니다. 글꼴·크기·위치는 이 프로젝트에 이미 있는
                  자막 스타일을 그대로 따릅니다.
                </p>

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
                    disabled={busy}
                    className="px-4 py-1.5 rounded bg-accent text-bg font-medium disabled:opacity-40"
                  >
                    {busy ? "쓰는 중…" : "쓰기"}
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

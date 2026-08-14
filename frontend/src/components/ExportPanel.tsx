"use client";
import { useMemo } from "react";
import { Block } from "@/lib/types";
import {
  ShapeOptions,
  FPS_CHOICES,
  PRESETS,
  countOnCuts,
  shapeStats,
} from "@/lib/shape";

interface Props {
  raw: Block[];
  shaped: Block[];
  opts: ShapeOptions;
  onChange: (patch: Partial<ShapeOptions>) => void;
  preview: boolean;
  onPreviewChange: (v: boolean) => void;
  /** Empty when this alignment did not come from a CapCut project. */
  cuts?: number[];
}

const PRESET_LABELS: [keyof typeof PRESETS, string, string][] = [
  ["capcut60", "캡컷 60fps", "빈틈 없이 이어붙임 · 60fps 스냅 (가장 많이 쓰시는 설정)"],
  ["capcut24", "캡컷 24fps", "빈틈 없이 이어붙임 · 24fps 스냅"],
  ["premiere30", "프리미어 30fps", "1프레임 간격 유지 · 30fps 스냅"],
  ["youtube", "유튜브 / 범용", "이어붙임 · 프레임 스냅 없음"],
  ["raw", "원본 그대로", "성형 끄기 (정렬 결과 그대로)"],
];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 justify-between">
      <span className="text-muted whitespace-nowrap">
        {label}
        {hint && <span className="text-muted/50 ml-1">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export default function ExportPanel({
  raw,
  shaped,
  opts,
  onChange,
  preview,
  onPreviewChange,
  cuts = [],
}: Props) {
  const cutCount = cuts.length;
  const snapped = useMemo(() => countOnCuts(shaped, cuts), [shaped, cuts]);
  const before = useMemo(
    () => shapeStats(raw, opts.minDuration),
    [raw, opts.minDuration]
  );
  const after = useMemo(
    () => shapeStats(shaped, opts.minDuration),
    [shaped, opts.minDuration]
  );

  const inputCls =
    "w-16 bg-bg border border-border rounded px-1.5 py-0.5 text-right font-mono text-xs focus:border-accent outline-none";

  return (
    <div className="text-xs space-y-3">
      {/* Presets */}
      <div className="flex flex-wrap gap-1.5">
        {PRESET_LABELS.map(([key, label, desc]) => (
          <button
            key={key}
            title={desc}
            onClick={() =>
              onChange({
                enabled: key !== "raw",
                ...PRESETS[key],
              })
            }
            className="px-2 py-1 rounded border border-border text-muted hover:text-white hover:border-accent"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Row label="빈 구간 처리">
          <select
            value={opts.enabled ? opts.gapMode : "off"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "off") onChange({ enabled: false });
              else onChange({ enabled: true, gapMode: v as "close" | "keep" });
            }}
            className="bg-bg border border-border rounded px-1.5 py-0.5 text-xs focus:border-accent outline-none"
          >
            <option value="close">다음 자막까지 이어붙이기</option>
            <option value="keep">그대로 두기</option>
            <option value="off">성형 끄기</option>
          </select>
        </Row>

        <Row label="사이 간격" hint="프레임">
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            value={opts.gapFrames}
            onChange={(e) => onChange({ gapFrames: Number(e.target.value) })}
            className={inputCls}
          />
        </Row>

        <Row label="최대 연장" hint="초 · 0=무제한">
          <input
            type="number"
            min={0}
            step={0.1}
            value={opts.maxExtend}
            onChange={(e) => onChange({ maxExtend: Number(e.target.value) })}
            className={inputCls}
          />
        </Row>

        <Row label="최소 표시" hint="초">
          <input
            type="number"
            min={0}
            step={0.1}
            value={opts.minDuration}
            onChange={(e) => onChange({ minDuration: Number(e.target.value) })}
            className={inputCls}
          />
        </Row>

        <Row label="시작 앞당김" hint="초">
          <input
            type="number"
            min={0}
            step={0.01}
            value={opts.leadIn}
            onChange={(e) => onChange({ leadIn: Number(e.target.value) })}
            className={inputCls}
          />
        </Row>

        <Row label="프레임 스냅" hint="편집 프로젝트와 같게">
          <select
            value={opts.fps ?? ""}
            onChange={(e) =>
              onChange({ fps: e.target.value ? Number(e.target.value) : null })
            }
            className="bg-bg border border-border rounded px-1.5 py-0.5 text-xs focus:border-accent outline-none"
          >
            <option value="">안 함</option>
            {FPS_CHOICES.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </Row>
      </div>

      {cutCount > 0 && (
        <div className="border border-accent/30 bg-accent/5 rounded p-2.5 space-y-1.5">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={opts.snapToCuts}
              onChange={(e) => onChange({ snapToCuts: e.target.checked })}
              className="accent-accent"
            />
            <span>
              <b>음성 조각 경계에 맞추기</b>
              <span className="text-muted/60"> · 캡컷에서 자른 지점 {cutCount}개</span>
            </span>
          </label>
          <div className="pl-5 font-mono text-[11px]">
            <span className="text-muted">컷에 맞춰진 자막 </span>
            <span className={snapped > 0 ? "text-accent" : "text-white/80"}>
              {snapped}/{shaped.length}
            </span>
            {opts.snapToCuts && snapped < shaped.length && (
              <span className="text-muted/60">
                {" "}
                · 나머지 {shaped.length - snapped}개는 한 조각에 여러 줄이 들어간 구간입니다
              </span>
            )}
          </div>
          <p className="text-muted/60 text-[11px] leading-relaxed pl-5">
            캡컷에서 대사마다 잘라두신 지점을 자막 시작으로 씁니다. Whisper 추정치보다
            정확해서, 이어붙이기와 같이 쓰면 자막이 <b className="text-muted">조각 시작 →
            다음 조각 시작</b>으로 딱 떨어집니다. 한 조각에 여러 줄이 들어간 구간은
            맞출 경계가 없어 정렬 결과를 그대로 씁니다.
          </p>
          <label className="flex items-center gap-2 pl-5">
            <span className="text-muted whitespace-nowrap">
              허용 범위 <span className="text-muted/50">초 · 이보다 멀면 안 맞춤</span>
            </span>
            <input
              type="number"
              min={0}
              step={0.05}
              value={opts.snapWindow}
              onChange={(e) => onChange({ snapWindow: Number(e.target.value) })}
              disabled={!opts.snapToCuts}
              className={inputCls + " disabled:opacity-40"}
            />
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={opts.tailToEnd}
            onChange={(e) => onChange({ tailToEnd: e.target.checked })}
            className="accent-accent"
          />
          마지막 자막을 음성 끝까지
        </label>
        <label className="flex items-center gap-1.5 text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => onPreviewChange(e.target.checked)}
            className="accent-accent"
          />
          결과 미리보기 (파형·목록에 반영)
        </label>
      </div>

      {opts.enabled && opts.gapMode === "close" && (
        <p className="text-muted/60 text-[11px] leading-relaxed">
          이어붙이기가 켜져 있으면 각 자막의 <b className="text-muted">끝</b>은 다음 자막
          시작까지 자동으로 늘어납니다. 끝 지점을 손으로 잡고 싶으면 &ldquo;그대로 두기&rdquo;로
          바꾸세요. 시작 지점 조절(Shift+◀▶)은 항상 그대로 반영됩니다.
        </p>
      )}

      {/* Before / after diagnostics */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 pt-2 border-t border-border/60 font-mono text-[11px]">
        <span className="text-muted">
          빈 구간{" "}
          <span className="text-white/80">{before.gapCount}개 / {before.gapTotal.toFixed(1)}초</span>
          {" → "}
          <span className={after.gapTotal < before.gapTotal ? "text-accent" : "text-white/80"}>
            {after.gapCount}개 / {after.gapTotal.toFixed(1)}초
          </span>
        </span>
        <span className="text-muted">
          짧은 자막{" "}
          <span className="text-white/80">{before.shortCount}개</span>
          {" → "}
          <span className={after.shortCount < before.shortCount ? "text-accent" : "text-white/80"}>
            {after.shortCount}개
          </span>
        </span>
        <span className="text-muted">
          최고 속도{" "}
          <span className="text-white/80">{before.maxCps.toFixed(1)}</span>
          {" → "}
          <span className={after.maxCps < before.maxCps ? "text-accent" : "text-white/80"}>
            {after.maxCps.toFixed(1)}
          </span>
          <span className="text-muted/50"> 자/초</span>
        </span>
      </div>
    </div>
  );
}

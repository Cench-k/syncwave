import {
  AlignResponse,
  Block,
  CapCutProject,
  CapCutProjectInfo,
  CapCutStyle,
  CapCutWriteResult,
  Lang,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export async function alignFiles(
  audios: File[],
  script: File,
  lang: Lang
): Promise<AlignResponse> {
  const fd = new FormData();
  for (const a of audios) fd.append("audios", a);
  fd.append("script", script);
  fd.append("lang", lang);

  const res = await fetch(`${BASE}/align`, { method: "POST", body: fd });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Align failed (${res.status}): ${detail}`);
  }
  const { job_id } = await res.json();

  // Poll /status/{job_id} until done
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(`${BASE}/status/${job_id}`);
    if (!statusRes.ok) {
      const detail = await statusRes.text().catch(() => "");
      throw new Error(`Status check failed (${statusRes.status}): ${detail}`);
    }
    const data = await statusRes.json();
    if (data.status === "done") return data as AlignResponse;
  }
}

export async function fetchCombinedAudio(
  audioUrl: string,
  fileName: string
): Promise<File> {
  const res = await fetch(`${BASE}${audioUrl}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch combined audio (${res.status})`);
  }
  const blob = await res.blob();
  return new File([blob], fileName, { type: "audio/mpeg" });
}

export async function pingHealth(timeoutMs = 60_000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/health`, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// CapCut integration. These routes only exist when the backend runs with
// SYNCWAVE_LOCAL set, so every call here must tolerate a 404 and the UI stays
// hidden on the hosted deployment.

/** Whether this backend exposes the CapCut routes. */
export async function isLocalBackend(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`);
    if (!r.ok) return false;
    return Boolean((await r.json()).local);
  } catch {
    return false;
  }
}

export async function listCapCutProjects(): Promise<{
  root: string;
  projects: CapCutProject[];
}> {
  const r = await fetch(`${BASE}/capcut/projects`);
  if (!r.ok) throw new Error(await errText(r, "프로젝트 목록을 읽지 못했습니다"));
  return r.json();
}

export async function getCapCutProject(name: string): Promise<CapCutProjectInfo> {
  const r = await fetch(`${BASE}/capcut/projects/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(await errText(r, "프로젝트 정보를 읽지 못했습니다"));
  return r.json();
}

export async function alignAgainstCapCut(
  project: string,
  script: File,
  lang: Lang
): Promise<AlignResponse> {
  const fd = new FormData();
  fd.append("project", project);
  fd.append("script", script);
  fd.append("lang", lang);
  const res = await fetch(`${BASE}/capcut/align`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(await errText(res, "정렬 요청 실패"));
  const { job_id } = await res.json();

  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(`${BASE}/status/${job_id}`);
    if (!statusRes.ok) throw new Error(await errText(statusRes, "상태 확인 실패"));
    const data = await statusRes.json();
    if (data.status === "done") return data as AlignResponse;
  }
}

/** Thrown when CapCut is running, so a write would be overwritten. */
export class EditorOpenError extends Error {}

export async function listCapCutStyles(): Promise<CapCutStyle[]> {
  const r = await fetch(`${BASE}/capcut/styles`);
  if (!r.ok) throw new Error(await errText(r, "스타일 목록을 읽지 못했습니다"));
  return (await r.json()).styles;
}

export async function writeCapCutSubtitles(payload: {
  project: string;
  blocks: Block[];
  replace_track?: string | null;
  track_name?: string;
  force?: boolean;
  style_from?: string | null;
}): Promise<CapCutWriteResult> {
  const r = await fetch(`${BASE}/capcut/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 409) throw new EditorOpenError(await errText(r, "캡컷이 실행 중입니다"));
  if (!r.ok) throw new Error(await errText(r, "자막 쓰기 실패"));
  return r.json();
}

/** Confirm the written track survived CapCut's own save cycle. */
export async function verifyCapCutTrack(
  project: string,
  track = "SyncWave"
): Promise<{ present: boolean; segments: number; editor_running: boolean }> {
  const r = await fetch(
    `${BASE}/capcut/verify/${encodeURIComponent(project)}?track=${encodeURIComponent(track)}`
  );
  if (!r.ok) throw new Error(await errText(r, "확인 실패"));
  return r.json();
}

/** FastAPI puts the message in `detail`; fall back to raw text. */
async function errText(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body?.detail ? String(body.detail) : `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

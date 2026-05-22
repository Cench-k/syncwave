import { AlignResponse, Lang } from "./types";

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

import { AlignResponse, Lang } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export async function alignFiles(
  audio: File,
  script: File,
  lang: Lang
): Promise<AlignResponse> {
  const fd = new FormData();
  fd.append("audio", audio);
  fd.append("script", script);
  fd.append("lang", lang);

  const res = await fetch(`${BASE}/align`, { method: "POST", body: fd });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Align failed (${res.status}): ${detail}`);
  }
  return res.json();
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

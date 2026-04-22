import { SavedSession } from "./types";

const KEY = "syncwave:session";

export function saveSession(s: SavedSession) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota or disabled — ignore */
  }
}

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedSession;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

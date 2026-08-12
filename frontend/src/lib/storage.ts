import { SavedSession } from "./types";
import { ShapeOptions, DEFAULT_SHAPE } from "./shape";

const KEY = "syncwave:session";
const SHAPE_KEY = "syncwave:shape";

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

/**
 * Shaping settings outlive a single job — the editor and its frame rate
 * don't change between projects — so they persist separately from the
 * session and survive "새 작업".
 */
export function saveShape(o: ShapeOptions) {
  try {
    localStorage.setItem(SHAPE_KEY, JSON.stringify(o));
  } catch {
    /* quota or disabled — ignore */
  }
}

export function loadShape(): ShapeOptions | null {
  try {
    const raw = localStorage.getItem(SHAPE_KEY);
    if (!raw) return null;
    // Merge over defaults so options added in a later version aren't
    // undefined for users with a stored blob from an older build.
    return { ...DEFAULT_SHAPE, ...(JSON.parse(raw) as Partial<ShapeOptions>) };
  } catch {
    return null;
  }
}

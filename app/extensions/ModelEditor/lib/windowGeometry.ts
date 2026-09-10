// FILENAME: app/extensions/ModelEditor/lib/windowGeometry.ts
// PURPOSE: Remember the Model Editor window's size and position across opens.
// CONTEXT: The window was created at a fixed 1150x780, centred, every single
//          time. A modeling window is one you size once — usually large, often
//          on a second monitor — and having it snap back to a small centred box
//          on every open is a papercut you pay for on every session.
//
//          THE TRAP THIS FILE EXISTS TO AVOID: Tauri's resize/move event
//          payloads are PHYSICAL pixels, but the WebviewWindow constructor
//          takes LOGICAL ones. On a 2x display, storing physical and restoring
//          as logical DOUBLES the window on every open — it would walk off the
//          screen within a few sessions. Everything here is stored logical, and
//          the conversion happens once, at capture.

/** Logical (CSS) pixels — the unit the window constructor speaks. */
export interface WindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

export const GEOMETRY_STORAGE_KEY = "calcula.modelEditor.windowGeometry";

/** Mirrors openModelEditorWindow's declared minimums. */
export const MIN_WIDTH = 760;
export const MIN_HEIGHT = 520;
/** A ceiling no real monitor arrangement exceeds; a stored value beyond it is
 *  corrupt, not ambitious. */
const MAX_DIMENSION = 30_000;
/** How far off the top-left a window may legitimately sit. Negative positions
 *  are normal with a monitor placed left of or above the primary one. */
const MIN_ORIGIN = -20_000;

/** Physical -> logical. `scale` is devicePixelRatio, which needs no Tauri
 *  permission and IS the window's scale factor. */
export function toLogical(physical: number, scale: number): number {
  const s = scale > 0 ? scale : 1;
  return Math.round(physical / s);
}

/**
 * Accept a stored geometry only if every field is a finite number in a range a
 * real window could occupy. Anything else — a half-written value, a value from
 * a monitor layout that no longer exists, a hand-edited localStorage entry —
 * is discarded in favour of the centred default, because a window restored
 * off-screen is a window the user cannot recover without clearing storage.
 */
export function isUsableGeometry(value: unknown): value is WindowGeometry {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  const nums = ["width", "height", "x", "y"].map((k) => g[k]);
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  const { width, height, x, y } = value as WindowGeometry;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return false;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return false;
  if (x < MIN_ORIGIN || y < MIN_ORIGIN) return false;
  if (x > MAX_DIMENSION || y > MAX_DIMENSION) return false;
  return true;
}

export function readGeometry(): WindowGeometry | null {
  try {
    const raw = localStorage.getItem(GEOMETRY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUsableGeometry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeGeometry(geometry: WindowGeometry): void {
  if (!isUsableGeometry(geometry)) return;
  try {
    localStorage.setItem(GEOMETRY_STORAGE_KEY, JSON.stringify(geometry));
  } catch {
    // Storage unavailable; the window simply forgets, which is today's behaviour.
  }
}

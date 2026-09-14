//! FILENAME: app/extensions/_shared/dsl/pivotLayout/describeQuery/panelSize.ts
// PURPOSE: How tall the transcript is, remembered between sessions.
// CONTEXT: HEIGHT ONLY, and deliberately not width. The panel is mounted at five
//          places whose widths run from a narrow pivot task pane to a wide
//          Reports dialog; a remembered width would be wrong at four of them the
//          moment it was set at the fifth. Height is the axis the person is
//          actually trading against the editor below.
//
//          `localStorage`, not a setting and never the workbook. This is a
//          per-viewer UI convenience in exactly the sense the storage rules
//          describe: it may come back empty (a private window, cleared site
//          data, a different machine) and the panel must be correct without it.
//          Every read and write is wrapped, because some contexts throw on the
//          ACCESSOR rather than returning null.

const KEY = "calcula.describeQuery.transcriptHeight";

/** Below this the transcript cannot show one turn; above it, it eats the editor. */
export const MIN_HEIGHT = 72;
export const MAX_HEIGHT = 420;
export const DEFAULT_HEIGHT = 132;

export function clampHeight(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_HEIGHT;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(px)));
}

export function readHeight(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_HEIGHT;
    const n = Number(raw);
    // `Number("")` is 0 and would clamp to MIN, silently shrinking the panel to
    // a sliver for anyone whose storage holds an empty string.
    if (raw.trim() === "" || !Number.isFinite(n)) return DEFAULT_HEIGHT;
    return clampHeight(n);
  } catch {
    return DEFAULT_HEIGHT;
  }
}

export function writeHeight(px: number): void {
  try {
    window.localStorage.setItem(KEY, String(clampHeight(px)));
  } catch {
    // A viewer who cannot store it still gets a resizable panel for this
    // session; losing the preference is not worth failing the drag over.
  }
}

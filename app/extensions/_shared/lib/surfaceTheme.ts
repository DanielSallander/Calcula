// FILENAME: app/extensions/_shared/lib/surfaceTheme.ts
// PURPOSE: The one answer to "is the surface the user is looking at dark?".
// CONTEXT: Lives in _shared because BOTH command panels (the Model Editor's and
//          the main window's) and the Model Editor's own token layer need it,
//          and two implementations of this question would drift the moment one
//          of them learned about a new skin.
//
//          Decided by LUMINANCE, not by asking which skin id is active: a user-
//          or org-authored skin can be dark without being named "dark", and
//          there is no token that declares it.

/** Read a CSS custom property off the document, with a fallback. */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function surfaceIsDark(): boolean {
  if (typeof document === "undefined") return false;
  const raw = cssVar("--bg-surface", "");
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (!m) return false;
  const h =
    m[1].length === 3
      ? m[1].split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  // Rec. 601 luma is ample for a light/dark decision.
  return (0.299 * h[0] + 0.587 * h[1] + 0.114 * h[2]) / 255 < 0.5;
}

//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/lib/alignmentValues.ts
// PURPOSE: The Alignment tab's two numeric controls -- Orientation (degrees, or
//          stacked "Text") and Indent -- converted to and from the values the
//          backend speaks.
// CONTEXT: The backend reports and accepts orientation as "none" | "rotate90" |
//          "rotate270" | "vertical" | "custom:N" (N counter-clockwise, -90..90),
//          and reports 0 / 90 / -90 as the NAMED values. Writing them back the
//          same way keeps an untouched OK an untouched OK: the dialog writes
//          only what changed, and "custom:90" vs "rotate90" would be a change
//          that is not one.

/** Excel's largest indent (measured: IndentLevel 251 errors). */
export const MAX_INDENT = 250;

/** What the Orientation control shows for a style's `textRotation`. */
export function orientationOf(textRotation: string): { stacked: boolean; degrees: number } {
  switch (textRotation) {
    case "vertical":
      return { stacked: true, degrees: 0 };
    case "rotate90":
      return { stacked: false, degrees: 90 };
    case "rotate270":
      return { stacked: false, degrees: -90 };
    default: {
      if (textRotation.startsWith("custom:")) {
        const n = Number(textRotation.substring(7));
        if (Number.isFinite(n)) return { stacked: false, degrees: Math.max(-90, Math.min(90, Math.round(n))) };
      }
      return { stacked: false, degrees: 0 };
    }
  }
}

/** The `textRotation` for an angle, clamped to -90..90 and rounded to a degree. */
export function textRotationForDegrees(degrees: number): string {
  const d = Math.max(-90, Math.min(90, Math.round(degrees)));
  if (d === 0) return "none";
  if (d === 90) return "rotate90";
  if (d === -90) return "rotate270";
  return `custom:${d}`;
}

/** An indent level the backend will take: a whole number, 0..250. */
export function clampIndent(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(MAX_INDENT, Math.round(level)));
}

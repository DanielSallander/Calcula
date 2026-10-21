// FILENAME: app/extensions/Collaboration/lib/writebackGuards.ts
// PURPOSE: The pure decisions behind the writeback range guard and commit
//          guard: may this grid operation touch these cells, and what typed
//          value does this text become.
// CONTEXT: A subscriber fills writeback cells ONE AT A TIME. A keystroke, F2,
//          a double-click or the formula bar asks the range guards with a 1x1
//          range and operation "edit"; that must pass, so the commit guard can
//          save the value as a draft. Everything else -- paste (even of one
//          cell, which never reaches the commit guard), fill, drag-move, a
//          structural operation -- arrives as "other" and is refused over a
//          writeback region, with a message that says why and what to do.
//          (The backend refuses a plain write into a writeback cell as well;
//          this is the friendly front door, not the only one.)

import type { SubmissionValue, WritebackRegionEntry } from "@api/collaboration";
import type { RangeGuardOperation } from "@api/editGuards";

/** The refusal shown for a paste/fill/move over writeback cells. */
export function writebackBulkRefusalMessage(applicationName: string): string {
  const app = applicationName.trim() !== "" ? `"${applicationName}"` : "the application";
  return (
    `These cells collect input for ${app}. Type into them one cell at a time; ` +
    `paste and fill are not supported for writeback cells.`
  );
}

/**
 * The range guard's decision.
 *
 * @param overlapping the first writeback region on the ACTIVE sheet that the
 *   range overlaps, or null.
 * @returns null to allow, or a refusal.
 */
export function decideWritebackRangeGuard(
  overlapping: WritebackRegionEntry | null,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  operation: RangeGuardOperation | undefined,
): { blocked: true; message: string } | null {
  if (!overlapping) return null;
  const single = startRow === endRow && startCol === endCol;
  if (operation === "edit" && single) {
    // A single-cell entry: the commit guard turns the value into a draft.
    return null;
  }
  return {
    blocked: true,
    message: writebackBulkRefusalMessage(overlapping.packageName ?? ""),
  };
}

/** Parsers the coercion needs, injected so the app locale is used (and tests
 *  can pin one). `parseNumber` answers null for text that is not a number. */
export interface WritebackInputParsers {
  parseNumber: (text: string) => number | null;
}

function parseBoolean(text: string): boolean | null {
  const t = text.trim().toUpperCase();
  if (t === "TRUE") return true;
  if (t === "FALSE") return false;
  return null;
}

function finiteNumber(text: string, parsers: WritebackInputParsers): number | null {
  const n = parsers.parseNumber(text);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Turn what the user typed into the value sent as a draft, by the region's
 * DECLARED type -- never by the string's shape when a type is declared, so a
 * product code typed into a TEXT region stays text. Numbers are read in the
 * APP locale ("1,5" in sv-SE is one and a half). Text that does not parse as
 * the declared type is sent as text, and the backend's schema check refuses it
 * with its own message. An empty entry is a pending retraction.
 */
export function coerceWritebackInput(
  raw: string,
  valueType: WritebackRegionEntry["valueType"],
  parsers: WritebackInputParsers,
): SubmissionValue {
  const trimmed = raw.trim();
  if (trimmed === "") return { type: "empty" };
  switch (valueType) {
    case "number":
    case "integer": {
      const n = finiteNumber(trimmed, parsers);
      return n === null ? { type: "text", value: trimmed } : { type: "number", value: n };
    }
    case "boolean": {
      const b = parseBoolean(trimmed);
      return b === null ? { type: "text", value: trimmed } : { type: "boolean", value: b };
    }
    case "text":
    case "date":
    case "enum":
      return { type: "text", value: trimmed };
    default: {
      // No declared type (unschematized region): read it the way the grid
      // would -- a number in the app locale, then TRUE/FALSE, else text. A
      // leading-zero code ("00123") stays text, as the grid keeps it.
      if (/^[+-]?0\d/.test(trimmed)) return { type: "text", value: trimmed };
      const n = finiteNumber(trimmed, parsers);
      if (n !== null) return { type: "number", value: n };
      const b = parseBoolean(trimmed);
      if (b !== null) return { type: "boolean", value: b };
      return { type: "text", value: trimmed };
    }
  }
}

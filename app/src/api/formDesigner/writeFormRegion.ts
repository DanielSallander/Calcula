//! FILENAME: app/src/api/formDesigner/writeFormRegion.ts
// PURPOSE: Put a FormSpec back into a script by re-emitting ONLY the
//          designer-owned `#region`, leaving every byte outside it identical.
// CONTEXT: M5a of docs/design/typescript-forms.md §14. This is the dangerous
//          half of the milestone: a designer that corrupts a user's script once
//          is a designer nobody opens again. Four rules keep it honest, and
//          each is a REFUSAL rather than a convention.
//
//          1. IT WILL NOT WRITE WHAT IT COULD NOT READ. The write starts with
//             a read of the current source. If the region does not parse, holds
//             code besides the define call, or contains anything the reader
//             cannot represent exactly, the write is refused with that same
//             sentence — because the alternative is overwriting code the
//             designer never understood.
//
//          2. NO EDIT, NO BYTES. If the spec it is handed already equals the
//             spec in the file, the source is returned UNCHANGED. That is what
//             makes the scaffold round-trip byte for byte: the emitter never
//             has to reproduce the author's hand-alignment, because opening a
//             designer and closing it does not reprint anything. `changed`
//             says which happened.
//
//          3. COMMENTS INSIDE THE REGION ARE LOST, AND SAYING SO IS STRUCTURAL.
//             Preserving them would mean mapping each comment onto the widget
//             it belongs to and re-attaching it after an arbitrary reorder — a
//             mapping the designer does not have, since a FormSpec carries no
//             provenance back to the nodes it was read from. Rather than eat
//             them silently, the write REFUSES while the region holds comments
//             and the caller has not passed `acknowledgeCommentLoss`. The
//             caller gets the comment text from the read
//             (`droppedComments`), so its warning can quote them.
//
//          4. IT RE-READS ITS OWN OUTPUT. After splicing, the new source is
//             parsed again and must yield a spec deep-equal to the one asked
//             for, with the bytes before and after the region byte-identical.
//             If any of that fails the original source is returned untouched.
//             This is the guard that catches an emitter bug before the user's
//             file does.

import type { FormSpec } from "../scriptHost/scriptFormSpec";
import { checkFormSpec } from "../scriptHost/validators";

import { emitDefineStatement, FormEmitError } from "./formEmit";
import { detectEol, detectIndentUnit } from "./formRegion";
import {
  parseFormSource,
  readParsedFormRegion,
  type FormRegionReadOk,
} from "./readFormRegion";
import type { FormDesignerRefusal, FormRegionComment, FormRegionSpan } from "./types";

export interface FormRegionWriteOptions {
  /**
   * The caller has told the user that the comments inside the region will be
   * lost. Without it a region that holds any comment is refused rather than
   * quietly rewritten — rule 3 above.
   */
  acknowledgeCommentLoss?: boolean;
  fileLabel?: string;
}

export type FormRegionWriteResult =
  | {
      ok: true;
      /** The whole script. Identical to the input when `changed` is false. */
      source: string;
      changed: boolean;
      region: FormRegionSpan;
    }
  | { ok: false; refusal: FormDesignerRefusal };

/**
 * The sentence a designer shows before its first write into a region that
 * carries comments. `null` when there is nothing to warn about.
 */
export function describeCommentLoss(comments: readonly FormRegionComment[]): string | null {
  if (comments.length === 0) return null;
  const lines = comments.map((c) => c.line).join(", ");
  const noun = comments.length === 1 ? "comment" : "comments";
  const which = comments.length === 1 ? `line ${lines}` : `lines ${lines}`;
  return (
    `Saving from the designer rewrites the whole layout block, which deletes the ${comments.length} ` +
    `${noun} inside it (${which}). Move anything you want to keep above the ` +
    "`// #region Form layout` marker first."
  );
}

/**
 * Structural equality, with an absent key and an `undefined` one treated as the
 * same thing — which is what `form.define` sees, and what the reader produces
 * for `{ hidden: undefined }`.
 */
export function sameFormSpec(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, i) => sameFormSpec(entry, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (left[key] === undefined && right[key] === undefined) continue;
      if (!sameFormSpec(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

function refuse(
  code: FormDesignerRefusal["code"],
  message: string,
  extra?: Partial<FormDesignerRefusal>,
): { ok: false; refusal: FormDesignerRefusal } {
  return { ok: false, refusal: { code, message, ...extra } };
}

/**
 * The region's replacement text: both marker comments verbatim, the emitted
 * define statement between them.
 *
 * The indentation in front of the OPENING marker is outside the replaced span
 * and is never touched; the indentation in front of the CLOSING one is inside
 * it, so it is reproduced from what the file already had.
 */
function buildRegionText(
  read: FormRegionReadOk,
  spec: FormSpec,
  source: string,
): string {
  const eol = detectEol(source);
  const options = {
    eol,
    indentUnit: detectIndentUnit(source),
    baseIndent: read.region.startIndent,
  };
  const statement = emitDefineStatement(read.calleeText, spec, options);
  return (
    read.region.startComment +
    eol +
    statement +
    eol +
    read.region.endIndent +
    read.region.endComment
  );
}

/**
 * Re-emit the designer-owned region of `source` with `spec` as its layout.
 *
 * Returns the whole script. Nothing outside the two `#region` / `#endregion`
 * markers can change: the `// @capability` pragmas above them, the file's
 * trailing newline, its line endings and every other statement are carried
 * across as bytes and then re-checked as bytes before the result is handed
 * back.
 */
export async function writeFormRegion(
  source: string,
  spec: FormSpec,
  options?: FormRegionWriteOptions,
): Promise<FormRegionWriteResult> {
  const label = options?.fileLabel ?? "script";
  const parsed = await parseFormSource(source, label);
  if (!parsed.ok) return parsed;
  const read = readParsedFormRegion(parsed.parsed);
  if (!read.ok) return read;

  // Rule: refused BEFORE anything is written, never after. A designer can build
  // a 201-widget tree as easily as a legal one, and the file must not be the
  // place that discovers it.
  const verdict = checkFormSpec(spec);
  if (verdict !== true) {
    return refuse(
      "invalid-spec",
      `Calcula would refuse this layout, so it was not written to the script: ${verdict}`,
    );
  }

  if (sameFormSpec(read.spec, spec)) {
    return { ok: true, source, changed: false, region: read.region };
  }

  if (read.region.innerComments.length > 0 && options?.acknowledgeCommentLoss !== true) {
    return refuse(
      "unacknowledged-comment-loss",
      describeCommentLoss(read.region.innerComments) ?? "",
      { line: read.region.innerComments[0].line },
    );
  }

  let regionText: string;
  try {
    regionText = buildRegionText(read, spec, source);
  } catch (err) {
    if (err instanceof FormEmitError) {
      return refuse(
        "unwritable-value",
        `The layout could not be written back into the script: ${err.message}. The script was not changed.`,
      );
    }
    throw err;
  }

  const prefix = source.slice(0, read.region.start);
  const suffix = source.slice(read.region.end);
  const next = prefix + regionText + suffix;

  // Rule 4: prove it, do not assume it. A splice arithmetic slip or an emitter
  // that printed something the reader parses differently would otherwise reach
  // the user's file, and the whole point of this module is that it cannot.
  const reparsed = await parseFormSource(next, label);
  if (!reparsed.ok) {
    return refuse(
      "round-trip-check-failed",
      "The designer produced a layout block that no longer compiles, so the script was left unchanged. " +
        "Edit this layout in the code editor and report it as a bug.",
    );
  }
  const verify = readParsedFormRegion(reparsed.parsed);
  const intact =
    verify.ok &&
    sameFormSpec(verify.spec, spec) &&
    next.slice(0, verify.region.start) === prefix &&
    next.slice(verify.region.end) === suffix;
  if (!intact) {
    return refuse(
      "round-trip-check-failed",
      "The designer could not read back the layout block it had just written, so the script was left " +
        "unchanged. Edit this layout in the code editor and report it as a bug.",
    );
  }

  return { ok: true, source: next, changed: true, region: verify.region };
}

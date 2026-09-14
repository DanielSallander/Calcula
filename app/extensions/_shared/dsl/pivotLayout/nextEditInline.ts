//! FILENAME: app/extensions/_shared/dsl/pivotLayout/nextEditInline.ts
// PURPOSE: Turn a next-edit suggestion into ONE editable line, so it can be
//          shown where the person is typing — as ghost text at the cursor, or
//          as an edit at another line they can jump to.
// CONTEXT: Milestone C, and the first surface in this repo that is
//          EDIT-TRIGGERED rather than request-shaped. Milestone A put the same
//          suggestions on a row of chips under the editor; that row stays, and
//          this is the same rules, same veto, same edits, rendered in the text.
//
//          NO MODEL. Milestone B measured the built-in 1.5B at 0 of 80 next
//          clauses with a chip on all 52 already-finished queries, so ghost text
//          fed by it would be wrong every time it appeared, in the one place a
//          wrong suggestion is hardest to ignore. The rules answer 19 of 80 and
//          answer instantly. `MODEL_CHIP_DEFAULT` still gates the model path for
//          the chip row, and this file never asks for it.
//
//          PURE, AND MONACO-FREE. It computes a line number and a replacement
//          string; `pivotDslLanguage.ts` turns that into an `InlineCompletion`.
//          That split is what lets the whole thing be unit-tested without an
//          editor, which matters because the only existing component test for
//          these editors mocks `@monaco-editor/react` wholesale.
//
// WHY EVERY EDIT IS EXPRESSED AS "REPLACE ONE WHOLE LINE"
//
// Monaco's contract for an inline completion is narrow, and two clauses of it
// decide this file's shape (editor.api.d.ts:7501-7520):
//
//   "The range to replace. Must begin and end on the same line."
//   "If the text contains a line break, the range must end at the end of a line."
//   "If existing text should be replaced, the existing text must be a prefix of
//    the text to insert."
//
// So a two-line range is not expressible at all. Every op this file offers is
// therefore rewritten as a replacement of ONE existing line whose new text may
// contain line breaks — which satisfies the first two clauses by construction,
// because a whole-line range always ends at the end of a line. An INSERTION
// becomes a replacement of the line above it (`old` + "\n" + new), which makes
// the old text a prefix of the new one and so satisfies the third clause too:
// those can be plain ghost text. A rewrite cannot satisfy it and is marked
// `isInlineEdit`, which is the shape Monaco renders as a diff rather than as
// an append.
//
// WHAT IS DELIBERATELY NOT OFFERED HERE: an edit that DELETES a line. Removing
// a clause's last field removes its line, which is a two-line range however it
// is sliced, and dressing it up as a one-line replace would mean rewriting a
// line the person did not ask about. Those suggestions keep the chip row, which
// has always applied them as a whole-text edit. `dropsALine` reports it so the
// caller can say so rather than silently offering fewer suggestions.

import type { NextEditSuggestion } from "@api/designQueryAssist";
import type { BiPivotModelInfo } from "../../components/types";
import type { DesignQueryModel } from "@api/designQueryAssist";
import { rulesChips, type CompileVerdict, type NextEditChip } from "./nextEditFacts";

/** The minimal span of lines that differ between two texts. */
export interface LineEdit {
  /** 1-based first line of the replaced span. */
  startLine: number;
  /** 1-based last line replaced. `startLine - 1` means a pure insertion. */
  endLine: number;
  /** The lines that take its place. */
  newLines: string[];
}

/**
 * The smallest line span in which `before` and `after` differ.
 *
 * A generic diff rather than something threaded out of `applyEditOp`: the edit
 * functions already decide where a clause goes, and asking them to ALSO report a
 * range would be a second source of truth about the same decision — the exact
 * drift this folder keeps paying for. Matching a common head and a common tail
 * is provably the same answer for every op, and it costs one pass.
 */
export function lineEditFor(before: string, after: string): LineEdit | null {
  if (before === after) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  return {
    startLine: head + 1,
    endLine: a.length - tail,
    newLines: b.slice(head, b.length - tail),
  };
}

/** One suggestion, rewritten as a replacement of a single whole line. */
export interface InlineNextEdit {
  suggestion: NextEditSuggestion;
  /** 1-based line whose entire content is replaced. */
  line: number;
  /** That line's current text. */
  oldText: string;
  /** What replaces it. May contain line breaks. */
  newText: string;
  /**
   * True when `oldText` is a prefix of `newText`, so Monaco may render it as
   * plain appended ghost text. False means a rewrite, which must be flagged
   * `isInlineEdit` or Monaco will refuse it.
   */
  isAppend: boolean;
  /** The whole edited document, for a caller that would rather apply it itself. */
  applied: string;
}

/**
 * Rewrite one op's effect as a single-line replacement, or null when it cannot
 * be one (it deletes a line, or spans several).
 */
export function inlineEditFor(before: string, after: string): Omit<InlineNextEdit, "suggestion" | "applied"> | null {
  const edit = lineEditFor(before, after);
  if (!edit) return null;
  const lines = before.split("\n");
  const replaced = edit.endLine - edit.startLine + 1;

  if (replaced === 0) {
    // A pure insertion before `startLine`. Anchor it to a real line so the
    // range ends at the end of a line, which Monaco requires whenever the
    // inserted text contains a break.
    if (edit.startLine > 1) {
      const anchor = edit.startLine - 1;
      const oldText = lines[anchor - 1];
      return { line: anchor, oldText, newText: `${oldText}\n${edit.newLines.join("\n")}`, isAppend: true };
    }
    // Inserting above the first line: anchor to line 1 and put the new text in
    // front of it. The old text is no longer a prefix, so this is a rewrite.
    const oldText = lines[0];
    return { line: 1, oldText, newText: `${edit.newLines.join("\n")}\n${oldText}`, isAppend: false };
  }

  if (replaced === 1 && edit.newLines.length >= 1) {
    const oldText = lines[edit.startLine - 1];
    const newText = edit.newLines.join("\n");
    return { line: edit.startLine, oldText, newText, isAppend: newText.startsWith(oldText) };
  }

  // Deletes a line, or rewrites several. Not expressible as one inline edit.
  return null;
}

/** What `inlineNextEdits` produced, and what it had to leave out. */
export interface InlineNextEdits {
  /** Ready to render, at-cursor first. */
  edits: InlineNextEdit[];
  /**
   * Suggestions the rules made that cannot be one inline edit — they delete a
   * line. Reported rather than dropped in silence, because "the row has three
   * chips and the editor shows none" should be explainable.
   */
  dropsALine: NextEditSuggestion[];
}

/**
 * Every rule suggestion for `text`, rewritten for the editor.
 *
 * It calls `rulesChips` — the SAME loop the chip row and the offline runner
 * call, with the same compile veto — so a suggestion cannot be offered in the
 * text that the row would have refused, and the two surfaces cannot disagree
 * about what the strategy wants.
 */
export function inlineNextEdits(
  text: string,
  biModel: BiPivotModelInfo | null | undefined,
  tableNames: readonly string[],
  compile: ((dsl: string) => CompileVerdict) | null,
  dismissed: ReadonlySet<string> = new Set(),
): InlineNextEdits {
  const model = (biModel as DesignQueryModel | null | undefined) ?? { tables: [], measures: [] };
  // CORRECTIONS ONLY. Explorations are ideas about a query that is already
  // right, and ghost text at the cursor is the one place a person cannot
  // ignore them. Owner decision 2026-09-14; the row below the editor is where
  // the family belongs, at three at a time rather than the eight asked for here.
  const chips: NextEditChip[] = rulesChips(text, model, tableNames, compile, dismissed, 8, [
    "correction",
  ]);
  const edits: InlineNextEdit[] = [];
  const dropsALine: NextEditSuggestion[] = [];
  for (const chip of chips) {
    const inline = inlineEditFor(text, chip.applied);
    if (!inline) {
      dropsALine.push(chip.suggestion);
      continue;
    }
    edits.push({ ...inline, suggestion: chip.suggestion, applied: chip.applied });
  }
  return { edits, dropsALine };
}

/**
 * One suggestion, decided down to what Monaco needs — minus the ranges, which
 * only the live text model can supply.
 *
 * This is the whole decision: which line, what replaces it, whether Monaco may
 * render it as plain ghost text or must treat it as an edit, and whether to
 * show a jump hint at the cursor. Keeping it here rather than inside the
 * provider is what lets it be tested at all: `pivotDslLanguage.ts` imports
 * `monaco-editor`, `@monaco-editor/react` and a `?worker` module, and mocking
 * that trio to assert a line number would test the mocks.
 */
export interface InlineItem {
  /** 1-based line whose whole text is replaced. */
  line: number;
  /** What replaces it. May contain line breaks. */
  insertText: string;
  /**
   * Monaco shows plain ghost text only when the replaced text is a prefix of
   * the suggestion (`inlineSuggest.mode` defaults to `prefix`). Anything else
   * must be declared an inline EDIT or it is silently never shown.
   */
  isInlineEdit: boolean;
  /**
   * The edit is NOT on the cursor's line, so it needs a hint at the cursor with
   * `jumpToEdit` — the Next-Edit-Suggestion shape.
   */
  elsewhere: boolean;
  /** The sentence the hint shows. */
  label: string;
  /** For dedup and dismissal. */
  suggestionId: string;
}

/**
 * Every in-editor suggestion for a document and cursor, ready to be dressed in
 * Monaco ranges. Returns at most `max`, nearest the cursor first.
 *
 * Total, and never throws: a suggestion engine that fails must not take the
 * editor with it — the person keeps typing and simply sees nothing.
 */
export function inlineItemsFor(
  rawText: string,
  cursorLine: number,
  biModel: BiPivotModelInfo | null | undefined,
  tableNames: readonly string[],
  compile: ((dsl: string) => CompileVerdict) | null,
  dismissed: ReadonlySet<string> = new Set(),
  max = 1,
): InlineItem[] {
  // NORMALISE THE LINE ENDINGS FIRST, and do it here so no caller can forget.
  //
  // A Monaco model's end-of-line is whatever its initial text implied, so a
  // query that ever held a CRLF arrives from `getValue()` with `\r` on every
  // line — while `applyEditOp` and the parser work in LF and hand back LF. The
  // diff below then finds NO common head and NO common tail, calls the whole
  // document one changed span, and `inlineEditFor` refuses it. The symptom is
  // not a wrong suggestion, it is SILENCE: not one piece of ghost text would
  // ever appear in that document, and nothing would say why. Line NUMBERS are
  // unaffected by the substitution, and Monaco re-normalises whatever is
  // inserted to the model's own ending, so the only thing this changes is that
  // the comparison is made between comparable things.
  const text = rawText.replace(/\r\n/g, "\n");
  if (!biModel || !text.trim()) return [];
  let found: InlineNextEdits;
  try {
    found = inlineNextEdits(text, biModel, tableNames, compile, dismissed);
  } catch {
    return [];
  }
  return orderForCursor(found.edits, cursorLine)
    .slice(0, Math.max(0, max))
    .map((edit) => {
      // WHERE THE NEW TEXT LANDS, not where it is anchored. An insertion is
      // anchored to the line ABOVE it so the old text is a prefix, so a person
      // who presses Enter at the end of `ROWS: …` to write the next clause has
      // the cursor on the new blank line while the edit is anchored to the one
      // above — and comparing the anchor alone called that "elsewhere" and
      // offered a hint to jump BACKWARDS to the line they just left, instead of
      // the ghost text they were plainly about to accept.
      const landsOn = edit.newText.startsWith(edit.oldText) ? edit.line + 1 : edit.line;
      const elsewhere = cursorLine !== edit.line && cursorLine !== landsOn;
      return {
        line: edit.line,
        insertText: edit.newText,
        isInlineEdit: elsewhere || !edit.isAppend,
        elsewhere,
        label: edit.suggestion.text,
        suggestionId: edit.suggestion.id,
      };
    });
}

/**
 * The same list, ordered for a cursor on `cursorLine`: the edit on that line
 * first, then the nearest edit elsewhere.
 *
 * Nearest, because the point of an edit-triggered suggestion is that it is
 * about what was just typed. A suggestion eleven lines away that happens to
 * sort first would read as noise.
 */
export function orderForCursor(edits: readonly InlineNextEdit[], cursorLine: number): InlineNextEdit[] {
  return [...edits].sort((x, y) => {
    const dx = Math.abs(x.line - cursorLine);
    const dy = Math.abs(y.line - cursorLine);
    if (dx !== dy) return dx - dy;
    return y.suggestion.priority - x.suggestion.priority;
  });
}

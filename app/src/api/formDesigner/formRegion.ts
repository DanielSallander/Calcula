//! FILENAME: app/src/api/formDesigner/formRegion.ts
// PURPOSE: Find the designer-owned `// #region Form layout …` block in a
//          script's source, and measure the two things the writer must
//          reproduce byte-for-byte around it: the file's line ending and its
//          indentation step.
// CONTEXT: M5a of docs/design/typescript-forms.md §14. The markers are the ones
//          the scaffold emits (app/src/api/scriptableObjectScaffolds.ts,
//          `getScaffoldTemplate` case "form").
//
//          WHY THE MARKERS ARE FOUND THROUGH THE PARSER AND NOT WITH indexOf.
//          A `#region` marker is a COMMENT, and text that looks like one can
//          appear in two places where it means nothing:
//
//            const help = "// #region Form layout (designer-owned)";
//            /* // #region Form layout — see the scaffold */
//
//          A locator that searched the raw text would take either of those as
//          the start of the designer's block and then rewrite from the middle
//          of a string literal — which is the one failure this milestone
//          cannot have. So the source is parsed once and every comment RANGE is
//          collected from the token stream; a marker is only a marker when the
//          compiler agrees it is a single-line comment. The same parse then
//          answers what lives inside the block, so nothing here is paid twice.
//
//          NESTING IS COUNTED, NOT ASSUMED. `#region` blocks nest (VS Code
//          folds them that way), so the designer's block ends at the
//          `#endregion` that brings the depth back to zero — not at the first
//          one. A block that never closes is refused rather than assumed to
//          run to the end of the file.

import type * as TS from "typescript";

import type { FormDesignerRefusal, FormRegionComment, FormRegionSpan } from "./types";

/**
 * The label the scaffold writes, and what the locator looks for.
 *
 * Matched case-insensitively against the comment body, so
 * `// #region Form layout (designer-owned — …)` and a user who reworded the
 * parenthetical both still open in the designer. The label is re-emitted
 * verbatim, so rewording it is safe.
 */
export const FORM_REGION_LABEL_RE = /^#region\s+form\s+layout\b/i;

/** Any `#region` marker, whatever its label — the depth counter's opener. */
const ANY_REGION_RE = /^#region\b/i;
/** Any `#endregion` marker, with or without a trailing label. */
const ANY_ENDREGION_RE = /^#endregion\b/i;

/** One `//` comment, with its body already stripped of the slashes. */
interface MarkerComment {
  pos: number;
  end: number;
  text: string;
  body: string;
}

/**
 * Every comment range in the file, in source order.
 *
 * Walked from the AST rather than scanned from the text, so a `#region` spelled
 * inside a string literal is never mistaken for one.
 *
 * BOTH TRIVIA DIRECTIONS ARE ASKED FOR, and that is not belt-and-braces. A
 * leading scan is not a superset of a trailing one: TypeScript's
 * `iterateCommentRanges` starts a leading scan with `collecting = false` and
 * only turns it on once it has passed a line break, so a comment reached before
 * any newline — an END-OF-LINE comment, `{ type: "checkbox", … }, // keep in
 * sync with B7` — is walked past and never returned. Enumerating leading ranges
 * alone therefore missed exactly the comment shape a layout block is most
 * likely to carry (one note per widget line), which made it invisible to the
 * comment-loss gate and deleted by the first write. So each leaf token is asked
 * for the comments BEFORE it and the comments AFTER it; `seen` keyed on
 * `range.pos` collapses the overlap where one token's trailing scan and the
 * next token's leading scan reach the same comment.
 */
export function collectCommentRanges(
  ts: typeof TS,
  sourceFile: TS.SourceFile,
): TS.CommentRange[] {
  const text = sourceFile.getFullText();
  const out: TS.CommentRange[] = [];
  const seen = new Set<number>();
  const take = (ranges: readonly TS.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      out.push(range);
    }
  };
  const visit = (node: TS.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      take(ts.getLeadingCommentRanges(text, node.getFullStart()));
      take(ts.getTrailingCommentRanges(text, node.getEnd()));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  out.sort((a, b) => a.pos - b.pos);
  return out;
}

/** The whitespace between the start of `pos`'s line and `pos`. */
function indentBefore(text: string, pos: number): string {
  let start = pos;
  while (start > 0 && text[start - 1] !== "\n") start--;
  const raw = text.slice(start, pos);
  return /^[ \t]*$/.test(raw) ? raw : "";
}

/**
 * Locate the designer-owned region.
 *
 * Returns the span, or a refusal naming which of the four things went wrong:
 * there is no region, there are two, one never closes, or the one that exists
 * is not the designer's.
 */
export function locateFormRegion(
  ts: typeof TS,
  sourceFile: TS.SourceFile,
): { ok: true; span: FormRegionSpan } | { ok: false; refusal: FormDesignerRefusal } {
  const text = sourceFile.getFullText();
  const markers: MarkerComment[] = [];
  for (const range of collectCommentRanges(ts, sourceFile)) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const raw = text.slice(range.pos, range.end);
    markers.push({ pos: range.pos, end: range.end, text: raw, body: raw.replace(/^\/\/+/, "").trim() });
  }

  const starts = markers.filter((m) => FORM_REGION_LABEL_RE.test(m.body));
  if (starts.length === 0) {
    return {
      ok: false,
      refusal: {
        code: "no-region",
        message:
          "This script has no designer-owned layout block. The designer edits the code between " +
          "`// #region Form layout` and `// #endregion`, which the Form scaffold writes for you; " +
          "add those two lines around the form.define(...) call, or edit the layout as code.",
      },
    };
  }
  if (starts.length > 1) {
    const line = sourceFile.getLineAndCharacterOfPosition(starts[1].pos).line + 1;
    return {
      ok: false,
      refusal: {
        code: "multiple-regions",
        message:
          `This script has ${starts.length} designer-owned layout blocks (the second one is on line ${line}). ` +
          "The designer owns exactly one, so it cannot tell which layout you mean. Leave one and edit the rest as code.",
        line,
        nodeText: starts[1].text,
      },
    };
  }

  const start = starts[0];
  const startIndex = markers.indexOf(start);
  let depth = 1;
  let end: MarkerComment | null = null;
  const innerComments: FormRegionComment[] = [];
  for (let i = startIndex + 1; i < markers.length; i++) {
    const marker = markers[i];
    if (ANY_REGION_RE.test(marker.body)) depth++;
    else if (ANY_ENDREGION_RE.test(marker.body)) {
      depth--;
      if (depth === 0) {
        end = marker;
        break;
      }
    }
    innerComments.push({
      text: marker.text,
      line: sourceFile.getLineAndCharacterOfPosition(marker.pos).line + 1,
    });
  }
  if (!end) {
    const line = sourceFile.getLineAndCharacterOfPosition(start.pos).line + 1;
    return {
      ok: false,
      refusal: {
        code: "unterminated-region",
        message:
          `The designer-owned layout block that starts on line ${line} is never closed: there is no ` +
          "matching `// #endregion` after it. The designer will not guess where your layout ends, so add " +
          "the closing marker or edit the layout as code.",
        line,
        nodeText: start.text,
      },
    };
  }

  // Block comments between the markers count too: they are just as destroyed
  // by a re-emit as `//` ones, and the caller's warning must list them.
  for (const range of collectCommentRanges(ts, sourceFile)) {
    if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    if (range.pos <= start.end || range.end >= end.pos) continue;
    innerComments.push({
      text: text.slice(range.pos, range.end),
      line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
    });
  }
  innerComments.sort((a, b) => a.line - b.line);

  return {
    ok: true,
    span: {
      start: start.pos,
      end: end.end,
      startComment: start.text,
      endComment: end.text,
      startIndent: indentBefore(text, start.pos),
      endIndent: indentBefore(text, end.pos),
      startLine: sourceFile.getLineAndCharacterOfPosition(start.pos).line + 1,
      innerComments,
    },
  };
}

/**
 * The line ending the file is written with.
 *
 * The dominant one wins, so a file that is CRLF throughout stays CRLF and a
 * stray lone `\n` in a template literal does not flip it. A tie goes to `\n`:
 * a file with no line endings at all is not a CRLF file.
 */
export function detectEol(source: string): "\r\n" | "\n" {
  const crlf = (source.match(/\r\n/g) ?? []).length;
  const lf = (source.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * The file's indentation step, as the literal string one level costs.
 *
 * Tabs win when more indented lines start with one. Otherwise the step is the
 * SMALLEST positive gap between the distinct indentation widths in the file —
 * for a file indented 2/4/6/8 that is 2, and for 4/8/12 it is 4. A file with
 * nothing to measure (or a nonsense measurement) falls back to two spaces,
 * which is what the scaffold uses.
 *
 * PROSE IS NOT INDENTATION, and skipping it is the whole reason this function
 * looks at the line's TEXT before its whitespace. A JSDoc header above
 * `function setup(form)` is the most ordinary thing an author writes, and its
 * continuation lines are one space and then an asterisk. Measured as code they
 * put a width of 1 into the set, which made the smallest gap 1 — so the layout
 * block came back printed at ONE space per level while every other line in the
 * file stayed at two, and the next diff of a script nobody had restyled showed
 * the whole block rewritten. So the scan skips a line whose first
 * non-whitespace character is an asterisk, and every line from one that opens a
 * block comment to the one that closes it. The opener counts only when it
 * starts the line's own text, so a `/*` spelled inside a string literal cannot
 * swallow the rest of the file's measurement.
 *
 * THE STEP IS THEN FLOORED AT TWO. One space per level is not a style anyone
 * writes; it is what a mis-measurement looks like — a wrapped condition aligned
 * to three columns inside a 2-space file yields a gap of 1 exactly the way a
 * doc comment did. So a measured 1 is treated as the same nonsense as a
 * measured 0 and falls back to the scaffold's two.
 */
export function detectIndentUnit(source: string): string {
  const widths = new Set<number>();
  let tabbed = 0;
  let spaced = 0;
  let inBlockComment = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("*")) continue;
    const match = /^[ \t]+(?=[^\s])/.exec(line);
    if (!match) continue;
    if (match[0].includes("\t")) tabbed++;
    else {
      spaced++;
      widths.add(match[0].length);
    }
  }
  if (tabbed > spaced) return "\t";
  const sorted = [...widths].sort((a, b) => a - b);
  let unit = 0;
  for (let i = 0; i < sorted.length; i++) {
    const step = i === 0 ? sorted[0] : sorted[i] - sorted[i - 1];
    if (step > 0 && (unit === 0 || step < unit)) unit = step;
  }
  if (unit < 2 || unit > 8) unit = 2;
  return " ".repeat(unit);
}

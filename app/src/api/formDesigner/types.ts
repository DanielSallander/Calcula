//! FILENAME: app/src/api/formDesigner/types.ts
// PURPOSE: The vocabulary the form designer's AST reader and writer share: the
//          span of the designer-owned `#region`, the comments inside it that a
//          re-emit would destroy, and the single REFUSAL shape both halves
//          answer with.
// CONTEXT: M5a of docs/design/typescript-forms.md §14. The rule the whole
//          milestone lives by is ONE ARTIFACT (app/src/api/scriptTranspile.ts's
//          header): the script IS the layout, so a designer may only emit CODE
//          back into the file the user already owns. There is no layout JSON
//          beside it and no designer state the code does not fully determine.
//
//          WHY A REFUSAL IS A SENTENCE, NOT A CODE. When the reader cannot
//          represent something EXACTLY it must never approximate — the caller
//          opens the code editor instead, and the only thing standing between
//          the user and a blank stare is this string. So `message` names what
//          in THEIR code the designer cannot draw, quotes it, and says which
//          line it is on. `code` exists for the caller to branch on (a missing
//          region is a different offer from a layout built out of variables);
//          it is never what gets shown.

/** Why the designer refused to read or to write. Never shown to the user. */
export type FormDesignerRefusalCode =
  /** The `typescript` chunk could not be fetched. */
  | "compiler-unavailable"
  /** The script does not parse at all. */
  | "parse-error"
  /** No `// #region Form layout …` marker in this script. */
  | "no-region"
  /** More than one designer-owned region: which one would the designer own? */
  | "multiple-regions"
  /** A `#region` marker with no matching `#endregion`. */
  | "unterminated-region"
  /** A marker sits inside a statement, so the region's edges cut code in half. */
  | "region-cuts-code"
  /** The region holds code besides the one `form.define(...)` statement. */
  | "extra-code-in-region"
  /** The region holds no `form.define(...)` call. */
  | "no-define"
  /** The region holds more than one `form.define(...)` call. */
  | "multiple-defines"
  /** `form.define(...)` was not handed one plain object literal. */
  | "define-argument"
  /** Something inside the literal cannot be represented exactly. */
  | "unrepresentable"
  /** The spec the designer produced is one `checkFormSpec` would refuse. */
  | "invalid-spec"
  /** A value in the spec cannot be written back out as source. */
  | "unwritable-value"
  /** The region carries comments and the caller has not warned the user. */
  | "unacknowledged-comment-loss"
  /** The emitted region did not read back as the spec that was asked for. */
  | "round-trip-check-failed";

/**
 * One refusal, ready to show.
 *
 * `message` is a complete user-facing sentence (or two): what the designer
 * found, where, and what happens instead. `nodeText` is the offending source
 * clipped for a tooltip, and `line` / `column` are 1-based so an editor can
 * put the caret on it.
 */
export interface FormDesignerRefusal {
  code: FormDesignerRefusalCode;
  message: string;
  nodeText?: string;
  line?: number;
  column?: number;
}

/** One comment found strictly between the two region markers. */
export interface FormRegionComment {
  /** The comment verbatim, its delimiters included. */
  text: string;
  /** 1-based line of the comment's first character. */
  line: number;
}

/**
 * Where the designer-owned block is, and what the writer must put back.
 *
 * The span is the two MARKER COMMENTS and everything between them —
 * `start` is the offset of the `/` that opens `// #region …` and `end` is one
 * past the last character of `// #endregion`. The indentation in front of the
 * opening marker therefore lies OUTSIDE the span and is never rewritten, while
 * the indentation in front of the closing marker lies inside it and is
 * reproduced from `endIndent`. Both marker comments are re-emitted verbatim,
 * so a user who reworded the region's label keeps their wording.
 */
export interface FormRegionSpan {
  start: number;
  end: number;
  /** The `// #region …` comment verbatim. */
  startComment: string;
  /** The `// #endregion…` comment verbatim. */
  endComment: string;
  /** Whitespace between the start of the line and the opening marker. */
  startIndent: string;
  /** Whitespace between the start of the line and the closing marker. */
  endIndent: string;
  /** 1-based line of the opening marker. */
  startLine: number;
  /** Comments strictly between the markers. A re-emit DESTROYS these. */
  innerComments: FormRegionComment[];
}

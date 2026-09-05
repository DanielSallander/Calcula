//! FILENAME: app/src/api/formDesigner/readFormRegion.ts
// PURPOSE: Read a script's designer-owned `#region` and answer with the
//          `FormSpec` it declares — or with the one sentence explaining why the
//          designer will not open it.
// CONTEXT: M5a of docs/design/typescript-forms.md §14.
//
//          THE REGION MUST HOLD EXACTLY ONE STATEMENT, the `form.define(...)`
//          call. Not because a script may not put code near its layout, but
//          because the WRITER re-emits the whole block: anything else in there
//          would be deleted the first time a widget moved. So the reader
//          refuses to open a block it could not put back, and the refusal says
//          what else it found. That is the same rule from the other side as
//          "exact or nothing" in formLiteral.ts.
//
//          A SECOND `form.define` OUTSIDE the region is not a refusal — it is
//          legal code, and the designer owns only the call inside the markers.
//          But whichever runs LAST is the layout the user sees, so the count is
//          reported (`definesOutsideRegion`) for the caller to warn about
//          rather than silently swallowed.
//
//          THE COMPILER IS THE TRANSPILER'S. `loadScriptTypeScript`
//          (app/src/api/scriptTranspile.ts) hands back the same cached module
//          the save-time transpile uses; adding a second `import("typescript")`
//          here would give the bundle a second copy of the same lazy chunk.

import type * as TS from "typescript";

import { loadScriptTypeScript, type TypeScriptModule } from "../scriptTranspile";
import type { FormSpec } from "../scriptHost/scriptFormSpec";
import { checkFormSpec } from "../scriptHost/validators";

import { readObjectLiteral } from "./formLiteral";
import { locateFormRegion } from "./formRegion";
import type { FormDesignerRefusal, FormRegionComment, FormRegionSpan } from "./types";

export interface FormRegionReadOk {
  ok: true;
  /** The layout as declared, already through `checkFormSpec`. */
  spec: FormSpec;
  region: FormRegionSpan;
  /** `form.define` exactly as the script spells it; the writer re-emits it. */
  calleeText: string;
  /**
   * Comments between the markers. Re-emitting the region DESTROYS these, so a
   * designer must show them to the user before its first write —
   * `writeFormRegion` refuses until the caller says it has.
   */
  droppedComments: readonly FormRegionComment[];
  /**
   * How many other `….define(...)` calls the script makes outside the region.
   * Non-zero means what the designer draws may not be what the form shows.
   */
  definesOutsideRegion: number;
}

export type FormRegionReadResult =
  | FormRegionReadOk
  | { ok: false; refusal: FormDesignerRefusal };

/** Everything the reader learned about the source, reused by the writer. */
export interface ParsedFormSource {
  ts: TypeScriptModule;
  sourceFile: TS.SourceFile;
}

function refuse(
  code: FormDesignerRefusal["code"],
  message: string,
  extra?: Partial<FormDesignerRefusal>,
): { ok: false; refusal: FormDesignerRefusal } {
  return { ok: false, refusal: { code, message, ...extra } };
}

/**
 * Parse the source, refusing loudly if it does not compile.
 *
 * The syntax gate is a `transpileModule` with diagnostics on — the same public
 * door scriptTranspile.ts uses — because `createSourceFile` reports its parse
 * errors only on an internal field, and a designer that opened a half-parsed
 * file would be reading a tree the compiler had guessed at. Two parses of a few
 * kilobytes is the price of not guessing.
 */
async function parseSource(
  source: string,
  fileLabel: string,
): Promise<{ ok: true; parsed: ParsedFormSource } | { ok: false; refusal: FormDesignerRefusal }> {
  let ts: TypeScriptModule;
  try {
    ts = await loadScriptTypeScript();
  } catch (err) {
    return refuse(
      "compiler-unavailable",
      `The designer could not load the TypeScript compiler it reads your layout with (${String(err)}). Nothing was changed.`,
    );
  }
  const label = fileLabel.replace(/[^A-Za-z0-9._-]/g, "_");
  const probe = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    fileName: `${label}.ts`,
    reportDiagnostics: true,
  });
  const first = (probe.diagnostics ?? [])[0];
  if (first) {
    const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
    let line: number | undefined;
    if (first.file && typeof first.start === "number") {
      line = first.file.getLineAndCharacterOfPosition(first.start).line + 1;
    }
    return refuse(
      "parse-error",
      `This script does not compile${line === undefined ? "" : ` (line ${line})`}: ${message} ` +
        "The designer can only read a layout out of a script that parses, so fix it in the code editor first.",
      { line },
    );
  }
  const sourceFile = ts.createSourceFile(
    `${label}.ts`,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  return { ok: true, parsed: { ts, sourceFile } };
}

/** Is this node the `x.define(...)` call shape the region is built around? */
function isDefineCall(ts: TypeScriptModule, node: TS.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "define"
  );
}

/** How many `.define(...)` calls sit outside `[start, end)`. */
function countDefinesOutside(
  ts: TypeScriptModule,
  sourceFile: TS.SourceFile,
  start: number,
  end: number,
): number {
  let count = 0;
  const visit = (node: TS.Node): void => {
    if (isDefineCall(ts, node)) {
      const at = node.getStart(sourceFile);
      if (at < start || at >= end) count++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return count;
}

/**
 * The nodes that lie wholly inside the region's content, outermost first.
 *
 * A node that STRADDLES the whole region is descended into — that is the normal
 * case, `function setup(form) { …markers… }`. A node that only PARTLY overlaps
 * means a marker was dropped into the middle of a statement, which the caller
 * turns into a refusal: re-emitting the span would cut that statement in half.
 */
function nodesInside(
  ts: TypeScriptModule,
  sourceFile: TS.SourceFile,
  contentStart: number,
  contentEnd: number,
): { inside: Array<TS.Node>; partial: Array<TS.Node> } {
  const inside: Array<TS.Node> = [];
  const partial: Array<TS.Node> = [];
  // A node the markers surround but which is not itself a STATEMENT means the
  // markers were dropped inside an expression — `form.define({` above the
  // opening one and `});` below the closing one, with only the `children:`
  // property between them. The walk finds a node wholly inside the span, so the
  // partial-overlap test alone does not catch it.
  const isStatementPosition = (node: TS.Node): boolean => {
    const parent = node.parent;
    return (
      parent !== undefined &&
      (ts.isSourceFile(parent) ||
        ts.isBlock(parent) ||
        ts.isModuleBlock(parent) ||
        ts.isCaseClause(parent) ||
        ts.isDefaultClause(parent))
    );
  };
  const visit = (node: TS.Node): void => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    if (end <= contentStart || start >= contentEnd) return;
    if (start >= contentStart && end <= contentEnd) {
      if (isStatementPosition(node)) inside.push(node);
      else partial.push(node);
      return;
    }
    if (start < contentStart && end > contentEnd) {
      ts.forEachChild(node, visit);
      return;
    }
    partial.push(node);
  };
  ts.forEachChild(sourceFile, visit);
  return { inside, partial };
}

/**
 * Read the designer-owned layout out of a script.
 *
 * Every failure is a refusal with a sentence, never an approximation and never
 * a throw: the caller's response to any of them is the same — open the code
 * editor and show the user why.
 */
export async function readFormRegion(
  source: string,
  options?: { fileLabel?: string },
): Promise<FormRegionReadResult> {
  const parsed = await parseSource(source, options?.fileLabel ?? "script");
  if (!parsed.ok) return parsed;
  return readParsedFormRegion(parsed.parsed);
}

/**
 * The read, given a source file the caller already parsed.
 *
 * The writer parses the source itself (it has to: it re-reads its own output to
 * prove the round trip) and calls this rather than `readFormRegion`, so one
 * write costs two parses instead of four.
 */
export function readParsedFormRegion(parsed: ParsedFormSource): FormRegionReadResult {
  const { ts, sourceFile } = parsed;
  const located = locateFormRegion(ts, sourceFile);
  if (!located.ok) return located;
  const span = located.span;

  const contentStart = span.start + span.startComment.length;
  const contentEnd = span.end - span.endComment.length;
  const { inside, partial } = nodesInside(ts, sourceFile, contentStart, contentEnd);

  if (partial.length > 0) {
    const line = sourceFile.getLineAndCharacterOfPosition(partial[0].getStart(sourceFile)).line + 1;
    return refuse(
      "region-cuts-code",
      `A layout marker sits in the middle of a statement: the block wraps part of the code on line ${line} ` +
        `(\`${partial[0].getText(sourceFile).replace(/\s+/g, " ").slice(0, 40)}\`) rather than whole lines. ` +
        "Move the `// #region Form layout` and `// #endregion` markers onto their own lines around the " +
        "entire form.define(...) call.",
      { line, nodeText: partial[0].getText(sourceFile).slice(0, 72) },
    );
  }
  if (inside.length === 0) {
    return refuse(
      "no-define",
      `The designer-owned layout block on line ${span.startLine} is empty: there is no form.define(...) call ` +
        "in it for the designer to draw.",
      { line: span.startLine },
    );
  }
  const defineStatements = inside.filter(
    (node) => ts.isExpressionStatement(node) && isDefineCall(ts, node.expression),
  );
  if (defineStatements.length > 1) {
    const line =
      sourceFile.getLineAndCharacterOfPosition(defineStatements[1].getStart(sourceFile)).line + 1;
    return refuse(
      "multiple-defines",
      `The designer-owned layout block declares the form twice — there is a second form.define(...) on ` +
        `line ${line}. The designer draws one layout, so it cannot tell which of them wins.`,
      { line },
    );
  }
  if (inside.length > 1) {
    const other = inside.find((node) => node !== defineStatements[0]) ?? inside[1];
    const line = sourceFile.getLineAndCharacterOfPosition(other.getStart(sourceFile)).line + 1;
    return refuse(
      "extra-code-in-region",
      `The designer-owned layout block holds code besides the form.define(...) call — line ${line} ` +
        `(\`${other.getText(sourceFile).replace(/\s+/g, " ").slice(0, 60)}\`). The designer rewrites the whole ` +
        "block when you move a widget, so it will not open one that holds code it would have to delete. " +
        "Move that line outside the markers.",
      { line, nodeText: other.getText(sourceFile).slice(0, 72) },
    );
  }

  const statement = inside[0];
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
    return refuse(
      "extra-code-in-region",
      `The designer-owned layout block holds code besides the form.define(...) call — line ${line}. ` +
        "The designer rewrites the whole block when you move a widget, so it will not open one that holds " +
        "code it would have to delete.",
      { line, nodeText: statement.getText(sourceFile).slice(0, 72) },
    );
  }
  const call = statement.expression;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "define") {
    const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
    return refuse(
      "no-define",
      `The designer-owned layout block calls \`${callee.getText(sourceFile)}\` on line ${line}, not ` +
        "form.define(...). The designer only draws the layout a form declares with define().",
      { line },
    );
  }
  if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) {
    const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
    return refuse(
      "define-argument",
      `form.define(...) on line ${line} is not given one plain layout object. The designer draws the ` +
        "object literal written out in the call, so a layout built anywhere else can only be edited as code.",
      { line },
    );
  }

  const literal = readObjectLiteral(ts, sourceFile, call.arguments[0]);
  if (!literal.ok) return literal;

  const verdict = checkFormSpec(literal.value);
  if (verdict !== true) {
    return refuse(
      "invalid-spec",
      `Calcula would refuse this layout, so the designer will not draw it: ${verdict}. Fix it in the code editor.`,
      { line: span.startLine },
    );
  }

  return {
    ok: true,
    spec: literal.value as unknown as FormSpec,
    region: span,
    calleeText: callee.getText(sourceFile),
    droppedComments: span.innerComments,
    definesOutsideRegion: countDefinesOutside(ts, sourceFile, span.start, span.end),
  };
}

/** Exported so the writer can parse once and hand the tree to the read. */
export { parseSource as parseFormSource };

// FILENAME: app/extensions/ModelEditor/lib/notebookBridge.ts
// PURPOSE: "Test in notebook" — hand a DRAFT measure / context expression to
//          the notebook so it can be interrogated against the LIVE model
//          without being applied to it.
//
// CONTEXT: The Model Editor authors measures; until now the app had no
//          evaluate surface for one (docs/design/notebook-analysis-workbench.md
//          §1). This is that bridge, and it is deliberately read-only end to end:
//
//   * The verdict shown in the scaffold comes from the READ-ONLY diagnostics —
//     bi_model_validate_measure / bi_model_validate_context (the same commands
//     behind the modal's "Validate" button) — which compile a candidate against
//     the live model WITHOUT installing it. No upsert, no batch, no mutation
//     path is touched here.
//   * What crosses to the notebook is TEXT: markdown prose plus a code cell.
//     Handing over a scaffold grants nothing; the code cell's first `model.*`
//     call still meets the notebook's own per-capability consent prompt and is
//     audited like any other.
//   * HONESTY: the engine has no ad-hoc measure evaluation (validate_measure_text
//     compiles, it does not execute), so an UNSAVED draft cannot be given a
//     number. The scaffold says so in as many words and evaluates what it
//     legitimately can — the saved definition, and the measures the draft
//     references — instead of implying it ran the draft.
//
// The event contract is mirrored in ScriptNotebook/lib/notebookScaffold.ts;
// extensions may not import each other, and app/src/api is out of scope for
// this change (see the CROSS-FILE REQUESTS note in the design doc).

import { biModelValidateContext, biModelValidateMeasure } from "@api";
import type { MeasureValidation, ModelMeasureInfo } from "@api";
import { emitTauriEvent } from "@api/backend";

/** Cross-window event: "please drop these cells into a notebook". */
const NOTEBOOK_SCAFFOLD_EVENT = "calcula:notebook-scaffold";

interface ScaffoldCell {
  kind: "code" | "markdown";
  source: string;
}

interface NotebookScaffoldRequest {
  notebookName: string;
  title: string;
  cells: ScaffoldCell[];
}

function emitScaffold(request: NotebookScaffoldRequest): Promise<void> {
  return emitTauriEvent(NOTEBOOK_SCAFFOLD_EVENT, request);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Fence an expression. The fence is always LONGER than the longest backtick
 *  run in the text, so a draft containing ``` cannot break out of the block
 *  (and the expression is reproduced byte-for-byte, not escaped). */
function fence(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0);
  const bar = "`".repeat(Math.max(3, longest + 1));
  return [bar, text, bar].join("\n");
}

/** One line describing the read-only verdict. */
function verdictLine(v: MeasureValidation): string {
  if (v.ok) return "**Validation:** compiles against the live model.";
  const where = v.position === null ? "" : ` (at position ${v.position})`;
  return `**Validation:** FAILS${where} — ${v.message ?? "invalid"}`;
}

/**
 * Measures the draft references, restricted to measures that actually exist in
 * the live model. `[Name]` is the measure-reference syntax; anything the model
 * does not define is dropped rather than guessed at.
 */
export function referencedMeasures(
  expression: string,
  known: ModelMeasureInfo[],
): string[] {
  const names = new Set(known.map((m) => m.name));
  const found = new Set<string>();
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) {
    const name = m[1].trim();
    if (names.has(name)) found.add(name);
  }
  return [...found].sort();
}

/** A JS array literal of measure names, safe for embedding in a cell. */
function measureListLiteral(names: string[]): string {
  return `[${names.map((n) => JSON.stringify(n)).join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

export interface TestMeasureRequest {
  connectionId: string;
  /** Draft name as typed in the editor. */
  name: string;
  /** Draft formula as typed in the editor. */
  formula: string;
  /** The measure being edited, or null for a brand-new one. */
  existing: ModelMeasureInfo | null;
  /** The live model's measures — used to resolve references in the draft. */
  knownMeasures: ModelMeasureInfo[];
}

/** Build the cells for a measure test. Pure — unit-testable without IPC. */
export function buildMeasureScaffold(
  request: TestMeasureRequest,
  validation: MeasureValidation,
): NotebookScaffoldRequest {
  const { connectionId, name, formula, existing, knownMeasures } = request;
  const label = name.trim() || "(unnamed measure)";
  const savedName = existing?.name ?? null;
  const refs = referencedMeasures(formula, knownMeasures);

  const prose: string[] = [
    `## Test measure \`${label}\``,
    "",
    "Draft from the Model Editor. **It has not been applied to the model** — nothing in",
    "this notebook can change the model.",
    "",
    fence(formula.trim() === "" ? "(empty — saves as BLANK())" : formula),
    "",
    verdictLine(validation),
    "",
    "### What the cell below evaluates",
    "",
  ];

  const evaluated: string[] = [];
  if (savedName) {
    evaluated.push(savedName);
    prose.push(
      `- \`${savedName}\` — the **saved** definition, as the model holds it today.`,
      "  Compare it with the draft above to see what your edit would change.",
    );
  }
  for (const r of refs) {
    if (!evaluated.includes(r)) evaluated.push(r);
  }
  if (refs.length > 0) {
    prose.push(
      `- ${refs.map((r) => `\`${r}\``).join(", ")} — the measures the draft references,`,
      "  so you can check the parts before saving the whole.",
    );
  }
  if (evaluated.length === 0) {
    prose.push(
      "- nothing yet: this draft is new and references no existing measure, so there is",
      "  no saved definition to query. Fill in `measures` below once you save it.",
    );
  }
  prose.push(
    "",
    "The engine compiles a candidate measure but cannot *execute* an unapplied one, so a",
    "draft has no number until you save it in the Model Editor. That is a real limit, not",
    "an omission here.",
  );

  const code: string[] = [
    `// Test measure "${label}" — read-only query against the live model.`,
    "// The first call asks for the `bi.query` capability (per notebook, revocable in",
    "// Settings > Script Security); every call is recorded in the audit trail.",
    `const conn = ${JSON.stringify(connectionId)};`,
    "",
    `model.query(conn, {`,
    `  measures: ${measureListLiteral(evaluated)},`,
    "  // Add a grain, e.g.: groupBy: [{ table: 'dim_date', column: 'Year' }],",
    "  groupBy: [],",
    "});",
    "",
  ];

  return {
    notebookName: "Model analysis",
    title: `Measure "${label}"`,
    cells: [
      { kind: "markdown", source: prose.join("\n") },
      { kind: "code", source: code.join("\n") },
    ],
  };
}

/**
 * Validate a draft measure through the read-only diagnostic and send the
 * result to the notebook. Never mutates the model.
 */
export async function testMeasureInNotebook(request: TestMeasureRequest): Promise<void> {
  const validation = await biModelValidateMeasure(
    request.connectionId,
    request.name,
    request.formula,
    request.existing?.name ?? null,
  );
  await emitScaffold(buildMeasureScaffold(request, validation));
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

export interface TestContextRequest {
  connectionId: string;
  name: string;
  expression: string;
  /** The context being edited, or null for a brand-new one. */
  originalName: string | null;
  knownMeasures: ModelMeasureInfo[];
}

/** Measures whose formula names this context (so the cell can show its effect). */
export function measuresUsingContext(
  contextName: string,
  known: ModelMeasureInfo[],
): string[] {
  const trimmed = contextName.trim();
  if (trimmed === "") return [];
  const re = new RegExp(`\\b${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return known
    .filter((m) => re.test(m.formula))
    .map((m) => m.name)
    .sort();
}

/** Build the cells for a context test. Pure — unit-testable without IPC. */
export function buildContextScaffold(
  request: TestContextRequest,
  validation: MeasureValidation,
): NotebookScaffoldRequest {
  const { connectionId, name, expression, originalName, knownMeasures } = request;
  const label = name.trim() || "(unnamed context)";
  const users = measuresUsingContext(originalName ?? name, knownMeasures);

  const prose: string[] = [
    `## Test context \`${label}\``,
    "",
    "Draft from the Model Editor. **It has not been applied to the model.**",
    "",
    fence(expression.trim() === "" ? "(empty)" : expression),
    "",
    verdictLine(validation),
    "",
    "### What the cell below evaluates",
    "",
  ];
  if (users.length > 0) {
    prose.push(
      `The measures that apply this context today — ${users
        .map((u) => `\`${u}\``)
        .join(", ")} — evaluated as the model currently defines them.`,
      "",
      "A context is a filter transformation a measure opts into; a query cannot apply an",
      "unsaved one directly, so this shows the current behaviour to diff against once you",
      "save the edit.",
    );
  } else {
    prose.push(
      "No saved measure applies this context yet, so there is nothing to evaluate. Save",
      "the context, reference it from a measure with `using(...)`, then come back.",
    );
  }

  const code: string[] = [
    `// Test context "${label}" — read-only query against the live model.`,
    `const conn = ${JSON.stringify(connectionId)};`,
    "",
    `model.query(conn, {`,
    `  measures: ${measureListLiteral(users)},`,
    "  groupBy: [],",
    "});",
    "",
  ];

  return {
    notebookName: "Model analysis",
    title: `Context "${label}"`,
    cells: [
      { kind: "markdown", source: prose.join("\n") },
      { kind: "code", source: code.join("\n") },
    ],
  };
}

/**
 * Validate a draft context through the read-only diagnostic and send the result
 * to the notebook. Never mutates the model.
 */
export async function testContextInNotebook(request: TestContextRequest): Promise<void> {
  const validation = await biModelValidateContext(
    request.connectionId,
    request.name,
    request.expression,
    request.originalName,
  );
  await emitScaffold(buildContextScaffold(request, validation));
}

//! FILENAME: app/extensions/FormulaAssist/lib/explain.ts
// PURPOSE: Say what a formula does, with NO model involved.
// CONTEXT: Tier 0 of the assistant, and the half that always works: offline,
//          with no provider configured, on a machine that has never downloaded
//          a model. It also cannot be wrong about the product, because it reads
//          the parsed tree the engine actually evaluated (`get_formula_eval_plan`)
//          and the function catalogue the engine actually ships
//          (`get_all_functions`) — two authorities, neither of them a guess.
//
//          THE TWO SOURCES DEGRADE INDEPENDENTLY, AND THE DIFFERENCE IS SAID
//          OUT LOUD. The eval plan supplies VALUES (what each sub-expression
//          returned); the catalogue supplies MEANING (what each function is
//          for). If the plan is unavailable — the cell holds no formula, the
//          backend refuses, the command is not reachable from here — the
//          catalogue alone still explains the structure, and the result says
//          `withValues: false` and carries a note. A tier that quietly drops
//          from "here is what it computed" to "here is what it might compute"
//          without saying so is exactly the kind of lie this codebase has been
//          removing.

import { getAllFunctions, getFormulaEvalPlan } from "@api";
import type { EvalPlanNode, FormulaEvalPlan } from "@api";
import type { FunctionInfo } from "@api/types";

export interface ExplainResult {
  /** The whole explanation, ready to render. */
  text: string;
  /** One line each, so a UI can render them as list items. */
  bullets: string[];
  /** True when the bullets carry computed values, false when structure only. */
  withValues: boolean;
  /** Why values are missing, when they are. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * The function catalogue, fetched once.
 *
 * Cached on the PROMISE rather than the value so two explanations opened in the
 * same second share one backend round trip instead of racing. Cleared on
 * failure so a transient error is not remembered as "there is no catalogue".
 */
let cataloguePromise: Promise<Map<string, FunctionInfo>> | null = null;

async function catalogue(): Promise<Map<string, FunctionInfo>> {
  if (!cataloguePromise) {
    cataloguePromise = getAllFunctions()
      .then((r) => {
        const byName = new Map<string, FunctionInfo>();
        for (const fn of r.functions) byName.set(fn.name.toUpperCase(), fn);
        return byName;
      })
      .catch((err) => {
        cataloguePromise = null;
        throw err;
      });
  }
  return cataloguePromise;
}

/** Test hook: forget the cached catalogue. */
export function resetCatalogueCache(): void {
  cataloguePromise = null;
}

/**
 * A sentence naming what a list of functions does.
 *
 * Used when a model returned a formula but no explanation, which happens
 * whenever a runtime ignores the reply schema. A structural sentence beats an
 * empty explanation slot, and it costs no tokens.
 */
export async function describeFunctions(names: readonly string[]): Promise<string> {
  const unique = [...new Set(names.map((n) => n.toUpperCase()))].filter(Boolean);
  if (unique.length === 0) return "";
  let byName: Map<string, FunctionInfo>;
  try {
    byName = await catalogue();
  } catch {
    return `Uses ${unique.join(", ")}.`;
  }
  const parts = unique.map((name) => {
    const info = byName.get(name);
    return info ? `${name} (${firstSentence(info.description)})` : name;
  });
  return `Uses ${parts.join("; ")}.`;
}

/** The first sentence of a catalogue description, lower-cased at the front. */
function firstSentence(description: string): string {
  const text = description.trim();
  if (!text) return "no description";
  const stop = text.indexOf(". ");
  const one = stop > 0 ? text.slice(0, stop) : text.replace(/\.$/, "");
  return one.charAt(0).toLowerCase() + one.slice(1);
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

export interface ExplainDeps {
  evalPlan: (row: number, col: number) => Promise<FormulaEvalPlan>;
  functions: () => Promise<Map<string, FunctionInfo>>;
}

export function defaultExplainDeps(): ExplainDeps {
  return { evalPlan: getFormulaEvalPlan, functions: catalogue };
}

/**
 * Explain the formula in one cell.
 *
 * Deterministic: the same cell always produces the same bullets, in evaluation
 * order. That is the point of Tier 0 — a person can check it against the sheet.
 */
export async function explainCell(
  row: number,
  col: number,
  deps: ExplainDeps = defaultExplainDeps(),
): Promise<ExplainResult> {
  let plan: FormulaEvalPlan | null = null;
  let planError = "";
  try {
    plan = await deps.evalPlan(row, col);
  } catch (err) {
    planError = messageOf(err);
  }

  let byName: Map<string, FunctionInfo>;
  try {
    byName = await deps.functions();
  } catch {
    byName = new Map();
  }

  if (!plan || !plan.formula) {
    return {
      text: "This cell holds no formula, so there is nothing to explain.",
      bullets: [],
      withValues: false,
      note: planError || undefined,
    };
  }

  return renderPlan(plan, byName);
}

/**
 * Explain a formula STRING with no cell behind it.
 *
 * The fallback path named in the header: no eval plan means no values, and the
 * caller is told so rather than being handed structure dressed up as a result.
 */
export async function explainFormulaText(
  formula: string,
  deps: Pick<ExplainDeps, "functions"> = { functions: catalogue },
): Promise<ExplainResult> {
  let byName: Map<string, FunctionInfo>;
  try {
    byName = await deps.functions();
  } catch {
    byName = new Map();
  }
  const names = functionNamesIn(formula);
  const bullets = names.map((name) => {
    const info = byName.get(name);
    return info
      ? `${name} — ${firstSentence(info.description)}.`
      : `${name} — not in Calcula's function catalogue.`;
  });
  return {
    text: [formula, ...bullets].join("\n"),
    bullets,
    withValues: false,
    note: "Calcula could not evaluate this formula in place, so this describes its structure without values.",
  };
}

/** An identifier immediately before `(` is a function call. */
function functionNamesIn(formula: string): string[] {
  const found = formula.match(/[A-Za-z][A-Za-z0-9._]*(?=\s*\()/g) ?? [];
  return [...new Set(found.map((s) => s.toUpperCase()))];
}

function renderPlan(
  plan: FormulaEvalPlan,
  byName: Map<string, FunctionInfo>,
): ExplainResult {
  const bullets: string[] = [];
  bullets.push(`${plan.formula} returns ${displayOf(plan.result)}.`);

  // Evaluation order, so the bullets read the way the engine worked: inner
  // arguments before the call that consumed them.
  const functionNodes = plan.nodes
    .filter((n) => n.nodeType === "function")
    .sort((a, b) => a.evalOrder - b.evalOrder);

  for (const node of functionNodes) {
    bullets.push(functionBullet(node, byName));
  }

  if (functionNodes.length === 0) {
    // An operator-only formula (=A1*B1) has no function nodes at all, and
    // saying nothing about it would read as a failure. The root node's own
    // value is the honest answer.
    const root = plan.nodes.find((n) => n.id === plan.rootId);
    if (root && root.subtitle) {
      bullets.push(`${root.label} over ${root.subtitle} gives ${displayOf(root.value)}.`);
    }
  }

  return { text: bullets.join("\n"), bullets, withValues: true };
}

function functionBullet(
  node: EvalPlanNode,
  byName: Map<string, FunctionInfo>,
): string {
  const name = node.label.toUpperCase();
  const info = byName.get(name);
  const what = info ? firstSentence(info.description) : "a function Calcula evaluated";
  const args = node.subtitleCompact || node.subtitle;
  const over = args ? ` over ${args}` : "";
  return `${name} — ${what}${over}; returned ${displayOf(node.value)}.`;
}

/** An empty result is a real answer and must not render as a blank line. */
function displayOf(value: string): string {
  const v = (value ?? "").trim();
  return v === "" ? "an empty value" : v;
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

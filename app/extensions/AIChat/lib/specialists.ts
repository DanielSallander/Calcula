//! FILENAME: app/extensions/AIChat/lib/specialists.ts
// PURPOSE: What the chat SENDS for each intent: which tools, and what it tells
//          the model about the job — a small surface for a decided request,
//          the whole surface for one nobody decided.
// CONTEXT: The one finding this programme has reproduced at every model size:
//          handed 24 tool schemas, qwen2.5-coder:3b named a real tool 0 times in
//          4; handed 12, 4 in 4 — and a 7B invented names at 24 exactly as the
//          3B did. The SIZE of the surface is the lever. Until the router
//          existed the chat could only cut the surface AFTER a model had already
//          invented a name (`narrowed` in ChatView); now a decisive route cuts
//          it before the first turn, to the tools that job can possibly need.
//
//          ONLY A DECISIVE ROUTE NARROWS. A lean ("this reads like a question")
//          keeps every tool, because a lean is allowed to be wrong and a missing
//          tool is not a mistake a model can recover from. The narrowing that
//          reacts to an invented name composes with this through
//          `narrowedSurface`: the retry carries the SMALLER of the core set and
//          the specialist's own, never the wider one — a format request that
//          began with four tools is not "narrowed" to ten.
//
//          EVERY TOOL IS REACHABLE FROM SOME SPECIALIST, and a test pins it —
//          the alternative is a tool that exists in the product and can never
//          be chosen, which is a deletion nobody decided on.

import type { Intent, IntentRoute } from "./intentRouter";
import { TOOLS, TOOL_NAMES, CORE_TOOL_NAMES, type ChatToolDef } from "./chatTools";

export interface Specialist {
  /**
   * The intent this specialist serves; `"general"` is the undecided loop and
   * `"core"` the fallback an inventing model is retried with.
   */
  readonly intent: Intent | "general" | "core";
  /** The tools sent, in the declared order of `TOOLS`. */
  readonly toolNames: readonly string[];
  readonly tools: readonly ChatToolDef[];
  /**
   * A short paragraph appended to the system prompt, saying what the job is.
   * Byte-stable per intent so the provider's prefix cache holds across turns.
   */
  readonly systemAddendum: string;
}

/** The subsets. Each is ≤ 8 names except the general loop; a test pins that too. */
const SUBSETS: Record<Intent, readonly string[]> = {
  script: [
    "get_sheet_summary", "read_cell_range", "draft_object_script", "run_script",
    "list_script_drafts", "get_script_draft", "list_charts", "list_tables",
  ],
  format: ["get_sheet_summary", "read_cell_range", "apply_formatting", "set_cell_range"],
  "data-op": [
    "get_sheet_summary", "read_cell_range", "set_cell_value", "set_cell_range", "create_table",
    "create_named_range", "list_tables", "run_script",
  ],
  formula: ["get_sheet_summary", "read_cell_range", "set_cell_value", "set_cell_range"],
  analyze: [
    "analyze_range", "analyze_model", "show_points_of_interest", "get_sheet_summary", "read_cell_range",
    "list_bi_connections", "describe_bi_model",
  ],
  chart: ["list_charts", "get_chart", "create_chart_from_spec", "show_points_of_interest", "get_sheet_summary", "read_cell_range", "list_tables"],
  "bi-query": [
    "list_bi_connections", "describe_bi_model", "run_bi_query", "cube_value", "cube_kpi",
    "cube_members", "create_pivot", "analyze_model",
  ],
  question: [
    "get_sheet_summary", "read_cell_range", "list_charts", "list_tables", "list_pivots",
    "list_named_ranges", "list_bi_connections",
  ],
  unclear: [...TOOL_NAMES],
};

const ADDENDA: Record<Intent, string> = {
  script:
    "\n\nTHIS REQUEST IS FOR AUTOMATION the user will keep. Author it with draft_object_script; " +
    "read the sheet first only if the script's logic depends on what is there.",
  format:
    "\n\nTHIS REQUEST IS ABOUT APPEARANCE ONLY. Use apply_formatting on the range named or selected; " +
    "change no values.",
  "data-op":
    "\n\nTHIS REQUEST IS A ONE-OFF EDIT to what the sheet holds. Make exactly the edit asked for, " +
    "once, and report what changed. Use run_script only when the edit is a rule over many cells " +
    "that no single write expresses.",
  formula:
    "\n\nTHIS REQUEST IS ABOUT A FORMULA. Answer with the formula the user should enter, or explain " +
    "the one they have; write it into a cell only when asked to.",
  analyze:
    "\n\nTHIS REQUEST ASKS WHAT THE DATA SAYS. Call analyze_range (or analyze_model) and put its " +
    "checked facts into words; derive no trend, outlier or correlation from raw values yourself. " +
    "When the user wants to SEE where something is on a chart, call show_points_of_interest instead of describing positions.",
  chart:
    "\n\nTHIS REQUEST IS ABOUT A CHART. Read the data it should show, then create or change the " +
    "chart; do not restate the numbers in prose.",
  "bi-query":
    "\n\nTHIS REQUEST IS A REPORT over the semantic model. Describe the model once, then run the " +
    "query or build the pivot the user asked for, following the model's strategy for measures " +
    "and groupings.",
  question:
    "\n\nTHIS IS A QUESTION, not a change request. Answer it; read the workbook only if the " +
    "answer depends on what is in it. Change nothing.",
  unclear: "",
};

function build(intent: Specialist["intent"], names: readonly string[], addendum: string): Specialist {
  const wanted = new Set(names);
  return {
    intent,
    toolNames: TOOL_NAMES.filter((n) => wanted.has(n)),
    tools: TOOLS.filter((t) => wanted.has(t.name)),
    systemAddendum: addendum,
  };
}

const GENERAL: Specialist = build("general", TOOL_NAMES, "");
/** The measured fallback (`CORE_TOOL_NAMES`), in specialist shape. */
const CORE: Specialist = build("core", CORE_TOOL_NAMES, "");
const BY_INTENT: Record<Intent, Specialist> = Object.fromEntries(
  (Object.keys(SUBSETS) as Intent[]).map((i) => [i, build(i, SUBSETS[i], ADDENDA[i])]),
) as Record<Intent, Specialist>;

/** Every specialist, for the reachability test. */
export const SPECIALISTS: readonly Specialist[] = [GENERAL, ...Object.values(BY_INTENT)];

/**
 * The specialist for a route. A decided route gets its specialist; a lean, an
 * ask, and `unclear` get the general loop with every tool.
 */
export function specialistFor(route: IntentRoute): Specialist {
  if (!route.decisive || route.clarify || route.intent === "unclear") return GENERAL;
  return BY_INTENT[route.intent];
}

/**
 * The surface once a model has invented a tool name: the SMALLER of the core
 * set and the specialist's own — the same object when the specialist is
 * already no wider than the core set, so a caller can tell "the retry shrank
 * the list" from "the list was already as short as this job allows" by
 * identity, and say the true thing to the user.
 *
 * The general loop's 24 fall to the core 10, as they always did. A specialist
 * of four is NOT lifted to ten: the measured lever is size, and widening a
 * list because the model invented a name from it would be the opposite of the
 * fix. What the retry then adds is the repair message in the tool result,
 * which names the closed list; a second invented turn ends in the verdict.
 */
export function narrowedSurface(specialist: Specialist): Specialist {
  return specialist.toolNames.length > CORE.toolNames.length ? CORE : specialist;
}

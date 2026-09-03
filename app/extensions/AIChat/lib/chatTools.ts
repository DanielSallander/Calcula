//! FILENAME: app/extensions/AIChat/lib/chatTools.ts
// PURPOSE: The in-app AI chat's TOOL SURFACE and system prompt, in one place.
//          Every entry here must have a matching arm in `ai_chat_run_tool`
//          (app/src-tauri/src/ai/tools.rs) — a tool declared on one side only is
//          either an unreachable promise to the model or a dead dispatcher arm.
//          `__tests__/chatToolSurface.test.ts` reads the Rust file at test time
//          and diffs both directions, so the two cannot drift in silence.
// CONTEXT: Extracted from ChatView.tsx, which had grown to ~230 lines of tool
//          schema around ~170 lines of component. Splitting it is what makes the
//          drift guard possible without parsing a .tsx file for an inline const.
//
//          WHY THE SCHEMAS ARE snake_case INSIDE `properties`: those are MCP tool
//          PARAMETERS, not the Tauri api_types boundary. The param structs they
//          deserialize into (crate::mcp::server::*Params) carry NO
//          `#[serde(rename_all)]`, so the wire names are the Rust field names
//          verbatim. The camelCase golden rule governs api_types.rs <-> types.ts
//          and does not reach inside a JSON Schema.
//
//          `inputSchema` itself IS camelCase, because that key crosses the Tauri
//          boundary as part of Calcula's own `ChatToolDef` (ai/wire.rs). It was
//          `input_schema` — Anthropic's spelling — until M3, which is exactly the
//          kind of vendor detail that had no business in an extension. A provider
//          now relocates it: Anthropic wants `input_schema`, OpenAI-compatible
//          servers want `function.parameters`, and neither spelling appears here.

/** One tool offered to the model, in Calcula's shape (mirrors `ChatToolDef`). */
export type { ChatToolDef } from "./aiTypes";
import type { ChatToolDef } from "./aiTypes";

/**
 * Object types a drafted script may target.
 *
 * MUST equal `VALID_OBJECT_TYPES` in `app/src-tauri/src/mcp/drafts.rs`, which is
 * the authoritative validator — it rejects anything outside the set, and it was
 * itself derived from what `save_object_script` will accept, so a draft the user
 * approves can actually be saved. Declared as an `enum` in the tool schema rather
 * than described in prose (the MCP server's own copy uses prose) because a closed
 * set is worth constraining: a model that invents "worksheet" gets a validation
 * error it must burn a turn recovering from.
 */
export const DRAFT_OBJECT_TYPES = [
  "workbook",
  "sheet",
  "cell",
  "row",
  "column",
  "slicer",
  "chart",
  "pivot",
  "button",
  "textbox",
  "timeline",
  "shape",
  "table",
  "namedRange",
  "panel",
  "range",
  "form",
] as const;

export const TOOLS: ChatToolDef[] = [
  {
    name: "get_sheet_summary",
    description:
      "Get an AI-optimized summary of the workbook: sheet dimensions, column types, formula patterns, sample data, and inventories of charts, named ranges, tables, and pivots. Call this first to understand the workbook.",
    inputSchema: {
      type: "object",
      properties: { max_chars: { type: "number", description: "Max summary length (default 8000)." } },
    },
  },
  {
    name: "read_cell_range",
    description: "Read the values of a rectangular cell range (0-based, inclusive).",
    inputSchema: {
      type: "object",
      properties: {
        start_row: { type: "number" }, start_col: { type: "number" },
        end_row: { type: "number" }, end_col: { type: "number" },
      },
      required: ["start_row", "start_col", "end_row", "end_col"],
    },
  },
  {
    name: "set_cell_value",
    description: "Set a single cell's value or formula (use '=' prefix for formulas). Undoable.",
    inputSchema: {
      type: "object",
      properties: {
        row: { type: "number", description: "0-based row" },
        col: { type: "number", description: "0-based column (A=0)" },
        value: { type: "string" },
      },
      required: ["row", "col", "value"],
    },
  },
  { name: "list_charts", description: "List every chart in the workbook.", inputSchema: { type: "object", properties: {} } },
  { name: "list_named_ranges", description: "List every named range.", inputSchema: { type: "object", properties: {} } },
  { name: "list_tables", description: "List every structured table.", inputSchema: { type: "object", properties: {} } },
  { name: "list_pivots", description: "List every pivot table with its fields.", inputSchema: { type: "object", properties: {} } },
  {
    name: "create_named_range",
    description: "Create a workbook-defined name. Undoable.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        refers_to: { type: "string", description: "e.g. \"=Sheet1!$A$1:$B$10\" or \"=0.25\"" },
        sheet_index: { type: "number", description: "Omit for workbook scope" },
        comment: { type: "string" },
      },
      required: ["name", "refers_to"],
    },
  },
  {
    name: "create_table",
    description: "Create a structured table over a cell range (0-based, inclusive). Undoable.",
    inputSchema: {
      type: "object",
      properties: {
        start_row: { type: "number" }, start_col: { type: "number" },
        end_row: { type: "number" }, end_col: { type: "number" },
        has_headers: { type: "boolean" }, name: { type: "string" },
      },
      required: ["start_row", "start_col", "end_row", "end_col"],
    },
  },
  {
    name: "set_cell_range",
    description: "Set values/formulas for multiple cells at once (more efficient than repeated set_cell_value). Undoable.",
    inputSchema: {
      type: "object",
      properties: {
        cells: {
          type: "array", description: "Cells to set.",
          items: {
            type: "object",
            properties: { row: { type: "number" }, col: { type: "number" }, value: { type: "string" } },
            required: ["row", "col", "value"],
          },
        },
      },
      required: ["cells"],
    },
  },
  {
    name: "apply_formatting",
    description: "Apply formatting to a cell range (0-based, inclusive): bold, italic, text/background color (hex), number format, text alignment. Undoable. Requires Script Security to allow execution.",
    inputSchema: {
      type: "object",
      properties: {
        start_row: { type: "number" }, start_col: { type: "number" },
        end_row: { type: "number" }, end_col: { type: "number" },
        bold: { type: "boolean" }, italic: { type: "boolean" },
        text_color: { type: "string", description: "hex, e.g. #FF0000" },
        background_color: { type: "string", description: "hex" },
        number_format: { type: "string" },
        text_align: { type: "string", enum: ["left", "center", "right", "general"] },
      },
      required: ["start_row", "start_col", "end_row", "end_col"],
    },
  },
  {
    name: "run_script",
    description: "Execute a JavaScript script in the script engine RIGHT NOW (Calcula.getCellValue/setCellValue/getRange/setRange). Undoable + recalc-tracked. Requires Script Security to allow execution. Use this ONLY for a one-off transformation the user wants applied immediately — if the user wants automation they will keep, re-run, or attach to something, use draft_object_script instead so they can review and mount it.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  // ---- Script drafting: AUTHOR for review, never mount or execute ----
  {
    name: "draft_object_script",
    description:
      "DRAFT an object script (a macro attached to a button, chart, sheet, workbook, ...) and hand it to the USER for review. This does NOT save the script into the workbook, does NOT mount it, and does NOT run it — the user reads it in the Object Script Editor and decides whether to mount it. PREFER THIS over run_script whenever the user wants automation that should persist, be re-run, or hang off an object. The script must `export function setup(context)` and react to the object's events through its HOOKS — a button's click handler is `context.onClick(handler)`; `context.expose(name, handler)` is only for named commands and NEVER runs on a click. Put the work in a top-level zero-argument function (`async function run() { ... }`) that setup() calls or wires to a hook -- setup() itself is not a run target, so a script whose only top-level function is setup cannot be started from the editor's Run. Declare any privileged capability the script needs with a `// @capability <id>` line comment (bi.query, bi.sql, net.fetch, storage, ui.html, ui.dialog, formula.udf, bi.model, bi.connector, distribution.writeback) — the reviewer is shown the declared set before they mount it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the script, e.g. \"Refresh Sales\"" },
        object_type: {
          type: "string",
          enum: [...DRAFT_OBJECT_TYPES],
          description: "Object type the script attaches to.",
        },
        instance_id: {
          type: "string",
          description: "For component objects (chart, pivot, table, button, ...): the target instance id from list_charts/list_tables/list_pivots. Omit for primitives like workbook or sheet.",
        },
        description: { type: "string", description: "Short description of what the script does, shown to the user during review." },
        source: { type: "string", description: "The JavaScript source, including any `// @capability <id>` declarations." },
      },
      required: ["name", "object_type", "source"],
    },
  },
  {
    name: "list_script_drafts",
    description: "List the object scripts drafted in this session and awaiting the user's review (id, name, target object, line count, declared capabilities). None of them are mounted or running. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_script_draft",
    description: "Get one drafted object script's full record (source, target, declared capabilities) so you can iterate on what you wrote. Read-only; the draft is still not mounted.",
    inputSchema: {
      type: "object",
      properties: { draft_id: { type: "string", description: "The draft id from draft_object_script / list_script_drafts" } },
      required: ["draft_id"],
    },
  },
  {
    name: "get_chart",
    description: "Get a single chart's full definition + ChartSpec as JSON. Pass a chart_id from list_charts.",
    inputSchema: {
      type: "object",
      properties: { chart_id: { type: "string" } },
      required: ["chart_id"],
    },
  },
  {
    name: "create_chart_from_spec",
    description: "Create a NEW chart from a ChartSpec JSON object. Call list_charts/get_chart for spec examples and get_sheet_summary for the data layout first. Requires Script Security to allow execution.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "object", description: "A ChartSpec JSON object (mark, data range, series)." },
        sheet_index: { type: "number" }, name: { type: "string" },
      },
      required: ["spec"],
    },
  },
  {
    name: "create_pivot",
    description: "Create a NEW pivot with row + value fields. Field names come from the source header row (call get_sheet_summary first). Undoable. Requires Script Security to allow execution.",
    inputSchema: {
      type: "object",
      properties: {
        source_range: { type: "string", description: "A1, e.g. A1:D100" },
        destination_cell: { type: "string", description: "A1, e.g. F1" },
        value_fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              aggregation: { type: "string", enum: ["sum", "count", "average", "min", "max"] },
            },
            required: ["field", "aggregation"],
          },
        },
        row_fields: { type: "array", items: { type: "string" } },
        source_sheet: { type: "number" }, destination_sheet: { type: "number" },
        has_headers: { type: "boolean" }, name: { type: "string" },
      },
      required: ["source_range", "destination_cell", "value_fields"],
    },
  },
  // ---- BI / cube (read-only) ----
  {
    name: "list_bi_connections",
    description: "List every BI/cube connection in the workbook (id, name, type, connected state, table/measure counts). Use this to discover BI models before describe_bi_model or run_bi_query.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "describe_bi_model",
    description: "Describe a BI/cube model's schema (tables, columns, measures, KPIs, relationships) for a connection_id from list_bi_connections. Call this before run_bi_query to learn valid measure/column names.",
    inputSchema: {
      type: "object",
      properties: { connection_id: { type: "string", description: "Connection id from list_bi_connections" } },
      required: ["connection_id"],
    },
  },
  {
    name: "run_bi_query",
    description: "Run a READ-ONLY structured BI/cube query: aggregate measures grouped by [table, column] dimensions, with optional filters. Returns a result table. Call describe_bi_model first for valid names.",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: { type: "string", description: "Connection id from list_bi_connections" },
        measures: { type: "array", items: { type: "string" }, description: "Measure names to aggregate" },
        group_by: {
          type: "array",
          description: "Dimensions to group by.",
          items: { type: "object", properties: { table: { type: "string" }, column: { type: "string" } }, required: ["table", "column"] },
        },
        filters: {
          type: "array",
          description: "Optional row filters.",
          items: { type: "object", properties: { table: { type: "string" }, column: { type: "string" }, operator: { type: "string", enum: ["=", "!=", ">", "<", ">=", "<="] }, value: { type: "string" } }, required: ["table", "column", "operator", "value"] },
        },
      },
      required: ["connection_id", "measures"],
    },
  },
  {
    name: "cube_value",
    description: "Resolve a CUBEVALUE: a measure expression plus optional member filters, against a BI model. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name or id" },
        members: { type: "array", items: { type: "string" }, description: "CUBE member-expressions, e.g. [\"[Sales Amount]\", \"Product[Category]=Bikes\"]" },
      },
      required: ["connection", "members"],
    },
  },
  {
    name: "cube_kpi",
    description: "Resolve a KPI value (1), goal (2), or status (3) for a BI model. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name or id" },
        kpi: { type: "string" },
        // NO `enum: [1, 2, 3]` HERE, however tempting — see the enum-portability
        // guard in __tests__/chatToolSurface.test.ts. Ollama decodes a tool's
        // schema into a Go struct whose per-property `enum` is `[]string`, so a
        // numeric member is a 400 at JSON-DECODE time, before any inference. And
        // because ChatView sends the whole TOOLS array on every turn, one bad
        // member broke every message to that runtime, whatever the user asked.
        // The closed set lives in the description instead; `CubeKpiParams.property`
        // (mcp/server.rs) is an i64 and still refuses anything else.
        property: { type: "integer", description: "Which KPI part: 1 = value, 2 = goal, 3 = status" },
      },
      required: ["connection", "kpi", "property"],
    },
  },
  {
    name: "cube_members",
    description: "List the distinct members of a level (a Table[Column] expression) in a BI model. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "Connection name or id" },
        level: { type: "string", description: "A level expression Table[Column], e.g. Product[Category]" },
      },
      required: ["connection", "level"],
    },
  },
];

/**
 * Every tool name, derived from `TOOLS` so it cannot drift from what is actually
 * offered.
 *
 * Two consumers depend on this being the SAME list the model is sent: the closed
 * set named in `SYSTEM_PROMPT` below, and the exact-match filter in
 * `textToolCalls.ts`. A hand-maintained second copy is how a salvaged call for a
 * tool that no longer exists would reach the dispatcher.
 */
export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/**
 * The tools a SMALL model is offered once the full surface has defeated it.
 *
 * MEASURED, not guessed. Against a live Ollama on 2026-08-22, replaying the
 * exact request a user reported, qwen2.5-coder:3b was asked to format the
 * selected cells:
 *
 *   24 tools, provider default temperature ... 0 of 4 named a real tool
 *   24 tools, temperature 0 ................. 0 of 4 (deterministically invented)
 *   12 tools, temperature 0 ................. 4 of 4 named a real tool
 *
 * The surface SIZE is the lever — not the prompt, and not the temperature. Two
 * dozen tool schemas is roughly 14k characters of JSON, and a 3B model handed
 * that reaches for a plausible-sounding name it made up
 * (`formatSelectedCellsBackgroundColor`) instead of the `apply_formatting` that
 * is sitting in its own tool list.
 *
 * WHAT IS IN, AND WHY. Orientation, read, write, format, and BOTH script paths.
 * `draft_object_script` is non-negotiable: "create a script" is the product's
 * headline use case, and the naive "just take the first twelve" slice drops it —
 * which produced a model that correctly called `apply_formatting` while the user
 * had asked for a script. What is OUT is everything a small model will not
 * reach for unprompted and can still get by naming explicitly on a later turn:
 * charts-from-spec, pivots, the BI/cube family, and the draft-inspection pair.
 *
 * This is a FALLBACK, never the default. A capable model is handed everything;
 * `ChatView` narrows only after a turn in which every call was invented.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  "get_sheet_summary",
  "read_cell_range",
  "set_cell_value",
  "set_cell_range",
  "apply_formatting",
  "draft_object_script",
  "run_script",
  "list_charts",
  "list_tables",
  "create_named_range",
];

/** `TOOLS` filtered to `CORE_TOOL_NAMES`, preserving the declared order. */
export const CORE_TOOLS: ChatToolDef[] = TOOLS.filter((t) => CORE_TOOL_NAMES.includes(t.name));

/**
 * Tools that run without asking, even when the model has given us a reason to
 * doubt this particular call.
 *
 * TWO TRIGGERS ask for confirmation, and both are about TRUST IN THIS TURN
 * rather than about reach — every call, confirmed or not, goes through the same
 * `ai_chat_run_tool` with the same window guard, script-security tier and audit:
 *
 *   1. The call was SALVAGED from prose. It is the model's intent recovered by a
 *      heuristic rather than delivered by the transport, and a heuristic must
 *      not be the sole authority for a silent edit.
 *   2. The model has already INVENTED A TOOL NAME during this message. Observed
 *      2026-08-24 on qwen2.5:7b: it called `format_selected_cells` (which does
 *      not exist), was told what does, and one turn later called
 *      `apply_formatting` over B2:D6 — a range the user had not selected —
 *      setting a white background, bold, right alignment and a "0.00" number
 *      format that nobody asked for, then reported success. A model that has
 *      just proved it is guessing should not silently reformat fifteen cells on
 *      its next guess.
 *
 * The exempt set is the same for both: reads cannot damage a workbook, and
 * `draft_object_script` neither mounts nor runs anything — its whole output is a
 * review-queue entry a human must then approve in the editor.
 *
 * FAIL-CLOSED: membership is required to auto-run, so a tool added to `TOOLS`
 * later is confirmed by default until someone deliberately adds it here.
 * `__tests__/chatToolSurface.test.ts` pins that every member exists and that no
 * mutating tool is in the set.
 */
export const AUTORUN_TOOLS: ReadonlySet<string> = new Set<string>([
  "get_sheet_summary",
  "read_cell_range",
  "list_charts",
  "list_named_ranges",
  "list_tables",
  "list_pivots",
  "get_chart",
  "list_bi_connections",
  "describe_bi_model",
  "run_bi_query",
  "cube_value",
  "cube_kpi",
  "cube_members",
  "list_script_drafts",
  "get_script_draft",
  "draft_object_script",
]);

/**
 * The system prompt.
 *
 * WHY IT NOW OPENS WITH THE CALLING MECHANISM. A local model was asked to "create
 * a script that formats the background colour of each selected cell" and replied
 * with a fenced ```json block containing `{"name": "format_cells", "arguments":
 * {...}}`. Two separate failures in one reply, and this prompt is the cheapest
 * place to address both:
 *
 *   1. It PRINTED a tool call instead of emitting one. Nothing ran, and the turn
 *      ended looking exactly like a normal conversational answer. Frontier models
 *      rarely need to be told the difference; a 3B-14B local model frequently
 *      does, because "show the JSON" is a very well-represented pattern in its
 *      training data. `textToolCalls.ts` recovers the call when it happens —
 *      but recovery is a net, not a fix, and the prompt is what lowers the rate.
 *   2. It INVENTED `format_cells`, a plausible near-neighbour of the real
 *      `apply_formatting`. A model cannot avoid a name it was never shown as
 *      closed, so the set is named here, built from TOOLS so it cannot drift.
 *
 * The names are interpolated rather than typed out for the same reason
 * `TOOL_NAMES` exists: a prompt that promises a tool the surface no longer offers
 * teaches the model to call something that will come back "Unknown tool".
 *
 * The prompt was NOT enough on its own — measured, see `CORE_TOOL_NAMES`. It
 * lowers the rate; the surface size is what decides it.
 *
 * The system prompt for a given tool surface.
 *
 * TAKES THE NAMES rather than closing over `TOOL_NAMES`, because the surface is
 * not always the full one: `ChatView` narrows to `CORE_TOOLS` after a model has
 * proved it cannot handle two dozen. A prompt that kept naming all 24 while the
 * request carried 10 would be strictly worse than the bug it is fixing — it
 * would be telling the model to call tools that are genuinely not there.
 *
 * The BI paragraph is emitted only when those tools are actually offered, for
 * the same reason.
 */
export function buildSystemPrompt(names: readonly string[] = TOOL_NAMES): string {
  const bi = names.includes("list_bi_connections")
    ? "If the workbook has BI/cube connections (list_bi_connections), you can query them read-only " +
      "with describe_bi_model, run_bi_query, cube_value, cube_kpi, and cube_members.\n\n"
    : "";
  return SYSTEM_PROMPT_HEAD + names.join(", ") + SYSTEM_PROMPT_MIDDLE + bi + SYSTEM_PROMPT_TAIL;
}

const SYSTEM_PROMPT_HEAD =
  "You are an AI assistant embedded in Calcula, a spreadsheet application. You help the user " +
  "read and edit the open workbook using the provided tools.\n\n" +
  "HOW TO ACT — READ THIS FIRST.\n" +
  "To do anything at all you must EMIT A TOOL CALL through the tool-calling interface. " +
  "Writing a tool call as text does nothing: a fenced ```json block containing " +
  '{"name": ..., "arguments": ...} is just prose. No tool runs, the workbook does not change, ' +
  "and the user sees only your message. If you intend to use a tool, emit the call — do not " +
  "describe it, do not print it, and do not ask the user to run it for you.\n\n" +
  "THE TOOLS THAT EXIST — this list is complete and closed:\n";

const SYSTEM_PROMPT_MIDDLE =
  ".\nNever call a name outside that list; an invented name does nothing. If nothing in the " +
  "list can do what the user asked, say so in plain text instead of inventing a tool.\n\n" +
  "ORIENTATION. Prefer get_sheet_summary before reading/writing. Cell coordinates are 0-based " +
  "(row 0 = row 1, col 0 = column A).\n\n";

const SYSTEM_PROMPT_TAIL =
  "THE USER'S SELECTION. No tool reads the selection. When the user has one it is stated at the " +
  "end of this prompt — use those coordinates. If the user says \"the selected cells\" and no " +
  "selection is stated, ask them to select a range rather than guessing one.\n\n" +
  "WRITING AUTOMATION. When the user asks for automation they will keep — something to re-run, or " +
  "to attach to a button, sheet, chart or the workbook — author it with draft_object_script rather " +
  "than run_script. A draft is NOT mounted and does NOT execute: it goes to the user, who reads it " +
  "in the Object Script Editor and decides whether it becomes live code. Say so plainly when you " +
  "draft one, and never imply the automation is already running. A drafted script arrives at the " +
  "RESTRICTED access level; if yours calls context.api.* it will not run until the user raises it " +
  "to Unlocked in the editor, so tell them that when it applies.\n\n" +
  "Keep replies concise. Confirm destructive or large edits before making them.";

/**
 * The full-surface prompt — what a capable model is sent.
 *
 * Declared last so every part it composes is initialised. `ChatView` uses
 * `buildSystemPrompt(CORE_TOOL_NAMES)` instead once it has narrowed.
 */
export const SYSTEM_PROMPT = buildSystemPrompt();

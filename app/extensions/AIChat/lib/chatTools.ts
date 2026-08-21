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
      "DRAFT an object script (a macro attached to a button, chart, sheet, workbook, ...) and hand it to the USER for review. This does NOT save the script into the workbook, does NOT mount it, and does NOT run it — the user reads it in the Object Script Editor and decides whether to mount it. PREFER THIS over run_script whenever the user wants automation that should persist, be re-run, or hang off an object. The script must `export function setup(context)` and react to the object's events through its HOOKS — a button's click handler is `context.onClick(handler)`; `context.expose(name, handler)` is only for named commands and NEVER runs on a click. Declare any privileged capability the script needs with a `// @capability <id>` line comment (bi.query, bi.sql, net.fetch, storage, ui.html, ui.dialog, formula.udf, bi.model, bi.connector, distribution.writeback) — the reviewer is shown the declared set before they mount it.",
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
        property: { type: "integer", enum: [1, 2, 3], description: "1 = value, 2 = goal, 3 = status" },
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

export const SYSTEM_PROMPT =
  "You are an AI assistant embedded in Calcula, a spreadsheet application. You help the user " +
  "read and edit the open workbook using the provided tools. Prefer get_sheet_summary to orient " +
  "yourself before reading/writing. Cell coordinates are 0-based (row 0 = row 1, col 0 = column A). " +
  "If the workbook has BI/cube connections (list_bi_connections), you can query them read-only with " +
  "describe_bi_model, run_bi_query, cube_value, cube_kpi, and cube_members. " +
  "When the user asks for automation they will keep — something to re-run, or to attach to a button, " +
  "sheet, chart or the workbook — author it with draft_object_script rather than run_script. " +
  "A draft is NOT mounted and does NOT execute: it goes to the user, who reads it in the Object " +
  "Script Editor and decides whether it becomes live code. Say so plainly when you draft one, and " +
  "never imply the automation is already running. " +
  "Keep replies concise. Confirm destructive or large edits before making them.";

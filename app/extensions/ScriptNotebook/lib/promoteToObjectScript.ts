//! FILENAME: app/extensions/ScriptNotebook/lib/promoteToObjectScript.ts
// PURPOSE: "Promote to object script" — turn a prototyped notebook cell into an
//          object script that can actually AUTOMATE, without giving the
//          notebook itself any automation reach.
// CONTEXT: The notebook's anti-goals (no event hooks, no UDF registration, no
//          model mutation) are what keep it from competing with the object-script
//          editor — but a prototype you cannot graduate is a dead end. This
//          module is the graduation path, and it is deliberately conservative:
//
//   * The promoted script LANDS UNMOUNTED. `promoteCellToObjectScript` calls
//     saveObjectScript + ObjectScriptManager.registerScript and NEVER
//     mountScript — the user starts it from the Object Scripts pane after
//     reading it. (Same shape as the pane's own "New script" flow.)
//   * The analysis body is placed inside `workbook.expose(...)`, not in
//     `setup()`. Mounting therefore only REGISTERS a callable method; nothing
//     from the notebook runs merely because the workbook was opened.
//   * Capability pragmas are DERIVED from what the snippet actually called
//     (`model.sql` -> bi.sql, the rest of `model.*` -> bi.query) — never a
//     blanket declaration. The user sees the derived set before consenting, the
//     final source is what they review, and the BACKEND re-derives the
//     authoritative ceiling from the pragmas in that source
//     (object_script_commands.rs::save_object_script -> parse_declared_capabilities),
//     so this module can only ever PROPOSE a ceiling, never set one.
//   * Nothing here widens a capability. `model.info(...)` has no bi.query
//     equivalent in the worker realm (the gateway gates model metadata on the
//     stronger `bi.model`), so the shim REFUSES it with a message instead of
//     quietly declaring bi.model.

import {
  ObjectScriptManager,
  saveObjectScript,
  type CapabilityId,
  type ObjectScriptDefinition,
} from "@api";
import { cellKindOf } from "./cellKind";

// ============================================================================
// Usage detection
// ============================================================================

/** One notebook API the snippet used, and what it means after promotion. */
export interface PromotionNote {
  /** The notebook-side call that was detected. */
  api: string;
  /** What the promoted script does about it. */
  note: string;
}

/** What a snippet needs to run as an object script. */
export interface PromotionPlan {
  /** Capability ids to declare, derived from actual use (sorted, deduped). */
  capabilities: CapabilityId[];
  /** Porting notes for the reviewer, in source order of significance. */
  notes: PromotionNote[];
  /** True when the snippet calls the read-only model API at all. */
  usesModel: boolean;
}

/** `name.member(` with arbitrary whitespace — the shape every detection uses. */
function callsMember(source: string, object: string, member: string): boolean {
  const re = new RegExp(`\\b${object}\\s*\\.\\s*${member}\\s*\\(`);
  return re.test(source);
}

/** The bi.query-backed members of the notebook `model` namespace. */
const MODEL_QUERY_MEMBERS = ["query", "connections", "value", "members", "kpi"] as const;

/**
 * Derive the capability declarations + porting notes for a snippet.
 *
 * Precise by design: over-declaring is a security defect, not a convenience —
 * a promoted script must not carry a ceiling the prototype never needed.
 */
export function planPromotion(source: string): PromotionPlan {
  const capabilities = new Set<CapabilityId>();
  const notes: PromotionNote[] = [];

  const usesSql = callsMember(source, "model", "sql");
  const usedQueryMembers = MODEL_QUERY_MEMBERS.filter((m) => callsMember(source, "model", m));
  const usesInfo = callsMember(source, "model", "info");

  if (usesSql) {
    capabilities.add("bi.sql");
    notes.push({
      api: "model.sql(...)",
      note:
        "declared as `bi.sql` — RAW read-only SQL, a strictly larger reach than bi.query. " +
        "Drop it from the promoted script if a model-scoped query would do.",
    });
  }
  for (const m of usedQueryMembers) {
    capabilities.add("bi.query");
    notes.push({
      api: `model.${m}(...)`,
      note: "declared as `bi.query` — read-only, model-scoped.",
    });
  }
  if (usesInfo) {
    notes.push({
      api: "model.info(...)",
      note:
        "NOT ported. Model metadata is gated on the stronger `bi.model` capability for object " +
        "scripts; promoting must not widen a prototype's reach, so the shim throws. Add " +
        "`// @capability bi.model` yourself only if the automation genuinely needs it.",
    });
  }

  if (/\bCalcula\s*\.\s*(setCellValue|setCellFormula|setRangeValues)\s*\(/.test(source)) {
    notes.push({
      api: "Calcula.setCellValue(...) / grid writes",
      note:
        "the object-script equivalent is `context.api?.setCellValue(...)`, available only at the " +
        "UNLOCKED access level. This script is promoted as `restricted`; raise the access level " +
        "in the Object Scripts pane if you mean to let it write to the grid.",
    });
  }
  if (/\bdisplay\s*\.\s*table\s*\(/.test(source)) {
    notes.push({
      api: "display.table(...)",
      note:
        "notebook-only (it renders into a cell's output area). Use `context.log(...)` or write " +
        "the rows to the grid instead.",
    });
  }

  return {
    capabilities: [...capabilities].sort(),
    notes,
    usesModel: usesSql || usedQueryMembers.length > 0 || usesInfo,
  };
}

// ============================================================================
// Source generation
// ============================================================================

/** Turn an arbitrary label into a JS identifier usable as a method name. */
export function methodNameFor(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9]+/g, " ").trim();
  if (cleaned === "") return "runAnalysis";
  const parts = cleaned.split(/\s+/);
  const head = parts[0].toLowerCase();
  const tail = parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
  const name = [head, ...tail].join("");
  return /^[A-Za-z_$]/.test(name) ? name : `run${name[0].toUpperCase()}${name.slice(1)}`;
}

/** Indent every line of a block by `spaces`, leaving blank lines blank. */
function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : pad + line))
    .join("\n");
}

/** The async `model` shim that makes a notebook snippet's calls resolvable in
 *  the worker realm. Only emitted when the snippet actually used `model.*`. */
function modelShim(): string {
  return [
    "// --- notebook `model.*` shim ------------------------------------------",
    "// The notebook's model API is SYNCHRONOUS; in a worker-realm object script",
    "// every privileged call is an RPC through the broker and therefore ASYNC.",
    "// Each function below returns a Promise: add `await` to the calls the cell",
    "// made bare. Wire shapes are identical, so nothing else changes.",
    "const model = {",
    "  connections: () => context.caps.listBiConnections(),",
    "  query: (conn, spec) =>",
    "    context.caps.biQuery(conn, {",
    "      measures: (spec && spec.measures) || [],",
    "      groupBy: (spec && spec.groupBy) || [],",
    "      filters: (spec && spec.filters) || [],",
    "    }),",
    "  sql: (conn, sql) => context.caps.biSql(conn, sql),",
    "  value: (conn, ...members) => context.caps.cube.value(conn, ...members),",
    "  members: (conn, level) => context.caps.cube.members(conn, level),",
    "  kpi: (conn, name, property) => context.caps.cube.kpi(conn, name, property),",
    "  info: () => {",
    "    throw new Error(",
    '      "model.info() is not available under bi.query. Model metadata is gated on the " +',
    '      "stronger bi.model capability for object scripts — declare it deliberately.",',
    "    );",
    "  },",
    "};",
  ].join("\n");
}

export interface PromotedScriptInput {
  /** Human-readable script name (also the source's title comment). */
  scriptName: string;
  /** The exposed method the analysis becomes. */
  methodName: string;
  /** The notebook cell's source, verbatim. */
  cellSource: string;
  /** Where it came from — notebook name + 1-based cell number. */
  notebookName: string;
  cellNumber: number;
  /** The derived plan (capabilities + notes). */
  plan: PromotionPlan;
}

/**
 * Build the promoted object-script source.
 *
 * Shape guarantees the reviewer can rely on:
 *   - `setup()` only REGISTERS; the analysis body sits inside `expose`, so
 *     mounting the script runs none of it.
 *   - every `// @capability` line corresponds to a call the snippet made.
 *   - the original cell is reproduced verbatim, so the diff a reviewer reads is
 *     the wrapper, not a rewrite of their code.
 */
export function buildPromotedScript(input: PromotedScriptInput): string {
  const { scriptName, methodName, cellSource, notebookName, cellNumber, plan } = input;

  const header: string[] = [
    `// ${scriptName}`,
    `// Promoted from notebook "${notebookName}", cell ${cellNumber}.`,
    "//",
    "// This script is INACTIVE until you start it in the Object Scripts pane.",
    "// Review it first: promotion copies your prototype verbatim and wraps it,",
    "// it does not verify that it is safe to automate.",
    "//",
    `// Mounting only registers the method — call it with callExposedMethod("${methodName}")`,
    "// or from another script; nothing here runs on workbook open.",
  ];

  if (plan.capabilities.length > 0) {
    header.push(
      "//",
      "// Declared capabilities (derived from the calls the cell actually made;",
      "// the backend re-derives the authoritative ceiling from these lines):",
    );
  } else {
    header.push(
      "//",
      "// The cell used no privileged API, so this script declares no capabilities.",
    );
  }

  if (plan.notes.length > 0) {
    header.push("//", "// Porting notes:");
    for (const n of plan.notes) {
      header.push(`//   * ${n.api}: ${n.note}`);
    }
  }

  const pragmas = plan.capabilities.map((c) => `// @capability ${c}`);

  const body: string[] = [];
  if (plan.usesModel) {
    body.push(modelShim(), "");
  }
  body.push(
    `workbook.expose("${methodName}", async () => {`,
    indent("// --- promoted notebook cell (verbatim) ---", 2),
    indent(cellSource.replace(/\s+$/, ""), 2),
    indent("// --- end of promoted cell ---", 2),
    "});",
  );

  return [
    ...header,
    ...(pragmas.length > 0 ? ["//", ...pragmas] : []),
    "",
    "function setup(workbook) {",
    indent(body.join("\n"), 2),
    "}",
    "",
  ].join("\n");
}

// ============================================================================
// Promotion
// ============================================================================

export interface PromotionResult {
  scriptId: string;
  scriptName: string;
  methodName: string;
  capabilities: CapabilityId[];
  source: string;
}

/** Injection seam so tests can drive promotion without a Tauri backend. */
export interface PromotionHost {
  save: (script: ObjectScriptDefinition) => Promise<void>;
  register: (script: ObjectScriptDefinition) => void;
}

/** The live host: the @api object-script doors. */
export const livePromotionHost: PromotionHost = {
  save: (script) => saveObjectScript(script),
  register: (script) => ObjectScriptManager.registerScript(script),
};

export interface PromoteRequest {
  scriptName: string;
  methodName: string;
  cellSource: string;
  notebookName: string;
  cellNumber: number;
}

/**
 * Persist a promoted snippet as a LOCAL object script — registered so it shows
 * up in the Object Scripts pane, and deliberately NOT mounted.
 *
 * Callers must have obtained the user's consent first (the notebook UI shows
 * the derived capability set before calling this).
 */
export async function promoteCellToObjectScript(
  request: PromoteRequest,
  host: PromotionHost = livePromotionHost,
): Promise<PromotionResult> {
  if (cellKindOf(request.cellSource) === "markdown") {
    throw new Error("A text cell has nothing to promote — promote a code cell.");
  }
  if (request.cellSource.trim() === "") {
    throw new Error("This cell is empty — there is nothing to promote.");
  }

  const plan = planPromotion(request.cellSource);
  const source = buildPromotedScript({ ...request, plan });

  const script: ObjectScriptDefinition = {
    id: `promoted-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    name: request.scriptName,
    objectType: "workbook",
    instanceId: null,
    source,
    // Never promoted straight to "unlocked": grid writes and structural API
    // reach are an escalation the user must ask for explicitly.
    accessLevel: "restricted",
    description: `Promoted from notebook "${request.notebookName}", cell ${request.cellNumber}.`,
  };

  // Persist FIRST: the backend derives the authoritative declared-capability
  // ceiling here. Registering a script the backend rejected would leave a live
  // entry with no persisted ceiling behind it.
  await host.save(script);
  host.register(script);
  // NOTE: no ObjectScriptManager.mountScript(...) — see the module header.

  return {
    scriptId: script.id,
    scriptName: script.name,
    methodName: request.methodName,
    capabilities: plan.capabilities,
    source,
  };
}

//! FILENAME: app/src/api/scriptSurfaces.ts
// PURPOSE: The single, queryable source of truth for every surface that runs
//          user- or extension-authored code in Calcula (Wave 3 / C3). The
//          governance is unified — ONE capability vocabulary (capabilityIds.ts),
//          one consent/provenance model, one transparency story — while
//          execution is deliberately heterogeneous (each surface has different
//          needs and constraints; see docs/design/script-sandbox-architecture.md
//          §0). This registry lets the transparency UI answer the vision's core
//          question — "where does code reside and what can it touch?" — from one
//          place, and a test keeps it in lockstep with the capability vocabulary.

import { ALL_CAPABILITY_IDS, type CapabilityId } from "./scriptHost/capabilityIds";

export type ScriptRuntime =
  | "worker-realm" // per-script hardened Web Worker, broker-mediated
  | "rust-quickjs" // isolated Rust QuickJS interpreter over cloned state
  | "main-thread" // runs in the page (pure / data only)
  | "rust-native"; // first-party Rust (not a user-scripting surface)

export type ScriptSurfaceId =
  | "object-script"
  | "formula-udf"
  | "notebook-cell"
  | "one-off-script"
  | "chart-transform"
  | "chart-transform-sandbox"
  | "chart-mark"
  | "mcp-tool";

export interface ScriptSurface {
  id: ScriptSurfaceId;
  /** Human label for the transparency UI. */
  label: string;
  runtime: ScriptRuntime;
  /** One-line containment summary. */
  containment: string;
  /** Capabilities this surface can be granted (subset of the one vocabulary). */
  capabilities: CapabilityId[];
  /** How execution is authorized. */
  gate: string;
  /** True when user/extension-authored IMPERATIVE code actually executes here
   *  (false for pure-declarative surfaces like chart transforms). */
  executesUserCode: boolean;
}

export const SCRIPT_SURFACES: readonly ScriptSurface[] = [
  {
    id: "object-script",
    label: "Object scripts",
    runtime: "worker-realm",
    containment:
      "Per-script hardened worker; no DOM/Tauri; every privileged call broker-mediated",
    capabilities: ["net.fetch", "bi.query", "storage", "ui.html", "formula.udf"],
    gate: "Tier broker + R19 ceiling + per-package consent",
    executesUserCode: true,
  },
  {
    id: "formula-udf",
    label: "Formula user-defined functions",
    runtime: "worker-realm",
    containment:
      "Runs in the owning script's worker realm; invoked via formula.udf.invoke, pre-fetched before the synchronous recalc",
    capabilities: ["formula.udf"],
    gate: "Broker (declared + granted)",
    executesUserCode: true,
  },
  {
    id: "notebook-cell",
    label: "Notebook cells",
    runtime: "rust-quickjs",
    containment:
      "Isolated QuickJS over a clone of grid state; grid-only ops, no network / filesystem / Tauri",
    capabilities: [],
    gate: "Coarse session approval (check_script_security)",
    executesUserCode: true,
  },
  {
    id: "one-off-script",
    label: "One-off scripts",
    runtime: "rust-quickjs",
    containment: "Ephemeral QuickJS over cloned state; grid-only, no ambient access",
    capabilities: [],
    gate: "Coarse session approval (check_script_security)",
    executesUserCode: true,
  },
  {
    id: "chart-transform",
    label: "Chart transforms (built-in pipeline)",
    runtime: "main-thread",
    containment:
      "Pure data pipeline; calculate/filter expressions via chartFormula (recursive-descent parser, no eval/new Function)",
    capabilities: [],
    gate: "n/a (pure declarative, not an execution surface)",
    executesUserCode: false,
  },
  {
    id: "chart-transform-sandbox",
    label: "Sandboxed chart transforms",
    runtime: "worker-realm",
    containment:
      "Per-library hardened worker; user-authored data->data transforms, broker-mediated capabilities (e.g. bi.query for cube.*)",
    capabilities: ["net.fetch", "bi.query", "bi.sql", "storage"],
    gate: "Broker + R19 ceiling + per-package consent (distributed)",
    executesUserCode: true,
  },
  {
    id: "chart-mark",
    label: "Sandboxed chart marks",
    runtime: "worker-realm",
    containment:
      "Per-mark hardened worker; paint-only into the chart's clipped plot rect — no network/disk/BI, returns only an ImageBitmap + hit geometry",
    capabilities: [],
    gate: "Broker (paint-only) + per-package consent (distributed)",
    executesUserCode: true,
  },
  {
    id: "mcp-tool",
    label: "MCP tools",
    runtime: "rust-native",
    containment:
      "First-party Rust tool bodies; sensitive commands main-window-guarded",
    capabilities: [],
    gate: "Window-label guard",
    executesUserCode: false,
  },
];

/** Look up a surface by id. */
export function getScriptSurface(id: ScriptSurfaceId): ScriptSurface | undefined {
  return SCRIPT_SURFACES.find((s) => s.id === id);
}

/** Surfaces that actually execute user/extension imperative code. */
export function executableScriptSurfaces(): ScriptSurface[] {
  return SCRIPT_SURFACES.filter((s) => s.executesUserCode);
}

/** True iff every capability referenced by a surface is in the one vocabulary —
 *  guards the taxonomy against drifting from capabilityIds.ts. */
export function scriptSurfacesReferenceOnlyKnownCapabilities(): boolean {
  const known = new Set<string>(ALL_CAPABILITY_IDS);
  return SCRIPT_SURFACES.every((s) => s.capabilities.every((c) => known.has(c)));
}

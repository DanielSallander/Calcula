//! FILENAME: app/src/api/chartTransformScripts.ts
// PURPOSE: User-authored SANDBOXED chart data transforms (Feature 1) — a
//          "transform library". A transform is a TYPE (one definition, used by
//          every chart whose spec.transform[].type === transformType), so it
//          follows the Custom Functions reserved-workbook-script model: the library
//          is persisted as one reserved workbook script whose `source` is JSON;
//          each transform is generated into an exposed (non-public) method on ONE
//          mounted worker (objectType "workbook", reserved instance) that the chart
//          data reader invokes via callExposedMethod, awaiting it IN PIPELINE ORDER.
//          A transform is pure data->data (ParsedChartData in, ParsedChartData out);
//          it may use the library's declared capabilities (e.g. bi.query for cube.*).
//
// Alien Rule: this @api module is BLIND to Charts render types — ParsedChartData /
// TransformSpec are `unknown` here; the Charts reader casts at the boundary.

import { invoke } from "@tauri-apps/api/core";
import { hostMountScript, hostUnmountScript } from "./scriptHost/host";
import { callExposedMethod } from "./scriptableObjects";
import type { CapabilityId } from "./scriptHost/capabilityIds";

/** A user-authored sandboxed chart transform. */
export interface ChartTransformScript {
  /** The spec.transform[].type value charts reference. Reserved "sandbox:" namespace. */
  type: string;
  /** Display name shown in the manager / transform picker. */
  label: string;
  /** JS body. Has `data` (ParsedChartData), `spec` (the transform object), `params`
   *  (plain object of named params), and `cube` (if bi.query granted). Must
   *  `return` a ParsedChartData ({ categories:[], series:[{name,values,color?}] }). */
  body: string;
  description?: string;
}

/** A library of sandboxed transforms sharing one sandbox + capability set. */
export interface ChartTransformLibrary {
  transforms: ChartTransformScript[];
  /** Capabilities the library may use (e.g. "bi.query" for cube.*, "net.fetch"). */
  capabilities?: CapabilityId[];
}

const LIB_SCRIPT_ID = "__calcula_chart_transforms__";
/** Exported so the code inventory (transparency panel) can join live tier/grant
 *  state for the chart-transform surface. */
export const CHART_TRANSFORMS_SCRIPT_ID = LIB_SCRIPT_ID;
// Reuse the workbook object-type with a reserved instance so the library never
// collides with a user's own workbook script (keyed by type + instanceId).
const LIB_OBJECT_TYPE = "workbook";
const LIB_INSTANCE_ID = "__chart_transforms__";

/** Reserved transform-type namespace — keeps authored transforms from ever
 *  colliding with a built-in (filter/sort/…) or an in-process registered type, and
 *  makes the surface auditable. */
export const TRANSFORM_TYPE_PREFIX = "sandbox:";

const PERSIST_SCRIPT_ID = LIB_SCRIPT_ID;

/** Validate a transform type. Returns an error string, or null when valid. The
 *  reserved prefix alone guarantees no collision with a built-in type. */
export function validateTransformType(type: string): string | null {
  const id = type.trim();
  if (!id.startsWith(TRANSFORM_TYPE_PREFIX)) {
    return `Transform type "${type}" must start with "${TRANSFORM_TYPE_PREFIX}".`;
  }
  const suffix = id.slice(TRANSFORM_TYPE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
    return `Transform type "${type}" suffix must be letters, digits, '-' or '_'.`;
  }
  return null;
}

/** Indent each line of a body by four spaces for readable generated source. */
function indent(body: string): string {
  return body.split("\n").map((line) => "    " + line).join("\n");
}

/**
 * Generate the sandboxed transform-library source: a setup() that exposes each
 * transform's body as a NON-public method keyed by its type. `public: false`
 * blocks CROSS-TRUST callers (a different tier or origin — e.g. a distributed
 * package script) from invoking it; it does NOT block a SAME-TRUST peer (another
 * local restricted script in this workbook), which the broker's sameTrust path
 * still allows — so a peer could drive a transform (and thus this library's granted
 * capabilities) indirectly. That is the same boundary as customFunctions/chartMarks
 * and acceptable here: all are user-authored local code, and the reach is the BI
 * model the user already wired into this library. `cube` is bound from the
 * capability shim so a body can `return await cube.value(...)`. Pure + exported for
 * tests; THROWS on an invalid type (so a crafted token can't break out of the
 * generated structure).
 */
export function generateTransformSource(defs: ChartTransformScript[]): string {
  const exposes = defs
    .filter((d) => d.type.trim() && d.body.trim())
    .map((d) => {
      const err = validateTransformType(d.type);
      if (err) throw new Error(err);
      const name = JSON.stringify(d.type.trim());
      return (
        `  context.expose(${name}, async (data, spec, params) => {\n` +
        `${indent(d.body)}\n` +
        `  }, { public: false });`
      );
    })
    .join("\n");
  return (
    `function setup(context) {\n` +
    `  const caps = context.caps || {};\n` +
    `  const cube = caps.cube;\n` +
    `${exposes}\n` +
    `}\n`
  );
}

// ---------------------------------------------------------------------------
// Install / mount lifecycle (mirrors customFunctions.ts)
// ---------------------------------------------------------------------------

let mountedTypes = new Set<string>();
let mounted = false;
let installQueue: Promise<unknown> = Promise.resolve();
let lastGood: { lib: ChartTransformLibrary; source: string } | null = null;

/** True when at least one authored transform is currently mounted. */
export function chartTransformsInstalled(): boolean {
  return mounted && mountedTypes.size > 0;
}

/** True when `type` is a mounted sandbox transform (the reader's routing gate). */
export function isSandboxTransformMounted(type: string): boolean {
  return mountedTypes.has(type);
}

/**
 * Run a mounted sandbox transform: invoke its exposed method in the worker with the
 * (clonable) data/spec/params and return its result. Throws if `type` isn't mounted
 * or the worker body throws — the caller (applyTransformsAsync) catches + degrades.
 * `data`/`spec` are opaque here (Charts owns those types); structured-clone ships
 * them to the worker and clones the result back.
 */
export function runSandboxTransform(type: string, data: unknown, spec: unknown, params?: Record<string, unknown>): Promise<unknown> {
  if (!mountedTypes.has(type)) {
    return Promise.reject(new Error(`Sandbox transform "${type}" is not mounted.`));
  }
  // callExposedMethod is typed `unknown` (it resolves a Promise at runtime via the
  // worker RPC); the await in applyTransformsAsync handles the actual settling.
  return callExposedMethod(LIB_OBJECT_TYPE, LIB_INSTANCE_ID, type, data, spec, params ?? {}) as Promise<unknown>;
}

/** Tear down the mounted worker + routing, WITHOUT touching `lastGood` — safe to
 *  call as the pre-step of a (re)install or rollback (so an install/rollback never
 *  nukes its own rollback target). Mirrors chartMarkScripts.teardownInstalled. */
function teardownInstalled(): void {
  if (mounted) {
    try {
      hostUnmountScript(LIB_SCRIPT_ID);
    } catch {
      /* best-effort */
    }
    mounted = false;
  }
  mountedTypes = new Set();
}

/** Mount `source` and record the exposed transform types (no rollback/queue). */
async function rawInstall(lib: ChartTransformLibrary, source: string): Promise<void> {
  teardownInstalled();
  const defs = lib.transforms.filter((d) => d.type.trim() && d.body.trim());
  if (defs.length === 0 || !source) return;
  await hostMountScript({
    id: LIB_SCRIPT_ID,
    name: "Chart Transforms",
    objectType: LIB_OBJECT_TYPE,
    instanceId: LIB_INSTANCE_ID,
    source,
    accessLevel: "restricted",
    declaredCapabilities: lib.capabilities ?? [],
    apiVersion: "1.0.0",
  });
  mounted = true;
  mountedTypes = new Set(defs.map((d) => d.type.trim()));
}

async function doInstall(lib: ChartTransformLibrary): Promise<void> {
  const defs = lib.transforms.filter((d) => d.type.trim() && d.body.trim());
  // Validate + generate FIRST (a bad type throws here, BEFORE any teardown), so an
  // invalid edit never tears down a working library.
  for (const d of defs) {
    const err = validateTransformType(d.type);
    if (err) throw new Error(err);
  }
  const source = defs.length ? generateTransformSource(defs) : "";
  const prev = lastGood;
  try {
    await rawInstall(lib, source);
    lastGood = { lib, source };
  } catch (e) {
    if (prev) {
      try {
        await rawInstall(prev.lib, prev.source);
      } catch {
        uninstallChartTransforms();
      }
    } else {
      uninstallChartTransforms();
    }
    throw e;
  }
}

/**
 * Mount the library's transforms in the sandbox. Replaces any previously-installed
 * library. Serialized; on failure the previous working library is restored.
 */
export function installChartTransformLibrary(lib: ChartTransformLibrary): Promise<void> {
  const run = () => doInstall(lib);
  const next = installQueue.then(run, run);
  installQueue = next.catch(() => undefined);
  return next;
}

/** Public uninstall: tear down the mounted library AND drop the rollback target
 *  (deactivate / no-library-on-open). NOT called mid-install — rawInstall uses
 *  teardownInstalled() so an install/rollback never nukes its own `lastGood`
 *  (which is what makes TWO consecutive failed edits still roll back to good). */
export function uninstallChartTransforms(): void {
  teardownInstalled();
  lastGood = null;
}

// ---------------------------------------------------------------------------
// Persistence (reserved workbook script; source is JSON, never executed as code)
// ---------------------------------------------------------------------------

/** Load the persisted chart-transform library from the workbook, or null. */
export async function loadPersistedTransformLibrary(): Promise<ChartTransformLibrary | null> {
  try {
    const data = await invoke<{ source: string }>("get_script", { id: PERSIST_SCRIPT_ID });
    if (!data?.source) return null;
    const parsed = JSON.parse(data.source) as ChartTransformLibrary;
    if (!parsed || !Array.isArray(parsed.transforms)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the library into the workbook (saved with the .cala). */
export async function savePersistedTransformLibrary(lib: ChartTransformLibrary): Promise<void> {
  await invoke("save_script", {
    script: {
      id: PERSIST_SCRIPT_ID,
      name: "Chart Transforms (data)",
      description: "Definitions for user-authored sandboxed chart transforms.",
      source: JSON.stringify(lib),
      scope: { type: "workbook" },
      sourcePackage: null,
    },
  });
}

/** Load the persisted library (if any) and install it. Call on startup + open.
 *  Best-effort: a corrupt/failing library must not throw into the open path. */
export async function loadAndInstallChartTransforms(): Promise<void> {
  try {
    const lib = await loadPersistedTransformLibrary();
    if (lib && lib.transforms.length > 0) {
      await installChartTransformLibrary(lib);
    } else {
      uninstallChartTransforms();
    }
  } catch (e) {
    console.error("[chartTransformScripts] failed to install persisted chart transforms", e);
  }
}

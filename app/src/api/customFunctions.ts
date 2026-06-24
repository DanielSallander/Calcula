//! FILENAME: app/src/api/customFunctions.ts
// PURPOSE: User-authored formula functions (JS UDFs) executed in a SANDBOXED
//          worker. A user writes function bodies (which may call cube.* / fetch);
//          we generate one "function library" script, mount it in the script
//          sandbox (broker-mediated capabilities + audit), and register each
//          function as a formula UDF whose implementation runs the body in the
//          worker via callExposedMethod. The synchronous evaluator serves the
//          pre-fetched result (same path as any UDF).
//
// Sandboxing: the body runs in the hardened Worker realm (no DOM/Tauri/network
// except declared capabilities), NOT on the main thread. Privileged reach is
// limited to the library's declaredCapabilities (e.g. "bi.query" for cube.*).

import { invoke } from "@tauri-apps/api/core";
import { registerFunction } from "./formulaFunctions";
import { hostMountScript, hostUnmountScript } from "./scriptHost/host";
import { callExposedMethod } from "./scriptableObjects";
import type { CapabilityId } from "./scriptHost/capabilityIds";

/** A user-authored custom formula function. */
export interface CustomFunctionUdf {
  /** Function name (uppercased for formula matching). */
  name: string;
  /** Parameter names (positional). */
  params: string[];
  /** JS body. Has `cube` (caps.cube), the params, and may `return` a value. */
  body: string;
  /** Help text shown in autocomplete. */
  description?: string;
}

/** A library of custom functions sharing one sandbox + capability set. */
export interface CustomFunctionLibrary {
  functions: CustomFunctionUdf[];
  /** Capabilities the library may use (e.g. "bi.query" for cube.*, "net.fetch"). */
  capabilities?: CapabilityId[];
}

const LIB_SCRIPT_ID = "__calcula_custom_functions__";
/** The broker scriptId the custom-function library mounts under — exported so the
 *  code inventory (transparency panel) can join live tier/grant state for the
 *  formula-udf surface. */
export const CUSTOM_FUNCTIONS_SCRIPT_ID = LIB_SCRIPT_ID;
// Reuse the workbook object-type with a reserved instance so the library never
// collides with a user's own workbook script (keyed by type + instanceId).
const LIB_OBJECT_TYPE = "workbook";
const LIB_INSTANCE_ID = "__custom_functions__";

const normalizeName = (n: string): string => n.trim().toUpperCase();

/** A valid JS identifier (function name / parameter). */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Names bound in the generated set() scope that a parameter must not shadow. */
const RESERVED_PARAMS = new Set(["cube", "caps", "context", "setup"]);

export function validateFunctionName(name: string): string | null {
  const up = normalizeName(name);
  if (!IDENT_RE.test(up)) {
    return `Invalid function name "${name}". Use letters, digits, and underscores (no dots/spaces).`;
  }
  return null;
}

export function validateParam(param: string, fnName: string): string | null {
  if (!IDENT_RE.test(param)) {
    return `Invalid parameter "${param}" in ${fnName}. Use a JS identifier.`;
  }
  if (RESERVED_PARAMS.has(param)) {
    return `Parameter "${param}" in ${fnName} is reserved (it would shadow the sandbox helpers).`;
  }
  return null;
}

/** Indent each line of a body by two spaces for readable generated source. */
function indent(body: string): string {
  return body
    .split("\n")
    .map((line) => "    " + line)
    .join("\n");
}

/**
 * Generate the sandboxed "function library" script source from the definitions.
 * Each function is exposed NON-public so only TRUSTED host code (the UDF
 * pre-fetch via callExposedMethod) can invoke it — a peer sandboxed script
 * cannot reach it via context.callMethod and borrow the library's capabilities.
 * `cube` is bound from the capability shim so a body can `return await
 * cube.value(...)`. Pure + exported for tests; THROWS on an invalid name/param
 * (so a crafted token cannot break out of the generated structure).
 */
export function generateLibrarySource(defs: CustomFunctionUdf[]): string {
  const exposes = defs
    .filter((d) => d.name.trim())
    .map((d) => {
      const nameErr = validateFunctionName(d.name);
      if (nameErr) throw new Error(nameErr);
      const params = d.params.map((p) => p.trim()).filter(Boolean);
      for (const p of params) {
        const perr = validateParam(p, d.name);
        if (perr) throw new Error(perr);
      }
      const name = JSON.stringify(normalizeName(d.name));
      return (
        `  context.expose(${name}, async (${params.join(", ")}) => {\n` +
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

let registeredCleanups: Array<() => void> = [];
let mounted = false;
// Serialize install/uninstall so a startup install + AFTER_OPEN reload can't
// interleave and corrupt the module-level mount/cleanup state.
let installQueue: Promise<unknown> = Promise.resolve();
// The last library that mounted+registered cleanly, for rollback on a failed edit.
let lastGood: { lib: CustomFunctionLibrary; source: string } | null = null;

/** Currently-installed status (for the manager UI). */
export function customFunctionsInstalled(): boolean {
  return mounted;
}

/** Mount `source` and register `defs` as UDFs (no rollback/queue). */
async function rawInstall(lib: CustomFunctionLibrary, source: string): Promise<void> {
  uninstallCustomFunctions();
  const defs = lib.functions.filter((d) => d.name.trim() && d.body.trim());
  if (defs.length === 0 || !source) return;
  await hostMountScript({
    id: LIB_SCRIPT_ID,
    name: "Custom Functions",
    objectType: LIB_OBJECT_TYPE,
    instanceId: LIB_INSTANCE_ID,
    source,
    accessLevel: "restricted",
    declaredCapabilities: lib.capabilities ?? [],
    apiVersion: "1.0.0",
  });
  mounted = true;
  for (const d of defs) {
    const upper = normalizeName(d.name);
    const arity = d.params.map((p) => p.trim()).filter(Boolean).length;
    const cleanup = registerFunction({
      name: upper,
      description: d.description?.trim() || "User-defined function",
      syntax: `${upper}(${d.params.map((p) => p.trim()).filter(Boolean).join(", ")})`,
      category: "Custom",
      minArgs: arity,
      maxArgs: arity,
      implementation: (...args: unknown[]) =>
        callExposedMethod(LIB_OBJECT_TYPE, LIB_INSTANCE_ID, upper, ...args),
    });
    registeredCleanups.push(cleanup);
  }
}

async function doInstall(lib: CustomFunctionLibrary): Promise<void> {
  const defs = lib.functions.filter((d) => d.name.trim() && d.body.trim());
  // Generate (and VALIDATE) first — a bad name/param throws here, BEFORE any
  // teardown, so an invalid edit never tears down a working library.
  const source = defs.length ? generateLibrarySource(defs) : "";
  const prev = lastGood;
  try {
    await rawInstall(lib, source);
    lastGood = { lib, source };
  } catch (e) {
    // Mount/compile failed — restore the previous good library rather than
    // leaving the user with NO functions.
    if (prev) {
      try {
        await rawInstall(prev.lib, prev.source);
      } catch {
        uninstallCustomFunctions();
      }
    } else {
      uninstallCustomFunctions();
    }
    throw e;
  }
}

/**
 * Mount the library in the sandbox and register each function as a formula UDF.
 * Replaces any previously-installed library. A formula `=NAME(args)` resolves by
 * running the body in the worker (off the synchronous recalc, via the UDF
 * pre-fetch path) — the result is served to the evaluator. Serialized: concurrent
 * calls run in order; on failure the previous working library is restored.
 */
export function installCustomFunctions(lib: CustomFunctionLibrary): Promise<void> {
  const run = () => doInstall(lib);
  const next = installQueue.then(run, run);
  // Keep the queue alive even if this install rejects (don't poison the chain).
  installQueue = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Persistence (reuses the workbook module-script store; no new backend section).
// The library lives in a RESERVED workbook script whose `source` is the JSON
// definition (it is never executed as code — we parse + install it ourselves).
// ---------------------------------------------------------------------------

const PERSIST_SCRIPT_ID = "__calcula_custom_functions__";

/** Load the persisted custom-function library from the workbook, or null. */
export async function loadPersistedLibrary(): Promise<CustomFunctionLibrary | null> {
  try {
    const data = await invoke<{ source: string }>("get_script", { id: PERSIST_SCRIPT_ID });
    if (!data?.source) return null;
    const parsed = JSON.parse(data.source) as CustomFunctionLibrary;
    if (!parsed || !Array.isArray(parsed.functions)) return null;
    return parsed;
  } catch {
    return null; // not found / not present
  }
}

/** Persist the library into the workbook (saved with the .cala). */
export async function savePersistedLibrary(lib: CustomFunctionLibrary): Promise<void> {
  await invoke("save_script", {
    script: {
      id: PERSIST_SCRIPT_ID,
      name: "Custom Functions (data)",
      description: "Definitions for user-authored formula functions.",
      source: JSON.stringify(lib),
      scope: { type: "workbook" },
      sourcePackage: null,
    },
  });
}

/** Load the persisted library (if any) and install it. Call on startup + open.
 *  Best-effort: a corrupt/failing library must not throw into the open path. */
export async function loadAndInstallCustomFunctions(): Promise<void> {
  try {
    const lib = await loadPersistedLibrary();
    if (lib && lib.functions.length > 0) {
      await installCustomFunctions(lib);
    } else {
      uninstallCustomFunctions();
    }
  } catch (e) {
    console.error("[customFunctions] failed to install persisted functions", e);
  }
}

/** Unregister all custom-function UDFs and tear down the sandbox. */
export function uninstallCustomFunctions(): void {
  for (const fn of registeredCleanups) {
    try {
      fn();
    } catch {
      /* best-effort */
    }
  }
  registeredCleanups = [];
  if (mounted) {
    try {
      hostUnmountScript(LIB_SCRIPT_ID);
    } catch {
      /* best-effort */
    }
    mounted = false;
  }
}

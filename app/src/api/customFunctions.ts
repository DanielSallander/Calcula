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
import { registerFunction, UDF_ERROR_KEY } from "./formulaFunctions";
import { hostMountScript, hostUnmountScript } from "./scriptHost/host";
import { callExposedMethod } from "./scriptableObjects";
import type { CapabilityId } from "./scriptHost/capabilityIds";
import { linkScript, type LibraryUseDeclaration } from "./scriptLibraries";

/** A user-authored custom formula function. */
export interface CustomFunctionUdf {
  /** Function name (uppercased for formula matching). */
  name: string;
  /** Parameter names (positional). */
  params: string[];
  /** JS body. Has `cube` (caps.cube), `cellError`, the params, and may
   *  `return` a value (a scalar, an array to spill, or `cellError("#N/A")`). */
  body: string;
  /** Help text shown in autocomplete. */
  description?: string;
  /** Recalculate on every edit (Excel's Application.Volatile). Default false:
   *  the cell recalculates only when one of its arguments changes. */
  volatile?: boolean;
}

/** A library of custom functions sharing one sandbox + capability set. */
export interface CustomFunctionLibrary {
  functions: CustomFunctionUdf[];
  /** Capabilities the library may use (e.g. "bi.query" for cube.*, "net.fetch"). */
  capabilities?: CapabilityId[];
  /**
   * Shared script libraries this UDF library imports. Emitted as `// @uses`
   * pragmas into the generated source, so the ONE linker (@api/scriptLibraries)
   * resolves them exactly as it does for an object script — including the
   * ceiling intersection: an imported library runs at
   * `declared(library) INTERSECT capabilities` above, never wider.
   */
  uses?: LibraryUseDeclaration[];
}

const LIB_SCRIPT_ID = "__calcula_custom_functions__";
/** The broker scriptId the custom-function library mounts under — exported so the
 *  code inventory (transparency panel) can join live tier/grant state for the
 *  formula-udf surface. */
export const CUSTOM_FUNCTIONS_SCRIPT_ID = LIB_SCRIPT_ID;
// Reuse the workbook object-type with a reserved instance so the library never
// collides with a user's own workbook script (keyed by type + instanceId).
const LIB_OBJECT_TYPE = "workbook";
/**
 * The instance the library exposes its UDFs under — RANDOM per install, not the
 * old fixed "__custom_functions__".
 *
 * SECURITY (pre-existing hole, closed here): the UDFs are exposed
 * `{ public: false }`, which the broker's `callExposed` enforces only for
 * CROSS-tier/CROSS-origin callers. This library mounts as a LOCAL, RESTRICTED
 * script, and so does every user object script — same tier, same origin — so
 * the `sameTrust` branch let any local object script invoke any custom function
 * with `context.callMethod("workbook", "__custom_functions__", "MYFN", …)` while
 * the fixed instance id was guessable. A UDF body may hold `bi.query` (or any
 * capability the user granted this library), so that was a confused deputy: a
 * script that declared nothing could drive the library's reach.
 * Randomizing the instance means the address is an unguessable reference held
 * only by trusted host code (`callExposedMethod` below and the UDF pre-fetch),
 * never handed to any script. The proper fix — an identity check on the CALLER
 * rather than on knowledge of the address — belongs in the broker; see
 * docs/design/script-package-manager.md §5.3.
 */
let libInstanceId = randomInstanceId();

function randomInstanceId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return (
    "__custom_functions_" +
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

const normalizeName = (n: string): string => n.trim().toUpperCase();

/** A valid JS identifier (function name / parameter). */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Names bound in the generated set() scope that a parameter must not shadow. */
const RESERVED_PARAMS = new Set([
  "cube",
  "caps",
  "context",
  "setup",
  "cellError",
  // Sibling-call table (below) and the library-import binding the linker's
  // generated prelude introduces.
  "fns",
  "imports",
]);

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
 * Emit the `// @uses` pragma block for a library's declared imports. Emitted as
 * real pragmas (rather than passed to the linker out-of-band) so the SAME
 * parser reads the same text for a UDF library as for a hand-written object
 * script — one dialect, no second code path that could disagree about what a
 * script declares.
 */
function usesPragmaBlock(uses: LibraryUseDeclaration[]): string {
  return uses
    .map(
      (u) =>
        `// @uses${u.isolated ? "-isolated" : ""} ${u.alias} ${u.package}@${u.pin}`,
    )
    .join("\n");
}

/**
 * Generate the sandboxed "function library" script source from the definitions.
 * Each function is exposed NON-public so only TRUSTED host code (the UDF
 * pre-fetch via callExposedMethod) can invoke it — a peer sandboxed script
 * cannot reach it via context.callMethod and borrow the library's capabilities.
 * `cube` is bound from the capability shim so a body can `return await
 * cube.value(...)`; `cellError` is bound so a body can return a SPECIFIC
 * spreadsheet error (the sentinel object survives structured clone across the
 * worker boundary, which a thrown object would not).
 *
 * SIBLING CALLS. Every function is also bound into a `fns` table, so a body can
 * call another custom function directly: `return await fns.OTHER(x)`. Before
 * this, each `context.expose` closure was anonymous inside `setup` and nothing
 * bound a sibling to a name, so the only way to reach one was the undocumented
 * `context.callMethod("workbook", <instance>, "OTHER", …)` peer path — untyped,
 * invisible to IntelliSense, and (with a fixed instance id) reachable by any
 * local script. Sanctioning `fns` and randomizing the instance id closes that
 * ambiguity in both directions.
 *
 * `uses` becomes a `// @uses` pragma block; the linker resolves it against the
 * workbook lockfile at mount and prepends the `imports` prelude.
 *
 * Pure + exported for tests; THROWS on an invalid name/param (so a crafted
 * token cannot break out of the generated structure).
 */
export function generateLibrarySource(
  defs: CustomFunctionUdf[],
  uses: LibraryUseDeclaration[] = [],
): string {
  const bodies = defs
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
        `  fns[${name}] = async (${params.join(", ")}) => {\n` +
        `${indent(d.body)}\n` +
        `  };\n` +
        `  context.expose(${name}, fns[${name}], { public: false });`
      );
    })
    .join("\n");
  const pragmas = usesPragmaBlock(uses);
  return (
    (pragmas ? pragmas + "\n" : "") +
    `function setup(context) {\n` +
    `  const caps = context.caps || {};\n` +
    `  const cube = caps.cube;\n` +
    `  // return cellError("#N/A") to put a specific error in the cell.\n` +
    `  const cellError = (code) => ({ ${UDF_ERROR_KEY}: String(code) });\n` +
    `  // Sibling calls: a body may call another custom function as await fns.NAME(...).\n` +
    `  const fns = {};\n` +
    `${bodies}\n` +
    `}\n`
  );
}

let registeredCleanups: Array<() => void> = [];
let mounted = false;
/** Drops this install's library-import tokens (and unmounts realms that lose
 *  their last consumer). Null when nothing is linked. */
let releaseLink: (() => void) | null = null;
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

  // Link declared library imports BEFORE mounting. Each imported library gets a
  // realm at `declared(library) INTERSECT (lib.capabilities ?? [])` — so a
  // library this UDF set imports can never reach further than the UDF set
  // itself was consented for. An unresolved alias throws here and the install
  // fails (the caller restores the previous good library), which is the point:
  // a UDF must not start with a dangling import.
  const link = await linkScript({
    scriptId: LIB_SCRIPT_ID,
    scriptName: "Custom Functions",
    source,
    declaredCapabilities: lib.capabilities ?? [],
    accessLevel: "restricted",
  });
  releaseLink = link.release;

  // A fresh unguessable instance per install (see libInstanceId's SECURITY note).
  libInstanceId = randomInstanceId();
  const instanceId = libInstanceId;
  try {
    await hostMountScript({
      id: LIB_SCRIPT_ID,
      name: "Custom Functions",
      objectType: LIB_OBJECT_TYPE,
      instanceId,
      source: link.prelude + source,
      accessLevel: "restricted",
      declaredCapabilities: lib.capabilities ?? [],
      apiVersion: "1.0.0",
    });
  } catch (e) {
    link.release();
    releaseLink = null;
    throw e;
  }
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
      volatile: d.volatile === true,
      // Bound to THIS install's instance so a later re-install cannot leave a
      // registered UDF pointing at a torn-down realm's address.
      implementation: (...args: unknown[]) =>
        callExposedMethod(LIB_OBJECT_TYPE, instanceId, upper, ...args),
    });
    registeredCleanups.push(cleanup);
  }
}

async function doInstall(lib: CustomFunctionLibrary): Promise<void> {
  const defs = lib.functions.filter((d) => d.name.trim() && d.body.trim());
  // Generate (and VALIDATE) first — a bad name/param throws here, BEFORE any
  // teardown, so an invalid edit never tears down a working library.
  const source = defs.length ? generateLibrarySource(defs, lib.uses ?? []) : "";
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
  if (releaseLink) {
    try {
      releaseLink();
    } catch {
      /* best-effort */
    }
    releaseLink = null;
  }
  if (mounted) {
    try {
      hostUnmountScript(LIB_SCRIPT_ID);
    } catch {
      /* best-effort */
    }
    mounted = false;
  }
}

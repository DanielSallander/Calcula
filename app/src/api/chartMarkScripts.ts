//! FILENAME: app/src/api/chartMarkScripts.ts
// PURPOSE: User-authored SANDBOXED chart marks (B8.D.2) — a "chart-mark library".
//          A mark is a TYPE (one definition, used by every chart whose
//          spec.mark === markId), so it follows the Custom Functions reserved-
//          workbook-script model (NOT the per-instance object-script model): the
//          library is persisted as one reserved workbook script whose `source` is
//          JSON; each mark is generated into a tiny setup() that registers a
//          markRenderer and mounted as its OWN sandboxed worker (objectType
//          "chartMark"); after mount we register a host-side blit shim so charts
//          can use it. Paint-only -> NO capability; the worker never touches the
//          real canvas/DOM (the host clips+blits its ImageBitmap to the plot rect).
//
// Alien Rule: registerSandboxMark/buildSandboxMarkDefinition live INSIDE the
// Charts extension (they need Charts-internal render types), so the lifecycle here
// takes the registrar as a CALLBACK rather than importing the Charts extension.

import { invoke } from "@tauri-apps/api/core";
import { hostMountScript, hostUnmountScript } from "./scriptHost/host";
import { clearBitmapCaches } from "./scriptHost/renderCache";
import { unregisterChartMark, getChartMarkMeta } from "./chartMarks";

export type MarkLayoutFamily = "cartesian" | "radial" | "other";

/** A user-authored sandboxed chart mark. */
export interface ChartMarkScript {
  /** The spec.mark value charts reference. Reserved "sandbox:" namespace. */
  markId: string;
  /** Display name shown in the chart-type picker. */
  label: string;
  /** Axis family (drives axis classification). */
  layoutFamily: MarkLayoutFamily;
  /** JS body. Has `ctx` (OffscreenCanvas 2D), `paint` ({spec,data,layout,theme}),
   *  and `b` ({x:0,y:0,width,height} local plot bounds). May `return { rects:[...] }`
   *  (local-coord hit geometry) for per-datum tooltips/selection. */
  body: string;
  description?: string;
  /** Optional explicit Y domain `[min,max]` so the host-drawn Y axis aligns with
   *  the values the mark maps into the plot (cartesian only). */
  yDomain?: [number, number];
}

/** A library of sandboxed marks, persisted with the workbook. */
export interface ChartMarkLibrary {
  marks: ChartMarkScript[];
}

/** Called after a mark's worker mounts: register its blit shim into the chart-mark
 *  registry. Supplied by the Charts extension (registerSandboxMark) so this module
 *  never imports the extension. */
export type SandboxMarkRegistrar = (
  scriptId: string,
  markId: string,
  meta: { label: string; layoutFamily: MarkLayoutFamily; yDomain?: [number, number] },
) => void;

const PERSIST_SCRIPT_ID = "__calcula_chart_marks__";
/** The reserved mark-library script id — exported as the stable CONSENT-VIEW id for
 *  the distributed-consent gate (the whole library is one consent unit). */
export const CHART_MARKS_SCRIPT_ID = PERSIST_SCRIPT_ID;
/** Reserved markId namespace — keeps authored marks from ever colliding with a
 *  built-in id and makes the surface auditable. */
export const MARK_ID_PREFIX = "sandbox:";

/** The broker scriptId (== instanceId, the invariant the shim + findWorkerForInstance
 *  require) a given mark mounts under. */
export function markScriptId(markId: string): string {
  return `__chartmark__:${markId}`;
}

/** Validate a markId. Returns an error string, or null when valid. */
export function validateMarkId(markId: string): string | null {
  const id = markId.trim();
  if (!id.startsWith(MARK_ID_PREFIX)) {
    return `Mark id "${markId}" must start with "${MARK_ID_PREFIX}".`;
  }
  const suffix = id.slice(MARK_ID_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
    return `Mark id "${markId}" suffix must be letters, digits, '-' or '_'.`;
  }
  if (getChartMarkMeta(id)?.builtin) {
    return `Mark id "${markId}" collides with a built-in chart type.`;
  }
  return null;
}

/** Indent each line of a body by four spaces for readable generated source. */
function indent(body: string): string {
  return body.split("\n").map((line) => "    " + line).join("\n");
}

/**
 * Generate the sandboxed mark script: a setup() that registers a markRenderer.
 * The body runs in the Worker realm with NO capability (paint-only) and is clipped
 * to the plot rect host-side, so even a hostile body is contained. Pure + exported
 * for tests. A malformed body fails to compile at mount -> doInstall rolls back.
 */
export function generateMarkSource(body: string): string {
  return (
    `function setup(context) {\n` +
    `  context.render.markRenderer((ctx, paint, b) => {\n` +
    `${indent(body)}\n` +
    `  });\n` +
    `}\n`
  );
}

// ---------------------------------------------------------------------------
// Install / mount / register lifecycle (mirrors customFunctions.ts)
// ---------------------------------------------------------------------------

let installed: Array<{ markId: string; scriptId: string }> = [];
let installQueue: Promise<unknown> = Promise.resolve();
let lastGood: { lib: ChartMarkLibrary; sourcePackage: string | null } | null = null;

/** True when at least one authored mark is currently mounted+registered. */
export function chartMarksInstalled(): boolean {
  return installed.length > 0;
}

/** Tear down the currently-mounted marks (unregister shims + unmount workers +
 *  clear bitmaps), WITHOUT touching `lastGood` — so it is safe to call as the
 *  pre-step of a (re)install or rollback. chartMark bitmaps are composite-keyed
 *  (markId:sig:WxH), NOT by scriptId, so hostUnmountScript's instanceId-based
 *  invalidation does NOT reach them — clearBitmapCaches() must. */
function teardownInstalled(): void {
  for (const { markId, scriptId } of installed) {
    try { unregisterChartMark(markId); } catch { /* best-effort */ }
    try { hostUnmountScript(scriptId); } catch { /* best-effort */ }
  }
  if (installed.length > 0) {
    try { clearBitmapCaches(); } catch { /* best-effort */ }
  }
  installed = [];
}

/** Mount each mark's worker and register its shim (no rollback/queue). When
 *  `sourcePackage` is set, each mark worker is mounted as DISTRIBUTED provenance so
 *  the broker does not auto-grant ui.html (marks are paint-only either way, but this
 *  keeps the consent model honest — a distributed mark holds no un-consented cap). */
async function rawInstall(lib: ChartMarkLibrary, registrar: SandboxMarkRegistrar, sourcePackage?: string | null): Promise<void> {
  teardownInstalled();
  const marks = lib.marks.filter((m) => m.markId.trim() && m.body.trim());
  for (const m of marks) {
    const err = validateMarkId(m.markId);
    if (err) throw new Error(err);
    const markId = m.markId.trim();
    const scriptId = markScriptId(markId);
    const source = generateMarkSource(m.body);
    await hostMountScript({
      id: scriptId,
      name: m.label?.trim() || markId,
      objectType: "chartMark",
      instanceId: scriptId,
      source,
      accessLevel: "restricted",
      provenance: sourcePackage ? "distributed" : undefined,
      packageName: sourcePackage ?? undefined,
      declaredCapabilities: [],
      apiVersion: "1.0.0",
    });
    // hostMountScript resolves AFTER the worker ran setup() (which called
    // render.markRenderer -> hookRegistered), so the markRenderer hook is declared
    // and findWorkerForInstance("chartMark", scriptId) will match.
    registrar(scriptId, markId, { label: m.label?.trim() || markId, layoutFamily: m.layoutFamily, yDomain: m.yDomain });
    installed.push({ markId, scriptId });
  }
}

async function doInstall(lib: ChartMarkLibrary, registrar: SandboxMarkRegistrar, sourcePackage?: string | null): Promise<void> {
  // Validate every markId BEFORE any teardown so a bad edit can't strip a working
  // library. (Body compile errors surface at mount and trigger rollback below.)
  for (const m of lib.marks) {
    if (!m.markId.trim()) continue;
    const err = validateMarkId(m.markId);
    if (err) throw new Error(err);
  }
  const prev = lastGood;
  try {
    await rawInstall(lib, registrar, sourcePackage);
    lastGood = { lib, sourcePackage: sourcePackage ?? null };
  } catch (e) {
    if (prev) {
      try {
        await rawInstall(prev.lib, registrar, prev.sourcePackage);
      } catch {
        await queuedTeardown();
      }
    } else {
      await queuedTeardown();
    }
    throw e;
  }
}

/**
 * Mount the library's marks in the sandbox and register each as a chart mark.
 * Replaces any previously-installed library. Serialized; on failure the previous
 * working library is restored (the user keeps a usable set of marks). Pass
 * `opts.sourcePackage` for a DISTRIBUTED library (mounts as distributed provenance).
 */
export function installChartMarkLibrary(lib: ChartMarkLibrary, registrar: SandboxMarkRegistrar, opts?: { sourcePackage?: string | null }): Promise<void> {
  const run = () => doInstall(lib, registrar, opts?.sourcePackage);
  const next = installQueue.then(run, run);
  installQueue = next.catch(() => undefined);
  return next;
}

/** The teardown body — tear down every authored mark AND drop the rollback target. */
function teardownAll(): void {
  teardownInstalled();
  lastGood = null;
}

/** Public uninstall: tear down every authored mark AND drop the rollback target
 *  (deactivate / no-library-on-open). SYNC — used where no install can be in flight. */
export function uninstallChartMarks(): void {
  teardownAll();
}

/** Queued uninstall: tears down AFTER any in-flight install settles, so a gate that
 *  must keep a not-yet-consented distributed library UNMOUNTED can't race a suspended
 *  install (which would resume past the teardown and re-mount). Use from the gate. */
export function uninstallChartMarksQueued(): Promise<void> {
  return queuedTeardown();
}

function queuedTeardown(): Promise<void> {
  const run = () => { teardownAll(); };
  const next = installQueue.then(run, run);
  installQueue = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Persistence (reserved workbook script; source is JSON, never executed as code)
// ---------------------------------------------------------------------------

/** The persisted mark library plus its PROVENANCE. `sourcePackage` non-null ⇒ the
 *  library came from a distributed .calp (gate behind consent); null ⇒ local. */
export interface PersistedMarkLibrary {
  lib: ChartMarkLibrary;
  sourcePackage: string | null;
}

/** Load the persisted mark library WITH its provenance, or null. `sourcePackage`
 *  is stamped ONLY by the .calp pull (savePersistedMarkLibrary writes null), so a
 *  non-null value authoritatively means "distributed". */
export async function loadPersistedMarkLibraryWithProvenance(): Promise<PersistedMarkLibrary | null> {
  try {
    const data = await invoke<{ source: string; sourcePackage?: string | null }>("get_script", { id: PERSIST_SCRIPT_ID });
    if (!data?.source) return null;
    const parsed = JSON.parse(data.source) as ChartMarkLibrary;
    if (!parsed || !Array.isArray(parsed.marks)) return null;
    return { lib: parsed, sourcePackage: data.sourcePackage ?? null };
  } catch {
    return null;
  }
}

/** Load the persisted chart-mark library from the workbook, or null
 *  (provenance-agnostic — used by the authoring dialog). */
export async function loadPersistedMarkLibrary(): Promise<ChartMarkLibrary | null> {
  return (await loadPersistedMarkLibraryWithProvenance())?.lib ?? null;
}

/**
 * The canonical "consent source" for a distributed mark library: the library JSON.
 * Marks are PAINT-ONLY (capability-free), so no `// @capability` pragmas — but a
 * marks-logic edit still changes this string, so the shared distributed-consent
 * store re-prompts on any change (source-hash). Pure + exported for the gate + tests.
 */
export function markLibraryConsentSource(lib: ChartMarkLibrary): string {
  return JSON.stringify(lib);
}

/** Persist the library into the workbook (saved with the .cala). */
export async function savePersistedMarkLibrary(lib: ChartMarkLibrary): Promise<void> {
  await invoke("save_script", {
    script: {
      id: PERSIST_SCRIPT_ID,
      name: "Chart Marks (data)",
      description: "Definitions for user-authored sandboxed chart marks.",
      source: JSON.stringify(lib),
      scope: { type: "workbook" },
      sourcePackage: null,
    },
  });
}

// NOTE: there is intentionally no loadAndInstall* here. Mounting a DISTRIBUTED
// (.calp) mark library must be gated behind explicit user consent (it is still
// user-authored code arriving from a third party), orchestrated in the Charts
// extension via loadPersistedMarkLibraryWithProvenance + installChartMarkLibrary.
// Local libraries (sourcePackage null) auto-install there too.

//! FILENAME: app/scripts/scriptTypings/probeShim.ts
// PURPOSE: Derive the OBJECT-SCRIPT AUTHORING SURFACE from the running shim
//          instead of describing it by hand. Builds a real context with
//          buildWorkerContext() for every objectType and both tiers, walks the
//          resulting object graph, and records every reachable member — plus,
//          by invoking each function against a recording transport, the BROKER
//          METHOD it dispatches to.
// CONTEXT: The one input that makes objectContexts.d.ts generated rather than
//          maintained. `app/src/api/scriptHost/worker/contextShims.ts` is the
//          only place the surface exists; anything this probe cannot see is not
//          callable by a script, and anything it can see but the typings lack
//          is invisible in IntelliSense. The generator turns both directions
//          into a build failure (see generateObjectContexts.ts).
//
//          Probing is SAFE: the shim is pure — every method either reads a
//          worker-local mirror or posts an RPC envelope through the injected
//          `post`. Nothing here touches Tauri, the DOM or the real host.

import { buildWorkerContext, type WorkerRuntime } from "../../src/api/scriptHost/worker/contextShims";
import type { MountSpec, W2H } from "../../src/api/scriptHost/protocol";

// ============================================================================
// Object types
// ============================================================================

/**
 * Every objectType `buildTyped` switches on, mapped to the interface name the
 * typings declare for it. `null` means "the switch has no case — the script
 * gets the base surface only", which is what the `default` branch returns.
 */
export const OBJECT_TYPE_INTERFACES: ReadonlyArray<readonly [objectType: string, iface: string]> = [
  ["workbook", "WorkbookContext"],
  ["sheet", "SheetContext"],
  ["cell", "CellContext"],
  ["row", "RowContext"],
  ["column", "ColumnContext"],
  ["slicer", "SlicerContext"],
  ["chart", "ChartContext"],
  ["pivot", "PivotContext"],
  ["shape", "ShapeContext"],
  ["panel", "PanelContext"],
  ["button", "ButtonContext"],
  ["table", "TableContext"],
  ["namedRange", "NamedRangeContext"],
  ["range", "RangeContext"],
  ["timeline", "TimelineContext"],
  ["chartMark", "ChartMarkContext"],
  // The `default` branch of buildTyped: no typed members beyond the base.
  ["textbox", "BaseObjectContext"],
];

/**
 * Sub-objects that the typings name with their own interface. A probed path
 * matching the key is recorded against that interface instead of being inlined
 * into its parent, so `caps.schedule.every` is checked against
 * ScriptScheduleApi.every rather than against a nested literal.
 *
 * Keys are probe paths RELATIVE TO A CONTEXT ROOT. `()` marks "the object this
 * function returns" (api.chart(id) hands back a chart handle).
 */
export const NAMED_SUBTREES: ReadonlyArray<readonly [path: string, iface: string]> = [
  ["package", "ScriptPackageInfo"],
  ["caps", "ScriptCapabilities"],
  ["caps.storage", "ScriptStorageApi"],
  ["caps.cube", "ScriptCubeApi"],
  ["caps.biModel", "ScriptBiModelApi"],
  ["caps.writeback", "ScriptWritebackApi"],
  ["caps.connector", "ScriptConnectorApi"],
  ["caps.schedule", "ScriptScheduleApi"],
  ["caps.dialog", "ScriptDialogApi"],
  ["caps.file", "ScriptFileApi"],
  ["caps.shortcut", "ScriptShortcutApi"],
  ["api", "UnlockedAPI"],
  ["api.workbook", "ScriptWorkbook"],
  ["api.chart()", "ScriptChartHandle"],
  ["api.table()", "ScriptTableHandle"],
  ["api.pivot()", "ScriptPivotHandle"],
  ["api.slicer()", "ScriptSlicerHandle"],
  ["api.shape()", "ScriptShapeHandle"],
  ["api.namedRange()", "ScriptNamedRangeHandle"],
  // The canonical Range facet, reachable from several contexts by the same shape.
  ["range()", "ScriptRange"],
  ["cell()", "ScriptRange"],
  ["api.table().range()", "ScriptRange"],
  ["api.table().cell()", "ScriptRange"],
];

// ============================================================================
// Probe result
// ============================================================================

export type MemberKind = "method" | "getter" | "property";

export interface ProbedMember {
  /** Dotted path within its owning interface, e.g. "style.setProperty". */
  path: string;
  kind: MemberKind;
  /** Declared parameter count (rest params report as 0 extra, so this is a
   *  floor, never a contract — the typings own the real signature). */
  arity: number;
  /**
   * The allowlisted broker method this member dispatches to, when invoking it
   * posted exactly one `call`. Members that only read a worker-local mirror, or
   * that register a hook, have none.
   */
  broker?: string;
  /** For object.getState / object.setState, the aspect name in args[0]. */
  aspect?: string;
  /** The hook name a subscription member registers (post `hookRegistered`). */
  hook?: string;
}

export interface ProbedInterface {
  name: string;
  members: Map<string, ProbedMember>;
}

export interface ProbeResult {
  interfaces: Map<string, ProbedInterface>;
  /** objectType -> interface, for the generator's context table. */
  objectTypes: ReadonlyArray<readonly [string, string]>;
}

// ============================================================================
// Probe arguments
// ============================================================================

/**
 * Arguments handed to a probed function. They must be plausible enough that a
 * shim wrapper reaches its `call(...)`, and inert enough that nothing else
 * happens. Every shim method either forwards its arguments verbatim or reads a
 * mirror, so a positional guess is sufficient; the recorded broker name is the
 * only thing we keep.
 */
const PROBE_ARGS: unknown[] = [
  // A string first arg satisfies addresses ("A1"), names, ids and messages;
  // numbers satisfy row/col; the trailing objects satisfy option bags.
  "A1",
  0,
  0,
  0,
];

/** Args tried in order until one does not throw synchronously. */
function argSets(arity: number): unknown[][] {
  const sets: unknown[][] = [];
  // Exact arity first, then a few shapes that suit the common signatures.
  sets.push(PROBE_ARGS.slice(0, Math.max(arity, 0)));
  sets.push(["A1"]);
  sets.push([0, 0]);
  sets.push([0, 0, 0, 0]);
  sets.push(["A1", {}]);
  sets.push([[]]);
  sets.push([() => undefined]);
  sets.push([]);
  return sets;
}

// ============================================================================
// Walking
// ============================================================================

interface WalkCtx {
  rt: WorkerRuntime;
  posted: W2H[];
  result: Map<string, ProbedInterface>;
  named: Map<string, string>;
  /** Interfaces already fully walked, so a self-referential shape (ScriptRange
   *  .offset() -> ScriptRange) terminates. */
  walked: Set<string>;
  /**
   * `owner|sortedKeys` of every ANONYMOUS sub-object already walked. Without it
   * a shape that returns itself — range.offset() -> range, range.getCell() ->
   * range — would nest forever, and the typings can only ever declare such a
   * return by NAME, so recursing past the first sighting would invent members
   * no declaration could match.
   */
  shapes: Set<string>;
}

function ifaceFor(ctx: WalkCtx, path: string): string | undefined {
  return ctx.named.get(path);
}

function ensure(ctx: WalkCtx, name: string): ProbedInterface {
  let iface = ctx.result.get(name);
  if (!iface) {
    iface = { name, members: new Map() };
    ctx.result.set(name, iface);
  }
  return iface;
}

/** Drain the RPC deadline timers a probe call armed, so nothing outlives it. */
function drain(ctx: WalkCtx): W2H[] {
  for (const entry of ctx.rt.pending.values()) clearTimeout(entry.timer);
  ctx.rt.pending.clear();
  const posted = ctx.posted.slice();
  ctx.posted.length = 0;
  return posted;
}

/**
 * Invoke a probed function and report what it dispatched. Returns the value it
 * produced when that value is a plain object worth recursing into (a handle, a
 * range) — never a Promise, which is an answer rather than a sub-surface.
 */
function invoke(ctx: WalkCtx, fn: (...a: unknown[]) => unknown): {
  broker?: string;
  aspect?: string;
  hook?: string;
  sub?: Record<string, unknown>;
} {
  drain(ctx);
  let value: unknown;
  let called = false;
  for (const args of argSets(fn.length)) {
    try {
      value = fn(...args);
      called = true;
      break;
    } catch {
      drain(ctx);
    }
  }
  if (!called) {
    drain(ctx);
    return {};
  }
  // A rejected RPC promise must never surface as an unhandled rejection.
  if (value && typeof (value as Promise<unknown>).then === "function") {
    void (value as Promise<unknown>).then(
      () => undefined,
      () => undefined,
    );
  }
  const posted = drain(ctx);
  const out: { broker?: string; aspect?: string; hook?: string; sub?: Record<string, unknown> } = {};
  for (const msg of posted) {
    if (msg.t === "call") {
      out.broker = msg.method;
      const first = Array.isArray(msg.args) ? msg.args[0] : undefined;
      if (
        (msg.method === "object.getState" || msg.method === "object.setState") &&
        typeof first === "string"
      ) {
        out.aspect = first;
      }
      break;
    }
    if (msg.t === "hookRegistered") out.hook = msg.hook;
  }
  const isPromise = !!value && typeof (value as Promise<unknown>).then === "function";
  if (!isPromise && value && (typeof value === "object" || typeof value === "function")) {
    out.sub = value as Record<string, unknown>;
  }
  return out;
}

/** Record an anonymous sub-shape; false when it has already been walked here. */
function markShape(ctx: WalkCtx, owner: string, value: object): boolean {
  const sig = `${owner}|${Object.keys(value).sort().join(",")}`;
  if (ctx.shapes.has(sig)) return false;
  ctx.shapes.add(sig);
  return true;
}

function walk(
  ctx: WalkCtx,
  target: Record<string, unknown>,
  ownerIface: string,
  memberPrefix: string,
  probePath: string,
  depth: number,
): void {
  if (depth > 6) return;
  for (const key of Object.keys(target)) {
    // Internal relay entry points are never part of the authoring surface.
    if (key.startsWith("__")) continue;
    const memberPath = memberPrefix ? `${memberPrefix}.${key}` : key;
    const childProbePath = probePath ? `${probePath}.${key}` : key;
    const desc = Object.getOwnPropertyDescriptor(target, key);
    const iface = ensure(ctx, ownerIface);

    if (desc?.get) {
      iface.members.set(memberPath, { path: memberPath, kind: "getter", arity: 0 });
      continue;
    }
    const value = desc?.value;

    if (typeof value === "function") {
      const probe = invoke(ctx, value as (...a: unknown[]) => unknown);
      iface.members.set(memberPath, {
        path: memberPath,
        kind: "method",
        arity: (value as (...a: unknown[]) => unknown).length,
        broker: probe.broker,
        aspect: probe.aspect,
        hook: probe.hook,
      });
      if (probe.sub) {
        const returnedPath = `${childProbePath}()`;
        const named = ifaceFor(ctx, returnedPath);
        if (named) {
          if (!ctx.walked.has(named)) {
            ctx.walked.add(named);
            // Register the shape under its own interface too: ScriptRange
            // hands back a ScriptRange from offset()/resize()/getCell(), and
            // without this those would be walked again as anonymous members.
            markShape(ctx, named, probe.sub);
            walk(ctx, probe.sub, named, "", returnedPath, depth + 1);
          }
        } else if (markShape(ctx, ownerIface, probe.sub)) {
          walk(ctx, probe.sub, ownerIface, `${memberPath}()`, returnedPath, depth + 1);
        }
      }
      continue;
    }

    if (value && typeof value === "object") {
      const named = ifaceFor(ctx, childProbePath);
      if (named) {
        iface.members.set(memberPath, { path: memberPath, kind: "property", arity: 0 });
        if (!ctx.walked.has(named)) {
          ctx.walked.add(named);
          walk(ctx, value as Record<string, unknown>, named, "", childProbePath, depth + 1);
        }
      } else {
        iface.members.set(memberPath, { path: memberPath, kind: "property", arity: 0 });
        if (markShape(ctx, ownerIface, value)) {
          walk(ctx, value as Record<string, unknown>, ownerIface, memberPath, childProbePath, depth + 1);
        }
      }
      continue;
    }

    // A primitive or an explicit null (context.api on a restricted script,
    // context.package on a local one).
    iface.members.set(memberPath, { path: memberPath, kind: "property", arity: 0 });
  }
}

// ============================================================================
// Entry point
// ============================================================================

function mountSpec(objectType: string, tier: "restricted" | "unlocked"): MountSpec {
  return {
    protocolVersion: 1,
    scriptId: "probe-script",
    objectType,
    instanceId: "probe-instance",
    tier,
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Probe",
    // A distributed provenance so `context.package` probes as an object rather
    // than as null — the typings declare it nullable either way.
    packageInfo: { name: "probe", version: "1.0.0", provenance: "distributed" },
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
}

/**
 * Build every context the shim can produce and record its shape.
 *
 * Both tiers are probed for every objectType: `context.api` is `null` for a
 * restricted script, so the unlocked pass is the only one that can see the
 * whole-workbook surface, while the restricted pass proves nothing appears
 * ONLY there.
 */
export function probeSurface(): ProbeResult {
  const result = new Map<string, ProbedInterface>();
  const named = new Map<string, string>(NAMED_SUBTREES.map(([p, i]) => [p, i]));
  const walked = new Set<string>();
  const shapes = new Set<string>();

  for (const [objectType, ifaceName] of OBJECT_TYPE_INTERFACES) {
    for (const tier of ["unlocked", "restricted"] as const) {
      const posted: W2H[] = [];
      const built = buildWorkerContext(mountSpec(objectType, tier), (msg) => {
        posted.push(msg);
      });
      const ctx: WalkCtx = { rt: built.rt, posted, result, named, walked, shapes };
      // Named subtrees are shared across contexts; only the first context to
      // reach one walks it, which is also what keeps ScriptRange from being
      // re-walked once per objectType.
      walk(ctx, built.context, ifaceName, "", "", 0);
      drain(ctx);
    }
  }

  return { interfaces: result, objectTypes: OBJECT_TYPE_INTERFACES };
}

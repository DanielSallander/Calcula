//! FILENAME: app/src/api/scriptHost/scriptValidation/surface.ts
// PURPOSE: Index the generated script surface for the two questions the
//          validator asks: "is this chain real?" and "what capability does
//          calling it require?" — plus the nearest-neighbour suggestion that
//          turns a rejection into a fix.
// CONTEXT: `generated/scriptSurfacePolicy.ts` is emitted from ONE probe of the
//          live worker shim plus the broker ALLOWLIST, in the same pass as
//          objectContexts.d.ts. Nothing here restates the surface; if this
//          module disagrees with the broker, the generator is the defect.
//          Design: docs/design/local-model-script-authoring.md §5a.

import {
  OBJECT_TYPE_CONTEXTS,
  SCRIPT_SURFACE,
  type SurfaceMember,
} from "../generated/scriptSurfacePolicy";
import type { CapabilityId } from "../capabilityIds";

// ---------------------------------------------------------------------------
// The surface as a GRAPH, and one object type's slice of it
// ---------------------------------------------------------------------------

/** The chain a member hangs off, or "" for one declared on a context root. */
function entryChainOf(m: SurfaceMember): string {
  return m.chain === m.path ? "" : m.chain.slice(0, m.chain.length - m.path.length - 1);
}

const BY_ENTRY: ReadonlyMap<string, SurfaceMember[]> = (() => {
  const out = new Map<string, SurfaceMember[]>();
  for (const m of SCRIPT_SURFACE) {
    const entry = entryChainOf(m);
    const list = out.get(entry) ?? [];
    list.push(m);
    out.set(entry, list);
  }
  return out;
})();

/**
 * Every chain a script handed `iface` can actually WRITE.
 *
 * REACHABILITY, not ownership. A sub-object is reachable only through the member
 * that hands it out: `range()` and `cell()` are declared on SheetContext and
 * TableContext alone, so a BUTTON script cannot obtain a ScriptRange at all and
 * `context.cell.setValue(...)` is a TypeError at mount. The same walk the
 * generator does (app/scripts/scriptTypings/generateObjectContexts.ts), over the
 * same rows -- measured set-identical to `chainsForObjectType` for all 17 types,
 * and pinned by a test, because two derivations that must agree are worth more
 * than one shared import that drags the prompt artifact into this bundle.
 */
function reachableFrom(iface: string): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const m of BY_ENTRY.get("") ?? []) {
    if (m.iface !== iface || reached.has(m.chain)) continue;
    reached.add(m.chain);
    queue.push(m.chain);
  }
  while (queue.length > 0) {
    const entry = queue.pop()!;
    for (const m of BY_ENTRY.get(entry) ?? []) {
      if (reached.has(m.chain)) continue;
      reached.add(m.chain);
      queue.push(m.chain);
    }
  }
  return reached;
}

/**
 * What the base context reaches — 424 chains, and today exactly what EVERY
 * context reaches.
 *
 * Unioned into every scope deliberately. It is redundant while the probe builds
 * a real context per object type and re-emits each base member under it; the day
 * an inheritance-aware probe stops duplicating them, dropping this would reject
 * `context.log` in every script ever written.
 */
const BASE_REACH: ReadonlySet<string> = reachableFrom("BaseObjectContext");

/**
 * The interfaces that belong to ONE object type, read from the probe's own
 * emitted table rather than matched on a "*Context" suffix — already wrong once,
 * for "textbox" (BaseObjectContext).
 */
const CONTEXT_IFACES: ReadonlySet<string> = new Set(OBJECT_TYPE_CONTEXTS.map(([, iface]) => iface));

/** objectType -> the context interface the probe hands it. */
const IFACE_BY_TYPE: ReadonlyMap<string, string> = new Map(OBJECT_TYPE_CONTEXTS);

/** iface -> the object types the probe hands that interface to, sorted. */
const TYPES_BY_IFACE: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [objectType, iface] of OBJECT_TYPE_CONTEXTS) {
    const list = out.get(iface) ?? [];
    list.push(objectType);
    out.set(iface, list);
  }
  for (const list of out.values()) list.sort();
  return out;
})();

function chainsForInterface(iface: string | undefined): string[] {
  if (!iface) return SCRIPT_SURFACE.map((m) => m.chain);
  return [...reachableFrom(iface), ...BASE_REACH];
}

/**
 * The surface AS ONE OBJECT TYPE SEES IT.
 *
 * WHY THIS EXISTS. `onSheetChange` is a WorkbookContext member
 * (generated/scriptSurfacePolicy.ts:788), but the reach check indexed the
 * surface as one flat set of chain strings -- so a BUTTON script calling it
 * validated CLEAN, and at mount `context.onSheetChange` was `undefined` and
 * `setup` threw on the first line.
 */
export interface SurfaceScope {
  /** The object type this was narrowed to; undefined when it is the flat union. */
  readonly objectType?: string;
  /** The context interface that type is handed; undefined for the flat union. */
  readonly iface?: string;
  /** Every chain legal in this scope. */
  readonly chains: ReadonlySet<string>;
  /** False when nothing was narrowed (no object type, or one nobody knows). */
  readonly narrowed: boolean;
  isKnownChain(chain: string): boolean;
  isKnownPrefix(chain: string): boolean;
  callableAncestorOf(chain: string): string | undefined;
  suggest(chain: string, limit?: number): string[];
}

function buildScope(objectType: string | undefined, iface: string | undefined): SurfaceScope {
  const chains: ReadonlySet<string> = new Set(chainsForInterface(iface));
  /**
   * Every PROPER prefix of a chain in scope: "caps", "caps.storage", "api.chart".
   *
   * Referencing a namespace without calling through it (`const c = context.caps`)
   * is legal, so a bare prefix must not be reported as an unknown member.
   */
  const prefixes = new Set<string>();
  for (const chain of chains) {
    const parts = chain.split(".");
    for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join("."));
  }
  const ancestorOf = (chain: string): string | undefined => {
    if (chains.has(chain) && !prefixes.has(chain)) return chain;
    const parts = chain.split(".");
    // Longest first: `caps.storage.get.length` must resolve to `caps.storage.get`
    // rather than stopping at `caps.storage` if both are callable.
    for (let i = parts.length - 1; i >= 1; i--) {
      const ancestor = parts.slice(0, i).join(".");
      // A NAMESPACE is not a data-returning call. `api` and `caps` are listed as
      // members in their own right AND are prefixes of hundreds of chains, so
      // treating them as data-returning would suppress every finding under them
      // -- `api.setCellValu` would sail through.
      if (chains.has(ancestor) && !prefixes.has(ancestor)) return ancestor;
    }
    return undefined;
  };
  return {
    objectType: iface === undefined ? undefined : objectType,
    iface,
    chains,
    narrowed: iface !== undefined,
    isKnownChain: (chain) => chains.has(chain),
    isKnownPrefix: (chain) => prefixes.has(chain),
    callableAncestorOf: ancestorOf,
    suggest: (chain, limit = 3) => suggestWithin(chains, chain, limit),
  };
}

/** The whole surface, unnarrowed. What a caller with no object type gets. */
const GLOBAL_SCOPE: SurfaceScope = buildScope(undefined, undefined);

/** Built once per object type -- ~430 strings each, at most 17 of them. */
const SCOPE_CACHE = new Map<string, SurfaceScope>();

/**
 * The scope to check a script against.
 *
 * An object type the generated table does not know narrows NOTHING. That is the
 * fail-open direction: a type added to the product before
 * `npm run gen:script-typings` is re-run would otherwise have every one of its
 * own hooks rejected. THIS IS A LINTER -- its worst outcome must be missing a
 * defect, never inventing one.
 */
export function surfaceScopeFor(objectType?: string): SurfaceScope {
  if (!objectType) return GLOBAL_SCOPE;
  const cached = SCOPE_CACHE.get(objectType);
  if (cached) return cached;
  const iface = IFACE_BY_TYPE.get(objectType);
  const scope = iface === undefined ? GLOBAL_SCOPE : buildScope(objectType, iface);
  SCOPE_CACHE.set(objectType, scope);
  return scope;
}

/**
 * chain -> the capabilities calling it can require.
 *
 * DELIBERATELY NOT SCOPED. What the broker demands is a property of the MEMBER,
 * not of the object it hangs off, and L2's asymmetry (§11.2) rests on never
 * talking an author out of a declaration it cannot prove wrong.
 */
const CAPABILITY_BY_CHAIN: ReadonlyMap<string, ReadonlySet<CapabilityId>> = (() => {
  const out = new Map<string, Set<CapabilityId>>();
  for (const m of SCRIPT_SURFACE) {
    if (!m.capability) continue;
    const set = out.get(m.chain) ?? new Set<CapabilityId>();
    set.add(m.capability);
    out.set(m.chain, set);
  }
  return out;
})();

export function isKnownChain(chain: string): boolean {
  return GLOBAL_SCOPE.isKnownChain(chain);
}

export function isKnownPrefix(chain: string): boolean {
  return GLOBAL_SCOPE.isKnownPrefix(chain);
}

/**
 * The surface member a chain ultimately reaches over the WHOLE surface.
 *
 * `api.getCellValue.toString` resolves to `api.getCellValue`; `caps.fetch.json`
 * resolves to `caps.fetch`; `api.setCellValu` resolves to nothing, because its
 * only known prefix is the `api` NAMESPACE.
 *
 * The rule lives on `SurfaceScope` because two consumers need it and they must
 * agree, but they ask it of different sets: the reach check asks ONE object
 * type's slice, while the preview's coverage measurement is a fact about the
 * whole surface and asks it here.
 */
export function callableAncestorOf(chain: string): string | undefined {
  return GLOBAL_SCOPE.callableAncestorOf(chain);
}

/** The capabilities calling `chain` requires. Empty for unpoliced members. */
export function capabilitiesFor(chain: string): ReadonlySet<CapabilityId> {
  return CAPABILITY_BY_CHAIN.get(chain) ?? new Set<CapabilityId>();
}

export function surfaceMember(chain: string): SurfaceMember | undefined {
  return SCRIPT_SURFACE.find((m) => m.chain === chain);
}

// ---------------------------------------------------------------------------
// "Real, but not here"
// ---------------------------------------------------------------------------

/** What a chain that exists on ANOTHER object's context resolves to. */
export interface WrongContextMember {
  /** The member itself -- `chain`, or the ancestor of it that is real. */
  chain: string;
  /** The context interfaces that declare it, sorted. */
  ifaces: string[];
  /** The object types those interfaces belong to, sorted. */
  objectTypes: string[];
}

/**
 * The context interfaces declaring `chain`, ignoring the shared base, sorted.
 *
 * SORTED, not in generated-row order: `setCellValue` has TableContext before
 * SheetContext in the emitted file, and an unsorted list would put "attach the
 * script to a table" in front of an author whose obvious answer is "sheet".
 */
function owningIfaces(chain: string): string[] {
  const out: string[] = [];
  for (const m of SCRIPT_SURFACE) {
    if (m.chain !== chain) continue;
    if (!CONTEXT_IFACES.has(m.iface)) continue;
    // BaseObjectContext is shared by every object type, so nothing is "only" on
    // it and naming it would be a false explanation.
    if (m.iface === "BaseObjectContext") continue;
    if (!out.includes(m.iface)) out.push(m.iface);
  }
  return out.sort();
}

/**
 * Why a chain failed the reach check in THIS scope: because it belongs to some
 * other object's context, or because it is not a member anywhere.
 *
 * Walks LONGEST FIRST and stops at the first segment the scope can already
 * reach, which keeps an ordinary typo out of this branch: `api.setCellValu` has
 * no rows of its own and its ancestor `api` IS reachable here. It also finds the
 * ENTRY POINT of a sub-object: a button writing `context.cell.getValue()` fails
 * on `cell.getValue` (declared by ScriptRange, which is not a context) and then
 * resolves `cell`, which SheetContext and TableContext declare -- so the message
 * names the object types that can actually obtain a cell.
 *
 * Returns undefined for an unnarrowed scope BY CONSTRUCTION.
 */
export function wrongContextMember(
  chain: string,
  scope: SurfaceScope,
): WrongContextMember | undefined {
  const parts = chain.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join(".");
    if (scope.isKnownChain(candidate) || scope.isKnownPrefix(candidate)) return undefined;
    const ifaces = owningIfaces(candidate);
    if (ifaces.length === 0) continue;
    const objectTypes: string[] = [];
    for (const iface of ifaces) {
      for (const objectType of TYPES_BY_IFACE.get(iface) ?? []) {
        if (!objectTypes.includes(objectType)) objectTypes.push(objectType);
      }
    }
    return { chain: candidate, ifaces, objectTypes: objectTypes.sort() };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Nearest neighbour
// ---------------------------------------------------------------------------

/** Levenshtein distance, iterative two-row. Small strings; no memo needed. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The closest real chains to one the author invented, best first.
 *
 * A rejection that only says "does not exist" costs a whole repair round to a
 * model that has no way to guess the right name. Comparing the LAST SEGMENT as
 * well as the whole chain matters: a model that writes `api.formatRange` is
 * usually reaching for something whose namespace it got right, and a model that
 * writes `caps.fetchUrl` got the namespace right and the verb wrong.
 *
 * SCOPING MATTERS AS MUCH AS CLOSENESS. `onSheetChanged` in a button script is
 * one edit from `onSheetChange` and scores 0 against the flat surface -- so it
 * would be the top hit, the repair prompt would send the model at a member a
 * button does not have, and the loop could not converge.
 */
function suggestWithin(chains: ReadonlySet<string>, chain: string, limit: number): string[] {
  const wantedTail = chain.split(".").pop() ?? chain;
  const wantedNs = chain.split(".").slice(0, -1).join(".");
  const scored: Array<{ candidate: string; score: number }> = [];
  for (const candidate of chains) {
    const tail = candidate.split(".").pop() ?? candidate;
    const ns = candidate.split(".").slice(0, -1).join(".");
    // Whole-chain distance, with the tail weighted double and a bonus for
    // landing in the same namespace.
    const score =
      editDistance(chain, candidate) +
      2 * editDistance(wantedTail, tail) +
      (ns === wantedNs ? -3 : 0);
    scored.push({ candidate, score });
  }
  scored.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  // A wildly distant "suggestion" is noise that makes the message worse, so the
  // list is cut on absolute closeness, not just rank.
  const threshold = Math.max(6, Math.ceil(wantedTail.length * 0.9));
  return scored.filter((s) => s.score <= threshold).slice(0, limit).map((s) => s.candidate);
}

/** Nearest neighbours over the WHOLE surface, for a caller with no object type. */
export function suggestChains(chain: string, limit = 3): string[] {
  return GLOBAL_SCOPE.suggest(chain, limit);
}

/** Total members indexed — used by tests to prove the surface is not empty. */
export const SURFACE_SIZE = SCRIPT_SURFACE.length;

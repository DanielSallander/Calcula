//! FILENAME: app/src/api/objectBindings/cache.ts
// PURPOSE: The seam's CACHE of the binding set and of the resolved values, and
//          the `onBindingsChanged` listener list.
// CONTEXT: Rust owns the store and evaluates. This cache exists so a painter
//          can read a resolved value SYNCHRONOUSLY at paint time
//          (`getResolved`, `overlayResolved`) and so the bridge knows whether a
//          workbook has any binding at all (a workbook without bindings sends
//          no cell trigger). It is refilled from the backend's answers and from
//          the `object-bindings:changed` event, never written by a caller.
//
//          Every write here is a DIFF: listeners hear only about objects whose
//          bindings or values really changed. The same value can arrive twice
//          (a `CellsChanged` answer AND the event that announced it) and must
//          cost one repaint, not two.
//
//          `epoch` is bumped by every reset (File > New / Open). A reload that
//          was in flight across a reset carries the old epoch and is dropped,
//          so a slow answer about the previous workbook can never repopulate
//          the cache of the new one.

import type { ObjectBindingInfo, ObjectBindingRef, ResolvedBinding } from "../types";
import type { ObjectBindingsChange } from "./types";

/** A binding as cached: the info without its (separately cached) resolved value. */
type CachedInfo = Omit<ObjectBindingInfo, "resolved">;

const bindings = new Map<string, Map<string, CachedInfo>>();
const resolved = new Map<string, Map<string, ResolvedBinding>>();
const refs = new Map<string, ObjectBindingRef>();
const listeners = new Set<(change: ObjectBindingsChange) => void>();
let epoch = 0;

/** The cache key of an object. */
export function objectKey(object: ObjectBindingRef): string {
  return `${object.kind}\u0000${object.id}`;
}

function copyRef(object: ObjectBindingRef): ObjectBindingRef {
  return { kind: object.kind, id: object.id };
}

/** The current epoch (bumped by every reset). */
export function cacheEpoch(): number {
  return epoch;
}

/** How many bindings the cache holds (the bridge's "any bindings at all?"). */
export function bindingCount(): number {
  let n = 0;
  for (const m of bindings.values()) n += m.size;
  return n;
}

function sameResolved(a: ResolvedBinding | undefined, b: ResolvedBinding | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.display === b.display &&
    (a.error ?? null) === (b.error ?? null) &&
    a.pending === b.pending &&
    JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
  );
}

function sameInfo(a: CachedInfo | undefined, b: CachedInfo | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.formula === b.formula && a.displayFormula === b.displayFormula && (a.model ?? null) === (b.model ?? null);
}

function withResolved(info: CachedInfo): ObjectBindingInfo {
  const r = resolved.get(objectKey(info.object))?.get(info.path) ?? null;
  return { ...info, object: copyRef(info.object), resolved: r };
}

function stripResolved(info: ObjectBindingInfo): CachedInfo {
  return {
    object: copyRef(info.object),
    path: info.path,
    formula: info.formula,
    displayFormula: info.displayFormula,
    model: info.model ?? null,
  };
}

/** Every cached binding, optionally of one object, ordered by object then path. */
export function listCached(object?: ObjectBindingRef): ObjectBindingInfo[] {
  const keys = object ? [objectKey(object)] : [...bindings.keys()].sort();
  const out: ObjectBindingInfo[] = [];
  for (const key of keys) {
    const m = bindings.get(key);
    if (!m) continue;
    for (const path of [...m.keys()].sort()) out.push(withResolved(m.get(path)!));
  }
  return out;
}

/** One cached binding, or null. */
export function getCachedBinding(object: ObjectBindingRef, path: string): ObjectBindingInfo | null {
  const info = bindings.get(objectKey(object))?.get(path);
  return info ? withResolved(info) : null;
}

/** One cached resolved value, or null. */
export function getCachedResolved(object: ObjectBindingRef, path: string): ResolvedBinding | null {
  return resolved.get(objectKey(object))?.get(path) ?? null;
}

/** Every cached resolved value of one object, keyed by path (a copy). */
export function getCachedResolvedForObject(object: ObjectBindingRef): ReadonlyMap<string, ResolvedBinding> {
  return new Map(resolved.get(objectKey(object)) ?? []);
}

/** Store resolved values; returns the objects whose values actually changed. */
export function applyResolvedValues(values: readonly ResolvedBinding[]): ObjectBindingRef[] {
  const changed = new Map<string, ObjectBindingRef>();
  for (const v of values) {
    if (!v || !v.object || typeof v.path !== "string") continue;
    const key = objectKey(v.object);
    let m = resolved.get(key);
    if (sameResolved(m?.get(v.path), v)) continue;
    if (!m) {
      m = new Map();
      resolved.set(key, m);
    }
    m.set(v.path, { ...v, object: copyRef(v.object), error: v.error ?? null });
    refs.set(key, copyRef(v.object));
    changed.set(key, copyRef(v.object));
  }
  return [...changed.values()];
}

/** Upsert one binding (and its resolved value when it carries one); true when it changed. */
export function applyBinding(info: ObjectBindingInfo): boolean {
  const key = objectKey(info.object);
  let m = bindings.get(key);
  const next = stripResolved(info);
  let changed = !sameInfo(m?.get(info.path), next);
  if (changed) {
    if (!m) {
      m = new Map();
      bindings.set(key, m);
    }
    m.set(info.path, next);
    refs.set(key, copyRef(info.object));
  }
  if (info.resolved) changed = applyResolvedValues([info.resolved]).length > 0 || changed;
  return changed;
}

/** Drop one binding and its value; true when the cache held it. */
export function removeCachedBinding(object: ObjectBindingRef, path: string): boolean {
  const key = objectKey(object);
  const m = bindings.get(key);
  const had = m?.delete(path) ?? false;
  if (m && m.size === 0) bindings.delete(key);
  const r = resolved.get(key);
  const hadValue = r?.delete(path) ?? false;
  if (r && r.size === 0) resolved.delete(key);
  return had || hadValue;
}

function objectSignature(key: string): string {
  const b = bindings.get(key);
  const r = resolved.get(key);
  const bs = b ? [...b.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)) : [];
  const rs = r ? [...r.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)) : [];
  return JSON.stringify([
    bs.map(([p, i]) => [p, i.formula, i.displayFormula, i.model ?? null]),
    rs.map(([p, v]) => [p, v.value ?? null, v.display, v.error ?? null, v.pending]),
  ]);
}

/**
 * Replace the whole cache with a fresh listing (and values). Returns every
 * object whose bindings or values differ from before -- an unchanged reload
 * returns nothing.
 */
export function replaceAll(infos: readonly ObjectBindingInfo[], values: readonly ResolvedBinding[]): ObjectBindingRef[] {
  const before = new Map<string, string>();
  const keys = new Set<string>([...bindings.keys(), ...resolved.keys()]);
  for (const key of keys) before.set(key, objectSignature(key));
  const oldRefs = new Map(refs);

  bindings.clear();
  resolved.clear();
  refs.clear();
  for (const info of infos) applyBinding(info);
  applyResolvedValues(values);

  const changed: ObjectBindingRef[] = [];
  for (const key of new Set([...keys, ...bindings.keys(), ...resolved.keys()])) {
    if (before.get(key) !== objectSignature(key)) {
      const ref = refs.get(key) ?? oldRefs.get(key);
      if (ref) changed.push(copyRef(ref));
    }
  }
  return changed;
}

/** Empty the cache for a new document; returns every object it held. Bumps the epoch. */
export function resetCache(): ObjectBindingRef[] {
  epoch++;
  const held = [...refs.values()].map(copyRef);
  bindings.clear();
  resolved.clear();
  refs.clear();
  return held;
}

/** Tell every listener; one listener's failure never starves the next. */
export function notifyBindingsChanged(change: ObjectBindingsChange): void {
  if (change.objects.length === 0 && !change.reload) return;
  for (const listener of [...listeners]) {
    try {
      listener({ objects: change.objects.map(copyRef), reload: change.reload });
    } catch (err) {
      console.warn("[objectBindings] A listener failed:", err);
    }
  }
}

/** Subscribe to binding changes. Returns the unsubscribe function. */
export function onBindingsChanged(cb: (change: ObjectBindingsChange) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

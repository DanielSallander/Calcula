//! FILENAME: app/src/api/objectBindings/overlay.ts
// PURPOSE: `overlayResolved` -- how a family PAINTS a bound property: a copy of
//          the object's literal JSON with every resolved binding under a root
//          applied, read synchronously from the seam's cache at paint time.
// CONTEXT: ONE spelling per fact (D invariant 1): the literal stays in the
//          object's record and is never rewritten by a resolved value; the
//          overlay exists only in the copy a renderer draws from. Controls are
//          overlaid in RUST (`resolve_control_properties`), so this is for the
//          families that read their own JSON in TS: charts (`/spec`),
//          slicers and timelines (`""`), canvas pages (`""`).
//
//          The rules (D §3.16):
//            * a PENDING value (a measure not fetched yet) is skipped -- the
//              literal stays rather than flashing a blank;
//            * an ERROR on a non-text slot is skipped -- the literal stays (a
//              KPI goal never becomes NaN);
//            * a TEXT slot shows `display`, errors included ("#REF!") -- a
//              title that cannot resolve says so where the user looks;
//            * a missing OBJECT member is created on the way (a chart with no
//              `xAxis` gains one), an array item never is (a binding on
//              series 3 of a two-series chart paints nothing) -- the Rust
//              literal writer's `set_at_pointer` rule.

import type { ObjectBindingRef, ResolvedBinding } from "../types";
import { getCachedResolvedForObject } from "./cache";
import { isBindablePath, isTextValueType, parsePointer } from "./catalog";

/** A structural deep copy of JSON-like data (functions and cycles are not JSON). */
function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepCopy(v);
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Write `value` at `segments` under `root` (the Rust `set_at_pointer` rule).
 * Returns the (possibly replaced) root, or `undefined` to mean "not applied".
 */
function setAt(root: unknown, segments: readonly string[], value: unknown): { root: unknown } | undefined {
  if (segments.length === 0) return { root: value };
  const top: unknown = root === null || root === undefined ? {} : root;
  let cursor: unknown = top;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (Array.isArray(cursor)) {
      if (!/^[0-9]+$/.test(seg)) return undefined;
      const idx = Number(seg);
      if (idx >= cursor.length) return undefined;
      let next = cursor[idx];
      if (next === null || next === undefined) {
        next = {};
        cursor[idx] = next;
      }
      cursor = next;
    } else if (isPlainObject(cursor)) {
      let next = cursor[seg];
      if (next === null || next === undefined) {
        next = {};
        cursor[seg] = next;
      }
      cursor = next;
    } else {
      return undefined;
    }
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) {
    if (!/^[0-9]+$/.test(last)) return undefined;
    const idx = Number(last);
    if (idx >= cursor.length) return undefined;
    cursor[idx] = value;
  } else if (isPlainObject(cursor)) {
    cursor[last] = value;
  } else {
    return undefined;
  }
  return { root: top };
}

/** The value a resolved binding paints, or `undefined` to keep the literal. */
export function paintedValue(object: ObjectBindingRef, r: ResolvedBinding): unknown {
  if (r.pending) return undefined;
  const spec = isBindablePath(object.kind, r.path);
  if (!spec) return undefined;
  if (isTextValueType(spec.valueType)) return r.display;
  if (r.error) return undefined;
  if (r.value === null || r.value === undefined) return undefined;
  return r.value;
}

/**
 * A deep copy of `value` (the JSON found at `rootPointer` of `object`, e.g. a
 * chart's spec at "/spec", a slicer's whole record at "") with every resolved
 * binding under that root applied. Never mutates `value`; returns the input
 * itself when the object has no resolved binding under the root (no copy cost
 * for the common, unbound case).
 */
export function overlayResolved<T>(object: ObjectBindingRef, rootPointer: string, value: T): T {
  const all = getCachedResolvedForObject(object);
  if (all.size === 0) return value;
  const rootSegments = rootPointer === "" ? [] : parsePointer(rootPointer);
  if (rootSegments === null) return value;

  const applicable: Array<{ rel: string[]; painted: unknown }> = [];
  for (const r of all.values()) {
    const segments = parsePointer(r.path);
    if (!segments || segments.length <= rootSegments.length) continue;
    if (!rootSegments.every((s, i) => segments[i] === s)) continue;
    const painted = paintedValue(object, r);
    if (painted === undefined) continue;
    applicable.push({ rel: segments.slice(rootSegments.length), painted });
  }
  if (applicable.length === 0) return value;

  let out: unknown = deepCopy(value);
  for (const { rel, painted } of applicable) {
    const applied = setAt(out, rel, deepCopy(painted));
    if (applied) out = applied.root;
  }
  return out as T;
}

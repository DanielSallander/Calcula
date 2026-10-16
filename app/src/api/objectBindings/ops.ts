//! FILENAME: app/src/api/objectBindings/ops.ts
// PURPOSE: The seam's operations: read the cached bindings synchronously, and
//          create / remove a binding, write a literal, analyse a formula, read
//          an object's JSON and its page's measures through the backend.
// CONTEXT: Every write goes to Rust, which applies the family's own gates
//          (protection, Lock Objects, subscribed sheets) and records the undo
//          step; the seam only updates its cache from the answer so a caller
//          that awaits `setBinding` can read the binding back at once. A
//          refusal arrives as a `BindingRefusal` carrying Rust's sentence.
//
//          LOCALE: a formula from a person (BindableField, the chart title
//          editor, the Properties pane) is in the user's locale and is sent
//          without `invariant` -- Rust delocalises it, exactly as `update_cell`
//          does. Scripts, MCP and the AI send `invariant: true` (`,`
//          separators, `.` decimals whatever the locale) and read `formula`;
//          people read `displayFormula`.

import type {
  BindingEditSource,
  BindingFormulaAnalysis,
  BindingModelMeasures,
  ObjectBindingInfo,
  ObjectBindingPlace,
  ObjectBindingRef,
  ResolvedBinding,
} from "../types";
import {
  applyBinding,
  getCachedBinding,
  getCachedResolved,
  getCachedResolvedForObject,
  listCached,
  notifyBindingsChanged,
  removeCachedBinding,
} from "./cache";
import { announceLiteralDomains, sendPageFiltersNow } from "./bridge";
import { expectResponse, sendObjectBindingsRequest } from "./transport";

/** Every cached binding (optionally of one object). Synchronous: the cache. */
export function listBindings(object?: ObjectBindingRef): ObjectBindingInfo[] {
  return listCached(object);
}

/** One cached binding, or null. */
export function getBinding(object: ObjectBindingRef, path: string): ObjectBindingInfo | null {
  return getCachedBinding(object, path);
}

/** One cached resolved value, or null. Synchronous: what a painter reads. */
export function getResolved(object: ObjectBindingRef, path: string): ResolvedBinding | null {
  return getCachedResolved(object, path);
}

/** Every cached resolved value of one object, keyed by path. */
export function getResolvedForObject(object: ObjectBindingRef): ReadonlyMap<string, ResolvedBinding> {
  return getCachedResolvedForObject(object);
}

/**
 * Bind `path` of `object` to `formula`. `formula` is in the user's locale
 * unless `invariant: true` (scripts and AI pass true). Before the `Set`, the
 * CURRENT page-filter snapshot is sent, so a first measure binding never
 * queries a stale mirror. Rejects with a `BindingRefusal`.
 */
export async function setBinding(
  object: ObjectBindingRef,
  path: string,
  formula: string,
  opts?: { model?: string; invariant?: boolean; source?: BindingEditSource },
): Promise<ObjectBindingInfo> {
  await sendPageFiltersNow();
  const answer = expectResponse(
    await sendObjectBindingsRequest({
      op: "set",
      object: { kind: object.kind, id: object.id },
      path,
      formula,
      model: opts?.model ?? null,
      invariant: opts?.invariant ?? null,
      source: opts?.source ?? null,
    }),
    "binding",
  );
  if (applyBinding(answer.binding)) {
    notifyBindingsChanged({ objects: [answer.binding.object], reload: false });
  }
  return answer.binding;
}

/** Remove the binding at `path` (the literal shows again). True when one was removed. */
export async function clearBinding(
  object: ObjectBindingRef,
  path: string,
  opts?: { source?: BindingEditSource },
): Promise<boolean> {
  const answer = expectResponse(
    await sendObjectBindingsRequest({
      op: "clear",
      object: { kind: object.kind, id: object.id },
      path,
      source: opts?.source ?? null,
    }),
    "cleared",
  );
  if (removeCachedBinding(object, path)) {
    notifyBindingsChanged({ objects: [{ kind: object.kind, id: object.id }], reload: false });
  }
  return answer.removed;
}

/**
 * Write the LITERAL at `path` through the family's own write core (its gates,
 * its undo). Emits MUTATION_REFRESH with the domains Rust reports, so the
 * family re-reads its record.
 */
export async function setLiteral(
  object: ObjectBindingRef,
  path: string,
  value: unknown,
  opts?: { source?: BindingEditSource },
): Promise<void> {
  const answer = expectResponse(
    await sendObjectBindingsRequest({
      op: "setLiteral",
      object: { kind: object.kind, id: object.id },
      path,
      value: value === undefined ? null : value,
      source: opts?.source ?? null,
    }),
    "literalSet",
  );
  announceLiteralDomains(answer.domains);
}

/**
 * What a formula would read and how it would be stored -- without storing it.
 * Pass the `model` the `setBinding` will name: on a page with several models a
 * `[Measure]` analysed without one is refused ("say which one") while the Set
 * that names it is not, and a caller that GATES on the analysis (the script
 * executor) must see what the Set will do.
 */
export async function analyzeBindingFormula(
  object: ObjectBindingRef,
  formula: string,
  opts?: { invariant?: boolean; model?: string | null },
): Promise<BindingFormulaAnalysis> {
  const answer = expectResponse(
    await sendObjectBindingsRequest({
      op: "analyze",
      object: { kind: object.kind, id: object.id },
      formula,
      invariant: opts?.invariant ?? null,
      model: opts?.model ?? null,
    }),
    "analysis",
  );
  return answer.analysis;
}

/** The object's AI-visible JSON (what binding pointers address). */
export async function getObjectJson(object: ObjectBindingRef): Promise<unknown> {
  const answer = expectResponse(
    await sendObjectBindingsRequest({ op: "objectJson", object: { kind: object.kind, id: object.id } }),
    "objectJson",
  );
  return answer.json;
}

/**
 * Where each object is (sheet index and name) and what a person calls it, in
 * the order asked. An object that no longer exists (an orphan binding's) is
 * left out. Read-only: the Bound Properties view's Object column and Go to.
 */
export async function locateBoundObjects(objects: readonly ObjectBindingRef[]): Promise<ObjectBindingPlace[]> {
  if (objects.length === 0) return [];
  const answer = expectResponse(
    await sendObjectBindingsRequest({ op: "locate", objects: objects.map((o) => ({ kind: o.kind, id: o.id })) }),
    "located",
  );
  return answer.places;
}

/** The models (and their measures) a binding on this object's page could read. */
export async function listBindingMeasures(object: ObjectBindingRef): Promise<BindingModelMeasures[]> {
  const answer = expectResponse(
    await sendObjectBindingsRequest({ op: "measures", object: { kind: object.kind, id: object.id } }),
    "measures",
  );
  return answer.models;
}

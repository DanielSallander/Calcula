//! FILENAME: app/extensions/_shared/lib/headerTitleContainer.ts
// PURPOSE: The one mapping between a HEADERED filter object's record (a slicer
//          or a timeline: `headerText`, `showHeader`, `container`) and the
//          visual container the object pane's Format tab reads and patches
//          (@api/visualContainer), shared by Slicer/lib/slicerObjectFormat.ts
//          and TimelineSlicer/lib/timelineObjectFormat.ts.
// CONTEXT: ONE SPELLING PER FACT (D-FORMAT). A slicer's and a timeline's title
//          text and title visibility already live on the record as
//          `headerText` (null = the object's name) and `showHeader`; every
//          other container leaf lives in `container`. So:
//            READ   -> the container with `title.show` = showHeader and, when
//                      the record stores one, `title.text` = headerText;
//            WRITE  -> a patch is split back into headerText / showHeader and a
//                      `container` that NEVER carries title.text / title.show
//                      (the Rust catalog has no container row for them on these
//                      kinds, and a second spelling would drift).
//          The two families' backends take all three in ONE update call
//          (`update_slicer` / `update_timeline_slicer`), so a Format commit is
//          one backend write and one undo entry.
//
//          No store, no backend, no DOM; the resolve memo reads WP-D's cache.

import {
  applyVisualContainerPatch,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "@api/visualContainer";
import { getResolvedForObject, type ObjectBindingRef } from "@api/objectBindings";

/** The record fields this mapping reads. */
export interface HeaderedRecord {
  headerText?: string | null;
  showHeader: boolean;
  container?: VisualContainerFormat | null;
}

/** The update this mapping writes (both families' update params carry these three keys). */
export interface HeaderedUpdate {
  headerText?: string | null;
  showHeader?: boolean;
  container?: VisualContainerFormat | null;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Whether two stored containers say the same thing (absent == empty; key order ignored). */
export function sameStoredContainer(
  a: VisualContainerFormat | null | undefined,
  b: VisualContainerFormat | null | undefined,
): boolean {
  const norm = (c: VisualContainerFormat | null | undefined) => applyVisualContainerPatch(c ?? undefined, {}) ?? null;
  return stableJson(norm(a)) === stableJson(norm(b));
}

/**
 * The container as the record STORES it, without the two title facts the
 * record spells elsewhere (an old or hand-written record might carry them in
 * `container`; they are never read from there). Undefined when nothing is left.
 */
export function storedContainerWithoutTitleIdentity(
  container: VisualContainerFormat | null | undefined,
): VisualContainerFormat | undefined {
  return applyVisualContainerPatch(container ?? undefined, { title: { text: null, show: null } });
}

/**
 * The STORED container the Format tab shows for a headered record:
 * `container` plus `title.show` = `showHeader` and, when the record stores a
 * header text, `title.text` = `headerText` (absent text = the family default,
 * the object's name).
 */
export function readHeaderedContainer(record: HeaderedRecord): VisualContainerFormat {
  const base = storedContainerWithoutTitleIdentity(record.container) ?? {};
  const title: Record<string, unknown> = { ...((base.title as Record<string, unknown> | undefined) ?? {}) };
  title.show = record.showHeader !== false;
  if (typeof record.headerText === "string" && record.headerText !== "") title.text = record.headerText;
  return { ...base, title: title as VisualContainerFormat["title"] };
}

/**
 * Split a container patch into the record's ONE update: `headerText` (a
 * cleared or empty title text = null, the object's name), `showHeader` (a
 * cleared one = shown, the default) and `container` (null when nothing is
 * left). Only what CHANGES is in the result; null when nothing does.
 */
export function headeredUpdateFor(record: HeaderedRecord, patch: VisualContainerPatch): HeaderedUpdate | null {
  const next = applyVisualContainerPatch(readHeaderedContainer(record), patch) ?? {};
  const title = (next.title ?? {}) as { text?: unknown; show?: unknown };
  const out: HeaderedUpdate = {};

  const nextText = typeof title.text === "string" && title.text !== "" ? title.text : null;
  const currentText = typeof record.headerText === "string" && record.headerText !== "" ? record.headerText : null;
  if (nextText !== currentText) out.headerText = nextText;

  const nextShow = typeof title.show === "boolean" ? title.show : true;
  if (nextShow !== (record.showHeader !== false)) out.showHeader = nextShow;

  const nextContainer = storedContainerWithoutTitleIdentity(next);
  if (!sameStoredContainer(nextContainer, storedContainerWithoutTitleIdentity(record.container))) {
    out.container = nextContainer ?? null;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The record as a PREVIEW of `patch` shows it (the transient-write pattern:
 * nothing is written): the same three fields `headeredUpdateFor` would write,
 * applied to a copy.
 */
export function previewHeaderedRecord<T extends HeaderedRecord>(record: T, patch: VisualContainerPatch): T {
  const update = headeredUpdateFor(record, patch);
  if (!update) return record;
  const out = { ...record } as T & HeaderedRecord;
  if ("headerText" in update) out.headerText = update.headerText ?? null;
  if ("showHeader" in update && update.showHeader !== undefined) out.showHeader = update.showHeader;
  if ("container" in update) out.container = update.container ?? undefined;
  return out;
}

// ============================================================================
// The resolve memo (the hit test asks on every pointer move)
// ============================================================================

/**
 * Everything a headered object's RESOLVED container depends on, as one string:
 * the stored facts (container, header text / show, name, style preset), a
 * preview in progress, and every resolved WP-D binding of the object (none,
 * for an unbound object, costs one empty map). Two equal keys resolve to the
 * same container, so a family may reuse the last one -- the zone answer is
 * asked several times per pointer move, and on every point of a test's grid.
 * Computed from the record each time, so a record changed IN PLACE is still
 * seen.
 */
export function headeredResolveKey(
  record: HeaderedRecord & { name?: string; stylePreset?: string },
  preview: VisualContainerPatch | undefined,
  ref: ObjectBindingRef,
): string {
  const bound: unknown[] = [];
  for (const [path, r] of getResolvedForObject(ref)) {
    bound.push([path, r.value, r.display, r.error, r.pending]);
  }
  return JSON.stringify([
    record.container ?? null,
    record.headerText ?? null,
    record.showHeader,
    record.name ?? "",
    record.stylePreset ?? "",
    preview ?? null,
    bound,
  ]);
}

/** A one-entry-per-object memo of resolved containers, keyed by `headeredResolveKey`. */
export class ResolvedContainerMemo<V> {
  private readonly entries = new Map<string, { key: string; value: V }>();

  /** The memoised value for `id` when `key` matches, else `compute()` (remembered). */
  get(id: string, key: string, compute: () => V): V {
    const hit = this.entries.get(id);
    if (hit && hit.key === key) return hit.value;
    const value = compute();
    this.entries.set(id, { key, value });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

//! FILENAME: app/extensions/Pivot/lib/pivotStylePersist.ts
// PURPOSE: The PERSISTED PivotTable style of each pivot (WP-C D-FORMAT): the
//          style id the gallery chose plus the colour overrides the Format
//          pane's Style card set -- what the box and the hidden grid paint
//          with, and the ONE door that changes it (`setPivotStyle`).
// CONTEXT: The style used to be session-only: a module map in Pivot/index.ts
//          fed by PIVOT_LAYOUT_STATE / PIVOT_LAYOUT_CHANGED, and a gallery click
//          rode PIVOT_LAYOUT_CHANGED into a FULL pivot fields update. Since WP-C
//          the definition persists it (`PivotDefinition.style`, Rust
//          `PivotStyleChoice`), so:
//            - the map here is SEEDED from every region refresh
//              (`PivotRegionData.style`), which is also how an undo of a style
//              change comes back;
//            - `setPivotStyle` writes ONE `update_pivot_properties { pivotId,
//              style }` (undoable, "PivotTable Style"; the backend restyles the
//              hidden grid itself, S10b) and never schedules a fields update.
//          An unchanged style is never sent (BUG-0477: that door dirties the
//          document even on a no-op).
//
//          TRANSIENT OVERRIDE PREVIEW. The Style card's colour pickers show a
//          colour while the picker is open without writing anything (the
//          transient-write pattern: no write, no undo, no dirty flag); the
//          painter asks `effectivePivotStyle`, which lays the preview over the
//          persisted choice. The gallery's hover preview stays where it was
//          (lib/pivotStyles.ts `setPivotStylePreview`).

import { useSyncExternalStore } from "react";
import { requestOverlayRedraw } from "@api/gridOverlays";
import type { PivotStyleConfig } from "@api/pivot";
import { updatePivotProperties } from "./pivot-api";
import { getPivotStylePreview } from "./pivotStyles";
import type { PivotRegionData } from "../types";

/** The colour keys a persisted override may name (Rust `PIVOT_THEME_OVERRIDE_KEYS`, drift-tested). */
export const PIVOT_THEME_OVERRIDE_KEYS = [
  "headerText",
  "labelText",
  "valueText",
  "totalText",
  "grandTotalText",
  "headerBackground",
  "labelBackground",
  "valueBackground",
  "totalBackground",
  "grandTotalBackground",
  "alternateRowBackground",
  "borderColor",
  "headerBorderColor",
] as const;
export type PivotThemeOverrideKey = (typeof PIVOT_THEME_OVERRIDE_KEYS)[number];

/** A persisted override value: Rust `PivotStyleChoice::validate` accepts #rrggbb only. */
const OVERRIDE_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Whether `key` may carry a persisted colour override. */
export function isPivotThemeOverrideKey(key: string): key is PivotThemeOverrideKey {
  return (PIVOT_THEME_OVERRIDE_KEYS as readonly string[]).includes(key);
}

/** The undo label the backend records for a style-only change (pinned by the Rust tests). */
export const PIVOT_STYLE_UNDO_LABEL = "PivotTable Style";

const persisted = new Map<string, PivotStyleConfig>();
const overridePreview = new Map<string, Record<string, string>>();
const listeners = new Set<() => void>();

function announce(): void {
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch (err) {
      console.error("[pivotStylePersist] a listener threw:", err);
    }
  }
  requestOverlayRedraw();
}

function sameOverrides(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  if (ak.length !== bk.length) return false;
  return ak.every((k) => (a ?? {})[k] === (b ?? {})[k]);
}

/** Whether two persisted choices are the same (null = the default style). */
export function samePivotStyle(a: PivotStyleConfig | null | undefined, b: PivotStyleConfig | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.styleId === b.styleId && sameOverrides(a.themeOverrides, b.themeOverrides);
}

function normalized(style: PivotStyleConfig | null | undefined): PivotStyleConfig | null {
  if (!style || typeof style.styleId !== "string") return null;
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(style.themeOverrides ?? {})) {
    if (isPivotThemeOverrideKey(k) && typeof v === "string" && OVERRIDE_COLOUR.test(v)) overrides[k] = v;
  }
  return Object.keys(overrides).length > 0 ? { styleId: style.styleId, themeOverrides: overrides } : { styleId: style.styleId };
}

/**
 * Seed the map from a region list (the ACTIVE sheet's pivots): each listed
 * pivot takes its region's `style` (absent = the default style). Pivots not in
 * the list are left alone -- they live on another sheet. Announces only when
 * something changed.
 */
export function seedPivotStylesFromRegions(regions: readonly PivotRegionData[]): boolean {
  let changed = false;
  for (const r of regions) {
    const next = normalized(r.style);
    const prev = persisted.get(r.pivotId) ?? null;
    if (samePivotStyle(prev, next)) continue;
    changed = true;
    if (next) persisted.set(r.pivotId, next);
    else persisted.delete(r.pivotId);
  }
  if (changed) announce();
  return changed;
}

/** The persisted style of `pivotId`, or null (the default style). */
export function getPersistedPivotStyle(pivotId: string): PivotStyleConfig | null {
  return persisted.get(pivotId) ?? null;
}

/** The style id the gallery shows as chosen ("" = the default style). */
export function persistedPivotStyleId(pivotId: string | null): string {
  if (!pivotId) return "";
  return persisted.get(pivotId)?.styleId ?? "";
}

/** The overrides the painter applies NOW: the persisted ones with any transient preview over them. */
export function effectivePivotOverrides(pivotId: string): Record<string, string> {
  return { ...(persisted.get(pivotId)?.themeOverrides ?? {}), ...(overridePreview.get(pivotId) ?? {}) };
}

/**
 * What the box and the worksheet overlay PAINT `pivotId` with: the style id
 * the gallery is hovering (a transient preview) else the persisted one ("" =
 * the default style), and the persisted overrides with any open picker's
 * preview over them. Resolve it with `resolvePivotStyleOverrides` -- THE rule
 * the backend's hidden grid follows too.
 */
export function effectivePivotStyle(pivotId: string): { styleId: string; overrides: Record<string, string> } {
  return {
    styleId: getPivotStylePreview(pivotId) ?? persisted.get(pivotId)?.styleId ?? "",
    overrides: effectivePivotOverrides(pivotId),
  };
}

/**
 * Show colour `overrides` on `pivotId` WITHOUT writing them (a colour picker
 * that is still open); `null` ends the preview. Repaints; touches nothing
 * persisted.
 */
export function setPivotOverridePreview(pivotId: string, overrides: Record<string, string> | null): void {
  if (overrides === null) {
    if (!overridePreview.delete(pivotId)) return;
  } else {
    overridePreview.set(pivotId, { ...overrides });
  }
  announce();
}

/** Be told when a persisted style or a preview changes. Returns the unsubscribe. */
export function subscribePersistedPivotStyles(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * THE style door. `styleId` null = back to the default style (clears the
 * overrides too: the definition's `style` becomes null). Otherwise the style
 * id with `overrides` -- or, when `overrides` is undefined, the overrides the
 * pivot already has (a gallery click keeps the user's own colours). An
 * override value of "" / null removes that key. Sends nothing when the result
 * equals what is persisted. ONE `update_pivot_properties { pivotId, style }`;
 * rejects with the backend's sentence (nothing changes here then).
 */
export async function setPivotStyle(
  pivotId: string,
  styleId: string | null,
  overrides?: Readonly<Record<string, string | null>>,
): Promise<void> {
  const current = persisted.get(pivotId) ?? null;
  let next: PivotStyleConfig | null = null;
  if (styleId !== null) {
    const base: Record<string, string | null> = overrides === undefined ? { ...(current?.themeOverrides ?? {}) } : { ...overrides };
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) {
      if (typeof v !== "string" || v === "") continue;
      if (!isPivotThemeOverrideKey(k)) throw new Error(`"${k}" is not a PivotTable style colour.`);
      if (!OVERRIDE_COLOUR.test(v)) throw new Error(`${k} must be a #rrggbb colour.`);
      kept[k] = v.toLowerCase();
    }
    next = Object.keys(kept).length > 0 ? { styleId, themeOverrides: kept } : { styleId };
  }
  if (samePivotStyle(current, next)) return;
  await updatePivotProperties({ pivotId, style: next });
  if (next) persisted.set(pivotId, next);
  else persisted.delete(pivotId);
  overridePreview.delete(pivotId);
  announce();
  // The backend restyled the hidden grid (a worksheet pivot's cells, a
  // canvas box's copy source): the grid's style cache follows.
  window.dispatchEvent(new CustomEvent("styles:refresh"));
}

/** React: the persisted style of `pivotId` (null = the default style), re-rendered on every change. */
export function usePersistedPivotStyle(pivotId: string | null): PivotStyleConfig | null {
  return useSyncExternalStore(subscribePersistedPivotStyles, () => (pivotId ? persisted.get(pivotId) ?? null : null));
}

/** File > New / Open, deactivate and tests. */
export function resetPersistedPivotStyles(): void {
  persisted.clear();
  overridePreview.clear();
}

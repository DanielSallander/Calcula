//! FILENAME: app/extensions/Pivot/components/PivotFormatCards.tsx
// PURPOSE: The canvas pivot box's own "Visual" cards in the object pane's
//          Format tab (WP-C D-FORMAT): STYLE (the PivotTable styles gallery and
//          six colour overrides) and LAYOUT (grand totals, report layout and
//          display -- the Design ribbon's own sections).
// CONTEXT: The host (BuiltIn/ObjectPane) wraps each card in its collapsible
//          frame; these components are the bodies only.
//
//          STYLE writes through THE style door (lib/pivotStylePersist.ts
//          `setPivotStyle`: ONE update_pivot_properties, undoable "PivotTable
//          Style", never a fields update). The gallery hover previews
//          transiently (setPivotStylePreview), and a colour override shows at
//          once while its picker reports (setPivotOverridePreview) and is
//          COMMITTED once the picks settle -- the palette's custom colour input
//          reports live while the OS picker is dragged, and every report as a
//          backend write would be an undo step each. "Automatic" removes the
//          override (the style's own colour shows again).
//
//          LAYOUT renders the Design sections in a sidebar surface. Their
//          change is SENT by the pivot's mounted field-list editor when the
//          object pane has one (its Fields / Design tab was shown), else
//          headlessly (pivotPanelStore.updateSharedLayout ->
//          lib/pivotLayoutEdits.ts); without an editor the shared store reads
//          the pivot's REAL layout from its definition, so the sections never
//          show defaults in its place.

import React, { useCallback, useEffect, useRef } from "react";
import type { FormatCardProps } from "@api/objectFormat";
import { ColorSwatch, Stack, ROW_GAP, normalizeHex } from "@api/layout";
import { showToast } from "@api/notifications";
import { PivotTableStylesGallery, DEFAULT_PIVOT_STYLE_ID } from "./PivotTableStylesGallery";
import { DesignDisplaySection, DesignGrandTotalsSection, DesignReportLayoutSection } from "./PivotDesignSections";
import { createPivotTheme, type PivotTheme } from "../rendering/pivot";
import { resolvePivotStyleOverrides, setPivotStylePreview } from "../lib/pivotStyles";
import {
  setPivotOverridePreview,
  setPivotStyle,
  usePersistedPivotStyle,
  type PivotThemeOverrideKey,
} from "../lib/pivotStylePersist";
import type { PanelSectionProps } from "@api/uiTypes";

/** The contribution ids (the Format tab's `data-format-card`). */
export const PIVOT_STYLE_CARD_ID = "pivot-style";
export const PIVOT_LAYOUT_CARD_ID = "pivot-layout";

/** The six colours the Style card overrides (each a Rust PIVOT_THEME_OVERRIDE_KEYS key). */
export const PIVOT_STYLE_OVERRIDE_ROWS: ReadonlyArray<{ key: PivotThemeOverrideKey; label: string }> = [
  { key: "headerBackground", label: "Header background" },
  { key: "headerText", label: "Header text" },
  { key: "valueBackground", label: "Values background" },
  { key: "alternateRowBackground", label: "Banded rows" },
  { key: "borderColor", label: "Borders" },
  { key: "grandTotalBackground", label: "Grand total background" },
];

/** How long the colour picks must settle before an override is written. */
export const PIVOT_OVERRIDE_COMMIT_DELAY_MS = 300;

function pivotIdOf(region: FormatCardProps["region"]): string | null {
  const id = (region.data as { pivotId?: unknown } | undefined)?.pivotId;
  return typeof id === "string" && id !== "" ? id : null;
}

function reportStyleFailure(err: unknown): void {
  showToast(`The PivotTable style could not be set: ${err instanceof Error ? err.message : String(err)}`, { type: "error" });
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
  minHeight: 28,
};

const noteStyle: React.CSSProperties = { fontSize: 11, opacity: 0.75 };

/** The Style card: the gallery, then the six override colours. */
export function PivotStyleCard({ region, readOnly, readOnlyReason }: FormatCardProps): React.ReactElement | null {
  const pivotId = pivotIdOf(region);
  const persisted = usePersistedPivotStyle(pivotId);
  /** Overrides picked but not yet committed (the picker still reporting). */
  const pending = useRef<Record<string, string | null> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistedRef = useRef(persisted);
  persistedRef.current = persisted;

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const picks = pending.current;
    pending.current = null;
    if (!pivotId || !picks) return;
    const current = persistedRef.current;
    const overrides: Record<string, string | null> = { ...(current?.themeOverrides ?? {}), ...picks };
    setPivotStyle(pivotId, current?.styleId ?? "", overrides)
      .catch(reportStyleFailure)
      .finally(() => setPivotOverridePreview(pivotId, null));
  }, [pivotId]);

  // A pick still waiting lands when the card goes (another object, pane closed).
  useEffect(() => () => flush(), [flush]);
  // The gallery's hover preview never outlives the card.
  useEffect(() => () => setPivotStylePreview(null, null), [pivotId]);

  if (!pivotId) return null;

  const styleId = persisted?.styleId || DEFAULT_PIVOT_STYLE_ID;
  const overrides = persisted?.themeOverrides ?? {};
  const shown: PivotTheme = createPivotTheme(resolvePivotStyleOverrides(styleId, overrides));

  const pick = (key: PivotThemeOverrideKey, hex: string | null): void => {
    if (readOnly) return;
    const next = hex === null ? null : normalizeHex(hex);
    if (hex !== null && next === null) return;
    pending.current = { ...(pending.current ?? {}), [key]: next };
    const preview: Record<string, string> = {};
    for (const [k, v] of Object.entries(pending.current)) if (typeof v === "string") preview[k] = v;
    setPivotOverridePreview(pivotId, preview);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, PIVOT_OVERRIDE_COMMIT_DELAY_MS);
  };

  return (
    <Stack gap={ROW_GAP}>
      <div
        data-testid="pivot-format-style-gallery"
        style={readOnly ? { pointerEvents: "none", opacity: 0.6 } : undefined}
        aria-disabled={readOnly || undefined}
        title={readOnly && readOnlyReason ? readOnlyReason : undefined}
      >
        <PivotTableStylesGallery
          selectedStyleId={styleId}
          onStyleSelect={(id) => {
            if (!readOnly) setPivotStyle(pivotId, id).catch(reportStyleFailure);
          }}
          onStyleClear={() => {
            if (!readOnly) setPivotStyle(pivotId, null).catch(reportStyleFailure);
          }}
          onStylePreview={(id) => setPivotStylePreview(pivotId, id)}
        />
      </div>
      {PIVOT_STYLE_OVERRIDE_ROWS.map(({ key, label }) => {
        const own = overrides[key];
        return (
          <div key={key} style={rowStyle} data-field-id={`pivotStyle.${key}`}>
            <span>
              {label}
              {own ? <span style={noteStyle}> (custom)</span> : null}
            </span>
            <ColorSwatch
              color={(shown as unknown as Record<string, string>)[key] ?? null}
              label={label}
              testId={`format-pivotStyle-${key}`}
              disabled={readOnly}
              allowAutomatic
              automaticLabel="Style colour"
              onAutomatic={() => pick(key, null)}
              onChange={(hex) => pick(key, hex)}
            />
          </div>
        );
      })}
    </Stack>
  );
}

const SIDEBAR_SECTION: PanelSectionProps = { placement: "sidebar" };

/** The Layout card: the Design ribbon's Grand Totals, Report Layout and Display sections. */
export function PivotLayoutCard({ region, readOnly, readOnlyReason }: FormatCardProps): React.ReactElement | null {
  const pivotId = pivotIdOf(region);
  if (!pivotId) return null;
  return (
    <fieldset
      disabled={readOnly}
      title={readOnly && readOnlyReason ? readOnlyReason : undefined}
      style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
      data-testid="pivot-format-layout"
    >
      <Stack gap={ROW_GAP}>
        <DesignGrandTotalsSection {...SIDEBAR_SECTION} />
        <DesignReportLayoutSection {...SIDEBAR_SECTION} />
        <DesignDisplaySection {...SIDEBAR_SECTION} />
      </Stack>
    </fieldset>
  );
}

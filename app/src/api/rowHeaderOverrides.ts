//! FILENAME: app/src/api/rowHeaderOverrides.ts
// PURPOSE: Row header overrides + the row GUTTER lane (granular bricks,
//          phase 3: structural bricks). Extensions replace row numbers with
//          custom text and/or place a small per-row widget (dot/flag/chevron)
//          in the gutter zone at the left edge of the row header, with click
//          routing — the "grid furniture" becomes a brick.
// ARCHITECTURE: API layer registry consumed by the Core header painter and
//          header click handling. Multi-provider with priorities (unlike the
//          original single-slot column override this generalizes).
// PERFORMANCE: hot per-visible-row path — hasX() fast flags + first-match
//          walks over tiny sorted arrays; providers must be O(1) per row.

// ============================================================================
// Row header text overrides
// ============================================================================

/** Override data for a single row header. */
export interface RowHeaderOverride {
  /** Text to display instead of the row number. */
  text?: string;
  /** Optional text color override. */
  textColor?: string;
}

/**
 * Provider called during header painting for each visible row.
 * Return an override or null to keep the default row number.
 */
export type RowHeaderOverrideProvider = (row: number) => RowHeaderOverride | null;

interface ProviderRegistration {
  provider: RowHeaderOverrideProvider;
  priority: number;
}

const overrideProviders: ProviderRegistration[] = [];

/**
 * Register a row-header override provider. Lower priority is consulted first;
 * the first non-null override wins.
 * @returns Cleanup function.
 */
export function registerRowHeaderOverrideProvider(
  provider: RowHeaderOverrideProvider,
  priority: number = 0
): () => void {
  const registration = { provider, priority };
  overrideProviders.push(registration);
  overrideProviders.sort((a, b) => a.priority - b.priority);
  return () => {
    const i = overrideProviders.indexOf(registration);
    if (i >= 0) overrideProviders.splice(i, 1);
  };
}

/** Fast flag for the painter. */
export function hasRowHeaderOverrides(): boolean {
  return overrideProviders.length > 0;
}

/** First non-null override across providers (priority order). */
export function getRowHeaderOverride(row: number): RowHeaderOverride | null {
  for (const r of overrideProviders) {
    try {
      const override = r.provider(row);
      if (override) return override;
    } catch (error) {
      console.error("[RowHeaderOverrides] Error in provider:", error);
    }
  }
  return null;
}

// ============================================================================
// Row gutter widgets
// ============================================================================

/** Pixel width of the gutter zone (left edge of the row header, after the
 *  grouping outline bar when present). */
export const ROW_GUTTER_WIDTH = 12;

/** A small glyph shown in a row's gutter slot. */
export interface RowGutterWidget {
  glyph: "dot" | "flag" | "chevron-right" | "chevron-down";
  /** CSS color (default: theme-ish blue). */
  color?: string;
}

export interface RowGutterWidgetRegistration {
  id: string;
  /** Lower = consulted first; the first widget wins the slot. Default 0. */
  priority?: number;
  /** The widget for a row, or null for no widget. Must be O(1) per row. */
  getWidget: (row: number) => RowGutterWidget | null;
  /** Click handler for the row's gutter slot. Return true when handled. */
  onClick?: (row: number) => boolean | Promise<boolean>;
}

const gutterRegistry: RowGutterWidgetRegistration[] = [];

/**
 * Register a row-gutter widget source.
 * @returns Cleanup function.
 */
export function registerRowGutterWidget(registration: RowGutterWidgetRegistration): () => void {
  gutterRegistry.push(registration);
  gutterRegistry.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return () => {
    const i = gutterRegistry.indexOf(registration);
    if (i >= 0) gutterRegistry.splice(i, 1);
  };
}

/** Fast flag for the painter. */
export function hasRowGutterWidgets(): boolean {
  return gutterRegistry.length > 0;
}

/** The winning widget for a row (with its registration, for click routing). */
export function getRowGutterWidget(
  row: number
): { widget: RowGutterWidget; registration: RowGutterWidgetRegistration } | null {
  for (const registration of gutterRegistry) {
    try {
      const widget = registration.getWidget(row);
      if (widget) return { widget, registration };
    } catch (error) {
      console.error(`[RowGutter] Error in widget source "${registration.id}":`, error);
    }
  }
  return null;
}

/**
 * Paint a gutter glyph. Called by the Core row-header painter with the gutter
 * zone's left X (after the outline bar) and the row's Y/height.
 */
export function drawRowGutterGlyph(
  ctx: CanvasRenderingContext2D,
  widget: RowGutterWidget,
  gutterX: number,
  rowY: number,
  rowHeight: number
): void {
  const cx = gutterX + ROW_GUTTER_WIDTH / 2;
  const cy = rowY + rowHeight / 2;
  const color = widget.color || "#0078d4";
  ctx.save();
  switch (widget.glyph) {
    case "dot": {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(2.5, rowHeight / 4), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "flag": {
      const h = Math.min(8, rowHeight - 4);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 2, cy + h / 2);
      ctx.lineTo(cx - 2, cy - h / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 2, cy - h / 2);
      ctx.lineTo(cx + 4, cy - h / 4);
      ctx.lineTo(cx - 2, cy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "chevron-right":
    case "chevron-down": {
      const s = Math.min(3.5, rowHeight / 5);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (widget.glyph === "chevron-right") {
        ctx.moveTo(cx - s / 2, cy - s);
        ctx.lineTo(cx + s / 2, cy);
        ctx.lineTo(cx - s / 2, cy + s);
      } else {
        ctx.moveTo(cx - s, cy - s / 2);
        ctx.lineTo(cx, cy + s / 2);
        ctx.lineTo(cx + s, cy - s / 2);
      }
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/**
 * Route a row-header click that landed inside the gutter X-zone. Called by the
 * Core header click handler BEFORE default row selection. Returns whether a
 * widget handled it.
 */
export async function checkRowGutterClick(row: number): Promise<boolean> {
  const hit = getRowGutterWidget(row);
  if (!hit?.registration.onClick) return false;
  try {
    return (await hit.registration.onClick(row)) === true;
  } catch (error) {
    console.error(`[RowGutter] Error in onClick of "${hit.registration.id}":`, error);
    return false;
  }
}

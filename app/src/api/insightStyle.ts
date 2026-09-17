//! FILENAME: app/src/api/insightStyle.ts
// PURPOSE: How the insight overlay LOOKS — a document setting the publisher
//          owns, read live by every painter that draws a cue.
// CONTEXT: docs/design/insight-overlays.md §4.10 (D-IO-11). The overlay's
//          colours began as literals in the Charts painter. A published
//          application is consumed by people who never see the author's app
//          skin, so the style has to travel WITH the workbook: it lives in the
//          Insights extension's data blob (persisted in the `.cala`, published
//          in the `.calp`'s `extension_data.json`, pulled back on the
//          subscriber's side) and this module is the one place a painter asks
//          "what colour is bad?". Precedence is two-level and deliberate: the
//          DOCUMENT's style when it declares one, else the built-in defaults.
//          No per-user override — the publisher decides how their report
//          reads, which is the vocabulary of the whole distribution model.
//
//          SEMANTIC, NEVER PIXEL. A style says what "good", "bad", "attention"
//          and "neutral" look like (a colour and a dash each), plus a line
//          width and a band opacity. It does not say where anything is drawn;
//          placement stays the geometry's. Shape (the dash) carries polarity
//          for colour-blind readers, so a style that gives two polarities the
//          same colour still reads — and the defaults keep the dashes distinct.
//
//          `normalizeOverlayStyle` is the boundary: anything from a file or a
//          script passes through it, and a field it cannot accept falls back
//          to the default for that field rather than failing the whole style.

import type { ChartCuePolarity } from "./chartCues";

export interface OverlayPolarityStyle {
  /** A CSS colour: `#rrggbb`, `#rgb`, `rgb(...)`, or a named colour. */
  color: string;
  /** Canvas dash pattern; [] is solid. */
  dash: number[];
}

export interface OverlayStyle {
  polarity: Record<ChartCuePolarity, OverlayPolarityStyle>;
  /** Stroke width of rings and callouts, in logical pixels. */
  lineWidth: number;
  /** Fill opacity of a band, 0..1. */
  bandOpacity: number;
}

export const DEFAULT_OVERLAY_STYLE: OverlayStyle = Object.freeze({
  polarity: Object.freeze({
    good: Object.freeze({ color: "#1e8e3e", dash: [] }),
    bad: Object.freeze({ color: "#d93025", dash: [] }),
    attention: Object.freeze({ color: "#e37400", dash: [6, 4] }),
    neutral: Object.freeze({ color: "#0e639c", dash: [2, 3] }),
  }) as Record<ChartCuePolarity, OverlayPolarityStyle>,
  lineWidth: 2,
  bandOpacity: 0.12,
}) as OverlayStyle;

export const POLARITIES: readonly ChartCuePolarity[] = Object.freeze(["good", "bad", "attention", "neutral"]);

/** The dash presets the pane offers; a file may carry any short pattern. */
export const DASH_PRESETS: Readonly<Record<"solid" | "dashed" | "dotted", number[]>> = Object.freeze({
  solid: [],
  dashed: [6, 4],
  dotted: [2, 3],
});

// ============================================================================
// Validation
// ============================================================================

const COLOR_RE = /^(#[0-9a-f]{3}([0-9a-f]{3})?|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;

/** A colour a canvas will accept and nobody can smuggle a `url(` or a script through. */
export function isOverlayColor(v: unknown): v is string {
  return typeof v === "string" && v.length <= 32 && COLOR_RE.test(v.trim());
}

function normalizeDash(v: unknown, fallback: number[]): number[] {
  if (!Array.isArray(v) || v.length > 4) return [...fallback];
  const out: number[] = [];
  for (const n of v) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 64) return [...fallback];
    out.push(n);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Turn anything (a stored blob, a script's argument, a half-filled form)
 * into a complete style. Field by field: an unacceptable value falls back to
 * that field's default, so a colour someone mistyped costs that colour and
 * nothing else.
 */
export function normalizeOverlayStyle(raw: unknown): OverlayStyle {
  const src = isRecord(raw) ? raw : {};
  const pol = isRecord(src.polarity) ? src.polarity : {};
  const polarity = {} as Record<ChartCuePolarity, OverlayPolarityStyle>;
  for (const p of POLARITIES) {
    const given = isRecord(pol[p]) ? (pol[p] as Record<string, unknown>) : {};
    const d = DEFAULT_OVERLAY_STYLE.polarity[p];
    polarity[p] = {
      color: isOverlayColor(given.color) ? given.color.trim() : d.color,
      dash: normalizeDash(given.dash, d.dash),
    };
  }
  const lw = src.lineWidth;
  const lineWidth = typeof lw === "number" && Number.isFinite(lw) && lw >= 0.5 && lw <= 8 ? lw : DEFAULT_OVERLAY_STYLE.lineWidth;
  const bo = src.bandOpacity;
  const bandOpacity = typeof bo === "number" && Number.isFinite(bo) && bo >= 0 && bo <= 1 ? bo : DEFAULT_OVERLAY_STYLE.bandOpacity;
  return { polarity, lineWidth, bandOpacity };
}

/** True when a style is the defaults, field for field. */
export function isDefaultOverlayStyle(style: OverlayStyle): boolean {
  return JSON.stringify(normalizeOverlayStyle(style)) === JSON.stringify(normalizeOverlayStyle(DEFAULT_OVERLAY_STYLE));
}

// ============================================================================
// The document's style (transient mirror of the persisted setting)
// ============================================================================

let documentStyle: OverlayStyle | null = null;
const listeners = new Set<() => void>();

/**
 * Set (or clear with null) the style the OPEN DOCUMENT declares. Called by
 * the Insights extension when it loads or saves the setting; painters never
 * call it. Notifies on change only.
 */
export function setDocumentOverlayStyle(style: OverlayStyle | null): void {
  const next = style === null ? null : normalizeOverlayStyle(style);
  if (JSON.stringify(next) === JSON.stringify(documentStyle)) return;
  documentStyle = next;
  for (const l of [...listeners]) l();
}

/** The document's declared style, or null when it declares none. */
export function getDocumentOverlayStyle(): OverlayStyle | null {
  return documentStyle;
}

/** What a painter uses right now: the document's style, else the defaults. */
export function resolveOverlayStyle(): OverlayStyle {
  return documentStyle ?? DEFAULT_OVERLAY_STYLE;
}

/** The colour and dash for one polarity, resolved live. */
export function overlayStyleFor(polarity: ChartCuePolarity): OverlayPolarityStyle {
  return resolveOverlayStyle().polarity[polarity];
}

export function onOverlayStyleChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

//! FILENAME: app/extensions/Charts/lib/chartObjectFormat.ts
// PURPOSE: The chart's half of the visual-container seams (WP-C D-FORMAT):
//          what a chart's container IS (read from its one-spelling fields),
//          what it looks like by default, how it resolves with WP-D's bindings
//          laid over it, and the `@api/objectFormat` provider the object pane's
//          Format tab writes through.
// CONTEXT: ONE SPELLING PER FACT. A chart already spells three title facts
//          elsewhere and keeps them there:
//            title text   -> `spec.title`
//            title colour -> `spec.config.theme.titleColor`
//            title size   -> `spec.config.theme.titleFontSize`
//          Everything else lives in `spec.container` (padding, the rest of the
//          title style, subtitle, divider, spacing, background -- which MOVED
//          here from `theme.background` -- border and shadow). `read` merges the
//          three into the container the pane shows, and `commit` splits a patch
//          back into the same three places plus the container, so the pane never
//          writes a second spelling (Rust refuses one too).
//
//          WHO PAINTS WHAT. Core paints the chart's shadow, background and
//          border around the raster (`paint.background/border/shadow: "core"`);
//          the chart paints its own title block INSIDE the raster
//          (`paint.title: "family"`, rendering/chartPainterUtils `drawTitle`),
//          and Core reserves no band for it. The raster is laid out and
//          hit-tested inside `visualContentRectFor(...)`.
//
//          NO STORE IMPORT. The chart store imports this module (its region
//          publisher resolves the container), so everything here that needs the
//          store, the renderer or the pane is INJECTED into
//          `createChartObjectFormatProvider` by activate() -- the
//          chartGeometry.ts pattern -- and a test can hand it doubles.

import type { ComponentType } from "react";
import type { GridRegion } from "@api/gridOverlays";
import type {
  ContainerCapabilities,
  DataFormatField,
  FormatCardProps,
  ObjectFormatProvider,
} from "@api/objectFormat";
import { onContainerBindingsChanged, resolveContainerForObject } from "@api/objectFormat";
import { runInUndoTransaction } from "@api/objectGeometry";
import {
  BASE_CONTAINER_DEFAULTS,
  applyVisualContainerPatch,
  isSafeVisualColor,
  validateVisualGradient,
  type ContainerFieldId,
  type ResolvedVisualContainer,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "@api/visualContainer";
import type { ObjectBindingRef } from "@api/objectBindings";
import type { ChartContainerFormat, ChartSpec, ThemeOverrides } from "../types";
import { isDesignQueryDataSource } from "../types";
import { DEFAULT_CHART_THEME } from "../rendering/chartTheme";
import { chartBindingRef } from "./chartBindings";

// ============================================================================
// The binding table (read as TEXT by ObjectPane's objectFormatBindingPaths test)
// ============================================================================

/** The WP-D binding kind a chart's container fields bind under. */
export const CONTAINER_BINDING_KIND = "chart";

/**
 * Field -> the WP-D catalog pointer a binding of that field lives at, or null
 * (never bindable). The three title facts the chart spells elsewhere bind at
 * their own Family rows; `lockAspect` is never bindable (all kinds).
 */
export const CONTAINER_BINDING_PATHS: Readonly<Record<ContainerFieldId, string | null>> = {
  "padding.top": "/spec/container/padding/top",
  "padding.right": "/spec/container/padding/right",
  "padding.bottom": "/spec/container/padding/bottom",
  "padding.left": "/spec/container/padding/left",
  lockAspect: null,
  "title.show": "/spec/container/title/show",
  "title.text": "/spec/title",
  "title.headingLevel": "/spec/container/title/headingLevel",
  "title.fontFamily": "/spec/container/title/fontFamily",
  "title.fontSize": "/spec/config/theme/titleFontSize",
  "title.bold": "/spec/container/title/bold",
  "title.italic": "/spec/container/title/italic",
  "title.underline": "/spec/container/title/underline",
  "title.color": "/spec/config/theme/titleColor",
  "title.background": "/spec/container/title/background",
  "title.align": "/spec/container/title/align",
  "title.wrap": "/spec/container/title/wrap",
  "subtitle.show": "/spec/container/subtitle/show",
  "subtitle.text": "/spec/container/subtitle/text",
  "subtitle.fontFamily": "/spec/container/subtitle/fontFamily",
  "subtitle.fontSize": "/spec/container/subtitle/fontSize",
  "subtitle.bold": "/spec/container/subtitle/bold",
  "subtitle.italic": "/spec/container/subtitle/italic",
  "subtitle.underline": "/spec/container/subtitle/underline",
  "subtitle.color": "/spec/container/subtitle/color",
  "subtitle.background": "/spec/container/subtitle/background",
  "subtitle.align": "/spec/container/subtitle/align",
  "subtitle.wrap": "/spec/container/subtitle/wrap",
  "divider.show": "/spec/container/divider/show",
  "divider.color": "/spec/container/divider/color",
  "divider.style": "/spec/container/divider/style",
  "divider.width": "/spec/container/divider/width",
  "divider.ignorePadding": "/spec/container/divider/ignorePadding",
  "spacing.custom": "/spec/container/spacing/custom",
  "spacing.belowTitle": "/spec/container/spacing/belowTitle",
  "spacing.belowSubtitle": "/spec/container/spacing/belowSubtitle",
  "spacing.belowDivider": "/spec/container/spacing/belowDivider",
  "background.show": "/spec/container/background/show",
  "background.color": "/spec/container/background/color",
  "background.transparency": "/spec/container/background/transparency",
  "border.show": "/spec/container/border/show",
  "border.color": "/spec/container/border/color",
  "border.width": "/spec/container/border/width",
  "border.radius": "/spec/container/border/radius",
  "shadow.show": "/spec/container/shadow/show",
  "shadow.color": "/spec/container/shadow/color",
  "shadow.transparency": "/spec/container/shadow/transparency",
  "shadow.offset": "/spec/container/shadow/offset",
  "shadow.position": "/spec/container/shadow/position",
  "shadow.blur": "/spec/container/shadow/blur",
  "shadow.distance": "/spec/container/shadow/distance",
};

/** The catalog pointer of a container field of a chart, or null (answered FROM the table). */
export function chartContainerBindingPath(field: ContainerFieldId): string | null {
  return CONTAINER_BINDING_PATHS[field] ?? null;
}

// ============================================================================
// Read / defaults / resolve (pure)
// ============================================================================

/** The default frame a chart has always had: a 1 px #d0d0d0 border on white. */
export const CHART_DEFAULT_BORDER_COLOR = "#d0d0d0";

/** The chart id a chart region carries (chartStore `syncChartRegions`), or null. */
export function chartIdOfFormatRegion(region: GridRegion): string | null {
  const id = (region.data as { chartId?: unknown } | undefined)?.chartId;
  return typeof id === "string" && id !== "" ? id : null;
}

function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * The chart's STORED container as the pane shows it: `spec.container` plus the
 * three title facts the chart spells elsewhere (text, colour, size), each only
 * when the chart actually stores it.
 */
export function readChartContainer(spec: ChartSpec): VisualContainerFormat {
  const c = (cloneJson(spec.container) ?? {}) as VisualContainerFormat;
  const title: Record<string, unknown> = { ...((c.title as Record<string, unknown> | undefined) ?? {}) };
  if (typeof spec.title === "string") title.text = spec.title;
  const theme = spec.config?.theme;
  if (typeof theme?.titleColor === "string" && theme.titleColor !== "") title.color = theme.titleColor;
  if (typeof theme?.titleFontSize === "number") title.fontSize = theme.titleFontSize;
  if (Object.keys(title).length > 0) c.title = title as VisualContainerFormat["title"];
  else delete c.title;
  return c;
}

/**
 * The chart's DEFAULTS: today's chart look (white background, a 1 px #d0d0d0
 * border, square corners, the title centred in the chart's font, 600 weight,
 * one line, 8 px under it) on Power BI's base. Core paints background, border
 * and shadow; the chart paints its own title block.
 */
export function chartContainerDefaults(spec: ChartSpec | null | undefined): ResolvedVisualContainer {
  const font = spec?.config?.theme?.fontFamily || DEFAULT_CHART_THEME.fontFamily;
  const b = BASE_CONTAINER_DEFAULTS;
  return {
    padding: { ...b.padding },
    lockAspect: false,
    title: {
      ...b.title,
      show: true,
      text: spec?.title ?? "",
      fontFamily: font,
      fontSize: DEFAULT_CHART_THEME.titleFontSize,
      color: DEFAULT_CHART_THEME.titleColor,
      bold: true,
      align: "center",
      wrap: false,
    },
    subtitle: { ...b.subtitle, fontFamily: font },
    divider: { ...b.divider },
    spacing: { belowTitle: 8, belowSubtitle: 8, belowDivider: 8 },
    background: { show: true, color: DEFAULT_CHART_THEME.background, alpha: 1, gradient: null },
    border: { show: true, color: CHART_DEFAULT_BORDER_COLOR, width: 1, radius: 0 },
    shadow: { ...b.shadow },
    paint: { background: "core", border: "core", title: "family", shadow: "core" },
  };
}

/**
 * The chart's RESOLVED container: bound > stored > defaults. `chartId` null (a
 * dialog preview of an unsaved chart, an export of a bare spec) = no binding
 * overlay -- such a chart has no bindings.
 */
export function resolveChartContainer(chartId: string | null | undefined, spec: ChartSpec): ResolvedVisualContainer {
  return resolveContainerForObject(
    chartId ? chartBindingRef(chartId) : null,
    readChartContainer(spec),
    chartContainerDefaults(spec),
    chartContainerBindingPath,
  );
}

/**
 * The marks that PAINT a design-query chart's Data format
 * (`spec.fieldFormats`): the four tile visuals, whose painters write the
 * Rust-formatted source text (`rendering/visuals/visualValues.ts`). A column,
 * bar, line or pie chart's data labels, value-axis ticks and tooltips format
 * the raw number (`formatTickValue` / the label's own d3 pattern) and never
 * read it, so offering the card there accepted, saved and undid a format the
 * chart then did not show. Offered where it paints; the other marks follow
 * when their labels, ticks and tooltips read it (open-items §2.ak).
 */
export const DATA_FORMAT_MARKS: ReadonlySet<string> = new Set(["card", "multiRowCard", "kpi", "gauge"]);

/** What the Format pane may offer for a chart. */
export function chartContainerCapabilities(spec: ChartSpec | null | undefined): ContainerCapabilities {
  return {
    padding: true,
    lockAspect: true,
    title: true,
    titleText: "free",
    subtitle: true,
    divider: true,
    background: true,
    backgroundTransparency: true,
    gradient: true,
    border: true,
    borderRadius: true,
    shadow: true,
    // Range charts: not in v1 (d3 vs Excel format dialects); a pivot-sourced
    // chart formats its PivotTable's values; a design-query chart only where
    // its mark paints the format (`DATA_FORMAT_MARKS`).
    dataFormat: !!spec && isDesignQueryDataSource(spec.data) && DATA_FORMAT_MARKS.has(spec.mark),
  };
}

// ============================================================================
// The legacy outer background (pure)
// ============================================================================

/**
 * A spec written before the container existed spelled the chart's outer
 * background `config.theme.background` (+ an untyped `backgroundGradient` that
 * `chart.setGradientFill` wrote). That fact now lives in
 * `container.background`, so a loaded spec is moved over once: a valid colour
 * becomes `container.background.color` (unless the container already names
 * one), a gradient becomes `container.background.gradient`, and both theme keys
 * go. A value the container cannot hold (a CSS colour name) is dropped -- the
 * default white shows. Returns `spec` itself when there is nothing to move.
 * No backward compatibility is owed; this only keeps the load canary quiet on
 * files authored before the move.
 */
export function migrateLegacyChartBackground(spec: ChartSpec): ChartSpec {
  const theme = spec.config?.theme as Record<string, unknown> | undefined;
  if (!theme || (!("background" in theme) && !("backgroundGradient" in theme))) return spec;
  const { background, backgroundGradient, ...rest } = theme;
  const container = (cloneJson(spec.container) ?? {}) as Record<string, unknown>;
  const bg: Record<string, unknown> = isPlainObject(container.background) ? { ...container.background } : {};
  if (typeof background === "string" && isSafeVisualColor(background) && background !== "" && bg.color === undefined) {
    bg.color = background;
  }
  if (isPlainObject(backgroundGradient) && validateVisualGradient(backgroundGradient) === null && bg.gradient === undefined) {
    bg.gradient = cloneJson(backgroundGradient);
  }
  if (Object.keys(bg).length > 0) container.background = bg;
  const next: ChartSpec = { ...spec, config: { ...spec.config, theme: rest as ThemeOverrides } };
  if (Object.keys(container).length > 0) next.container = container as ChartContainerFormat;
  return next;
}

// ============================================================================
// Patch -> spec patch (pure)
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The deep-merge patch that turns `before` into `after` under the store's
 * `deepMergeSpec` (plain objects merge, everything else replaces, an explicit
 * `undefined` clears -- the OB-1 explicit clear). A key `after` lacks becomes
 * `undefined`, so a cleared leaf really goes.
 */
function replacementPatch(before: unknown, after: unknown): unknown {
  if (!isPlainObject(after)) return after;
  if (!isPlainObject(before)) return cloneJson(after);
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = after[key];
    if (a === undefined) out[key] = undefined;
    else out[key] = replacementPatch(before[key], a);
  }
  return out;
}

/**
 * Split a container patch into the chart's spec patch: title text -> `title`,
 * title colour / size -> `config.theme`, everything else -> `container`. A
 * leaf `null` clears (back to the chart's default); a cleared title text is
 * "no title" (`title: null`). Returns null when the patch changes nothing.
 */
export function chartSpecPatchFor(spec: ChartSpec, patch: VisualContainerPatch): Partial<ChartSpec> | null {
  const out: Partial<ChartSpec> = {};
  const p = { ...(patch as Record<string, unknown>) };
  const titlePatch = isPlainObject(p.title) ? { ...p.title } : p.title;
  let themeChanged = false;
  const theme: Record<string, unknown> = {};

  if (titlePatch === null) {
    // The whole title group cleared: the container's title style AND the three
    // facts spelled elsewhere go back to their defaults (text: no title).
    out.title = null;
    theme.titleColor = undefined;
    theme.titleFontSize = undefined;
    themeChanged = true;
  } else if (isPlainObject(titlePatch)) {
    if ("text" in titlePatch && titlePatch.text !== undefined) {
      const t = titlePatch.text;
      out.title = typeof t === "string" && t !== "" ? t : null;
    }
    if ("color" in titlePatch && titlePatch.color !== undefined) {
      theme.titleColor = titlePatch.color === null || titlePatch.color === "" ? undefined : titlePatch.color;
      themeChanged = true;
    }
    if ("fontSize" in titlePatch && titlePatch.fontSize !== undefined) {
      theme.titleFontSize = titlePatch.fontSize === null ? undefined : titlePatch.fontSize;
      themeChanged = true;
    }
    delete titlePatch.text;
    delete titlePatch.color;
    delete titlePatch.fontSize;
    if (Object.keys(titlePatch).length > 0) p.title = titlePatch;
    else delete p.title;
  }

  if (themeChanged) out.config = { theme: theme as Record<string, never> } as ChartSpec["config"];

  const containerKeys = Object.keys(p).filter((k) => p[k] !== undefined);
  if (containerKeys.length > 0) {
    const before = spec.container as VisualContainerFormat | undefined;
    const after = applyVisualContainerPatch(before, p as VisualContainerPatch);
    if (after === undefined) {
      if (before !== undefined) out.container = undefined;
    } else {
      out.container = replacementPatch(before, after) as ChartContainerFormat;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ============================================================================
// The re-publish when a container binding changes
// ============================================================================

/** What the re-publish needs (the renderer's cache and the store's regions, injected). */
export interface ChartContainerResyncDeps {
  invalidate(chartId: string): void;
  invalidateAll(): void;
  /** Re-publish the chart regions (each carries its RESOLVED container). */
  sync(): void;
  /** An overlay redraw -- never GRID_REFRESH (WP-D's feedback-loop rule). */
  redraw(): void;
}

/**
 * Re-publish the charts whose CONTAINER bindings changed. The raster bakes the
 * title block in, so each named chart's cache is dropped FIRST (all of them on
 * a reload), then the regions are re-published -- Core paints the resolved
 * container from the region -- and one overlay redraw is asked for (review
 * R2-8). Returns the unsubscribe.
 */
export function installChartContainerResync(deps: ChartContainerResyncDeps): () => void {
  return onContainerBindingsChanged("chart", (ids) => {
    if (ids === "all") deps.invalidateAll();
    else for (const id of ids) deps.invalidate(id);
    deps.sync();
    deps.redraw();
  });
}

// ============================================================================
// The provider
// ============================================================================

/** One refused chart write, as the store's quiet flush reports it. */
export interface ChartFormatFlushFailure {
  chartId: string;
  reason: string;
}

/** What the provider needs from the store, the renderer and the pane (injected by activate()). */
export interface ChartObjectFormatDeps {
  /** The STORED spec (never a live preview's): what a commit starts from and the pane shows. */
  getStoredSpec(chartId: string): ChartSpec | null;
  /** The real edit: a deep-merge patch, persisted by the store's debounced save. */
  updateSpec(chartId: string, patch: Partial<ChartSpec>): void;
  /** A transient edit: no write, no undo, no dirty flag. */
  previewSpec(chartId: string, patch: Partial<ChartSpec>): void;
  /** Put a previewed chart back; answers its id (or null when nothing previewed). */
  restorePreview(): string | null;
  /** Drop the raster cache, re-publish the regions, announce the change, repaint. */
  repaint(chartId: string): void;
  /** Land every pending chart save WITHOUT a dialog; answers the refusals. */
  flushQuietly(): Promise<ChartFormatFlushFailure[]>;
  /** Tell the user about refusals that are not this provider's to report. */
  reportOther(failures: ChartFormatFlushFailure[]): void;
  /** The number formats of a design-query chart's measures. */
  dataFormats?(chartId: string, spec: ChartSpec): Promise<DataFormatField[]>;
  /** The chart's own "Chart elements" card (the retargeting element formatter). */
  elementCard?: ComponentType<FormatCardProps>;
}

/** The undo step a data-format change records. */
export const CHART_DATA_FORMAT_UNDO_LABEL = "Number Format";

/** The chart element card's contribution id (the Format tab's `data-format-card`). */
export const CHART_ELEMENTS_CARD_ID = "chart-elements";

/** Build the `@api/objectFormat` provider registered for region type "chart". */
export function createChartObjectFormatProvider(deps: ChartObjectFormatDeps): ObjectFormatProvider {
  /** Charts whose commits since the last flush this provider owns. */
  const committed = new Set<string>();
  /** The chart a preview of THIS provider is showing. */
  let previewing: string | null = null;

  const specOf = (region: GridRegion): { id: string; spec: ChartSpec } | null => {
    const id = chartIdOfFormatRegion(region);
    if (id === null) return null;
    const spec = deps.getStoredSpec(id);
    return spec ? { id, spec } : null;
  };

  const endPreview = (): void => {
    if (previewing === null) return;
    previewing = null;
    const id = deps.restorePreview();
    if (id !== null) deps.repaint(id);
  };

  return {
    types: ["chart"],

    read(region) {
      const s = specOf(region);
      return s ? readChartContainer(s.spec) : {};
    },

    defaults(region) {
      return chartContainerDefaults(specOf(region)?.spec);
    },

    capabilities(region) {
      return chartContainerCapabilities(specOf(region)?.spec);
    },

    preview(region, patch) {
      const s = specOf(region);
      if (!s) return;
      const specPatch = chartSpecPatchFor(s.spec, patch);
      if (!specPatch) return;
      deps.previewSpec(s.id, specPatch);
      previewing = s.id;
      deps.repaint(s.id);
    },

    endPreview,

    async commit(region, patch) {
      endPreview();
      const s = specOf(region);
      if (!s) throw new Error("The chart no longer exists.");
      const specPatch = chartSpecPatchFor(s.spec, patch);
      if (!specPatch) return;
      deps.updateSpec(s.id, specPatch);
      committed.add(s.id);
      deps.repaint(s.id);
    },

    // `updateSpec` only SCHEDULES the store's 300 ms save: land it inside
    // commitObjectFormat's transaction, or the `update_chart` write and its
    // undo record would close a step of their own after the "Format Object"
    // one (review R1-4).
    async flush() {
      const mine = new Set(committed);
      committed.clear();
      const failures = await deps.flushQuietly();
      const refused = failures.filter((f) => mine.has(f.chartId));
      const other = failures.filter((f) => !mine.has(f.chartId));
      if (other.length > 0) deps.reportOther(other);
      for (const id of mine) deps.repaint(id);
      if (refused.length > 0) {
        const reasons = Array.from(new Set(refused.map((f) => f.reason).filter((r) => r !== "")));
        throw new Error(reasons.join(" ") || "The chart could not be saved.");
      }
    },

    bindingPath(region, field) {
      // Every capability is on for a chart, so the table answers alone.
      return chartIdOfFormatRegion(region) === null ? null : chartContainerBindingPath(field);
    },

    async bindingRef(region): Promise<ObjectBindingRef | null> {
      const id = chartIdOfFormatRegion(region);
      return id !== null && deps.getStoredSpec(id) ? chartBindingRef(id) : null;
    },

    async dataFormats(region) {
      const s = specOf(region);
      if (!s || !isDesignQueryDataSource(s.spec.data) || !deps.dataFormats) return [];
      return deps.dataFormats(s.id, s.spec);
    },

    async setDataFormat(region, key, format) {
      const s = specOf(region);
      if (!s) throw new Error("The chart no longer exists.");
      if (!isDesignQueryDataSource(s.spec.data)) {
        throw new Error("Only a chart that runs a design query has data formats of its own.");
      }
      const current = s.spec.fieldFormats ?? {};
      const next: Record<string, string> = { ...current };
      if (format === null || format === "") delete next[key];
      else next[key] = format;
      const same =
        Object.keys(next).length === Object.keys(current).length &&
        Object.entries(next).every(([k, v]) => current[k] === v);
      if (same) return;
      // ONE undo step, landed before it closes. `fieldFormats` is a map: a
      // removed key is written as an explicit undefined, so it really goes.
      await runInUndoTransaction(CHART_DATA_FORMAT_UNDO_LABEL, async () => {
        deps.updateSpec(s.id, {
          fieldFormats:
            Object.keys(next).length > 0 ? (replacementPatch(current, next) as Record<string, string>) : undefined,
        });
        deps.repaint(s.id);
        const failures = await deps.flushQuietly();
        const refused = failures.filter((f) => f.chartId === s.id);
        const other = failures.filter((f) => f.chartId !== s.id);
        if (other.length > 0) deps.reportOther(other);
        if (refused.length > 0) throw new Error(refused.map((f) => f.reason).join(" "));
      });
    },

    visualCards() {
      return deps.elementCard
        ? [{ id: CHART_ELEMENTS_CARD_ID, title: "Chart elements", order: 0, Component: deps.elementCard }]
        : [];
    },
  };
}

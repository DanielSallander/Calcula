//! FILENAME: app/extensions/ControlsPane/lib/controlsPaneTypes.ts
// PURPOSE: TypeScript types mirroring Rust pane_control types.
// CONTEXT: A pane control is a named, pane-hosted UI control (button, slider,
//          dropdown, checkbox, or custom scripted control). Its published
//          value (ControlValue) is what GET.CONTROLVALUE("name") returns.
//          Pane controls share the Controls-pane strip with ribbon filters
//          (merged `order` number space) — PaneItem is the merged-strip union.
//          Mirrors app/src-tauri/src/pane_control/types.rs.

import type { ControlValue } from "@api/controlValues";
import type { RibbonFilter } from "./filterPaneTypes";

/** Re-export: the engine-owned value union (serde: tag "kind", content "value"). */
export type { ControlValue } from "@api/controlValues";

/** The kind of pane control. Determines the `PaneControlConfig` variant and
 *  what value type the control publishes: button -> none, slider -> number,
 *  dropdown -> text, checkbox -> boolean, custom -> script-defined. */
export type PaneControlType =
  | "button"
  | "slider"
  | "dropdown"
  | "checkbox"
  | "custom";

/** Where a dropdown pane control gets its item list (v1: static list or a
 *  cell range; model-column sources are what a Filter item is for). */
export type DropdownSource =
  | { type: "static"; items: string[] }
  | { type: "cellRange"; reference: string };

/** An optional chart-parameter binding: value changes (including transient
 *  drag frames) drive the chart param via @api/chartParams. */
export interface ChartParamTarget {
  chartId: string;
  param: string;
}

/** Per-type configuration for a pane control, internally tagged on "type"
 *  (mirrors Rust `PaneControlConfig`, camelCase wire form). */
export type PaneControlConfig =
  | { type: "button"; label: string }
  | {
      type: "slider";
      min: number;
      max: number;
      step: number;
      showValue: boolean;
      chartParamTarget?: ChartParamTarget;
    }
  | {
      type: "dropdown";
      source: DropdownSource;
      placeholder: string | null;
      chartParamTarget?: ChartParamTarget;
    }
  | { type: "checkbox"; label: string }
  | { type: "custom"; properties: Record<string, string> };

/** A pane control — a named control card in the Controls pane. */
export interface PaneControl {
  /** Unique control id (EntityId uuid string). */
  id: string;
  /** Display name — the GET.CONTROLVALUE lookup key. Unique
   *  CASE-INSENSITIVELY across pane controls AND ribbon filters. */
  name: string;
  /** The control kind (matches the `config` variant). */
  controlType: PaneControlType;
  /** Per-type configuration. */
  config: PaneControlConfig;
  /** The control's current published value. null for value-less controls
   *  (buttons) or controls that have not published a value yet. */
  value: ControlValue | null;
  /** Position in the Controls-pane strip. Shares the number space with
   *  `RibbonFilter.order` (the frontend merge-sorts both lists). */
  order: number;
}

/** Parameters for creating a new pane control. */
export interface CreatePaneControlParams {
  name: string;
  controlType: PaneControlType;
  config: PaneControlConfig;
  /** Optional initial value (e.g. a checkbox starting checked). */
  value?: ControlValue | null;
  /** Explicit strip position; null/omitted appends after every existing
   *  pane control AND ribbon filter (max order + 1). */
  order?: number | null;
}

/** Parameters for updating pane control properties (all optional; value
 *  changes go through the dedicated set_pane_control_value command). */
export interface UpdatePaneControlParams {
  name?: string;
  config?: PaneControlConfig;
  order?: number;
}

/** One entry of the merged Controls-pane strip: a ribbon filter or a pane
 *  control, carrying its shared-number-space `order` for merge-sorting. */
export type PaneItem =
  | { kind: "filter"; filter: RibbonFilter; order: number }
  | { kind: "control"; control: PaneControl; order: number };

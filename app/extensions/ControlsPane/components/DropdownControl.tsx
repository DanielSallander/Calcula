//! FILENAME: app/extensions/ControlsPane/components/DropdownControl.tsx
// PURPOSE: Single-select dropdown body for a pane control card. Items come
//          from the config's source: a static list, or a cell range read via
//          the @api CellRange facade (display strings, empties skipped),
//          re-read on the "grid:refresh" window event and on open. A range
//          names its sheet ("Data!A1:A5") and is read from THAT sheet only: a
//          name no sheet answers to, or a #REF! source, lists nothing
//          (lib/dropdownCellRangeSource.ts).
// CONTEXT: Selecting an item commits { kind: "text" } (one backend write, one
//          undo entry, one GET.CONTROLVALUE dependent recalc).
//
//          Drawn by the @api Dropdown — the value picker of the control
//          grammar: a 28px token trigger and a card Popover listbox with the
//          listbox keyboard model (arrows, Home/End, type-ahead). It replaced
//          a hand-rolled position:fixed portal list with its own outside-click
//          and Escape listeners; the Popover owns dismissal now.

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Dropdown, useSurfaceLayout } from "@api/layout";
import type { DropdownOption } from "@api/layout";
import { setChartParamValue } from "@api/chartParams";
import type { ControlValue } from "@api/controlValues";
import type { PaneControl } from "../lib/controlsPaneTypes";
import { commitValue } from "../lib/controlsPaneStore";
import { loadCellRangeItems } from "../lib/dropdownCellRangeSource";

type DropdownConfig = Extract<PaneControl["config"], { type: "dropdown" }>;

const FALLBACK_CONFIG: DropdownConfig = {
  type: "dropdown",
  source: { type: "static", items: [] },
  placeholder: null,
};

/** Band trigger width: fills a card at its minimum width. */
const BAND_TRIGGER_WIDTH = 140;

/** Keys that open the list from the trigger (and so re-read a range). */
const OPEN_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " "]);

/** The placeholder row's value when a source has no items. It is only ever
 *  offered when there are NO real items, so it cannot shadow one. */
const NO_ITEMS_VALUE = "__controls_pane_no_items__";

interface Props {
  control: PaneControl;
}

export function DropdownControl({ control }: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const config: DropdownConfig =
    control.config.type === "dropdown" ? control.config : FALLBACK_CONFIG;
  const { source } = config;
  const placeholder = config.placeholder ?? "Select...";

  const committedText =
    control.value?.kind === "text" ? control.value.value : null;

  const [selected, setSelected] = useState<string | null>(committedText);
  const [items, setItems] = useState<string[]>(
    source.type === "static" ? source.items.filter((i) => i !== "") : [],
  );
  const wrapperRef = useRef<HTMLSpanElement>(null);
  // Guards stale async range reads (source changed / unmounted mid-flight).
  const loadSeqRef = useRef(0);

  // Sync local selection when the value changes externally (undo, script).
  useEffect(() => {
    setSelected(committedText);
  }, [committedText]);

  const loadItems = useCallback(() => {
    if (source.type === "static") {
      setItems(source.items.filter((i) => i !== ""));
      return;
    }
    const seq = ++loadSeqRef.current;
    loadCellRangeItems(source.reference)
      .then((loaded) => {
        if (loadSeqRef.current === seq) setItems(loaded);
      })
      .catch(() => {
        // Invalid reference or read failure — show an empty list rather
        // than breaking the card.
        if (loadSeqRef.current === seq) setItems([]);
      });
  }, [source]);

  // Load on mount / when the source config changes; cell-range sources
  // re-read whenever the grid refreshes (edits, undo, script writes).
  useEffect(() => {
    loadItems();
    if (source.type !== "cellRange") return;
    const onGridRefresh = () => loadItems();
    window.addEventListener("grid:refresh", onGridRefresh);
    return () => {
      window.removeEventListener("grid:refresh", onGridRefresh);
    };
  }, [loadItems, source.type]);

  // Cell-range sources: re-read when the list is being OPENED so it is always
  // fresh. The Dropdown owns its open state, so the opening gesture is read
  // at the trigger — a press or an opening key that lands on the trigger
  // itself. React events from the portalled list bubble here too; the DOM
  // containment test keeps a click on an option from triggering a re-read.
  const refreshOnOpen = useCallback(
    (target: EventTarget | null) => {
      if (source.type !== "cellRange") return;
      if (!(target instanceof Node) || !wrapperRef.current?.contains(target)) return;
      loadItems();
    },
    [source.type, loadItems],
  );

  // Optional chart-param binding (D9/Phase 7): a selection also drives the
  // bound chart param (numeric strings as numbers — params bound to axis
  // domains need numbers, not text).
  const chartTarget = config.chartParamTarget;

  const handleSelect = useCallback(
    (value: string) => {
      setSelected(value);
      const committed: ControlValue = { kind: "text", value };
      void commitValue(control.id, committed);
      if (chartTarget) {
        const n = Number(value);
        setChartParamValue(
          chartTarget.chartId,
          chartTarget.param,
          value.trim() !== "" && !Number.isNaN(n) ? n : value,
        );
      }
    },
    [control.id, chartTarget],
  );

  // An empty source still opens to a visible "No items" row (disabled, so it
  // can never be chosen), as the old list did.
  const options: DropdownOption<string>[] = useMemo(
    () =>
      items.length === 0
        ? [{ value: NO_ITEMS_VALUE, label: "No items", disabled: true }]
        : items.map((item) => ({ value: item, label: item })),
    [items],
  );

  const hasSelection = selected !== null && selected !== "";

  // A committed value that is not (or no longer) in the list still shows on
  // the trigger, exactly as the old hand-rolled trigger did: the Dropdown
  // shows its placeholder when the value matches no option, so the value
  // itself is offered as that text.
  const inList = hasSelection && items.includes(selected as string);
  const triggerText = hasSelection && !inList ? (selected as string) : placeholder;

  return (
    <span
      ref={wrapperRef}
      style={styles.wrapper}
      title={hasSelection ? (selected as string) : placeholder}
      onPointerDownCapture={(e) => refreshOnOpen(e.target)}
      onKeyDownCapture={(e) => {
        if (OPEN_KEYS.has(e.key)) refreshOnOpen(e.target);
      }}
    >
      <Dropdown<string>
        value={hasSelection ? (selected as string) : ""}
        options={options}
        onChange={handleSelect}
        placeholder={triggerText}
        width={band ? BAND_TRIGGER_WIDTH : undefined}
        ariaLabel={control.name}
        optionTestIdPrefix="controls-pane-dropdown-option-"
      />
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    alignItems: "center",
    flex: 1,
    minWidth: 0,
  },
};

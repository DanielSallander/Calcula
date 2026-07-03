//! FILENAME: app/extensions/ControlsPane/components/DropdownControl.tsx
// PURPOSE: Single-select dropdown body for a pane control card. Items come
//          from the config's source: a static list, or a cell range read via
//          the @api CellRange facade (display strings, empties skipped),
//          re-read on the "grid:refresh" window event and on open.
// CONTEXT: Selecting an item commits { kind: "text" } (one backend write, one
//          undo entry, one GET.CONTROLVALUE dependent recalc). The item list
//          renders in a portal above the grid canvas (position: fixed,
//          zIndex 10000 — the FilterDropdown idiom), never a bare <select>.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CellRange, getSheets } from "@api";
import { useSurfaceLayout } from "@api/layout";
import { setChartParamValue } from "@api/chartParams";
import type { ControlValue } from "@api/controlValues";
import type { PaneControl } from "../lib/controlsPaneTypes";
import { commitValue } from "../lib/controlsPaneStore";

type DropdownConfig = Extract<PaneControl["config"], { type: "dropdown" }>;

const FALLBACK_CONFIG: DropdownConfig = {
  type: "dropdown",
  source: { type: "static", items: [] },
  placeholder: null,
};

/** Cap cell-range reads so a whole-column reference stays cheap. */
const MAX_RANGE_CELLS = 1000;

const LIST_MIN_WIDTH = 160;
const LIST_MAX_HEIGHT = 240;

/**
 * Read a cell-range source's items: display strings in range order
 * (row-major), empties skipped. An explicit "Sheet!" prefix is resolved to
 * its sheet index (CellRange parses but does not resolve sheet names);
 * unknown sheet names fall back to the active sheet.
 */
async function loadCellRangeItems(reference: string): Promise<string[]> {
  let sheetIndex: number | undefined;
  const bangIdx = reference.lastIndexOf("!");
  if (bangIdx !== -1) {
    const sheetName = reference
      .substring(0, bangIdx)
      .trim()
      .replace(/^'+|'+$/g, "");
    const result = await getSheets();
    const match = result.sheets.find(
      (s: { index: number; name: string }) =>
        s.name.toLowerCase() === sheetName.toLowerCase(),
    );
    if (match) sheetIndex = match.index;
  }

  let range = CellRange.fromAddress(reference, sheetIndex);
  if (range.cellCount > MAX_RANGE_CELLS) {
    const rows = Math.max(1, Math.floor(MAX_RANGE_CELLS / range.colCount));
    range = range.resize(rows, range.colCount);
  }

  const values = await range.getValues();
  const items: string[] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const display = values.get(`${r},${c}`)?.display ?? "";
      if (display !== "") items.push(display);
    }
  }
  return items;
}

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
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closedAtRef = useRef(0);
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

  const toggleOpen = useCallback(() => {
    // Same close/reopen guard as RibbonFilterCard's dropdown arrow.
    if (Date.now() - closedAtRef.current < 200) return;
    if (!open && triggerRef.current) {
      setAnchorRect(triggerRef.current.getBoundingClientRect());
      // Cell-range sources: re-read on open so the list is always fresh.
      if (source.type === "cellRange") loadItems();
    }
    setOpen((prev) => !prev);
  }, [open, source.type, loadItems]);

  const handleClose = useCallback(() => {
    closedAtRef.current = Date.now();
    setOpen(false);
  }, []);

  // Optional chart-param binding (D9/Phase 7): a selection also drives the
  // bound chart param (numeric strings as numbers — params bound to axis
  // domains need numbers, not text).
  const chartTarget = config.chartParamTarget;

  const handleSelect = useCallback(
    (value: string) => {
      setSelected(value);
      handleClose();
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
    [control.id, handleClose, chartTarget],
  );

  // Close on outside click (delayed registration, FilterDropdown pattern).
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      handleClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open, handleClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleClose]);

  const hasSelection = selected !== null && selected !== "";

  // List geometry: below the trigger, at least as wide as the trigger,
  // clamped to the viewport.
  const listWidth = Math.max(anchorRect?.width ?? 0, LIST_MIN_WIDTH);
  const listTop = (anchorRect?.bottom ?? 0) + 2;
  const listLeft = Math.min(
    anchorRect?.left ?? 0,
    window.innerWidth - listWidth - 8,
  );

  return (
    <>
      <button
        ref={triggerRef}
        style={{
          ...styles.trigger,
          fontSize: band ? "11px" : "12px",
        }}
        onClick={toggleOpen}
        title={hasSelection ? (selected as string) : placeholder}
      >
        <span
          style={{
            ...styles.triggerText,
            ...(hasSelection ? {} : styles.placeholderText),
          }}
        >
          {hasSelection ? selected : placeholder}
        </span>
        <span style={styles.arrow}>{open ? "▲" : "▼"}</span>
      </button>

      {open &&
        anchorRect &&
        createPortal(
          <div
            ref={listRef}
            style={{
              ...styles.list,
              left: listLeft,
              top: listTop,
              width: listWidth,
            }}
          >
            {items.map((item, i) => (
              <button
                key={`${item}-${i}`}
                style={{
                  ...styles.item,
                  ...(item === selected ? styles.itemSelected : {}),
                }}
                onClick={() => handleSelect(item)}
              >
                {item}
              </button>
            ))}
            {items.length === 0 && <div style={styles.noItems}>No items</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    width: "100%",
    minWidth: 0,
    padding: "3px 6px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    background: "#f9fafb",
    color: "#333",
    cursor: "pointer",
    textAlign: "left",
    boxSizing: "border-box",
  },
  triggerText: {
    flex: 1,
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  placeholderText: {
    color: "#8a8a8a",
    fontStyle: "italic",
  },
  arrow: {
    fontSize: "9px",
    color: "#555",
    flexShrink: 0,
  },
  list: {
    position: "fixed",
    maxHeight: LIST_MAX_HEIGHT,
    overflowY: "auto",
    backgroundColor: "#fff",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    zIndex: 10000,
    display: "flex",
    flexDirection: "column",
    padding: "4px 0",
    boxSizing: "border-box",
  },
  item: {
    display: "block",
    width: "100%",
    border: "none",
    background: "none",
    cursor: "pointer",
    textAlign: "left",
    padding: "4px 12px",
    fontSize: 12,
    color: "#333",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemSelected: {
    background: "#edf4fc",
    fontWeight: 600,
  },
  noItems: {
    padding: "6px 12px",
    color: "#999",
    fontStyle: "italic",
    fontSize: 12,
  },
};

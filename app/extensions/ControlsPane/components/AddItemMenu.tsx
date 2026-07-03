//! FILENAME: app/extensions/ControlsPane/components/AddItemMenu.tsx
// PURPOSE: The Controls pane's "+" button: a small popup menu offering every
//          addable item kind. "Filter..." opens the Add Filter dialog (BI-only,
//          disabled with a tooltip when the workbook has no model connections);
//          the five control kinds open the Add Control dialog pre-set to the
//          picked type.
// CONTEXT: Portal menu with the pane's shared popover idiom (position: fixed,
//          zIndex 10000, outside-click + Escape close, 200ms reopen guard —
//          see ControlCard's context menu / FilterDropdown).

import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { showDialog } from "@api";
import { Button } from "@api/layout";
import { getBiConnections } from "../lib/filterPaneApi";
import type { PaneControlType } from "../lib/controlsPaneTypes";
import { ADD_FILTER_DIALOG_ID, ADD_CONTROL_DIALOG_ID } from "../manifest";

const MENU_WIDTH = 160;

const NO_CONNECTION_TOOLTIP =
  "Requires a model connection (Data > Business Intelligence)";

const CONTROL_ITEMS: Array<{ label: string; controlType: PaneControlType }> = [
  { label: "Button", controlType: "button" },
  { label: "Slider", controlType: "slider" },
  { label: "Dropdown", controlType: "dropdown" },
  { label: "Checkbox", controlType: "checkbox" },
  { label: "Custom...", controlType: "custom" },
];

export function AddItemMenu(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // null = still loading (Filter... stays disabled until connections confirm).
  const [hasConnections, setHasConnections] = useState<boolean | null>(null);
  const closedAtRef = useRef(0);

  const toggleMenu = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      // If the menu was just closed by an outside click (<200ms ago), the user
      // intended to close, not toggle (same guard as the pane's other popovers).
      if (Date.now() - closedAtRef.current < 200) return;
      if (!open) {
        setAnchor(e.currentTarget.getBoundingClientRect());
      }
      setOpen((prev) => !prev);
    },
    [open],
  );

  const handleClose = useCallback(() => {
    closedAtRef.current = Date.now();
    setOpen(false);
  }, []);

  // Check for model connections whenever the menu opens (the Filter item is
  // BI-only — same source the Add Filter dialog lists).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHasConnections(null);
    getBiConnections()
      .then((conns) => {
        if (!cancelled) setHasConnections(conns.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleAddFilter = useCallback(() => {
    handleClose();
    showDialog(ADD_FILTER_DIALOG_ID);
  }, [handleClose]);

  const handleAddControl = useCallback(
    (controlType: PaneControlType) => {
      handleClose();
      showDialog(ADD_CONTROL_DIALOG_ID, { controlType });
    },
    [handleClose],
  );

  return (
    <>
      <Button
        title="Add a filter or control"
        onClick={toggleMenu}
        style={styles.addButton}
      >
        <span style={styles.addIcon}>+</span>
      </Button>
      {open && anchor && (
        <AddItemMenuPopup
          anchorRect={anchor}
          filterEnabled={hasConnections === true}
          onAddFilter={handleAddFilter}
          onAddControl={handleAddControl}
          onClose={handleClose}
        />
      )}
    </>
  );
}

function AddItemMenuPopup({
  anchorRect,
  filterEnabled,
  onAddFilter,
  onAddControl,
  onClose,
}: {
  anchorRect: DOMRect;
  filterEnabled: boolean;
  onAddFilter: () => void;
  onAddControl: (controlType: PaneControlType) => void;
  onClose: () => void;
}): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click (delayed registration so the opening click does
  // not immediately close it — the FilterDropdown pattern).
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const top = anchorRect.bottom + 2;
  const left = Math.min(anchorRect.left, window.innerWidth - MENU_WIDTH - 8);

  return createPortal(
    <div ref={menuRef} style={{ ...styles.menu, left, top }}>
      <button
        style={{
          ...styles.menuItem,
          ...(filterEnabled ? {} : styles.menuItemDisabled),
        }}
        disabled={!filterEnabled}
        title={filterEnabled ? undefined : NO_CONNECTION_TOOLTIP}
        onClick={onAddFilter}
      >
        Filter...
      </button>
      <div style={styles.menuDivider} />
      {CONTROL_ITEMS.map((item) => (
        <button
          key={item.controlType}
          style={styles.menuItem}
          onClick={() => onAddControl(item.controlType)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

const styles: Record<string, React.CSSProperties> = {
  addButton: {
    width: 28,
    flexShrink: 0,
  },
  addIcon: {
    fontWeight: "bold",
    fontSize: "16px",
    lineHeight: 1,
  },
  menu: {
    position: "fixed",
    width: MENU_WIDTH,
    backgroundColor: "#fff",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    zIndex: 10000,
    display: "flex",
    flexDirection: "column",
    fontSize: 12,
    color: "#333",
    padding: "4px 0",
    boxSizing: "border-box",
  },
  menuItem: {
    display: "block",
    width: "100%",
    border: "none",
    background: "none",
    cursor: "pointer",
    textAlign: "left",
    padding: "6px 12px",
    fontSize: 12,
    color: "#333",
  },
  menuItemDisabled: {
    color: "#aaa",
    cursor: "default",
  },
  menuDivider: {
    height: "1px",
    background: "#e5e7eb",
    margin: "2px 0",
  },
};

//! FILENAME: app/extensions/Controls/components/ControlContextMenu.tsx
// PURPOSE: The right-click menu for an on-grid control (button, shape, picture).
// CONTEXT: Precedent FloatingRange/components/FloatingRangeContextMenu.tsx and
//          Charts/components/ChartContextMenu.tsx — an overlay in the "dropdown"
//          layer, shown by the extension's own capture-phase contextmenu
//          listener. It exists because Core refuses to open the grid's CELL menu
//          over a floating object (Spreadsheet.tsx: "Cell options on an object
//          right-click are always wrong"), which left every Controls item with
//          no renderer at all. The item MODEL lives in lib/controlContextMenu.ts;
//          this file only paints it, so a rule about WHICH items apply is never
//          re-decided here.

import React, { useEffect, useRef, useState } from "react";
import { css } from "@emotion/css";
import type { OverlayProps } from "@api/uiTypes";
import { getFloatingControl } from "../lib/floatingStore";
import type { ControlMenuItem } from "../lib/controlContextMenu";

const styles = {
  menu: css`
    position: fixed;
    z-index: 10000;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    min-width: 190px;
    padding: 4px 0;
    font-size: 12px;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  `,
  item: css`
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 6px 16px;
    cursor: pointer;
    white-space: nowrap;
    color: #333;

    &:hover {
      background: #e8f0fe;
    }
  `,
  destructive: css`
    color: #b42318;
  `,
  shortcut: css`
    color: #999;
    font-size: 11px;
  `,
  chevron: css`
    color: #999;
    font-size: 11px;
  `,
  divider: css`
    border-top: 1px solid #e8e8e8;
    margin: 4px 0;
  `,
  header: css`
    padding: 4px 16px 2px;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  submenu: css`
    position: absolute;
    top: -4px;
    left: 100%;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    min-width: 170px;
    padding: 4px 0;
  `,
};

/** Rough per-item height + padding, for keeping the menu inside the viewport. */
const ITEM_H = 29;
const CHROME_H = 34;
const MENU_W = 210;

/** What the user calls this object — the header the menu is titled with. */
function controlKindLabel(controlType: string): string {
  if (controlType === "shape") return "Shape";
  if (controlType === "image") return "Picture";
  if (controlType === "button") return "Button";
  return controlType;
}

export function ControlContextMenu({
  onClose,
  data,
}: OverlayProps): React.ReactElement | null {
  const controlId = typeof data?.controlId === "string" ? data.controlId : null;
  const screenX = typeof data?.screenX === "number" ? data.screenX : null;
  const screenY = typeof data?.screenY === "number" ? data.screenY : null;
  const items = Array.isArray(data?.items) ? (data.items as ControlMenuItem[]) : [];

  const menuRef = useRef<HTMLDivElement>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);

  // Close on outside click. The 50 ms delay is the Charts precedent: without it
  // the very mousedown that opened the menu closes it again.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = window.setTimeout(
      () => document.addEventListener("mousedown", handler, true),
      50,
    );
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler, true);
    };
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  const ctrl = controlId ? getFloatingControl(controlId) : null;
  if (!ctrl || screenX === null || screenY === null || items.length === 0) return null;

  const height = items.length * ITEM_H + CHROME_H;

  const runItem = (item: ControlMenuItem) => {
    // Close FIRST: Edit Script and Apply Template open their own dialog, and a
    // menu still mounted underneath it steals the outside-click that dismisses
    // the dialog.
    onClose();
    item.run();
  };

  return (
    <div
      ref={menuRef}
      data-control-context-menu=""
      className={styles.menu}
      style={{
        left: Math.min(screenX, window.innerWidth - MENU_W),
        top: Math.max(4, Math.min(screenY, window.innerHeight - height - 4)),
      }}
    >
      <div className={styles.header}>{controlKindLabel(ctrl.controlType)}</div>
      {items.map((item) => (
        <React.Fragment key={item.id}>
          <div
            className={`${styles.item}${item.destructive ? ` ${styles.destructive}` : ""}`}
            data-control-menu-item={item.id}
            onMouseEnter={() => setOpenSubmenuId(item.children ? item.id : null)}
            onClick={() => {
              if (item.children) return; // The submenu is the action.
              runItem(item);
            }}
          >
            <span>{item.label}</span>
            {item.children ? (
              <span className={styles.chevron}>{"›"}</span>
            ) : item.shortcut ? (
              <span className={styles.shortcut}>{item.shortcut}</span>
            ) : null}
            {item.children && openSubmenuId === item.id ? (
              <div className={styles.submenu}>
                {item.children.map((child) => (
                  <div
                    key={child.id}
                    className={styles.item}
                    data-control-menu-item={child.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      runItem(child);
                    }}
                  >
                    <span>{child.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {item.separatorAfter ? <div className={styles.divider} /> : null}
        </React.Fragment>
      ))}
    </div>
  );
}

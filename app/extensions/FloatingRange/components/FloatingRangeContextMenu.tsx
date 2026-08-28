//! FILENAME: app/extensions/FloatingRange/components/FloatingRangeContextMenu.tsx
// PURPOSE: The floating range's own object right-click menu.
// CONTEXT: Precedent Charts/components/ChartContextMenu.tsx — an overlay in the
//          "dropdown" layer, shown by the extension's capture-phase contextmenu
//          listener. It exists because Core refuses to open the grid's CELL
//          menu over a floating object (Spreadsheet.tsx: "Cell options on an
//          object right-click are always wrong"), which left the FR's items
//          with no renderer at all. The item MODEL lives in lib/frContextMenu.ts;
//          this file only paints it.

import React, { useEffect, useRef } from "react";
import { css } from "@emotion/css";
import type { OverlayProps } from "@api/uiTypes";
import { getFloatingRangeById } from "../lib/floatingRangeStore";
import type { FrMenuItem } from "../lib/frContextMenu";

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
};

/** Rough per-item height + padding, for keeping the menu inside the viewport. */
const ITEM_H = 29;
const CHROME_H = 34;

export function FloatingRangeContextMenu({
  onClose,
  data,
}: OverlayProps): React.ReactElement | null {
  const frId = typeof data?.frId === "string" ? data.frId : null;
  const screenX = typeof data?.screenX === "number" ? data.screenX : null;
  const screenY = typeof data?.screenY === "number" ? data.screenY : null;
  const items = Array.isArray(data?.items) ? (data.items as FrMenuItem[]) : [];

  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click. The 50 ms delay is the Charts precedent: without
  // it the very mousedown that opened the menu closes it again.
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

  const entry = frId ? getFloatingRangeById(frId) : null;
  if (!entry || screenX === null || screenY === null) return null;

  const visible = items.filter((item) => item.enabled);
  const height = visible.length * ITEM_H + CHROME_H;

  return (
    <div
      ref={menuRef}
      data-fr-context-menu=""
      className={styles.menu}
      style={{
        left: Math.min(screenX, window.innerWidth - 210),
        top: Math.max(4, Math.min(screenY, window.innerHeight - height - 4)),
      }}
    >
      <div className={styles.header}>{entry.name}</div>
      {visible.map((item) => (
        <React.Fragment key={item.id}>
          <div
            className={`${styles.item}${item.destructive ? ` ${styles.destructive}` : ""}`}
            data-fr-menu-item={item.id}
            onClick={() => {
              // Close FIRST: rename/delete open their own modal dialog, and a
              // menu still mounted underneath it steals the outside-click.
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut ? (
              <span className={styles.shortcut}>{item.shortcut}</span>
            ) : null}
          </div>
          {item.separatorAfter ? <div className={styles.divider} /> : null}
        </React.Fragment>
      ))}
    </div>
  );
}

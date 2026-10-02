//! FILENAME: app/extensions/BuiltIn/ObjectPosition/components/GripMenu.tsx
// PURPOSE: The small menu a click on an object's six-dot GRIP opens (BUG-0258
//          design phase 5b): "Size and Position..." first -- the no-drag route
//          WCAG 2.2 SC 2.5.7 requires -- then whatever other extensions
//          register for the grip (@api/objectPosition `objectGripMenuItems`;
//          the canvas adds Bring Forward, Send Backward and Lock).
// CONTEXT: Shown as an overlay ("dropdown" layer) by this extension's
//          `floatingObject:gripClick` listener, anchored under the grip's hit
//          square (Core hands its CLIENT rectangle in the event).
//
//          Keyboard: it takes focus when it opens (so the grid's own keys and
//          the canvas's Escape binding, which ask whether the GRID is focused,
//          stand down), and its session-scoped capture listeners give it the
//          menu keys -- ArrowUp / ArrowDown / Home / End move between the
//          enabled rows, Enter or Space runs one, Escape closes it -- each
//          CONSUMED, so nothing behind the menu hears it. A mousedown outside
//          it closes it. Focus goes back to where it was (the grid) when it
//          closes, unless the user clicked somewhere else.
//
//          It closes by itself when its object stops being published (deleted,
//          or the sheet changed under it).

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OverlayProps } from "@api/uiTypes";
import { LT } from "@api/layout";
import { getGridRegions, onRegionChange, type GridRegion } from "@api/gridOverlays";
import { noteObjectGripMenuOpen, objectGripMenuItems, sizeAndPositionMenuEntry } from "@api/objectPosition";

/** The overlay's id in the overlay registry. */
export const GRIP_MENU_ID = "objectPosition:gripMenu";

/** One row of the menu. */
interface GripMenuRow {
  id: string;
  label: string;
  enabled: boolean;
  /** Shown as the row's tooltip (why a row is disabled or read-only). */
  title?: string;
  /** Draw a rule under this row. */
  separatorAfter?: boolean;
  run(): void;
}

/** Gap between the grip and the menu, in px. */
const GAP = 2;

function regionOf(regionId: string | null): GridRegion | null {
  if (!regionId) return null;
  return getGridRegions().find((r) => r.id === regionId) ?? null;
}

/** The rows for `region`: Size and Position first, then every registered grip item. */
export function gripMenuRows(region: GridRegion): GripMenuRow[] {
  const sizePos = sizeAndPositionMenuEntry(region);
  const others = objectGripMenuItems(region);
  const rows: GripMenuRow[] = [
    {
      id: sizePos.id,
      label: sizePos.label,
      enabled: !sizePos.disabled,
      title: sizePos.reason ?? undefined,
      separatorAfter: others.length > 0,
      run: sizePos.run,
    },
  ];
  for (const item of others) rows.push({ id: item.id, label: item.label, enabled: item.enabled, run: item.run });
  return rows;
}

/** The next ENABLED row from `from` in `direction` (wrapping), or -1 when none is. */
export function nextEnabledRow(rows: readonly { enabled: boolean }[], from: number, direction: 1 | -1): number {
  const n = rows.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + direction * step) % n) + n) % n;
    if (rows[i].enabled) return i;
  }
  return -1;
}

export function GripMenu({ onClose, data, anchorRect }: OverlayProps): React.ReactElement | null {
  const regionId = typeof data?.regionId === "string" ? data.regionId : null;
  // Keyed by the object: a re-open for ANOTHER object while the overlay is
  // still shown starts fresh (top row active, focus taken again).
  return <GripMenuBody key={regionId ?? ""} regionId={regionId} onClose={onClose} anchorRect={anchorRect} />;
}

function GripMenuBody({
  regionId,
  onClose,
  anchorRect,
}: {
  regionId: string | null;
  onClose: () => void;
  anchorRect: OverlayProps["anchorRect"];
}): React.ReactElement | null {
  const region = regionOf(regionId);
  const rows = region ? gripMenuRows(region) : [];
  const menuRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() => nextEnabledRow(rows, -1, 1));

  // The live rows for the key handler (it is bound once per open).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const activeRef = useRef(active);
  activeRef.current = active;

  const runRow = (row: GripMenuRow | undefined) => {
    if (!row || !row.enabled) return;
    // Close FIRST: the row may open a dialog, which must not fight this menu
    // for focus or for the outside-click that dismisses it.
    onClose();
    row.run();
  };
  const runRowRef = useRef(runRow);
  runRowRef.current = runRow;

  // Focus: the menu takes it, and gives it back when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = menuRef.current;
    el?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const menuHadFocus = now === null || now === document.body || (el?.contains(now) ?? false);
      if (menuHadFocus && previous && previous.isConnected && previous !== document.body) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  // The menu's keys, consumed (capture, on document: a session-scoped listener
  // that exists only while the menu is open).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const list = rowsRef.current;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          e.stopPropagation();
          const next = nextEnabledRow(list, activeRef.current, e.key === "ArrowDown" ? 1 : -1);
          if (next >= 0) setActive(next);
          return;
        }
        case "Home":
        case "End": {
          e.preventDefault();
          e.stopPropagation();
          const next = e.key === "Home" ? nextEnabledRow(list, -1, 1) : nextEnabledRow(list, list.length, -1);
          if (next >= 0) setActive(next);
          return;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          e.stopPropagation();
          runRowRef.current(list[activeRef.current]);
          return;
        }
        default:
          return;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    // While these keys are the menu's, say so: an inner keyboard focus (a
    // slicer's, a timeline's) listens on WINDOW capture, which runs before
    // this, and stands down on `isObjectGripMenuOpen` (M8 S7).
    const closed = noteObjectGripMenuOpen();
    return () => {
      closed();
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  // A mousedown outside closes it -- attached after the click that opened it.
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", onPointerDown, true), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [onClose]);

  // Its object gone (deleted, another sheet): nothing left to act on.
  useEffect(() => {
    if (!regionId) return;
    return onRegionChange((regions) => {
      if (!regions.some((r) => r.id === regionId)) onClose();
    });
  }, [regionId, onClose]);

  // Keep the whole menu on screen, from its measured box: under the grip,
  // flipped above it when there is no room below.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !anchorRect) return;
    const { width, height } = el.getBoundingClientRect();
    let top = anchorRect.y + anchorRect.height + GAP;
    if (top + height > window.innerHeight) top = anchorRect.y - height - GAP;
    const left = Math.min(anchorRect.x, window.innerWidth - width - 4);
    el.style.left = `${Math.max(0, left)}px`;
    el.style.top = `${Math.max(0, top)}px`;
  });

  if (!region || rows.length === 0) return null;
  const at = anchorRect ?? { x: 0, y: 0, width: 0, height: 0 };

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label="Object"
      data-object-grip-menu={region.id}
      style={{ ...styles.menu, left: at.x, top: at.y + at.height + GAP }}
    >
      {rows.map((row, i) => (
        <React.Fragment key={row.id}>
          <div
            role="menuitem"
            aria-disabled={!row.enabled}
            data-grip-menu-item={row.id}
            data-active={i === active ? "true" : undefined}
            title={row.title}
            style={{
              ...styles.item,
              ...(row.enabled ? null : styles.disabled),
              ...(i === active && row.enabled ? styles.active : null),
            }}
            onMouseEnter={() => {
              if (row.enabled) setActive(i);
            }}
            onClick={() => runRow(row)}
          >
            {row.label}
          </div>
          {row.separatorAfter && <div role="separator" style={styles.separator} />}
        </React.Fragment>
      ))}
    </div>
  );
}

// ============================================================================
// Styles (theme tokens only)
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  menu: {
    position: "fixed",
    zIndex: 10000,
    minWidth: 180,
    padding: "4px 0",
    background: LT.surface,
    border: `1px solid ${LT.border}`,
    borderRadius: LT.radiusControl,
    boxShadow: LT.shadowPopover,
    color: LT.text,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: "12px",
    outline: "none",
  },
  item: {
    padding: "6px 16px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  active: {
    background: LT.menuHover,
  },
  disabled: {
    color: LT.textTertiary,
    cursor: "default",
  },
  separator: {
    height: 1,
    margin: "4px 0",
    background: LT.border,
  },
};

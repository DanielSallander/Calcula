// FILENAME: app/extensions/ModelEditor/components/TopBarMenu.tsx
// PURPOSE: The "Model" dropdown in the editor's top bar.
// CONTEXT: The bar carried SEVEN visually identical bordered buttons — New
//          Model…, Import…, Export…, Undo, Redo, Command Line — so nothing in
//          it had rank and the two that are used constantly (undo/redo) looked
//          exactly like the three that are used once a month. The rare,
//          model-FILE actions collapse in here; the frequent ones stay out as
//          icons.
//
//          Deliberately not a native <select>: these are commands, not a
//          value, and a select that fires on change and then snaps back reads
//          as a broken control.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { styles } from "./editorShared";
import { ME, SHADOW } from "./theme";

export interface TopBarMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  /** Draws a separator ABOVE this item. */
  separatorBefore?: boolean;
}

const menuStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 2,
  minWidth: 220,
  background: ME.surface,
  border: `1px solid ${ME.border}`,
  borderRadius: 6,
  boxShadow: SHADOW.popover,
  padding: 4,
  zIndex: 900,
};

const itemStyle = (disabled: boolean): React.CSSProperties => ({
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 12,
  fontFamily: "inherit",
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: disabled ? ME.textOff : ME.text,
  cursor: disabled ? "default" : "pointer",
});

export function TopBarMenu({
  label,
  items,
}: {
  label: string;
  items: TopBarMenuItem[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Close on an outside click or Escape. Both listeners are registered only
  // while open, so a closed menu costs nothing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        style={{ ...styles.btn, fontWeight: 600 }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="topbar-model-menu"
        onClick={() => setOpen((v) => !v)}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div style={menuStyle} role="menu" aria-label={label}>
          {items.map((item) => (
            <React.Fragment key={item.label}>
              {item.separatorBefore && (
                <div style={{ height: 1, background: ME.borderSubtle, margin: "4px 6px" }} />
              )}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                style={itemStyle(Boolean(item.disabled))}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

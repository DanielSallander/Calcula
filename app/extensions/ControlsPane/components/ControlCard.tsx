//! FILENAME: app/extensions/ControlsPane/components/ControlCard.tsx
// PURPOSE: Shared card chrome for pane controls in the Controls pane, visually
//          matching RibbonFilterCard (fixed 56px card in the ribbon band,
//          full-width card in the sidebar). Shows the control name where the
//          filter card shows its field, hosts the type-specific control body,
//          and offers a "..." menu with Rename... / Delete (+ "Edit code..."
//          for custom AND button controls — both are script-backed, wired via
//          the onEditCode callback). Rename failures (the backend's name-
//          uniqueness rule across pane controls AND ribbon filters) surface
//          inline in the rename view, AddControlDialog's inline-error idiom.
// CONTEXT: Dispatches on control.controlType to SliderControl / DropdownControl /
//          CheckboxControl / ButtonControl; custom controls render through the
//          renderCustom prop (CustomControlHost, wired by the section).

import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useSurfaceLayout } from "@api/layout";
import type { PaneControl } from "../lib/controlsPaneTypes";
import {
  updateControlAsync,
  deleteControlAsync,
} from "../lib/controlsPaneStore";
import { SliderControl } from "./SliderControl";
import { DropdownControl } from "./DropdownControl";
import { CheckboxControl } from "./CheckboxControl";
import { ButtonControl } from "./ButtonControl";

const MENU_WIDTH = 160;

interface Props {
  control: PaneControl;
  /** Opens the object-script editor ("Edit code..." — custom AND button
   *  controls; openControlScriptEditor picks the objectType by kind). */
  onEditCode?: (control: PaneControl) => void;
  /** Renders the body of a custom scripted control (CustomControlHost). */
  renderCustom?: (control: PaneControl) => React.ReactNode;
}

export function ControlCard({
  control,
  onEditCode,
  renderCustom,
}: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closedAtRef = useRef(0);

  const toggleMenu = useCallback(() => {
    // If the menu was just closed by an outside click (<200ms ago), don't
    // reopen it — the user intended to close, not toggle (same guard as
    // RibbonFilterCard's dropdown arrow).
    if (Date.now() - closedAtRef.current < 200) return;
    if (!menuOpen && menuButtonRef.current) {
      setMenuAnchor(menuButtonRef.current.getBoundingClientRect());
    }
    setMenuOpen((prev) => !prev);
  }, [menuOpen]);

  const handleMenuClose = useCallback(() => {
    closedAtRef.current = Date.now();
    setMenuOpen(false);
  }, []);

  /** Commit a rename. Resolves to an error message to show inline in the
   *  rename view (menu stays open), or null on success/no-op (menu closes).
   *  The backend enforces case-insensitive name uniqueness across pane
   *  controls AND ribbon filters; updateControlAsync returns its message. */
  const handleRename = useCallback(
    async (newName: string): Promise<string | null> => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === control.name) {
        handleMenuClose();
        return null;
      }
      const result = await updateControlAsync(control.id, { name: trimmed });
      if ("error" in result) {
        return result.error;
      }
      handleMenuClose();
      return null;
    },
    [control.id, control.name, handleMenuClose],
  );

  const handleDelete = useCallback(async () => {
    handleMenuClose();
    await deleteControlAsync(control.id);
  }, [control.id, handleMenuClose]);

  const handleEditCode = useCallback(() => {
    handleMenuClose();
    onEditCode?.(control);
  }, [control, onEditCode, handleMenuClose]);

  const body = renderControlBody(control, renderCustom);

  return (
    <>
      <div
        style={{
          ...styles.card,
          ...(band ? styles.cardBand : styles.cardSidebar),
        }}
        title={`${control.name} (${control.controlType})`}
      >
        <div style={styles.cardBody}>
          <div style={styles.topRow}>
            <div style={styles.name}>{control.name}</div>
            <button
              ref={menuButtonRef}
              style={styles.menuButton}
              onClick={toggleMenu}
              title="Control options"
            >
              &#8943;
            </button>
          </div>
          <div style={styles.controlRow}>{body}</div>
        </div>
      </div>

      {menuOpen && menuAnchor && (
        <ControlCardMenu
          anchorRect={menuAnchor}
          canEditCode={
            control.controlType === "custom" ||
            control.controlType === "button"
          }
          currentName={control.name}
          onRename={handleRename}
          onDelete={handleDelete}
          onEditCode={onEditCode ? handleEditCode : undefined}
          onClose={handleMenuClose}
        />
      )}
    </>
  );
}

/** Dispatch to the type-specific control body. */
function renderControlBody(
  control: PaneControl,
  renderCustom?: (control: PaneControl) => React.ReactNode,
): React.ReactNode {
  switch (control.controlType) {
    case "slider":
      return <SliderControl control={control} />;
    case "dropdown":
      return <DropdownControl control={control} />;
    case "checkbox":
      return <CheckboxControl control={control} />;
    case "button":
      return <ButtonControl control={control} />;
    case "custom":
      return renderCustom ? (
        renderCustom(control)
      ) : (
        <div style={styles.customPlaceholder}>Custom control</div>
      );
    default:
      return (
        <div style={styles.customPlaceholder}>
          Unknown control type
        </div>
      );
  }
}

// ============================================================================
// Card context menu
// ============================================================================

function ControlCardMenu({
  anchorRect,
  canEditCode,
  currentName,
  onRename,
  onDelete,
  onEditCode,
  onClose,
}: {
  anchorRect: DOMRect;
  /** Script-backed kinds (custom + button) get the "Edit code..." item. */
  canEditCode: boolean;
  currentName: string;
  /** Resolves to an inline error message (rename view stays open) or null. */
  onRename: (newName: string) => Promise<string | null>;
  onDelete: () => void;
  onEditCode?: () => void;
  onClose: () => void;
}): React.ReactElement {
  const [view, setView] = useState<"menu" | "rename">("menu");
  const [renameValue, setRenameValue] = useState(currentName);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  /** Run the rename; on failure keep the view open and show the error inline
   *  (AddControlDialog's inline-error idiom). */
  const commitRename = useCallback(async () => {
    if (renaming) return;
    setRenaming(true);
    try {
      setRenameError(await onRename(renameValue));
    } finally {
      setRenaming(false);
    }
  }, [onRename, renameValue, renaming]);

  // Close on outside click (delayed registration so the opening click
  // doesn't immediately close it — same pattern as FilterDropdown).
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

  // Focus the rename input when switching to the rename view
  useEffect(() => {
    if (view === "rename") {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [view]);

  const top = anchorRect.bottom + 2;
  const left = Math.min(anchorRect.left, window.innerWidth - MENU_WIDTH - 8);

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left,
        top,
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
        padding: view === "rename" ? "8px 10px" : "4px 0",
        boxSizing: "border-box",
      }}
    >
      {view === "menu" ? (
        <>
          <button style={styles.menuItem} onClick={() => setView("rename")}>
            Rename...
          </button>
          {canEditCode && onEditCode && (
            <button style={styles.menuItem} onClick={onEditCode}>
              Edit code...
            </button>
          )}
          <div style={styles.menuDivider} />
          <button
            style={{ ...styles.menuItem, color: "#c00" }}
            onClick={onDelete}
          >
            Delete
          </button>
        </>
      ) : (
        <>
          <div style={styles.renameLabel}>Control name</div>
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => {
              setRenameValue(e.target.value);
              setRenameError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
            }}
            style={styles.renameInput}
          />
          {renameError && <div style={styles.renameError}>{renameError}</div>}
          <div style={styles.renameFooter}>
            <button
              style={styles.okButton}
              onClick={() => void commitRename()}
              disabled={renameValue.trim().length === 0 || renaming}
            >
              OK
            </button>
            <button style={styles.cancelButton} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

// ============================================================================
// Styles — matches RibbonFilterCard's card chrome
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 6px 4px 10px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#c0c0c0",
    borderRadius: "3px",
    background: "#fff",
    cursor: "default",
    boxSizing: "border-box",
  },
  cardBand: {
    height: "56px",
    flexShrink: 0,
    maxWidth: "220px",
    minWidth: "120px",
  },
  cardSidebar: {
    width: "100%",
    minHeight: "56px",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "4px",
    flex: 1,
    minWidth: 0,
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: 0,
  },
  name: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#333",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
  },
  menuButton: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: "12px",
    color: "#555",
    padding: "0 4px",
    flexShrink: 0,
    lineHeight: 1,
  },
  controlRow: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
  },
  customPlaceholder: {
    fontSize: "10px",
    color: "#8a8a8a",
    fontStyle: "italic",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
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
  menuDivider: {
    height: "1px",
    background: "#e5e7eb",
    margin: "2px 0",
  },
  renameLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#555",
    marginBottom: 4,
  },
  renameInput: {
    width: "100%",
    padding: "4px 6px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    fontSize: 12,
    outline: "none",
    boxSizing: "border-box",
    marginBottom: 6,
  },
  // Inline backend-rejection text (AddControlDialog's error idiom).
  renameError: {
    fontSize: 11,
    color: "#c00",
    whiteSpace: "pre-wrap",
    marginBottom: 6,
  },
  renameFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
  },
  okButton: {
    padding: "3px 14px",
    border: "none",
    borderRadius: 3,
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
  },
  cancelButton: {
    padding: "3px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    color: "#333",
  },
};

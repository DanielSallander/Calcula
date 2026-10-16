//! FILENAME: app/extensions/Slicer/components/SlicerSettingsDialog.tsx
// PURPOSE: Settings dialog for slicer selection and layout options.
// CONTEXT: Opened from the slicer right-click context menu "Slicer Settings..."
//          Inspired by Power BI's slicer settings panel. The fields are
//          SlicerSettingsBody.tsx's -- the object pane's Settings tab renders
//          the same body (WP-C D-PANE) -- and OK commits through its
//          `commitSlicerSettings` (ONE "Slicer Settings" step).

import React, { useState, useEffect } from "react";
import type { DialogProps } from "@api";
import { dialogWidth, dialogHeight } from "@api/dialogLayout";
import { useDialogWindow } from "@api/dialogWindow";
import { getSlicerById } from "../lib/slicerStore";
import { getSlicerComputedAttributes } from "../lib/slicer-api";
import { useJsonToggle, JsonToggleButton, JsonToggleEditor } from "../../_shared/components/jsonToggle";
import {
  DEFAULT_SLICER_SETTINGS,
  SlicerSettingsBody,
  commitSlicerSettings,
  slicerSettingsParams,
  slicerSettingsValuesOf,
  type SlicerSettingsValues,
} from "./SlicerSettingsBody";

// ============================================================================
// Component
// ============================================================================

export function SlicerSettingsDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const slicerId = data?.slicerId as string | undefined;

  // Movable + resizable dialog window (shared @api hook, wired as
  // InsertSlicerDialog does it). Fourteen controls do not fit a fixed box on
  // every screen, so the user gets the last word on its size.
  const win = useDialogWindow({ minWidth: 520, minHeight: 380 });

  const [values, setValues] = useState<SlicerSettingsValues>({ ...DEFAULT_SLICER_SETTINGS });

  // JSON toggle (Phase C)
  const jsonToggle = useJsonToggle(
    "slicer",
    slicerId != null ? String(slicerId) : "",
  );

  // Computed attributes (attributes controlled by formulas)
  const [computedAttrs, setComputedAttrs] = useState<Set<string>>(new Set());

  // Load current settings when dialog opens
  useEffect(() => {
    if (isOpen && slicerId != null) {
      // Reopen centred at the natural size — a drag made while editing one
      // slicer has nothing to say about the next one.
      win.reset();
      const slicer = getSlicerById(slicerId);
      if (slicer) setValues(slicerSettingsValuesOf(slicer));
      // Fetch which attributes are computed
      getSlicerComputedAttributes(slicerId).then((attrs) => {
        setComputedAttrs(new Set(attrs));
      });
    }
  }, [isOpen, slicerId, win.reset]);

  const handleClose = () => {
    onClose();
  };

  const handleOk = async () => {
    if (slicerId == null) return;
    // The settings AND the re-routed filter are ONE undo step, asked about a
    // pivot overwrite once after it commits (SlicerSettingsBody.tsx
    // `commitSlicerSettings`). The dialog sends every setting, as it always did.
    await commitSlicerSettings(slicerId, slicerSettingsParams(values));
    handleClose();
  };

  const handleReset = async () => {
    if (slicerId == null) return;
    setValues({ ...DEFAULT_SLICER_SETTINGS });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    } else if (e.key === "Enter") {
      handleOk();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div style={s.overlay} onClick={handleClose}>
      <div
        ref={win.ref}
        // position:relative anchors the absolutely-positioned resize handles;
        // win.style goes LAST so a user drag wins over the CSS placement.
        style={{
          ...s.dialog,
          position: "relative",
          // Monaco has no intrinsic height — it lays itself out to whatever its
          // container measures. `flex: 1` divides FREE space, and an auto-height
          // box has none, so the JSON branch needs a DEFINITE height or the editor
          // collapses to nothing between the header and the button bar.
          ...(jsonToggle.isJsonMode ? { height: dialogHeight(560) } : {}),
          ...win.style,
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header — drag handle */}
        <div style={s.header} onMouseDown={win.onHeaderMouseDown}>
          <h2 style={s.title}>Slicer Settings</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <JsonToggleButton
              isActive={jsonToggle.isJsonMode}
              onClick={jsonToggle.toggle}
              disabled={slicerId == null}
            />
            <button style={s.closeButton} onClick={handleClose} aria-label="Close">
              x
            </button>
          </div>
        </div>

        {/* JSON editor (shown when toggle is active) */}
        {jsonToggle.isJsonMode ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <JsonToggleEditor
              json={jsonToggle.json}
              onChange={jsonToggle.setJson}
              onApply={jsonToggle.apply}
              onRevert={jsonToggle.revert}
              dirty={jsonToggle.dirty}
              error={jsonToggle.error}
              loading={jsonToggle.loading}
            />
          </div>
        ) : (
        <>
        <SlicerSettingsBody
          variant="dialog"
          values={values}
          onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
          computedAttrs={computedAttrs}
        />

        {/* Footer — "Reset to default" sits beside the buttons it undoes. It
            used to be the last row INSIDE the scroll region, i.e. a control you
            had to scroll to the bottom to find. */}
        <div style={s.footer}>
          <button style={s.resetButton} onClick={handleReset} type="button">
            Reset to default
          </button>
          <div style={s.footerActions}>
            <button style={s.cancelButton} onClick={handleClose}>
              Cancel
            </button>
            <button style={s.okButton} onClick={handleOk}>
              OK
            </button>
          </div>
        </div>
        </>
        )}
        {win.resizeHandles}
      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    backgroundColor: "#2d2d2d",
    borderRadius: "8px",
    border: "1px solid #454545",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
    // 340px held one column of fourteen controls; 700px holds two, which keeps
    // each toggle within the ~330px of its own label rather than stranding it
    // at the far right of a single wide column.
    width: dialogWidth(700),
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid #454545",
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 600,
    color: "#ffffff",
  },
  closeButton: {
    background: "transparent",
    border: "none",
    color: "#888888",
    fontSize: "18px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "4px",
    lineHeight: 1,
  },
  resetButton: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    // Was a full-width row at the foot of the scroller; in the footer it is one
    // control among three, so it stops claiming the whole line.
    padding: "8px 0",
    background: "transparent",
    border: "none",
    color: "#999999",
    fontSize: "12px",
    cursor: "pointer",
    flexShrink: 0,
    textAlign: "left",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    // Reset on the left, Cancel/OK on the right.
    justifyContent: "space-between",
    gap: "8px",
    padding: "14px 20px",
    borderTop: "1px solid #454545",
    flexShrink: 0,
  },
  footerActions: {
    display: "flex",
    gap: "8px",
  },
  cancelButton: {
    padding: "8px 16px",
    fontSize: "13px",
    backgroundColor: "transparent",
    border: "1px solid #454545",
    borderRadius: "4px",
    color: "#cccccc",
    cursor: "pointer",
  },
  okButton: {
    padding: "8px 20px",
    fontSize: "13px",
    backgroundColor: "#0e639c",
    border: "1px solid #0e639c",
    borderRadius: "4px",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 500,
  },
};

export default SlicerSettingsDialog;

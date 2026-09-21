//! FILENAME: app/extensions/Protection/components/ProtectSheetDialog.tsx
// PURPOSE: Dialog for configuring and applying sheet protection.
// CONTEXT: Shows password field and permission checkboxes, calls protectSheet() on confirm.

import React, { useEffect, useState } from "react";
import type { DialogProps, SheetProtectionOptions } from "@api";
import {
  protectSheet,
  DEFAULT_PROTECTION_OPTIONS,
} from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import { DialogFieldGrid } from "@api/dialogLayout";
import { refreshProtectionState } from "../lib/protectionStore";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9500,
};

// The box positions ITSELF (fixed + centering transform) instead of riding the
// overlay's flex centering: useDialogWindow materializes the on-screen rect into
// left/top, which only mean anything on a fixed box. And it is a flex COLUMN
// that clips — so the title bar (which is also the drag handle) and the
// OK/Cancel row stay put while the body alone scrolls.
const dialogStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  // 520, not 620: two columns of permissions plus the password pair need this
  // much and no more, and dead air is the same complaint as a scrolling straw.
  width: 520,
  maxHeight: "90vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  padding: 0,
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

const titleBarStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
  flexShrink: 0,
  cursor: "move",
  userSelect: "none",
};

// The only scroller. At the natural size nothing scrolls any more; this earns
// its keep when the user drags the window short, where the alternative is an
// OK button clipped away with no way to reach it.
const bodyStyle: React.CSSProperties = {
  padding: "12px 16px",
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
};

const fieldStyle: React.CSSProperties = {
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 4,
  fontSize: 12,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  border: "1px solid #ababab",
  borderRadius: 2,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

// The confirm field is always mounted (see the JSX) — this is what it looks like
// while there is no password to confirm.
const disabledInputStyle: React.CSSProperties = {
  ...inputStyle,
  backgroundColor: "#eaeaea",
  color: "#8a8a8a",
  borderColor: "#cccccc",
};

// Fifteen independent toggles were squeezed into a 200px straw, hiding six of
// them — "Edit objects" among them, which is a security decision, not a
// cosmetic one. Two columns show all fifteen with no inner scroller. The flow
// is COLUMN-major on purpose: row-major would split the Format / Insert /
// Delete families across the column boundary, and those families are the only
// grouping this flat list has.
const checkboxListStyle: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 2,
  padding: "8px",
  backgroundColor: "#fff",
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gridTemplateRows: "repeat(8, auto)",
  gridAutoFlow: "column",
  columnGap: 24,
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 0",
  fontSize: 12,
};

const buttonBarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "8px 16px 16px",
  flexShrink: 0,
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 16px",
  minWidth: 72,
  border: "1px solid #ababab",
  borderRadius: 2,
  backgroundColor: "#e1e1e1",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0078d4",
};

// The refusal lives BETWEEN the scroller and the button bar, never inside the
// scroller: the reason OK refused belongs next to the OK button, not scrolled
// away from it.
const errorStyle: React.CSSProperties = {
  color: "#d32f2f",
  fontSize: 12,
  padding: "4px 16px 0",
  flexShrink: 0,
};

// ============================================================================
// Permission Definitions
// ============================================================================

interface PermissionItem {
  key: keyof SheetProtectionOptions;
  label: string;
}

const PERMISSIONS: PermissionItem[] = [
  { key: "allowSelectLockedCells", label: "Select locked cells" },
  { key: "allowSelectUnlockedCells", label: "Select unlocked cells" },
  { key: "allowFormatCells", label: "Format cells" },
  { key: "allowFormatColumns", label: "Format columns" },
  { key: "allowFormatRows", label: "Format rows" },
  { key: "allowInsertColumns", label: "Insert columns" },
  { key: "allowInsertRows", label: "Insert rows" },
  { key: "allowInsertHyperlinks", label: "Insert hyperlinks" },
  { key: "allowDeleteColumns", label: "Delete columns" },
  { key: "allowDeleteRows", label: "Delete rows" },
  { key: "allowSort", label: "Sort" },
  { key: "allowAutoFilter", label: "Use AutoFilter" },
  { key: "allowPivotTables", label: "Use PivotTable reports" },
  { key: "allowEditObjects", label: "Edit objects" },
  { key: "allowEditScenarios", label: "Edit scenarios" },
];

// ============================================================================
// Component
// ============================================================================

export function ProtectSheetDialog(props: DialogProps) {
  const { isOpen, onClose } = props;

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [options, setOptions] = useState<SheetProtectionOptions>({
    ...DEFAULT_PROTECTION_OPTIONS,
  });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // minWidth 440 is the floor at which the two permission columns still hold
  // the longest label ("Use PivotTable reports") without wrapping.
  const win = useDialogWindow({ minWidth: 440, minHeight: 300 });

  // Reopen centered at the natural size — where a previous session dragged the
  // window is not a decision about where the next one should appear.
  useEffect(() => {
    if (isOpen) {
      win.reset();
    }
  }, [isOpen, win.reset]);

  if (!isOpen) {
    return null;
  }

  const handleToggleOption = (key: keyof SheetProtectionOptions) => {
    setOptions((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleSubmit = async () => {
    setError(null);

    // Validate password confirmation
    if (password && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await protectSheet({
        password: password || undefined,
        options,
      });

      if (result.success) {
        await refreshProtectionState();
        // Reset form state
        setPassword("");
        setConfirmPassword("");
        setOptions({ ...DEFAULT_PROTECTION_OPTIONS });
        setError(null);
        onClose();
      } else {
        setError(result.error || "Failed to protect sheet.");
      }
    } catch (err) {
      setError("An error occurred while protecting the sheet.");
      console.error("[Protection] Protect sheet error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setPassword("");
    setConfirmPassword("");
    setOptions({ ...DEFAULT_PROTECTION_OPTIONS });
    setError(null);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleCancel();
    } else if (e.key === "Enter" && !isSubmitting) {
      handleSubmit();
    }
  };

  return (
    <div style={overlayStyle} onKeyDown={handleKeyDown}>
      <div
        ref={win.ref}
        style={{ ...dialogStyle, ...win.style }}
        role="dialog"
        aria-labelledby="protect-sheet-title"
      >
        <div
          style={titleBarStyle}
          id="protect-sheet-title"
          onMouseDown={win.onHeaderMouseDown}
        >
          Protect Sheet
        </div>
        <div style={bodyStyle}>
          {/* Password and its confirmation are one decision, so they share one
              row now that there is width for it. */}
          <DialogFieldGrid minColumnWidth={210} maxColumns={2}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Password to unprotect sheet (optional):</label>
              <input
                type="password"
                style={inputStyle}
                value={password}
                onChange={(e) => {
                  const next = e.target.value;
                  setPassword(next);
                  // Erasing the password erases what was confirming it, so a
                  // stale confirmation cannot outlive the thing it confirmed.
                  if (!next) {
                    setConfirmPassword("");
                  }
                }}
                placeholder="Leave blank for no password"
                autoFocus
              />
            </div>

            {/* Always MOUNTED, merely disabled until there is a password to
                confirm: mounting it on the first keystroke jumped the layout,
                and the live Review-menu journey fills this field by index —
                Playwright refuses an element that is absent or hidden. */}
            <div style={fieldStyle}>
              <label style={labelStyle}>Confirm password:</label>
              <input
                type="password"
                style={password ? inputStyle : disabledInputStyle}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                disabled={!password}
              />
            </div>
          </DialogFieldGrid>

          <div style={fieldStyle}>
            <label style={labelStyle}>Allow all users of this worksheet to:</label>
            <div style={checkboxListStyle}>
              {PERMISSIONS.map((perm) => (
                <label key={perm.key} style={checkboxRowStyle}>
                  <input
                    type="checkbox"
                    checked={options[perm.key]}
                    onChange={() => handleToggleOption(perm.key)}
                  />
                  {perm.label}
                </label>
              ))}
            </div>
          </div>
        </div>
        {error && <div style={errorStyle}>{error}</div>}
        <div style={buttonBarStyle}>
          <button
            style={primaryButtonStyle}
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            OK
          </button>
          <button style={buttonStyle} onClick={handleCancel}>
            Cancel
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}

//! FILENAME: app/extensions/Hyperlinks/InsertHyperlinkDialog.tsx
// PURPOSE: Insert/Edit Hyperlink dialog component.
// CONTEXT: Supports URL, Cell Reference, and Email hyperlink types.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  addHyperlink,
  updateHyperlink,
  getHyperlink,
  type Hyperlink,
  type HyperlinkType,
} from "@api/backend";
import { getSheets } from "@api/lib";
import { emitAppEvent, AppEvents } from "@api";

// ============================================================================
// Types
// ============================================================================

type TabType = "url" | "cellRef" | "email";

interface SheetInfo {
  name: string;
  index: number;
}

// ============================================================================
// Styles
// ============================================================================

const v = (name: string) => `var(${name})`;

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1050,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 440,
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  title: {
    fontWeight: 600,
    fontSize: 15,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 14,
  },
  tabBar: {
    display: "flex",
    gap: 0,
    borderBottom: `1px solid ${v("--border-default")}`,
    marginBottom: 4,
  },
  tab: {
    padding: "8px 16px",
    fontSize: 13,
    cursor: "pointer",
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    color: v("--text-secondary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  tabActive: {
    padding: "8px 16px",
    fontSize: 13,
    cursor: "pointer",
    background: "transparent",
    border: "none",
    borderBottom: `2px solid ${v("--accent-primary")}`,
    color: v("--text-primary"),
    fontWeight: 600,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  fieldLabel: {
    width: 110,
    fontSize: 13,
    flexShrink: 0,
  },
  fieldInput: {
    flex: 1,
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  fieldSelect: {
    flex: 1,
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  btn: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  errorText: {
    color: "#e74c3c",
    fontSize: 12,
    marginTop: -8,
  },
};

// ============================================================================
// Component
// ============================================================================

export function InsertHyperlinkDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Cell coordinates from the opener
  const row = (data?.row as number) ?? 0;
  const col = (data?.col as number) ?? 0;
  const isEdit = (data?.editMode as boolean) ?? false;

  // Tab state
  const [activeTab, setActiveTab] = useState<TabType>("url");

  // URL tab fields
  const [urlAddress, setUrlAddress] = useState("");
  const [urlDisplayText, setUrlDisplayText] = useState("");
  const [urlTooltip, setUrlTooltip] = useState("");

  // Cell Reference tab fields
  const [refSheet, setRefSheet] = useState("");
  const [refCell, setRefCell] = useState("A1");
  const [refDisplayText, setRefDisplayText] = useState("");
  const [refTooltip, setRefTooltip] = useState("");

  // Email tab fields
  const [emailAddress, setEmailAddress] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailDisplayText, setEmailDisplayText] = useState("");
  const [emailTooltip, setEmailTooltip] = useState("");

  // Sheets list for dropdown
  const [sheets, setSheets] = useState<SheetInfo[]>([]);

  // Validation
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load sheets and existing hyperlink on mount
  useEffect(() => {
    async function init() {
      // Load sheets for the Cell Reference dropdown
      try {
        const sheetsResult = await getSheets();
        const sheetList = sheetsResult.sheets.map((s: { name: string; index: number }) => ({
          name: s.name,
          index: s.index,
        }));
        setSheets(sheetList);

        // Set default sheet to active sheet
        const activeSheet = sheetList.find(
          (s: SheetInfo) => s.index === sheetsResult.activeIndex
        );
        if (activeSheet) {
          setRefSheet(activeSheet.name);
        }
      } catch {
        // Sheets unavailable - leave empty
      }

      // If editing, load existing hyperlink
      if (isEdit) {
        try {
          const existing = await getHyperlink(row, col);
          if (existing) {
            populateFromHyperlink(existing);
          }
        } catch {
          // No existing hyperlink
        }
      }
    }

    init();
  }, []);

  function populateFromHyperlink(h: Hyperlink): void {
    switch (h.linkType) {
      case "url":
        setActiveTab("url");
        setUrlAddress(h.target);
        setUrlDisplayText(h.displayText ?? "");
        setUrlTooltip(h.tooltip ?? "");
        break;

      case "internalReference":
        setActiveTab("cellRef");
        if (h.internalRef) {
          setRefSheet(h.internalRef.sheetName ?? "");
          setRefCell(h.internalRef.cellReference ?? "A1");
        }
        setRefDisplayText(h.displayText ?? "");
        setRefTooltip(h.tooltip ?? "");
        break;

      case "email": {
        setActiveTab("email");
        // Parse mailto: target
        const target = h.target;
        const mailtoMatch = target.match(/^mailto:([^?]+)(?:\?subject=(.*))?$/i);
        if (mailtoMatch) {
          setEmailAddress(mailtoMatch[1]);
          setEmailSubject(decodeURIComponent(mailtoMatch[2] ?? ""));
        } else {
          setEmailAddress(target);
        }
        setEmailDisplayText(h.displayText ?? "");
        setEmailTooltip(h.tooltip ?? "");
        break;
      }

      default:
        // For "file" type or unknown, default to URL tab
        setActiveTab("url");
        setUrlAddress(h.target);
        setUrlDisplayText(h.displayText ?? "");
        setUrlTooltip(h.tooltip ?? "");
        break;
    }
  }

  // Keyboard handlers
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Enter") {
        e.stopPropagation();
        handleOk();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeTab, urlAddress, urlDisplayText, urlTooltip, refSheet, refCell, refDisplayText, refTooltip, emailAddress, emailSubject, emailDisplayText, emailTooltip, isEdit]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  // Submit handler
  const handleOk = useCallback(async () => {
    setValidationError(null);
    setIsLoading(true);

    try {
      let linkType: HyperlinkType;
      let target: string;
      let displayText: string | undefined;
      let tooltip: string | undefined;
      let sheetName: string | undefined;
      let cellReference: string | undefined;
      let emailSubjectParam: string | undefined;

      switch (activeTab) {
        case "url": {
          if (!urlAddress.trim()) {
            setValidationError("Please enter a URL address.");
            setIsLoading(false);
            return;
          }
          linkType = "url";
          // Auto-prepend https:// if no protocol specified
          let addr = urlAddress.trim();
          if (!/^https?:\/\//i.test(addr) && !/^[a-z][a-z0-9+.-]*:/i.test(addr)) {
            addr = "https://" + addr;
          }
          target = addr;
          displayText = urlDisplayText.trim() || undefined;
          tooltip = urlTooltip.trim() || undefined;
          break;
        }

        case "cellRef": {
          if (!refCell.trim()) {
            setValidationError("Please enter a cell reference.");
            setIsLoading(false);
            return;
          }
          // Validate cell reference format
          const cellMatch = refCell.trim().replace(/\$/g, "").match(/^[A-Za-z]+\d+$/);
          if (!cellMatch) {
            setValidationError("Invalid cell reference. Use format like A1 or B5.");
            setIsLoading(false);
            return;
          }
          linkType = "internalReference";
          // Build target for display
          const cleanRef = refCell.trim().replace(/\$/g, "").toUpperCase();
          target = refSheet ? `${refSheet}!${cleanRef}` : cleanRef;
          displayText = refDisplayText.trim() || undefined;
          tooltip = refTooltip.trim() || undefined;
          sheetName = refSheet || undefined;
          cellReference = cleanRef;
          break;
        }

        case "email": {
          if (!emailAddress.trim()) {
            setValidationError("Please enter an email address.");
            setIsLoading(false);
            return;
          }
          // Basic email validation
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress.trim())) {
            setValidationError("Please enter a valid email address.");
            setIsLoading(false);
            return;
          }
          linkType = "email";
          const subjectPart = emailSubject.trim()
            ? `?subject=${encodeURIComponent(emailSubject.trim())}`
            : "";
          target = `mailto:${emailAddress.trim()}${subjectPart}`;
          displayText = emailDisplayText.trim() || undefined;
          tooltip = emailTooltip.trim() || undefined;
          emailSubjectParam = emailSubject.trim() || undefined;
          break;
        }

        default:
          setIsLoading(false);
          return;
      }

      // Call the backend
      const result = await addHyperlink({
        row,
        col,
        linkType,
        target,
        displayText,
        tooltip,
        sheetName,
        cellReference,
        emailSubject: emailSubjectParam,
      });

      if (!result.success) {
        setValidationError(result.error ?? "Failed to add hyperlink.");
        setIsLoading(false);
        return;
      }

      // Refresh grid to show hyperlink indicator
      emitAppEvent(AppEvents.DATA_CHANGED, {});
      window.dispatchEvent(new CustomEvent("grid:refresh"));

      onClose();
    } catch (err) {
      setValidationError(`Error: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [activeTab, urlAddress, urlDisplayText, urlTooltip, refSheet, refCell, refDisplayText, refTooltip, emailAddress, emailSubject, emailDisplayText, emailTooltip, row, col, isEdit, onClose]);

  // Render tab content
  function renderUrlTab(): React.ReactElement {
    return (
      <>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Address:</label>
          <input
            style={styles.fieldInput}
            value={urlAddress}
            onChange={(e) => { setUrlAddress(e.target.value); setValidationError(null); }}
            placeholder="https://example.com"
            autoFocus
          />
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Display text:</label>
          <input
            style={styles.fieldInput}
            value={urlDisplayText}
            onChange={(e) => setUrlDisplayText(e.target.value)}
            placeholder="(optional) Text to display in the cell"
          />
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Tooltip:</label>
          <input
            style={styles.fieldInput}
            value={urlTooltip}
            onChange={(e) => setUrlTooltip(e.target.value)}
            placeholder="(optional) Hover tooltip text"
          />
        </div>
      </>
    );
  }

  function renderCellRefTab(): React.ReactElement {
    return (
      <>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Sheet:</label>
          <select
            style={styles.fieldSelect}
            value={refSheet}
            onChange={(e) => setRefSheet(e.target.value)}
          >
            {sheets.map((s) => (
              <option key={s.index} value={s.name}>{s.name}</option>
            ))}
          </select>
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Cell reference:</label>
          <input
            style={styles.fieldInput}
            value={refCell}
            onChange={(e) => { setRefCell(e.target.value); setValidationError(null); }}
            placeholder="A1"
          />
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Display text:</label>
          <input
            style={styles.fieldInput}
            value={refDisplayText}
            onChange={(e) => setRefDisplayText(e.target.value)}
            placeholder="(optional) Text to display in the cell"
          />
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Tooltip:</label>
          <input
            style={styles.fieldInput}
            value={refTooltip}
            onChange={(e) => setRefTooltip(e.target.value)}
            placeholder="(optional) Hover tooltip text"
          />
        </div>
      </>
    );
  }

  function renderEmailTab(): React.ReactElement {
    return (
      <>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Email address:</label>
          <input
            style={styles.fieldInput}
            value={emailAddress}
            onChange={(e) => { setEmailAddress(e.target.value); setValidationError(null); }}
            placeholder="user@example.com"
          />
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Subject:</label>
          <input
            style={styles.fieldInput}
            value={emailSubject}
            onChange={(e) => setEmailSubject(e.target.value)}
            placeholder="(optional) Email subject line"
          />
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Display text:</label>
          <input
            style={styles.fieldInput}
            value={emailDisplayText}
            onChange={(e) => setEmailDisplayText(e.target.value)}
            placeholder="(optional) Text to display in the cell"
          />
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.fieldLabel}>Tooltip:</label>
          <input
            style={styles.fieldInput}
            value={emailTooltip}
            onChange={(e) => setEmailTooltip(e.target.value)}
            placeholder="(optional) Hover tooltip text"
          />
        </div>
      </>
    );
  }

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>{isEdit ? "Edit Hyperlink" : "Insert Hyperlink"}</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Tab bar */}
          <div style={styles.tabBar}>
            <button
              style={activeTab === "url" ? styles.tabActive : styles.tab}
              onClick={() => { setActiveTab("url"); setValidationError(null); }}
            >
              URL
            </button>
            <button
              style={activeTab === "cellRef" ? styles.tabActive : styles.tab}
              onClick={() => { setActiveTab("cellRef"); setValidationError(null); }}
            >
              Cell Reference
            </button>
            <button
              style={activeTab === "email" ? styles.tabActive : styles.tab}
              onClick={() => { setActiveTab("email"); setValidationError(null); }}
            >
              Email
            </button>
          </div>

          {/* Tab content */}
          {activeTab === "url" && renderUrlTab()}
          {activeTab === "cellRef" && renderCellRefTab()}
          {activeTab === "email" && renderEmailTab()}

          {/* Validation error */}
          {validationError && (
            <div style={styles.errorText}>{validationError}</div>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...styles.btnPrimary,
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? "not-allowed" : "pointer",
            }}
            onClick={handleOk}
            disabled={isLoading}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

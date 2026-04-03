//! FILENAME: app/extensions/CustomFillLists/components/CustomFillListsDialog.tsx
// PURPOSE: Dialog for viewing, adding, editing, and deleting custom auto-fill lists.
// CONTEXT: Shows built-in lists (read-only) and user-defined lists (editable).

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import { FillListRegistry, type FillList } from "@api";

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
    width: 560,
    maxHeight: "80vh",
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
    gap: 16,
    flex: 1,
    overflow: "hidden",
  },
  leftPanel: {
    width: 200,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  rightPanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  listBox: {
    flex: 1,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    overflow: "auto",
    minHeight: 200,
  },
  listItem: {
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 12,
    borderBottom: `1px solid ${v("--border-default")}`,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  listItemSelected: {
    background: v("--accent-primary"),
    color: "#ffffff",
  },
  listItemBuiltIn: {
    fontStyle: "italic" as const,
    color: v("--text-secondary"),
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: v("--text-secondary"),
  },
  textArea: {
    flex: 1,
    minHeight: 160,
    padding: "8px",
    fontSize: 13,
    borderRadius: 4,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    resize: "none" as const,
    lineHeight: 1.5,
  },
  nameInput: {
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    width: "100%",
    boxSizing: "border-box" as const,
  },
  buttonRow: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap" as const,
  },
  btn: {
    padding: "5px 14px",
    fontSize: 12,
    borderRadius: 4,
    cursor: "pointer",
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "5px 14px",
    fontSize: 12,
    borderRadius: 4,
    cursor: "pointer",
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  btnDanger: {
    padding: "5px 14px",
    fontSize: 12,
    borderRadius: 4,
    cursor: "pointer",
    background: "#dc3545",
    color: "#ffffff",
    border: "1px solid #dc3545",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  helpText: {
    fontSize: 11,
    color: v("--text-secondary"),
    lineHeight: 1.4,
  },
};

// ============================================================================
// Component
// ============================================================================

export const CustomFillListsDialog: React.FC<DialogProps> = ({ onClose }) => {
  const [allLists, setAllLists] = useState<FillList[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editItems, setEditItems] = useState("");
  const [isNew, setIsNew] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  // Load lists
  const refreshLists = useCallback(() => {
    const lists = FillListRegistry.getAllLists();
    setAllLists(lists);
  }, []);

  useEffect(() => {
    refreshLists();
    const unsub = FillListRegistry.subscribe(refreshLists);
    return unsub;
  }, [refreshLists]);

  // Handle Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Select a list
  const handleSelect = useCallback((list: FillList) => {
    setSelectedId(list.id);
    setEditName(list.name);
    setEditItems(list.items.join("\n"));
    setIsNew(false);
  }, []);

  // Start new list
  const handleNew = useCallback(() => {
    setSelectedId(null);
    setEditName("");
    setEditItems("");
    setIsNew(true);
    setTimeout(() => textAreaRef.current?.focus(), 50);
  }, []);

  // Save (add or update)
  const handleSave = useCallback(() => {
    const items = editItems
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length < 2) return;

    const name = editName.trim() || `Custom List`;

    if (isNew) {
      const created = FillListRegistry.addList(name, items);
      setSelectedId(created.id);
      setIsNew(false);
    } else if (selectedId) {
      FillListRegistry.updateList(selectedId, name, items);
    }
    refreshLists();
  }, [editName, editItems, isNew, selectedId, refreshLists]);

  // Delete
  const handleDelete = useCallback(() => {
    if (!selectedId) return;
    const list = allLists.find((l) => l.id === selectedId);
    if (!list || list.builtIn) return;
    FillListRegistry.removeList(selectedId);
    setSelectedId(null);
    setEditName("");
    setEditItems("");
    setIsNew(false);
    refreshLists();
  }, [selectedId, allLists, refreshLists]);

  const selectedList = allLists.find((l) => l.id === selectedId) ?? null;
  const isBuiltIn = selectedList?.builtIn ?? false;
  const isEditing = isNew || (selectedId !== null && !isBuiltIn);
  const canSave = isEditing && editItems.split("\n").filter((s) => s.trim()).length >= 2;

  // Format list items for preview in the list panel
  const formatPreview = (list: FillList): string => {
    const preview = list.items.slice(0, 4).join(", ");
    return list.items.length > 4 ? `${preview}, ...` : preview;
  };

  return (
    <div style={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Custom Lists</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">X</button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Left Panel: List of all fill lists */}
          <div style={styles.leftPanel}>
            <span style={styles.label}>Custom lists:</span>
            <div style={styles.listBox}>
              {allLists.map((list) => (
                <div
                  key={list.id}
                  style={{
                    ...styles.listItem,
                    ...(selectedId === list.id ? styles.listItemSelected : {}),
                    ...(list.builtIn && selectedId !== list.id ? styles.listItemBuiltIn : {}),
                  }}
                  onClick={() => handleSelect(list)}
                  title={list.builtIn ? `${list.name} (built-in)` : list.name}
                >
                  {formatPreview(list)}
                </div>
              ))}
            </div>
            <div style={styles.buttonRow}>
              <button style={styles.btnPrimary} onClick={handleNew}>Add New</button>
              {selectedId && !isBuiltIn && (
                <button style={styles.btnDanger} onClick={handleDelete}>Delete</button>
              )}
            </div>
          </div>

          {/* Right Panel: Edit area */}
          <div style={styles.rightPanel}>
            <span style={styles.label}>
              {isBuiltIn ? "List entries (read-only):" : isNew ? "New list entries:" : "List entries:"}
            </span>
            {isEditing && (
              <>
                <span style={styles.label}>Name:</span>
                <input
                  style={styles.nameInput}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="e.g., Regions, Priorities..."
                />
              </>
            )}
            <textarea
              ref={textAreaRef}
              style={styles.textArea}
              value={editItems}
              onChange={(e) => setEditItems(e.target.value)}
              readOnly={isBuiltIn}
              placeholder={isEditing ? "Enter list items, one per line:\n\nHigh\nMedium\nLow" : "Select a list or click Add New"}
            />
            <span style={styles.helpText}>
              Enter each list entry on a separate line. Minimum 2 entries required.
              {"\n"}Lists wrap around automatically when filling cells.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          {isEditing && (
            <button
              style={canSave ? styles.btnPrimary : { ...styles.btn, opacity: 0.5, cursor: "default" }}
              onClick={canSave ? handleSave : undefined}
            >
              {isNew ? "Add" : "Save"}
            </button>
          )}
          <button style={styles.btn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

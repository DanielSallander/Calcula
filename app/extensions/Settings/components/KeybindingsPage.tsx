//! FILENAME: app/extensions/Settings/components/KeybindingsPage.tsx
// PURPOSE: Settings page for viewing and customizing keyboard shortcuts.
// CONTEXT: Displays all registered keybindings grouped by category with
//          search/filter, inline editing, conflict detection, and reset.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  getAllKeybindings,
  getCategories,
  getEffectiveCombo,
  hasUserOverride,
  getDefaultCombo,
  setUserKeybinding,
  resetUserKeybinding,
  resetAllKeybindings,
  findConflicts,
  formatCombo,
  eventToCombo,
  subscribeToKeybindingChanges,
  addCustomKeybinding,
  removeCustomKeybinding,
  getAvailableCommands,
  type KeyBinding,
} from "@api/keybindings";

const h = React.createElement;

// ============================================================================
// Keybinding Row (individual shortcut)
// ============================================================================

interface KeybindingRowProps {
  binding: KeyBinding;
  effectiveCombo: string;
  isOverridden: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (combo: string) => void;
  onReset: () => void;
  onDelete?: () => void;
}

function KeybindingRow(props: KeybindingRowProps): React.ReactElement {
  const { binding, effectiveCombo, isOverridden, isEditing: editing, onStartEdit, onCancelEdit, onSaveEdit, onReset, onDelete } = props;
  const [capturedCombo, setCapturedCombo] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<KeyBinding[]>([]);
  const captureRef = useRef<HTMLDivElement>(null);

  // Focus the capture element when editing starts
  useEffect(() => {
    if (editing && captureRef.current) {
      captureRef.current.focus();
    }
  }, [editing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels
      if (e.key === "Escape") {
        onCancelEdit();
        return;
      }

      const combo = eventToCombo(e.nativeEvent);
      if (!combo) return; // Pure modifier key

      const formatted = formatCombo(combo);
      setCapturedCombo(formatted);

      // Check for conflicts
      const conflictList = findConflicts(formatted, binding.id);
      setConflicts(conflictList);
    },
    [binding.id, onCancelEdit]
  );

  const handleSave = useCallback(() => {
    if (capturedCombo) {
      onSaveEdit(capturedCombo);
      setCapturedCombo(null);
      setConflicts([]);
    }
  }, [capturedCombo, onSaveEdit]);

  const handleCancel = useCallback(() => {
    setCapturedCombo(null);
    setConflicts([]);
    onCancelEdit();
  }, [onCancelEdit]);

  const displayCombo = formatCombo(effectiveCombo);
  const sourceLabel = binding.source === "built-in" ? "Built-in" : binding.extensionId || "Extension";

  if (editing) {
    return h("tr", { style: rowStyles.row },
      // Command name
      h("td", { style: rowStyles.cellLabel },
        h("span", { style: rowStyles.label }, binding.label),
        h("span", { style: rowStyles.commandId }, binding.commandId),
      ),
      // Capture area
      h("td", { style: rowStyles.cellCombo },
        h("div", {
          ref: captureRef,
          tabIndex: 0,
          style: rowStyles.captureBox,
          onKeyDown: handleKeyDown,
        },
          capturedCombo
            ? h("span", { style: rowStyles.capturedText }, capturedCombo)
            : h("span", { style: rowStyles.captureHint }, "Press key combination..."),
        ),
        conflicts.length > 0 && h("div", { style: rowStyles.conflictWarning },
          "Conflict with: " + conflicts.map((c) => c.label).join(", ")
        ),
      ),
      // Source
      h("td", { style: rowStyles.cellSource }, sourceLabel),
      // Actions
      h("td", { style: rowStyles.cellActions },
        capturedCombo && h("button", {
          style: { ...rowStyles.actionBtn, ...rowStyles.saveBtn },
          onClick: handleSave,
          title: "Accept",
        }, "Accept"),
        h("button", {
          style: { ...rowStyles.actionBtn, ...rowStyles.cancelBtn },
          onClick: handleCancel,
          title: "Cancel",
        }, "Cancel"),
      ),
    );
  }

  return h("tr", { style: rowStyles.row },
    // Command name
    h("td", { style: rowStyles.cellLabel },
      h("span", { style: rowStyles.label }, binding.label),
      h("span", { style: rowStyles.commandId }, binding.commandId),
    ),
    // Shortcut
    h("td", { style: rowStyles.cellCombo },
      h("span", {
        style: {
          ...rowStyles.comboDisplay,
          ...(isOverridden ? rowStyles.overridden : {}),
        },
        onClick: onStartEdit,
        title: "Click to change shortcut",
      }, displayCombo),
    ),
    // Source
    h("td", { style: rowStyles.cellSource }, sourceLabel),
    // Actions
    h("td", { style: rowStyles.cellActions },
      h("button", {
        style: rowStyles.actionBtn,
        onClick: onStartEdit,
        title: "Edit shortcut",
      }, "Edit"),
      isOverridden && h("button", {
        style: { ...rowStyles.actionBtn, ...rowStyles.resetBtn },
        onClick: onReset,
        title: "Reset to default",
      }, "Reset"),
      onDelete && h("button", {
        style: { ...rowStyles.actionBtn, color: "#d32f2f" },
        onClick: onDelete,
        title: "Remove this custom shortcut",
      }, "Delete"),
    ),
  );
}

// ============================================================================
// KeybindingsPage
// ============================================================================

export function KeybindingsPage(): React.ReactElement {
  const [searchTerm, setSearchTerm] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addCommandId, setAddCommandId] = useState("");
  const [addCombo, setAddCombo] = useState("");
  const [addCategory, setAddCategory] = useState("Custom");
  const [addContext, setAddContext] = useState<"always" | "editing" | "not-editing">("always");
  const addCaptureRef = useRef<HTMLDivElement>(null);

  // Re-render when keybindings change
  useEffect(() => {
    const unsub = subscribeToKeybindingChanges(() => {
      setVersion((v) => v + 1);
    });
    return unsub;
  }, []);

  const allBindings = getAllKeybindings();
  const categories = getCategories();

  // Filter
  const normalizedSearch = searchTerm.toLowerCase().trim();
  const filteredBindings = normalizedSearch
    ? allBindings.filter(
        (b) =>
          b.label.toLowerCase().includes(normalizedSearch) ||
          b.commandId.toLowerCase().includes(normalizedSearch) ||
          b.category.toLowerCase().includes(normalizedSearch) ||
          getEffectiveCombo(b.id).toLowerCase().includes(normalizedSearch)
      )
    : allBindings;

  // Group by category
  const grouped = new Map<string, KeyBinding[]>();
  for (const cat of categories) {
    const items = filteredBindings.filter((b) => b.category === cat);
    if (items.length > 0) {
      grouped.set(cat, items);
    }
  }

  const handleStartEdit = useCallback((id: string) => {
    setEditingId(id);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleSaveEdit = useCallback((id: string, combo: string) => {
    setUserKeybinding(id, combo);
    setEditingId(null);
  }, []);

  const handleReset = useCallback((id: string) => {
    resetUserKeybinding(id);
  }, []);

  const handleResetAll = useCallback(() => {
    if (confirm("Reset all keyboard shortcuts to their defaults?")) {
      resetAllKeybindings();
    }
  }, []);

  const handleDelete = useCallback((id: string) => {
    removeCustomKeybinding(id);
  }, []);

  const handleAddSubmit = useCallback(() => {
    if (!addCombo || !addCommandId) return;
    addCustomKeybinding(addCombo, addCommandId, addLabel || addCommandId, addCategory, addContext);
    setShowAddForm(false);
    setAddLabel("");
    setAddCommandId("");
    setAddCombo("");
    setAddCategory("Custom");
    setAddContext("always");
  }, [addCombo, addCommandId, addLabel, addCategory, addContext]);

  const handleAddCancel = useCallback(() => {
    setShowAddForm(false);
    setAddLabel("");
    setAddCommandId("");
    setAddCombo("");
    setAddCategory("Custom");
    setAddContext("always");
  }, []);

  const availableCommands = getAvailableCommands()
    .filter((cmd): cmd is string => typeof cmd === "string")
    .sort();

  return h("div", { style: pageStyles.container },
    // Header
    h("div", { style: pageStyles.header },
      h("div", { style: pageStyles.title }, "Keyboard Shortcuts"),
      h("div", { style: pageStyles.headerActions },
        h("button", {
          style: pageStyles.addBtn,
          onClick: () => setShowAddForm(true),
        }, "+ Add Shortcut"),
        h("button", {
          style: pageStyles.resetAllBtn,
          onClick: handleResetAll,
        }, "Reset All"),
      ),
    ),

    // Add Shortcut Form (inline)
    showAddForm && h("div", { style: pageStyles.addForm },
      h("div", { style: pageStyles.addFormTitle }, "Add New Keyboard Shortcut"),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Label:"),
        h("input", {
          type: "text",
          placeholder: "My Shortcut",
          value: addLabel,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAddLabel(e.target.value),
          style: pageStyles.addFormInput,
        }),
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Command:"),
        h("select", {
          value: addCommandId,
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setAddCommandId(e.target.value),
          style: pageStyles.addFormInput,
        },
          h("option", { value: "" }, "-- Select a command --"),
          ...availableCommands.map((cmd) =>
            h("option", { key: cmd, value: cmd }, cmd)
          ),
        ),
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Shortcut:"),
        h("div", {
          ref: addCaptureRef,
          tabIndex: 0,
          style: {
            ...pageStyles.addFormInput,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            minHeight: 28,
            backgroundColor: addCombo ? "#fff" : "#fffde7",
            outline: "none",
          },
          onFocus: () => { /* ready to capture */ },
          onKeyDown: (e: React.KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") { setAddCombo(""); return; }
            const combo = eventToCombo(e.nativeEvent);
            if (combo) setAddCombo(formatCombo(combo));
          },
        }, addCombo || "Click here and press a key combination..."),
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Category:"),
        h("input", {
          type: "text",
          placeholder: "Custom",
          value: addCategory,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAddCategory(e.target.value),
          style: pageStyles.addFormInput,
        }),
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Context:"),
        h("select", {
          value: addContext,
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setAddContext(e.target.value as "always" | "editing" | "not-editing"),
          style: pageStyles.addFormInput,
        },
          h("option", { value: "always" }, "Always"),
          h("option", { value: "not-editing" }, "When not editing"),
          h("option", { value: "editing" }, "When editing"),
        ),
      ),
      addCombo && findConflicts(addCombo).length > 0 && h("div", { style: { color: "#d32f2f", fontSize: 12, padding: "4px 0 0 120px" } },
        "Warning: conflicts with ", findConflicts(addCombo).map((c) => c.label).join(", "),
      ),
      h("div", { style: pageStyles.addFormActions },
        h("button", {
          style: pageStyles.addFormOkBtn,
          onClick: handleAddSubmit,
          disabled: !addCombo || !addCommandId,
        }, "Add"),
        h("button", {
          style: pageStyles.addFormCancelBtn,
          onClick: handleAddCancel,
        }, "Cancel"),
      ),
    ),

    // Search
    h("div", { style: pageStyles.searchContainer },
      h("input", {
        type: "text",
        placeholder: "Search shortcuts...",
        value: searchTerm,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm((e.target as HTMLInputElement).value),
        style: pageStyles.searchInput,
      }),
    ),

    // Table
    h("div", { style: pageStyles.tableContainer },
      h("table", { style: pageStyles.table },
        h("thead", null,
          h("tr", null,
            h("th", { style: { ...pageStyles.th, width: "40%" } }, "Command"),
            h("th", { style: { ...pageStyles.th, width: "25%" } }, "Shortcut"),
            h("th", { style: { ...pageStyles.th, width: "15%" } }, "Source"),
            h("th", { style: { ...pageStyles.th, width: "20%" } }, "Actions"),
          ),
        ),
        h("tbody", null,
          ...Array.from(grouped.entries()).flatMap(([category, bindings]) => [
            // Category header row
            h("tr", { key: `cat-${category}` },
              h("td", {
                colSpan: 4,
                style: pageStyles.categoryHeader,
              }, category),
            ),
            // Binding rows
            ...bindings.map((binding) =>
              h(KeybindingRow, {
                key: binding.id,
                binding,
                effectiveCombo: getEffectiveCombo(binding.id),
                isOverridden: hasUserOverride(binding.id),
                isEditing: editingId === binding.id,
                onStartEdit: () => handleStartEdit(binding.id),
                onCancelEdit: handleCancelEdit,
                onSaveEdit: (combo: string) => handleSaveEdit(binding.id, combo),
                onReset: () => handleReset(binding.id),
                onDelete: binding.source === "user" ? () => handleDelete(binding.id) : undefined,
              })
            ),
          ]),

          // Empty state
          grouped.size === 0 &&
            h("tr", null,
              h("td", {
                colSpan: 4,
                style: pageStyles.emptyState,
              }, normalizedSearch ? "No shortcuts match your search." : "No keyboard shortcuts registered."),
            ),
        ),
      ),
    ),

    // Footer hint
    h("div", { style: pageStyles.footer },
      "Click on a shortcut to change it. User-modified shortcuts are shown in bold.",
    ),
  );
}

// ============================================================================
// Page Styles
// ============================================================================

const pageStyles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
    fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px 10px",
    borderBottom: "1px solid #e0e0e0",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "#333",
  },
  headerActions: {
    display: "flex",
    gap: 8,
  },
  addBtn: {
    fontSize: 11,
    padding: "4px 12px",
    border: "1px solid #0078d4",
    borderRadius: 4,
    backgroundColor: "#0078d4",
    color: "#fff",
    cursor: "pointer",
  },
  resetAllBtn: {
    fontSize: 11,
    padding: "4px 12px",
    border: "1px solid #ccc",
    borderRadius: 4,
    backgroundColor: "#fff",
    color: "#666",
    cursor: "pointer",
  },
  addForm: {
    padding: "12px 16px",
    margin: "0 16px 8px",
    borderRadius: 6,
    backgroundColor: "#f5f8ff",
    border: "1px solid #c8d8e8",
  },
  addFormTitle: {
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 10,
    color: "#333",
  },
  addFormRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: 8,
    gap: 8,
  },
  addFormLabel: {
    width: 110,
    fontSize: 12,
    color: "#555",
    textAlign: "right" as const,
    flexShrink: 0,
  },
  addFormInput: {
    flex: 1,
    fontSize: 12,
    padding: "4px 8px",
    border: "1px solid #ccc",
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  addFormActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  addFormOkBtn: {
    fontSize: 12,
    padding: "5px 16px",
    border: "1px solid #0078d4",
    borderRadius: 3,
    backgroundColor: "#0078d4",
    color: "#fff",
    cursor: "pointer",
  },
  addFormCancelBtn: {
    fontSize: 12,
    padding: "5px 16px",
    border: "1px solid #ccc",
    borderRadius: 3,
    backgroundColor: "#fff",
    color: "#666",
    cursor: "pointer",
  },
  searchContainer: {
    padding: "10px 16px",
  },
  searchInput: {
    width: "100%",
    padding: "7px 10px",
    fontSize: 12,
    borderRadius: 4,
    border: "1px solid #ccc",
    backgroundColor: "#fff",
    color: "#333",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  tableContainer: {
    flex: 1,
    overflow: "auto",
    padding: "0 16px",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 12,
  },
  th: {
    textAlign: "left" as const,
    padding: "8px 8px",
    fontSize: 11,
    fontWeight: 600,
    color: "#777",
    borderBottom: "2px solid #e0e0e0",
    position: "sticky" as const,
    top: 0,
    backgroundColor: "#fafafa",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  categoryHeader: {
    padding: "10px 8px 4px",
    fontSize: 11,
    fontWeight: 600,
    color: "#10b981",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    borderBottom: "1px solid #f0f0f0",
    backgroundColor: "#f9fafb",
  },
  emptyState: {
    textAlign: "center" as const,
    padding: "24px 8px",
    color: "#999",
    fontSize: 12,
  },
  footer: {
    padding: "10px 16px",
    fontSize: 11,
    color: "#999",
    borderTop: "1px solid #e0e0e0",
  },
};

// ============================================================================
// Row Styles
// ============================================================================

const rowStyles: Record<string, React.CSSProperties> = {
  row: {
    borderBottom: "1px solid #f0f0f0",
  },
  cellLabel: {
    padding: "6px 8px",
    verticalAlign: "middle" as const,
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 500,
    color: "#333",
  },
  commandId: {
    display: "block",
    fontSize: 10,
    color: "#aaa",
    marginTop: 1,
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
  },
  cellCombo: {
    padding: "6px 8px",
    verticalAlign: "middle" as const,
  },
  comboDisplay: {
    display: "inline-block",
    padding: "2px 8px",
    fontSize: 11,
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
    backgroundColor: "#f0f0f0",
    borderRadius: 3,
    border: "1px solid #ddd",
    cursor: "pointer",
    userSelect: "none" as const,
  },
  overridden: {
    fontWeight: 700,
    backgroundColor: "#e8f5e9",
    borderColor: "#a5d6a7",
  },
  captureBox: {
    padding: "6px 10px",
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
    backgroundColor: "#fff8e1",
    borderRadius: 4,
    border: "2px solid #ffc107",
    outline: "none",
    minWidth: 120,
    textAlign: "center" as const,
  },
  capturedText: {
    fontWeight: 600,
    color: "#333",
  },
  captureHint: {
    color: "#999",
    fontStyle: "italic" as const,
    fontSize: 11,
  },
  conflictWarning: {
    marginTop: 4,
    fontSize: 10,
    color: "#e65100",
    fontWeight: 500,
  },
  cellSource: {
    padding: "6px 8px",
    fontSize: 11,
    color: "#888",
    verticalAlign: "middle" as const,
  },
  cellActions: {
    padding: "6px 8px",
    verticalAlign: "middle" as const,
    whiteSpace: "nowrap" as const,
  },
  actionBtn: {
    fontSize: 11,
    padding: "2px 10px",
    border: "1px solid #ddd",
    borderRadius: 3,
    backgroundColor: "#fff",
    color: "#555",
    cursor: "pointer",
    marginRight: 4,
  },
  saveBtn: {
    borderColor: "#10b981",
    color: "#10b981",
    fontWeight: 600,
  },
  cancelBtn: {
    borderColor: "#ccc",
    color: "#999",
  },
  resetBtn: {
    borderColor: "#ef9a9a",
    color: "#c62828",
  },
};

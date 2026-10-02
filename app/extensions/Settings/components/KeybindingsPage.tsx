//! FILENAME: app/extensions/Settings/components/KeybindingsPage.tsx
// PURPOSE: Settings page for viewing and customizing keyboard shortcuts.
// CONTEXT: Displays all registered keybindings grouped by category with
//          search/filter, inline editing, conflict detection, and reset.
//
//          Calcula Clusters: headers use the one panel header recipe the
//          General and Appearance pages use (12px/600, sentence case, LT
//          tokens), the buttons, text fields and selects are the @api/layout
//          Button / Input / Select, and every colour is an LT token, so the
//          page follows the skin (the old literals left a white form and green
//          category labels on a Dark skin).
//
//          KEY CAPTURE. Both capture boxes (a row's Edit, the Add Shortcut
//          form) register with the keybinding dispatcher while they are open
//          (@api/keybindings beginShortcutCapture), which hands them every key
//          pressed in them -- an already-bound combination included -- instead
//          of running it. Through React's onKeyDown alone they came second to
//          the window-capture dispatcher: Ctrl+S in the box saved the workbook
//          and recorded nothing (BUG-0199).
//
//          A BARE KEY IS REFUSED (owner call 23). A recorded Space, Enter or
//          printable character with no modifier shows the refusal sentence of
//          @api/keybindings bareKeyShortcutRefusal where the conflict warning
//          goes, and the row offers no Accept / the form's Add stays off: it
//          would take that key from every text field and from the first
//          keystroke of every cell entry. The box keeps recording, so the
//          next combination pressed replaces it. (A key the grid owns, such as
//          Ctrl+Space, is still only WARNED: the user's binding wins it.)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { css } from "@emotion/css";
import {
  getAllKeybindings,
  isListedKeybinding,
  getCategories,
  getEffectiveCombo,
  hasUserOverride,
  setUserKeybinding,
  resetUserKeybinding,
  resetAllKeybindings,
  findConflicts,
  formatCombo,
  eventToCombo,
  subscribeToKeybindingChanges,
  addCustomKeybinding,
  removeCustomKeybinding,
  revokeScriptKeybinding,
  getAvailableCommands,
  beginShortcutCapture,
  bareKeyShortcutRefusal,
  type KeyBinding,
} from "@api/keybindings";
import { confirmAsync } from "@api/dialogs";
import { Button, FONT_FAMILY, FONT_MONO, HEADER_FONT_SIZE, Input, LT, Select } from "@api/layout";

const h = React.createElement;

/** The one panel header recipe (AppearancePage / SettingsView): 12px/600,
 *  sentence case, painted with LT. */
const sectionTitleClass = css`
  margin: 0;
  font-family: ${FONT_FAMILY};
  font-size: ${HEADER_FONT_SIZE}px;
  font-weight: 600;
  line-height: 16px;
  color: ${LT.text};
`;

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
  // A bare Space, Enter or printable character is REFUSED (owner call 23):
  // the sentence takes the conflict warning's place and there is no Accept.
  const refusal = capturedCombo ? bareKeyShortcutRefusal(capturedCombo) : null;
  const captureRef = useRef<HTMLDivElement>(null);

  const handleCapturedKey = useCallback(
    (e: KeyboardEvent) => {
      // Escape cancels
      if (e.key === "Escape") {
        onCancelEdit();
        return;
      }

      const combo = eventToCombo(e);
      if (!combo) return; // Pure modifier key

      const formatted = formatCombo(combo);
      setCapturedCombo(formatted);

      // Check for conflicts (a binding the list does not show is not one the
      // user can be told to resolve here -- see KeyBinding.listed)
      const conflictList = findConflicts(formatted, binding.id).filter(isListedKeybinding);
      setConflicts(conflictList);
    },
    [binding.id, onCancelEdit]
  );

  // Focus the capture box when editing starts, and make it a CAPTURE box for
  // as long as it is open: the keybinding dispatcher hands it every key
  // pressed in it -- an already-bound one too -- instead of running that key's
  // command (BUG-0199: Ctrl+S here SAVED the workbook and recorded nothing).
  useEffect(() => {
    if (editing && captureRef.current) {
      captureRef.current.focus();
    }
  }, [editing]);
  useEffect(() => {
    const el = captureRef.current;
    if (!editing || !el) return;
    return beginShortcutCapture(el, handleCapturedKey);
  }, [editing, handleCapturedKey]);

  // A host without the dispatcher (nothing else hands the box its keys).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handleCapturedKey(e.nativeEvent);
    },
    [handleCapturedKey]
  );

  const handleSave = useCallback(() => {
    if (capturedCombo && refusal === null) {
      onSaveEdit(capturedCombo);
      setCapturedCombo(null);
      setConflicts([]);
    }
  }, [capturedCombo, refusal, onSaveEdit]);

  const handleCancel = useCallback(() => {
    setCapturedCombo(null);
    setConflicts([]);
    onCancelEdit();
  }, [onCancelEdit]);

  const displayCombo = formatCombo(effectiveCombo);
  // A SCRIPT shortcut is not an extension's. Saying "Extension" here hid the one
  // fact that matters about it — that a script inside THIS WORKBOOK is holding a
  // key — behind the word for code the user installed on purpose. The category
  // column already names the owning script (host-supplied at registration), so
  // this reads "Script" and the two together say who has the key.
  const isScript = binding.source === "script";
  const sourceLabel = isScript
    ? "Script"
    : binding.source === "built-in"
      ? "Built-in"
      : binding.extensionId || "Extension";
  // A script binding is never persisted and never user-remappable
  // (setUserKeybinding refuses it, and getEffectiveCombo ignores overrides for
  // it), so an Edit button here is a control that does nothing. Hide it rather
  // than leave a dead affordance on a security surface.
  const mayEdit = !isScript;

  if (editing) {
    return h("tr", { style: rowStyles.row },
      // Command name
      h("td", { style: rowStyles.cellLabel },
        h("span", { style: rowStyles.label }, binding.label),
        h("span", { style: rowStyles.commandId }, binding.commandId),
      ),
      // Capture area (JSX, so the ref is visibly a ref prop rather than an
      // object handed to a function during render)
      h("td", { style: rowStyles.cellCombo },
        <div ref={captureRef} tabIndex={0} style={rowStyles.captureBox} onKeyDown={handleKeyDown}>
          {capturedCombo
            ? h("span", { style: rowStyles.capturedText }, capturedCombo)
            : h("span", { style: rowStyles.captureHint }, "Press key combination...")}
        </div>,
        refusal !== null
          ? h("div", { style: rowStyles.refusal, role: "alert", "data-shortcut-refusal": "" }, refusal)
          : conflicts.length > 0 && h("div", { style: rowStyles.conflictWarning },
            "Conflict with: " + conflicts.map((c) => c.label).join(", ")
          ),
      ),
      // Source
      h("td", { style: rowStyles.cellSource }, sourceLabel),
      // Actions
      h("td", { style: rowStyles.cellActions },
        capturedCombo && refusal === null && h(Button, {
          type: "button",
          variant: "outlined",
          size: "sm",
          style: rowStyles.actionBtn,
          onClick: handleSave,
          title: "Accept",
        }, "Accept"),
        h(Button, {
          type: "button",
          variant: "outlined",
          size: "sm",
          style: rowStyles.actionBtn,
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
        onClick: mayEdit ? onStartEdit : undefined,
        title: mayEdit
          ? "Click to change shortcut"
          : "A script holds this shortcut. It cannot be remapped — remove it, or stop the script.",
      }, displayCombo),
    ),
    // Source
    h("td", { style: rowStyles.cellSource }, sourceLabel),
    // Actions
    h("td", { style: rowStyles.cellActions },
      mayEdit && h(Button, {
        type: "button",
        variant: "outlined",
        size: "sm",
        style: rowStyles.actionBtn,
        onClick: onStartEdit,
        title: "Edit shortcut",
      }, "Edit"),
      isOverridden && h(Button, {
        type: "button",
        variant: "outlined",
        size: "sm",
        tone: "danger",
        style: rowStyles.actionBtn,
        onClick: onReset,
        title: "Reset to default",
      }, "Reset"),
      onDelete && h(Button, {
        type: "button",
        variant: "outlined",
        size: "sm",
        tone: "danger",
        style: rowStyles.actionBtn,
        onClick: onDelete,
        title: isScript
          ? "Take this shortcut back from the script"
          : "Remove this custom shortcut",
      }, isScript ? "Revoke" : "Delete"),
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

  // The Add Shortcut form's key box records every key pressed in it, an
  // already-bound one included, instead of running it (see the row's box).
  const handleAddCapturedKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { setAddCombo(""); return; }
    const combo = eventToCombo(e);
    if (combo) setAddCombo(formatCombo(combo));
  }, []);
  useEffect(() => {
    const el = addCaptureRef.current;
    if (!showAddForm || !el) return;
    return beginShortcutCapture(el, handleAddCapturedKey);
  }, [showAddForm, handleAddCapturedKey]);

  // Re-render when keybindings change
  useEffect(() => {
    const unsub = subscribeToKeybindingChanges(() => {
      setVersion((v) => v + 1);
    });
    return unsub;
  }, []);

  // Only the bindings the list is meant to show: a REFUSAL binding (for one,
  // FloatingRange's ~40 "not while my range owns the selection" keys) declares
  // `listed: false` and is left out, rows and conflict warnings alike.
  const allBindings = getAllKeybindings().filter(isListedKeybinding);
  const categories = getCategories();
  const addConflicts = addCombo ? findConflicts(addCombo).filter(isListedKeybinding) : [];
  const addRefusal = addCombo ? bareKeyShortcutRefusal(addCombo) : null;

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

  const handleResetAll = useCallback(async () => {
    // AWAITED. The bare `confirm(...)` returned a truthy Promise, so Cancel
    // wiped every custom shortcut just as OK did.
    if (await confirmAsync("Reset all keyboard shortcuts to their defaults?")) {
      resetAllKeybindings();
    }
  }, []);

  const handleDelete = useCallback((id: string) => {
    removeCustomKeybinding(id);
  }, []);

  /** Take a script's shortcut back. A user who cannot see WHY a key stopped
   *  working must at least be able to reclaim it without stopping the script;
   *  the script is told nothing and simply stops being called. */
  const handleRevokeScript = useCallback((id: string) => {
    revokeScriptKeybinding(id);
  }, []);

  const handleAddSubmit = useCallback(() => {
    if (!addCombo || !addCommandId || addRefusal !== null) return;
    addCustomKeybinding(addCombo, addCommandId, addLabel || addCommandId, addCategory, addContext);
    setShowAddForm(false);
    setAddLabel("");
    setAddCommandId("");
    setAddCombo("");
    setAddCategory("Custom");
    setAddContext("always");
  }, [addCombo, addCommandId, addRefusal, addLabel, addCategory, addContext]);

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
      h("h3", { className: sectionTitleClass }, "Keyboard shortcuts"),
      h("div", { style: pageStyles.headerActions },
        h(Button, {
          type: "button",
          variant: "outlined",
          size: "sm",
          onClick: () => setShowAddForm(true),
        }, "+ Add Shortcut"),
        h(Button, {
          type: "button",
          variant: "outlined",
          size: "sm",
          onClick: () => void handleResetAll(),
        }, "Reset All"),
      ),
    ),

    // Add Shortcut Form (inline)
    showAddForm && h("div", { style: pageStyles.addForm },
      h("h3", { className: sectionTitleClass, style: pageStyles.addFormTitle }, "Add new keyboard shortcut"),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Label:"),
        h(Input, {
          type: "text",
          placeholder: "My Shortcut",
          value: addLabel,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAddLabel(e.target.value),
          style: pageStyles.addFormField,
        }),
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Command:"),
        h(Select, {
          value: addCommandId,
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setAddCommandId(e.target.value),
        },
          h("option", { value: "" }, "-- Select a command --"),
          ...availableCommands.map((cmd) =>
            h("option", { key: cmd, value: cmd }, cmd)
          ),
        ),
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Shortcut:"),
        <div
          ref={addCaptureRef}
          tabIndex={0}
          style={{
            ...pageStyles.addFormCapture,
            backgroundColor: addCombo ? LT.inputBg : LT.warnBg,
          }}
          onFocus={() => { /* ready to capture */ }}
          onKeyDown={(e: React.KeyboardEvent) => {
            // A host without the dispatcher (it otherwise hands the box its keys).
            e.preventDefault();
            e.stopPropagation();
            handleAddCapturedKey(e.nativeEvent);
          }}
        >
          {addCombo || "Click here and press a key combination..."}
        </div>,
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Category:"),
        h(Input, {
          type: "text",
          placeholder: "Custom",
          value: addCategory,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAddCategory(e.target.value),
          style: pageStyles.addFormField,
        }),
      ),
      h("div", { style: pageStyles.addFormRow },
        h("label", { style: pageStyles.addFormLabel }, "Context:"),
        h(Select, {
          value: addContext,
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setAddContext(e.target.value as "always" | "editing" | "not-editing"),
        },
          h("option", { value: "always" }, "Always"),
          h("option", { value: "not-editing" }, "When not editing"),
          h("option", { value: "editing" }, "When editing"),
        ),
      ),
      addRefusal !== null
        ? h("div", { style: pageStyles.addFormConflict, role: "alert", "data-shortcut-refusal": "" }, addRefusal)
        : addConflicts.length > 0 && h("div", { style: pageStyles.addFormConflict },
          "Warning: conflicts with ", addConflicts.map((c) => c.label).join(", "),
        ),
      h("div", { style: pageStyles.addFormActions },
        h(Button, {
          type: "button",
          variant: "outlined",
          size: "sm",
          onClick: handleAddSubmit,
          disabled: !addCombo || !addCommandId || addRefusal !== null,
        }, "Add"),
        h(Button, {
          type: "button",
          variant: "outlined",
          size: "sm",
          onClick: handleAddCancel,
        }, "Cancel"),
      ),
    ),

    // Search
    h("div", { style: pageStyles.searchContainer },
      h(Input, {
        type: "text",
        placeholder: "Search shortcuts...",
        value: searchTerm,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm((e.target as HTMLInputElement).value),
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
                // A user's own custom shortcut can be deleted; a SCRIPT's can be
                // revoked. Leaving the script case out meant the one binding the
                // user did not create was also the one they could not take back
                // from this page.
                onDelete:
                  binding.source === "user"
                    ? () => handleDelete(binding.id)
                    : binding.source === "script"
                      ? () => handleRevokeScript(binding.id)
                      : undefined,
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
// Page Styles (every colour is an LT token)
// ============================================================================

const pageStyles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
    fontFamily: FONT_FAMILY,
    color: LT.text,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    padding: "14px 16px 10px",
    borderBottom: `1px solid ${LT.controlDivider}`,
  },
  headerActions: {
    display: "flex",
    gap: 8,
  },
  addForm: {
    padding: "12px 16px",
    margin: "0 16px 8px",
    borderRadius: LT.radiusCluster,
    backgroundColor: LT.clusterBg,
    border: `1px solid ${LT.clusterBorder}`,
  },
  addFormTitle: {
    marginBottom: 10,
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
    color: LT.textSecondary,
    textAlign: "right" as const,
    flexShrink: 0,
  },
  /** An @api Input in a form row: takes the rest of the row. */
  addFormField: {
    flex: 1,
    minWidth: 0,
  },
  /** The key-capture box: the field chrome, drawn here because it is a
   *  focusable div, not an input (it swallows the keystroke it records). */
  addFormCapture: {
    flex: 1,
    minWidth: 0,
    boxSizing: "border-box" as const,
    display: "flex",
    alignItems: "center",
    minHeight: 28,
    padding: "0 8px",
    fontSize: 12,
    color: LT.text,
    border: `1px solid ${LT.controlBorder}`,
    borderRadius: LT.radiusControl,
    cursor: "pointer",
    outline: "none",
  },
  addFormConflict: {
    color: LT.dangerFg,
    fontSize: 12,
    padding: "4px 0 0 120px",
  },
  addFormActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  searchContainer: {
    padding: "10px 16px",
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
    fontSize: HEADER_FONT_SIZE,
    fontWeight: 600,
    lineHeight: "16px",
    color: LT.textSecondary,
    borderBottom: `1px solid ${LT.border}`,
    position: "sticky" as const,
    top: 0,
    backgroundColor: LT.panel,
  },
  /** A category is a section of the table: the panel header recipe. */
  categoryHeader: {
    padding: "12px 8px 4px",
    fontSize: HEADER_FONT_SIZE,
    fontWeight: 600,
    lineHeight: "16px",
    color: LT.text,
    borderBottom: `1px solid ${LT.controlDivider}`,
  },
  emptyState: {
    textAlign: "center" as const,
    padding: "24px 8px",
    color: LT.textTertiary,
    fontSize: 12,
  },
  footer: {
    padding: "10px 16px",
    fontSize: 11,
    color: LT.textTertiary,
    borderTop: `1px solid ${LT.controlDivider}`,
  },
};

// ============================================================================
// Row Styles (every colour is an LT token)
// ============================================================================

const rowStyles: Record<string, React.CSSProperties> = {
  row: {
    borderBottom: `1px solid ${LT.controlDivider}`,
  },
  cellLabel: {
    padding: "6px 8px",
    verticalAlign: "middle" as const,
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 500,
    color: LT.text,
  },
  commandId: {
    display: "block",
    fontSize: 10,
    color: LT.textTertiary,
    marginTop: 1,
    fontFamily: FONT_MONO,
  },
  cellCombo: {
    padding: "6px 8px",
    verticalAlign: "middle" as const,
  },
  comboDisplay: {
    display: "inline-block",
    padding: "2px 8px",
    fontSize: 11,
    fontFamily: FONT_MONO,
    color: LT.text,
    backgroundColor: LT.clusterBg,
    borderRadius: 4,
    border: `1px solid ${LT.controlBorder}`,
    cursor: "pointer",
    userSelect: "none" as const,
  },
  overridden: {
    fontWeight: 700,
    backgroundColor: LT.pressed,
    borderColor: LT.pressedBorder,
  },
  captureBox: {
    padding: "6px 10px",
    fontSize: 12,
    fontFamily: FONT_MONO,
    backgroundColor: LT.warnBg,
    borderRadius: 4,
    border: `2px solid ${LT.warnFg}`,
    outline: "none",
    minWidth: 120,
    textAlign: "center" as const,
  },
  capturedText: {
    fontWeight: 600,
    color: LT.text,
  },
  captureHint: {
    color: LT.textTertiary,
    fontStyle: "italic" as const,
    fontSize: 11,
  },
  conflictWarning: {
    marginTop: 4,
    fontSize: 10,
    color: LT.warnFg,
    fontWeight: 500,
  },
  /** A refused key (a bare Space, Enter or character): the danger tone, and
   *  wrapped -- the sentence is longer than the box. */
  refusal: {
    marginTop: 4,
    maxWidth: 260,
    fontSize: 10,
    color: LT.dangerFg,
    fontWeight: 500,
    whiteSpace: "normal" as const,
  },
  cellSource: {
    padding: "6px 8px",
    fontSize: 11,
    color: LT.textSecondary,
    verticalAlign: "middle" as const,
  },
  cellActions: {
    padding: "6px 8px",
    verticalAlign: "middle" as const,
    whiteSpace: "nowrap" as const,
  },
  /** Spacing between the @api Buttons in the Actions cell. */
  actionBtn: {
    marginRight: 4,
  },
};

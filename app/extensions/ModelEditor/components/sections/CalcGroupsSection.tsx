// FILENAME: app/extensions/ModelEditor/components/sections/CalcGroupsSection.tsx
// PURPOSE: Calculation groups section of the Model Editor window, displayed
//          like the Measures tree: each GROUP is a collapsible top node and
//          its ITEMS (named formulas that transform the measure in play via
//          SELECTEDMEASURE()) are the child rows. A single click on a group
//          or an item opens a properties pane; double-click (or "Edit
//          formula…") opens the workspace modal, which edits one item's
//          formula at a time front-and-centre. Blank item formulas are legal —
//          they evaluate to BLANK().
//
//          All pane mutations are SERIALIZED through a promise queue and
//          resolve their group FRESH at execution time (with a rename alias
//          map) — a blur-committed rename is often immediately followed by
//          the click that caused the blur (Add item, Edit formula…, Delete),
//          and building that second op from the render-time snapshot would
//          silently revert the rename or hit "not found". The modal mounts
//          only when the queue is idle, so it always seeds from fresh state.

import React, { useEffect, useRef, useState } from "react";
import { biModelDeleteCalcGroup, biModelUpsertCalcGroup } from "@api";
import type { CalcGroupItemDto, ModelCalcGroupInfo, ModelOverview } from "@api";
import { ACCENT, Badge, Field, Modal, SELECTION_BG, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { CalcGroupIcon, Chevron, treeStyles } from "../treeKit";
import { ExpressionWorkspace } from "./ExpressionWorkspace";

/** What a modal save actually installed — for selection/alias reconciliation. */
interface SavedGroup {
  name: string;
  items: CalcGroupItemDto[];
  /** AS-style selection-state expressions (undefined = not defined). */
  multipleOrEmptySelection?: string;
  multipleOrEmptySelectionFormat?: string;
  noSelection?: string;
  noSelectionFormat?: string;
  /** Item renames as [oldName, newName] pairs (edit mode only). */
  renames: [string, string][];
}

export function CalcGroupsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const groups = overview.calculationGroups;

  /** item = null selects the group node itself. */
  const [selected, setSelected] = useState<{ group: string; item: string | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{
    /** null = creating a new group. Resolved to the LIVE group at mount. */
    groupName: string | null;
    initialItem?: number;
    /** Preselect a selection-state expression instead of an item. */
    initialSel?: "moe" | "nosel";
  } | null>(null);
  /** In-flight queued ops; the modal mounts only when this is 0. */
  const [pending, setPending] = useState(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    group: string;
    /** null = the menu was opened on the group node. */
    item: string | null;
  } | null>(null);

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Latest known-good groups: synced from the overview, updated optimistically
  // after each queued save so follow-up ops build on what was submitted.
  const latestGroupsRef = useRef(groups);
  useEffect(() => {
    latestGroupsRef.current = groups;
  }, [groups]);
  // Rename trail (old -> new) so an op enqueued against a pre-rename name
  // still finds its group. Never auto-cleared — old names stay unambiguous
  // for the life of the window.
  const aliasRef = useRef(new Map<string, string>());
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const resolveGroupName = (name: string): string => {
    let n = name;
    const seen = new Set<string>();
    while (aliasRef.current.has(n) && !seen.has(n)) {
      seen.add(n);
      n = aliasRef.current.get(n)!;
    }
    return n;
  };

  const enqueue = (fn: () => Promise<void>): void => {
    if (readOnly) return;
    setPending((p) => p + 1);
    queueRef.current = queueRef.current
      .then(fn)
      .catch((err: unknown) => reportError(err))
      .finally(() => setPending((p) => p - 1));
  };

  /** Run a full-payload group upsert against the FRESH group state. `op`
   *  returns the new {name, items} (or null to skip, e.g. a guard failed). */
  const enqueueGroupOp = (
    groupName: string,
    op: (g: ModelCalcGroupInfo) => { name: string; items: CalcGroupItemDto[] } | null,
    after?: (g: ModelCalcGroupInfo, saved: { name: string; items: CalcGroupItemDto[] }) => void,
  ): void => {
    enqueue(async () => {
      const target = resolveGroupName(groupName);
      const g = latestGroupsRef.current.find((x) => x.name === target);
      if (!g) {
        reportError(`Calculation group '${groupName}' changed while the edit was pending — retry.`);
        return;
      }
      const payload = op(g);
      if (!payload) return;
      try {
        const o = await biModelUpsertCalcGroup({
          connectionId,
          originalName: g.name,
          name: payload.name,
          items: payload.items,
          // An upsert replaces the whole group — carry the selection-state
          // expressions forward or they would be wiped by every item edit.
          multipleOrEmptySelection: g.multipleOrEmptySelection ?? null,
          multipleOrEmptySelectionFormat: g.multipleOrEmptySelectionFormat ?? null,
          noSelection: g.noSelection ?? null,
          noSelectionFormat: g.noSelectionFormat ?? null,
        });
        if (payload.name !== g.name) aliasRef.current.set(g.name, payload.name);
        latestGroupsRef.current = latestGroupsRef.current.map((x) =>
          x.name === g.name ? { ...x, name: payload.name, items: payload.items } : x,
        );
        applyOverview(o);
        after?.(g, payload);
      } catch (err: unknown) {
        reportError(err);
      }
    });
  };

  const selectedGroup = selected ? groups.find((g) => g.name === selected.group) : undefined;
  const selectedItem =
    selectedGroup && selected?.item != null
      ? selectedGroup.items.find((i) => i.name === selected.item)
      : undefined;

  const toggleCollapse = (group: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  const handleDeleteGroup = (name: string): void => {
    if (!window.confirm(`Delete calculation group '${name}'?`)) return;
    enqueue(async () => {
      const target = resolveGroupName(name);
      try {
        const o = await biModelDeleteCalcGroup(connectionId, target);
        latestGroupsRef.current = latestGroupsRef.current.filter((g) => g.name !== target);
        applyOverview(o);
        setSelected((cur) => (cur && (cur.group === name || cur.group === target) ? null : cur));
      } catch (err: unknown) {
        reportError(err);
      }
    });
  };

  const renameGroup = (name: string, newName: string): void => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    enqueueGroupOp(
      name,
      (g) => {
        if (trimmed === g.name) return null;
        if (
          latestGroupsRef.current.some(
            (o) => o.name !== g.name && o.name.toLowerCase() === trimmed.toLowerCase(),
          )
        ) {
          reportError(`A calculation group named '${trimmed}' already exists.`);
          return null;
        }
        return { name: trimmed, items: g.items };
      },
      // Re-point the selection only if it still sits on the renamed group —
      // the blur that committed this rename may have been the user clicking
      // ANOTHER row, and that newer selection must win.
      (g, saved) =>
        setSelected((cur) =>
          cur && (cur.group === name || cur.group === g.name)
            ? { group: saved.name, item: cur.item }
            : cur,
        ),
    );
  };

  const renameItem = (groupName: string, itemName: string, newName: string): void => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    enqueueGroupOp(
      groupName,
      (g) => {
        if (trimmed === itemName) return null;
        if (!g.items.some((i) => i.name === itemName)) return null;
        if (
          g.items.some(
            (i) => i.name !== itemName && i.name.toLowerCase() === trimmed.toLowerCase(),
          )
        ) {
          reportError(`Item '${trimmed}' already exists in '${g.name}'.`);
          return null;
        }
        return {
          name: g.name,
          items: g.items.map((i) => (i.name === itemName ? { ...i, name: trimmed } : i)),
        };
      },
      (g) =>
        setSelected((cur) =>
          cur && (cur.group === groupName || cur.group === g.name) && cur.item === itemName
            ? { group: g.name, item: trimmed }
            : cur,
        ),
    );
  };

  const deleteItem = (groupName: string, itemName: string): void => {
    if (!window.confirm(`Delete item '${itemName}'?`)) return;
    enqueueGroupOp(
      groupName,
      (g) => {
        if (g.items.length <= 1 || !g.items.some((i) => i.name === itemName)) return null;
        return { name: g.name, items: g.items.filter((i) => i.name !== itemName) };
      },
      (g) =>
        setSelected((cur) =>
          cur && (cur.group === groupName || cur.group === g.name) && cur.item === itemName
            ? { group: g.name, item: null }
            : cur,
        ),
    );
  };

  // Appends a fresh blank item (blank formula = BLANK()) and selects it — the
  // pane is then right there for the rename, the modal for the formula.
  const addItem = (groupName: string): void => {
    enqueueGroupOp(
      groupName,
      (g) => {
        let n = g.items.length + 1;
        while (g.items.some((i) => i.name.toLowerCase() === `item ${n}`.toLowerCase())) n++;
        return { name: g.name, items: [...g.items, { name: `Item ${n}`, formula: "" }] };
      },
      (g, saved) => {
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(g.name);
          return next;
        });
        setSelected({ group: saved.name, item: saved.items[saved.items.length - 1].name });
      },
    );
  };

  const editItemFormula = (groupName: string, itemName: string, formula: string): void => {
    const next = formula.trim();
    enqueueGroupOp(groupName, (g) => {
      const item = g.items.find((i) => i.name === itemName);
      if (!item || item.formula === next) return null;
      return {
        name: g.name,
        items: g.items.map((i) => (i.name === itemName ? { ...i, formula: next } : i)),
      };
    });
  };

  const openModal = (groupName: string | null, itemName?: string | null): void => {
    if (readOnly) return;
    // The item is addressed by INDEX (stable across renames); resolved from
    // the current render — fine, since the modal itself mounts queue-idle.
    const g = groupName ? groups.find((x) => x.name === groupName) : null;
    const idx = g && itemName ? g.items.findIndex((i) => i.name === itemName) : -1;
    setEditing({ groupName, initialItem: idx >= 0 ? idx : undefined });
  };

  // Resolve the modal's group at render time — the modal only mounts when the
  // queue is idle, so this is the post-save truth. A group deleted while the
  // open was pending closes the request (render-adjust pattern; converges).
  const modalOriginal = editing?.groupName
    ? (groups.find((g) => g.name === resolveGroupName(editing.groupName!)) ?? null)
    : null;
  if (editing && editing.groupName && pending === 0 && !modalOriginal) {
    setEditing(null);
  }

  const handleModalSaved = (o: ModelOverview, saved: SavedGroup): void => {
    const oldName = editing?.groupName ? resolveGroupName(editing.groupName) : null;
    if (oldName && saved.name !== oldName) aliasRef.current.set(oldName, saved.name);
    const savedInfo = {
      name: saved.name,
      items: saved.items,
      multipleOrEmptySelection: saved.multipleOrEmptySelection,
      multipleOrEmptySelectionFormat: saved.multipleOrEmptySelectionFormat,
      noSelection: saved.noSelection,
      noSelectionFormat: saved.noSelectionFormat,
    };
    latestGroupsRef.current = oldName
      ? latestGroupsRef.current.map((g) => (g.name === oldName ? savedInfo : g))
      : [...latestGroupsRef.current, savedInfo];
    applyOverview(o);
    setSelected((cur) => {
      // A newly created group becomes the selection when nothing else is.
      if (!oldName) return cur ?? { group: saved.name, item: null };
      if (!cur || (cur.group !== oldName && cur.group !== editing?.groupName)) return cur;
      const item = cur.item
        ? (saved.renames.find(([from]) => from === cur.item)?.[1] ??
          (saved.items.some((i) => i.name === cur.item) ? cur.item : null))
        : null;
      return { group: saved.name, item };
    });
    setEditing(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Calculation Groups ({groups.length})
        </span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ groupName: null })}>
          New
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedGroup}
          onClick={() => selectedGroup && openModal(selectedGroup.name, selected?.item)}
        >
          Edit
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedGroup}
          onClick={() => selectedGroup && handleDeleteGroup(selectedGroup.name)}
        >
          Delete
        </button>
      </div>

      {/* Tree + properties pane — same shape as the Measures tab. */}
      <div style={{ display: "flex", gap: 10, flex: 1, minHeight: 0 }}>
        <div style={{ ...styles.card, flex: 1, minWidth: 0, overflowY: "auto", padding: 4 }}>
          {groups.length === 0 && (
            <div style={{ ...styles.muted, padding: 8 }}>
              No calculation groups defined — create one with New.
            </div>
          )}
          {groups.map((g) => {
            const isOpen = !collapsed.has(g.name);
            const groupSelected = selected?.group === g.name && selected.item === null;
            return (
              <div key={g.name}>
                <div
                  style={{
                    ...treeStyles.folderRow,
                    background: groupSelected ? SELECTION_BG : undefined,
                  }}
                  onClick={() => setSelected({ group: g.name, item: null })}
                  onDoubleClick={() => openModal(g.name, null)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (readOnly) return;
                    setSelected({ group: g.name, item: null });
                    setMenu({ x: e.clientX, y: e.clientY, group: g.name, item: null });
                  }}
                  title={`${g.items.length} item${g.items.length === 1 ? "" : "s"}`}
                >
                  <span
                    style={{ display: "flex", alignItems: "center" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(g.name);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <Chevron open={isOpen} />
                  </span>
                  <span style={{ color: "#666", display: "flex", alignItems: "center" }}>
                    <CalcGroupIcon />
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {g.name}
                  </span>
                  <button
                    style={{
                      marginLeft: "auto",
                      border: "1px solid transparent",
                      background: "transparent",
                      color: "#666",
                      cursor: "pointer",
                      fontSize: 13,
                      lineHeight: 1,
                      padding: "1px 5px",
                      borderRadius: 3,
                      flexShrink: 0,
                    }}
                    title="Add item"
                    disabled={readOnly}
                    onClick={(e) => {
                      e.stopPropagation();
                      addItem(g.name);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    +
                  </button>
                  <span style={{ ...styles.muted, fontSize: 11, flexShrink: 0 }}>
                    {g.items.length}
                  </span>
                </div>
                {isOpen &&
                  g.items.map((it) => {
                    const itemSelected =
                      selected?.group === g.name && selected.item === it.name;
                    const blank = it.formula.trim() === "";
                    return (
                      <div
                        key={it.name}
                        style={{
                          ...treeStyles.leafRow,
                          paddingLeft: 24,
                          background: itemSelected ? SELECTION_BG : undefined,
                        }}
                        onClick={() => setSelected({ group: g.name, item: it.name })}
                        onDoubleClick={() => openModal(g.name, it.name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (readOnly) return;
                          setSelected({ group: g.name, item: it.name });
                          setMenu({ x: e.clientX, y: e.clientY, group: g.name, item: it.name });
                        }}
                        title={blank ? "(blank — evaluates to BLANK())" : it.formula}
                      >
                        <span style={{ color: ACCENT, flexShrink: 0, fontSize: 11 }}>ƒ</span>
                        <span
                          style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}
                        >
                          {it.name}
                        </span>
                        <span
                          style={{
                            ...styles.muted,
                            fontSize: 12,
                            fontFamily: "Consolas, 'Cascadia Code', monospace",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flexShrink: 1,
                          }}
                        >
                          {blank ? "(blank)" : it.formula}
                        </span>
                      </div>
                    );
                  })}
                {/* AS-style selection-state expressions as editable
                    pseudo-items (double-click to edit in the group dialog). */}
                {isOpen &&
                  (
                    [
                      ["moe", "Multiple/empty selection", g.multipleOrEmptySelection],
                      ["nosel", "No selection", g.noSelection],
                    ] as const
                  ).map(([key, label, expr]) => (
                    <div
                      key={key}
                      style={{
                        ...treeStyles.leafRow,
                        paddingLeft: 24,
                        opacity: expr ? 1 : 0.55,
                      }}
                      onDoubleClick={() => {
                        if (!readOnly) setEditing({ groupName: g.name, initialSel: key });
                      }}
                      title={
                        expr ??
                        "Not set — double-click to define. Default: no item is applied " +
                          "(measures show base values)."
                      }
                    >
                      <span style={{ color: ACCENT, flexShrink: 0, fontSize: 11 }}>{"◈"}</span>
                      <span
                        style={{
                          fontStyle: "italic",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {label}
                      </span>
                      <span
                        style={{
                          ...styles.muted,
                          fontSize: 12,
                          fontFamily: "Consolas, 'Cascadia Code', monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flexShrink: 1,
                        }}
                      >
                        {expr ?? "(not set)"}
                      </span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>

        {selectedGroup && (
          <CalcGroupInspector
            key={`${selectedGroup.name}::${selectedItem?.name ?? ""}`}
            group={selectedGroup}
            item={selectedItem ?? null}
            readOnly={readOnly}
            onRenameGroup={(n) => renameGroup(selectedGroup.name, n)}
            onRenameItem={(item, n) => renameItem(selectedGroup.name, item, n)}
            onDeleteItem={(item) => deleteItem(selectedGroup.name, item)}
            onAddItem={() => addItem(selectedGroup.name)}
            onEditFormula={(item) => openModal(selectedGroup.name, item)}
            onEditFormulaText={(item, f) => editItemFormula(selectedGroup.name, item, f)}
          />
        )}
      </div>

      {menu && (
        <CalcGroupContextMenu
          menu={menu}
          lastItem={
            menu.item !== null &&
            (groups.find((g) => g.name === menu.group)?.items.length ?? 0) <= 1
          }
          onAddItem={() => {
            addItem(menu.group);
            setMenu(null);
          }}
          onEditInEditor={() => {
            openModal(menu.group, menu.item);
            setMenu(null);
          }}
          onDelete={() => {
            if (menu.item !== null) deleteItem(menu.group, menu.item);
            else handleDeleteGroup(menu.group);
            setMenu(null);
          }}
        />
      )}

      {editing && (!editing.groupName || modalOriginal) && pending === 0 && (
        <CalcGroupModal
          connectionId={connectionId}
          overview={overview}
          original={modalOriginal}
          initialItem={editing.initialItem}
          initialSel={editing.initialSel}
          onClose={() => setEditing(null)}
          onSaved={handleModalSaved}
        />
      )}
    </div>
  );
}

// ============================================================================
// Context menu — right-click on a group node or an item row
// ============================================================================

function CalcGroupContextMenu({
  menu,
  lastItem,
  onAddItem,
  onEditInEditor,
  onDelete,
}: {
  menu: { x: number; y: number; group: string; item: string | null };
  /** True when the menu targets a group's only item (cannot be deleted). */
  lastItem: boolean;
  onAddItem: () => void;
  onEditInEditor: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const isItem = menu.item !== null;
  const itemStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "5px 12px",
    border: "none",
    background: "transparent",
    color: "#222",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  };
  return (
    <div
      // Fixed at the pointer so the tree's own overflow never clips it; the
      // window click listener closes it.
      style={{
        position: "fixed",
        top: menu.y,
        left: menu.x,
        zIndex: 1000,
        minWidth: 180,
        background: "#fff",
        border: "1px solid #ccc",
        borderRadius: 4,
        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
        padding: "4px 0",
      }}
    >
      {!isItem && (
        <button style={itemStyle} onClick={onAddItem}>
          Add item
        </button>
      )}
      <button style={itemStyle} onClick={onEditInEditor}>
        {isItem ? "Edit formula…" : "Open in editor…"}
      </button>
      <button
        style={{
          ...itemStyle,
          color: "#a4262c",
          opacity: isItem && lastItem ? 0.5 : 1,
        }}
        disabled={isItem && lastItem}
        title={
          isItem && lastItem
            ? "A calculation group needs at least one item — delete the group instead"
            : undefined
        }
        onClick={onDelete}
      >
        {isItem ? "Delete item" : "Delete group"}
      </button>
    </div>
  );
}

// ============================================================================
// Properties pane — group node or item node (measures-inspector style)
// ============================================================================

function CalcGroupInspector({
  group,
  item,
  readOnly,
  onRenameGroup,
  onRenameItem,
  onDeleteItem,
  onAddItem,
  onEditFormula,
  onEditFormulaText,
}: {
  group: ModelCalcGroupInfo;
  /** null = the group node itself is selected. */
  item: CalcGroupItemDto | null;
  readOnly: boolean;
  onRenameGroup: (newName: string) => void;
  onRenameItem: (itemName: string, newName: string) => void;
  onDeleteItem: (itemName: string) => void;
  onAddItem: () => void;
  /** Open the workspace modal on this item (null = the group). */
  onEditFormula: (itemName: string | null) => void;
  /** Commit a formula typed directly in the pane (blank = BLANK()). */
  onEditFormulaText: (itemName: string, formula: string) => void;
}): React.ReactElement {
  const [name, setName] = useState(item ? item.name : group.name);
  const currentName = item ? item.name : group.name;

  // The formula is editable in place. The pane remounts when the SELECTED
  // node changes (keyed by name), but the formula can also change under the
  // same key (the workspace modal saved) — adopt the external value only when
  // the draft was un-diverged, per the measures-inspector pattern. A commit
  // that fails to parse keeps the draft so the user can fix it (the error
  // shows in the window banner).
  const [formula, setFormula] = useState(item?.formula ?? "");
  const [formulaSeed, setFormulaSeed] = useState(item?.formula ?? "");
  if (item && item.formula !== formulaSeed) {
    if (formula === formulaSeed) setFormula(item.formula);
    setFormulaSeed(item.formula);
  }

  const commitOnEnter = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter") (e.target as HTMLElement).blur();
  };
  const commitName = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(currentName);
      return;
    }
    if (trimmed === currentName) return;
    if (item) onRenameItem(item.name, trimmed);
    else onRenameGroup(trimmed);
  };

  const label: React.CSSProperties = { ...styles.label, marginTop: 8 };

  return (
    <div
      style={{
        ...styles.card,
        width: 300,
        flexShrink: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
          {item ? "Calculation item" : "Calculation group"}
        </span>
        {item && <span style={{ ...styles.muted, fontSize: 11 }}>{group.name}</span>}
      </div>

      <label style={label}>Name</label>
      <input
        style={styles.input}
        value={name}
        disabled={readOnly}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={commitOnEnter}
        onBlur={commitName}
      />

      {item ? (
        <>
          <label style={label}>Formula</label>
          <textarea
            style={{ ...styles.textarea, fontSize: 11, minHeight: 96 }}
            value={formula}
            placeholder="(blank — evaluates to BLANK())"
            disabled={readOnly}
            onChange={(e) => setFormula(e.target.value)}
            onBlur={() => {
              if (formula.trim() !== item.formula) onEditFormulaText(item.name, formula);
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button style={styles.btn} disabled={readOnly} onClick={() => onEditFormula(item.name)}>
              Edit in editor…
            </button>
            <button
              style={{ ...styles.btn, color: "#a4262c" }}
              disabled={readOnly || group.items.length <= 1}
              title={
                group.items.length <= 1
                  ? "A calculation group needs at least one item — delete the group instead"
                  : undefined
              }
              onClick={() => onDeleteItem(item.name)}
            >
              Delete item
            </button>
          </div>
          <div style={{ ...styles.hint, marginTop: 10 }}>
            Inside an item formula, SELECTEDMEASURE() references whichever measure is in play when
            the item is applied.
          </div>
        </>
      ) : (
        <>
          <label style={label}>Items</label>
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            {group.items.length} item{group.items.length === 1 ? "" : "s"}{" "}
            <Badge tone="neutral">
              {group.items.map((i) => i.name).join(", ") || "none"}
            </Badge>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={styles.btn} disabled={readOnly} onClick={onAddItem}>
              Add item
            </button>
            <button style={styles.btn} disabled={readOnly} onClick={() => onEditFormula(null)}>
              Open in editor…
            </button>
          </div>
          <div style={{ ...styles.hint, marginTop: 10 }}>
            A calculation group is a set of named items whose formulas transform whichever measure
            is in play — applied as an axis in pivots, each item becomes one transformed variant.
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Add/edit modal — same workspace layout as the Measure editor; one item's
// formula is in the editor at a time, switched via the chip strip.
// ============================================================================

interface ItemDraft {
  /** Stable per-draft identity — keys the workspace so Monaco remounts (and
   *  its undo history resets) exactly when the EDITED ITEM changes; drafts
   *  with id < original.items.length map back to the original item at that
   *  index (for rename reconciliation). */
  id: number;
  name: string;
  formula: string;
  /** Format string applied to measures transformed by this item ("" = keep
   *  the base measure's format). */
  formatString?: string;
}

function CalcGroupModal({
  connectionId,
  overview,
  original,
  initialItem,
  initialSel,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelCalcGroupInfo | null;
  /** Index of the item to preselect (e.g. "Edit formula…" from the pane). */
  initialItem?: number;
  /** Preselect a selection-state expression instead of an item. */
  initialSel?: "moe" | "nosel";
  onClose: () => void;
  onSaved: (overview: ModelOverview, saved: SavedGroup) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [items, setItems] = useState<ItemDraft[]>(() =>
    original && original.items.length > 0
      ? original.items.map((i, idx) => ({ id: idx, ...i }))
      : [{ id: 0, name: "", formula: "" }],
  );
  const nextId = useRef(original?.items.length || 1);
  // Selection: an item index, or one of the two AS-style selection-state
  // expressions ("moe" = multiple-or-empty, "nosel" = no selection).
  const [sel, setSel] = useState<number | "moe" | "nosel">(() => {
    if (initialSel) return initialSel;
    return initialItem !== undefined &&
      initialItem >= 0 &&
      initialItem < (original?.items.length ?? 0)
      ? initialItem
      : 0;
  });
  const [moeFormula, setMoeFormula] = useState(original?.multipleOrEmptySelection ?? "");
  const [moeFormat, setMoeFormat] = useState(original?.multipleOrEmptySelectionFormat ?? "");
  const [noselFormula, setNoselFormula] = useState(original?.noSelection ?? "");
  const [noselFormat, setNoselFormat] = useState(original?.noSelectionFormat ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selIndex = typeof sel === "number" ? Math.min(sel, items.length - 1) : null;
  const current = selIndex !== null ? items[selIndex] : undefined;

  const updateItem = (index: number, patch: Partial<ItemDraft>) => {
    setItems((is) => is.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  };

  const addItem = () => {
    setItems((is) => [...is, { id: nextId.current++, name: "", formula: "" }]);
    setSel(items.length);
  };

  const removeItem = (index: number) => {
    setItems((is) => is.filter((_, j) => j !== index));
    setSel((s) =>
      typeof s === "number" ? Math.max(0, s > index ? s - 1 : Math.min(s, items.length - 2)) : s,
    );
  };

  // A blank FORMULA is legal (it evaluates to BLANK()); item names identify
  // the axis entries, so those are still required.
  const canSave =
    name.trim() !== "" && items.length > 0 && items.every((i) => i.name.trim() !== "");

  const save = async () => {
    setError(null);
    const trimmedName = name.trim();
    // Client-side duplicate guards, matching the pane's (case-insensitive,
    // trimmed): the engine only rejects exact-case duplicates, so without
    // these the two surfaces would disagree about what is a legal model.
    if (
      overview.calculationGroups.some(
        (g) => g.name !== original?.name && g.name.toLowerCase() === trimmedName.toLowerCase(),
      )
    ) {
      setError(`A calculation group named '${trimmedName}' already exists.`);
      return;
    }
    const finalItems = items.map((i) => ({
      name: i.name.trim(),
      formula: i.formula.trim(),
      formatString: i.formatString?.trim() || undefined,
    }));
    const lower = finalItems.map((i) => i.name.toLowerCase());
    const dupe = lower.find((n, i) => lower.indexOf(n) !== i);
    if (dupe) {
      setError(`Duplicate item name '${dupe}' — item names must be unique within the group.`);
      return;
    }
    setBusy(true);
    try {
      const moe = moeFormula.trim();
      const nosel = noselFormula.trim();
      const o = await biModelUpsertCalcGroup({
        connectionId,
        originalName: original?.name ?? null,
        name: trimmedName,
        items: finalItems,
        multipleOrEmptySelection: moe || null,
        multipleOrEmptySelectionFormat: (moe && moeFormat.trim()) || null,
        noSelection: nosel || null,
        noSelectionFormat: (nosel && noselFormat.trim()) || null,
      });
      const renames: [string, string][] = original
        ? items
            .map((draft, idx): [string, string] | null => {
              const orig = draft.id < original.items.length ? original.items[draft.id] : null;
              return orig && orig.name !== finalItems[idx].name
                ? [orig.name, finalItems[idx].name]
                : null;
            })
            .filter((r): r is [string, string] => r !== null)
        : [];
      onSaved(o, {
        name: trimmedName,
        items: finalItems,
        multipleOrEmptySelection: moe || undefined,
        multipleOrEmptySelectionFormat: (moe && moeFormat.trim()) || undefined,
        noSelection: nosel || undefined,
        noSelectionFormat: (nosel && noselFormat.trim()) || undefined,
        renames,
      });
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 10px",
    borderRadius: 12,
    fontSize: 12,
    cursor: "pointer",
    border: active ? `1px solid ${ACCENT}` : "1px solid #ccc",
    background: active ? "#eff5ff" : "#fff",
    color: active ? ACCENT : "#444",
    fontWeight: active ? 600 : 400,
    whiteSpace: "nowrap",
    maxWidth: 220,
  });

  return (
    <Modal
      title={original ? `Edit Calculation Group: ${original.name}` : "New Calculation Group"}
      width={1280}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? "Saving…" : "Save Calculation Group"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        A calculation group is a set of named items whose formulas transform whichever measure is
        in play — inside an item formula, SELECTEDMEASURE() references that measure. A blank
        formula is allowed and evaluates to BLANK().
      </div>

      {/* Identity row — group name and the selected item's name. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Field label="Name" flex={1}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Time Intelligence"
          />
        </Field>
        <Field label="Item name" flex={1}>
          <input
            style={styles.input}
            value={current?.name ?? ""}
            disabled={selIndex === null}
            onChange={(e) => {
              if (selIndex !== null) updateItem(selIndex, { name: e.target.value });
            }}
            placeholder={selIndex === null ? "(selection expression)" : "e.g. YTD"}
          />
        </Field>
        {/* Format string of the SELECTED item / selection expression. Applied
            to any measure it transforms; blank keeps the measure's format. */}
        <Field label="Format" flex={1}>
          <input
            style={styles.input}
            value={
              sel === "moe"
                ? moeFormat
                : sel === "nosel"
                  ? noselFormat
                  : (current?.formatString ?? "")
            }
            onChange={(e) => {
              const v = e.target.value;
              if (sel === "moe") setMoeFormat(v);
              else if (sel === "nosel") setNoselFormat(v);
              else if (selIndex !== null) updateItem(selIndex, { formatString: v });
            }}
            placeholder="e.g. #,##0.00 or 0.0% (blank = measure format)"
            title="Number format applied to measures transformed by this item (e.g. a YOY% item formatting any measure as a percentage). Blank keeps each measure's own format."
          />
        </Field>
      </div>

      {/* Item strip — one chip per item; the selected item's formula is in the editor. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <span style={{ ...styles.label, marginRight: 2 }}>Items</span>
        {items.map((item, i) => (
          <span key={item.id} style={chipStyle(i === sel)} onClick={() => setSel(i)}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {item.name.trim() || `(item ${i + 1})`}
            </span>
            {items.length > 1 && (
              <span
                title="Remove this item"
                style={{ color: "#999", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                onClick={(e) => {
                  e.stopPropagation();
                  removeItem(i);
                }}
              >
                ×
              </span>
            )}
          </span>
        ))}
        <button style={styles.smallBtn} onClick={addItem}>
          + Add item
        </button>
        {/* AS-style selection-state expressions: applied when the group is
            filtered to several items / none (multiple-or-empty) or not
            filtered at all (no selection). Blank = default: base measures. */}
        <span style={{ width: 1, alignSelf: "stretch", background: "#ddd", margin: "0 4px" }} />
        <span
          style={chipStyle(sel === "moe")}
          onClick={() => setSel("moe")}
          title={
            "Applied when several items (or none) are selected on a filter/slicer. " +
            "Blank = default: no item applied, measures show base values."
          }
        >
          Multiple/empty selection{moeFormula.trim() ? " •" : ""}
        </span>
        <span
          style={chipStyle(sel === "nosel")}
          onClick={() => setSel("nosel")}
          title={
            "Applied when the group is placed as a filter but nothing is filtered. " +
            "Blank = default: no item applied, measures show base values."
          }
        >
          No selection{noselFormula.trim() ? " •" : ""}
        </span>
      </div>

      {/* Workspace: the selected item's (or selection expression's) formula
          front-and-centre. Keyed by the selected item's IDENTITY so Monaco's
          undo history doesn't bleed across items (an index key would survive
          removing the selected item). */}
      <ExpressionWorkspace
        key={sel === "moe" ? "moe" : sel === "nosel" ? "nosel" : (current?.id ?? -1)}
        overview={overview}
        value={
          sel === "moe" ? moeFormula : sel === "nosel" ? noselFormula : (current?.formula ?? "")
        }
        onChange={(v) => {
          if (sel === "moe") setMoeFormula(v);
          else if (sel === "nosel") setNoselFormula(v);
          else if (selIndex !== null) updateItem(selIndex, { formula: v });
        }}
        label={
          sel === "moe"
            ? "Expression — multiple or empty selection"
            : sel === "nosel"
              ? "Expression — no selection"
              : `Formula — ${current?.name.trim() || `(item ${(selIndex ?? 0) + 1})`}`
        }
        hint={
          selIndex === null
            ? "Applied instead of an item for this selection state. Blank = default: measures show their base values. SELECTEDMEASURE() references the measure in play."
            : "SELECTEDMEASURE() references whichever measure is in play when this item is applied. Leave empty for BLANK(). Drag from the tree to insert."
        }
        hintTitle="Example: CALCULATE(SELECTEDMEASURE(), DATESYTD(Calendar[date])). SELECTEDMEASURE() references whichever measure is in play when the item is applied."
      />

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

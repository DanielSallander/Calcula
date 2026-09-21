//! FILENAME: app/extensions/BuiltIn/HomeTab/components/HomeTabCustomizeDialog.tsx
// PURPOSE: Dialog for customizing which items appear in the Home ribbon tab.
// CONTEXT: Opened from View > "Customize Home Tab...".
//
// TWO RULES THIS FILE KEEPS. (1) A SEPARATOR IS MULTI-INSTANCE. The default
// layout places five row breaks, so anything keyed on "is this id already
// used" must exempt separators or Row Break is greyed out on first open and
// layout control is advertised but unreachable. Because ids repeat, item
// remove/move are INDEX-based, never equality-based. (2) NOTHING IS WRITTEN
// UNTIL SAVE. Reset hands back the default layout and touches no storage, so
// Reset-then-Cancel is a true no-op.

import React, { useState, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import { DialogBody, DialogPane, dialogWidth, dialogHeight } from "@api/dialogLayout";
import { alertAsync } from "@api/dialogs";
import {
  loadLayout,
  saveLayout,
  resetLayout,
  isMultiInstanceItem,
  ALL_ITEMS,
  ITEMS_BY_ID,
  getCategories,
  type HomeTabLayout,
} from "../homeTabConfig";
import { homeTabIcon, groupIconFor, GROUP_ICON_IDS } from "./homeTabIcons";

// ============================================================================
// Styles
// ============================================================================

const backdrop = css`
  position: fixed;
  inset: 0;
  z-index: 1050;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const dialog = css`
  background: var(--panel-bg, #2a2a2a);
  border: 1px solid var(--border-default, #444);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  width: ${dialogWidth(1000)};
  height: ${dialogHeight(680, 0.85)};
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  color: var(--text-primary, #e0e0e0);
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-default, #444);
  flex-shrink: 0;
`;

const title = css`
  font-weight: 600;
  font-size: 15px;
`;

const closeBtn = css`
  background: transparent;
  border: none;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;

  &:hover {
    background: var(--grid-bg, #333);
    color: var(--text-primary, #e0e0e0);
  }
`;

const sectionLabel = css`
  font-weight: 600;
  font-size: 13px;
  color: var(--text-secondary, #aaa);
  margin-bottom: 4px;
`;

const groupCard = css`
  border: 1px solid var(--border-default, #444);
  border-radius: 6px;
  padding: 10px 12px;
  background: var(--grid-bg, #1e1e1e);
`;

const groupHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
`;

const groupTitle = css`
  font-weight: 600;
  font-size: 13px;
`;

const groupActions = css`
  display: flex;
  gap: 4px;
`;

const smallBtn = css`
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--border-default, #444);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;

  &:hover {
    background: var(--border-default, #444);
    color: var(--text-primary, #e0e0e0);
  }
`;

const dangerBtn = css`
  ${smallBtn};
  &:hover {
    background: #dc2626;
    color: #fff;
    border-color: #dc2626;
  }
`;

const itemList = css`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

const itemChip = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-default, #444);
  border-radius: 4px;
  font-size: 12px;
  background: var(--panel-bg, #2a2a2a);
  cursor: default;
`;

const chipRemove = css`
  cursor: pointer;
  color: var(--text-secondary, #aaa);
  font-size: 10px;
  margin-left: 2px;

  &:hover {
    color: #dc2626;
  }
`;

/** The palette owns its own pane now, so it no longer needs a dashed box to
 *  say "this is a different thing" — the divider says it. */
const addSection = css`
  display: flex;
  flex-direction: column;
`;

const addSectionHeader = css`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
`;

const categorySection = css`
  margin-bottom: 8px;
`;

const categoryLabel = css`
  font-size: 11px;
  color: var(--text-secondary, #aaa);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
`;

const addableItem = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-default, #444);
  border-radius: 4px;
  font-size: 12px;
  background: transparent;
  color: var(--text-primary, #e0e0e0);
  cursor: pointer;
  margin: 2px;

  &:hover {
    background: var(--border-default, #444);
    border-color: var(--accent-primary, #0078d4);
  }
`;

const addableItemDisabled = css`
  ${addableItem};
  opacity: 0.35;
  cursor: not-allowed;

  &:hover {
    background: transparent;
    border-color: var(--border-default, #444);
  }
`;

const footer = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-default, #444);
  flex-shrink: 0;
`;

const primaryBtn = css`
  padding: 6px 20px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  min-width: 80px;
  background: var(--accent-primary, #0078d4);
  color: #ffffff;
  border: 1px solid var(--accent-primary, #0078d4);

  &:hover { opacity: 0.85; }
  &:active { opacity: 0.7; }
`;

const secondaryBtn = css`
  padding: 6px 20px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  min-width: 80px;
  background: var(--grid-bg, #333);
  color: var(--text-primary, #e0e0e0);
  border: 1px solid var(--border-default, #444);

  &:hover { opacity: 0.85; }
  &:active { opacity: 0.7; }
`;

const newGroupRow = css`
  display: flex;
  gap: 8px;
  margin-top: 8px;
`;

const newGroupInput = css`
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border-default, #444);
  border-radius: 4px;
  background: var(--grid-bg, #1e1e1e);
  color: var(--text-primary, #e0e0e0);
  font-family: inherit;
  outline: none;

  &:focus { border-color: var(--accent-primary, #0078d4); }
`;

const selectGroup = css`
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border-default, #444);
  border-radius: 4px;
  background: var(--grid-bg, #1e1e1e);
  color: var(--text-primary, #e0e0e0);
  font-family: inherit;
  outline: none;
  margin-bottom: 8px;

  &:focus { border-color: var(--accent-primary, #0078d4); }
`;

// ============================================================================
// Component
// ============================================================================

export function HomeTabCustomizeDialog(props: DialogProps): React.ReactElement | null {
  const { onClose } = props;

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 720, minHeight: 420 });

  const [layout, setLayout] = useState<HomeTabLayout>(() => loadLayout());
  const [newGroupName, setNewGroupName] = useState("");
  const [addToGroupId, setAddToGroupId] = useState<string>("");

  // Set initial "add to" group
  useEffect(() => {
    if (layout.groups.length > 0 && !addToGroupId) {
      setAddToGroupId(layout.groups[0].id);
    }
  }, [layout.groups, addToGroupId]);

  // Collect the item IDs that may appear only ONCE and already do. Separators
  // are deliberately absent: "Row Break" is placeable as often as the user
  // likes, and putting it in this set greyed it out permanently.
  const usedItemIds = new Set<string>();
  for (const group of layout.groups) {
    for (const id of group.items) {
      if (!isMultiInstanceItem(ITEMS_BY_ID.get(id))) usedItemIds.add(id);
    }
  }

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // Remove item from a group. BY INDEX: a group may hold several row breaks,
  // and filtering by equality removed every one of them at once.
  const removeItem = (groupId: string, index: number) => {
    setLayout((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (index < 0 || index >= g.items.length) return g;
        const items = [...g.items];
        items.splice(index, 1);
        return { ...g, items };
      }),
    }));
  };

  // Add item to a group
  const addItem = (groupId: string, itemId: string) => {
    setLayout((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === groupId ? { ...g, items: [...g.items, itemId] } : g
      ),
    }));
  };

  // Change a group's launcher glyph (shown when the section is demoted).
  const setGroupIcon = (groupId: string, iconId: string) => {
    setLayout((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => (g.id === groupId ? { ...g, iconId } : g)),
    }));
  };

  // Remove entire group
  const removeGroup = (groupId: string) => {
    setLayout((prev) => ({
      ...prev,
      groups: prev.groups.filter((g) => g.id !== groupId),
    }));
    // Reset addToGroupId if we removed the selected one
    if (addToGroupId === groupId) {
      const remaining = layout.groups.filter((g) => g.id !== groupId);
      setAddToGroupId(remaining.length > 0 ? remaining[0].id : "");
    }
  };

  // Move group up/down
  const moveGroup = (groupId: string, direction: -1 | 1) => {
    setLayout((prev) => {
      const idx = prev.groups.findIndex((g) => g.id === groupId);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.groups.length) return prev;
      const groups = [...prev.groups];
      [groups[idx], groups[newIdx]] = [groups[newIdx], groups[idx]];
      return { ...prev, groups };
    });
  };

  // Move item within group. BY INDEX, for the same reason as removeItem:
  // indexOf always found the FIRST row break, so the arrows on the second one
  // moved the first one.
  const moveItem = (groupId: string, index: number, direction: -1 | 1) => {
    setLayout((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (index < 0 || index >= g.items.length) return g;
        const newIdx = index + direction;
        if (newIdx < 0 || newIdx >= g.items.length) return g;
        const items = [...g.items];
        [items[index], items[newIdx]] = [items[newIdx], items[index]];
        return { ...g, items };
      }),
    }));
  };

  // Add new group
  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!id || layout.groups.some((g) => g.id === id)) return;
    setLayout((prev) => ({
      ...prev,
      // A new group collapses last (it is the one the user asked for), and
      // starts on the generic glyph until they pick one.
      groups: [...prev.groups, { id, label: name, items: [], collapsePriority: 99 }],
    }));
    setNewGroupName("");
    setAddToGroupId(id);
  };

  // Save and close.
  //
  // The dialog stays OPEN when the write fails. Closing it would destroy the
  // only copy of the user's arrangement: `saveLayout` used to swallow the
  // failure, and this handler then closed and fired `layoutChanged` anyway, so
  // the ribbon repainted from memory and the customization vanished at the next
  // launch with nothing said. Keeping the dialog up leaves the work on screen
  // and recoverable.
  const handleSave = async () => {
    // Drop groups with nothing to render. "Nothing" includes a group holding
    // only row breaks: a separator paints no button, so such a group would
    // survive as a labelled, empty section in the ribbon.
    const cleaned: HomeTabLayout = {
      ...layout,
      groups: layout.groups.filter((g) =>
        g.items.some((id) => !isMultiInstanceItem(ITEMS_BY_ID.get(id)))
      ),
    };
    if (!saveLayout(cleaned)) {
      await alertAsync(
        "Could not save the ribbon layout — the browser storage rejected the write. " +
          "Your arrangement is still here; close this message and try Save again.",
        { title: "Customize Home Tab" }
      );
      return;
    }
    window.dispatchEvent(new Event("homeTab:layoutChanged"));
    onClose();
  };

  // Reset to defaults. resetLayout() is PURE - it returns the default layout
  // and writes nothing, so this stages a reset the same way every other edit
  // in this dialog is staged. Cancelling therefore really cancels; it used to
  // clear localStorage on the spot, leaving the ribbon unchanged and the reset
  // waiting to appear at the next launch.
  const handleReset = () => {
    setLayout(resetLayout());
  };

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const categories = getCategories();

  return (
    <div className={backdrop} onMouseDown={handleBackdropClick}>
      <div
        className={dialog}
        ref={win.ref}
        data-hometab-customize-dialog=""
        style={{ position: "relative", ...win.style }}
      >
        {/* Header — drag handle */}
        <div className={header} onMouseDown={win.onHeaderMouseDown}>
          <span className={title}>Customize Home Tab</span>
          <button className={closeBtn} onClick={onClose}>X</button>
        </div>

        {/* Body — the arrangement you are building on the left, the palette you
            build it from on the right. Stacked, adding a command meant scrolling
            past every group you had already made to reach the palette, and then
            back up to see where it landed. */}
        <DialogBody>
          <DialogPane scroll grow={1.15} minWidth={280} data-testid="hometab-current-groups">
          {/* Current Groups */}
          <div>
            <div className={sectionLabel}>Current Groups</div>
            {layout.groups.map((group, gIdx) => (
              <div
                key={group.id}
                className={groupCard}
                data-hometab-group={group.id}
                style={{ marginBottom: 8 }}
              >
                <div className={groupHeader}>
                  <span className={groupTitle} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", width: 16, justifyContent: "center" }}>
                      {groupIconFor(group, 16)}
                    </span>
                    {group.label}
                  </span>
                  <div className={groupActions}>
                    <select
                      className={selectGroup}
                      style={{ marginBottom: 0 }}
                      value={group.iconId ?? ""}
                      onChange={(e) => setGroupIcon(group.id, e.target.value)}
                      title="Launcher icon (shown when this group collapses)"
                    >
                      <option value="">Icon: default</option>
                      {GROUP_ICON_IDS.map((iconId) => (
                        <option key={iconId} value={iconId}>
                          {iconId}
                        </option>
                      ))}
                    </select>
                    <button
                      className={smallBtn}
                      onClick={() => moveGroup(group.id, -1)}
                      disabled={gIdx === 0}
                      title="Move group left"
                    >
                      {"<"}
                    </button>
                    <button
                      className={smallBtn}
                      onClick={() => moveGroup(group.id, 1)}
                      disabled={gIdx === layout.groups.length - 1}
                      title="Move group right"
                    >
                      {">"}
                    </button>
                    <button
                      className={dangerBtn}
                      onClick={() => removeGroup(group.id)}
                      title="Remove group"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className={itemList}>
                  {group.items.map((itemId, iIdx) => {
                    const item = ITEMS_BY_ID.get(itemId);
                    if (!item) return null;
                    return (
                      // Keyed by POSITION, not id: row breaks repeat, and a
                      // duplicated React key silently collapses siblings.
                      <span
                        key={`${itemId}#${iIdx}`}
                        className={itemChip}
                        data-hometab-chip={itemId}
                        data-hometab-chip-index={iIdx}
                      >
                        <button
                          className={smallBtn}
                          data-hometab-chip-left=""
                          onClick={() => moveItem(group.id, iIdx, -1)}
                          disabled={iIdx === 0}
                          style={{ padding: "0 3px", fontSize: "9px", border: "none" }}
                          title="Move left"
                        >
                          {"<"}
                        </button>
                        <span style={{ fontSize: "12px", display: "inline-flex", alignItems: "center" }}>
                          {homeTabIcon(item.id, 12) ?? item.icon}
                        </span>
                        {item.label}
                        <button
                          className={smallBtn}
                          onClick={() => moveItem(group.id, iIdx, 1)}
                          disabled={iIdx === group.items.length - 1}
                          style={{ padding: "0 3px", fontSize: "9px", border: "none" }}
                          title="Move right"
                        >
                          {">"}
                        </button>
                        <span
                          className={chipRemove}
                          onClick={() => removeItem(group.id, iIdx)}
                          title="Remove item"
                        >
                          X
                        </span>
                      </span>
                    );
                  })}
                  {group.items.length === 0 && (
                    <span style={{ color: "var(--text-secondary, #888)", fontStyle: "italic", fontSize: "12px" }}>
                      Empty group - add items below or it will be removed on save
                    </span>
                  )}
                </div>
              </div>
            ))}

            {/* New group */}
            <div className={newGroupRow}>
              <input
                className={newGroupInput}
                type="text"
                placeholder="New group name..."
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addGroup();
                }}
              />
              <button className={smallBtn} onClick={addGroup}>
                Add Group
              </button>
            </div>
          </div>

          </DialogPane>

          <DialogPane scroll minWidth={260} style={{ borderLeft: "1px solid var(--border-default, #444)" }} data-testid="hometab-available-commands">
          {/* Available Items */}
          <div className={addSection}>
            <div className={addSectionHeader}>Available Commands</div>
            {layout.groups.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: "12px", marginRight: 8 }}>Add to:</span>
                <select
                  className={selectGroup}
                  data-hometab-add-to=""
                  value={addToGroupId}
                  onChange={(e) => setAddToGroupId(e.target.value)}
                >
                  {layout.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {categories.map((cat) => {
              const catItems = ALL_ITEMS.filter((i) => i.category === cat);
              return (
                <div key={cat} className={categorySection}>
                  <div className={categoryLabel}>{cat}</div>
                  <div>
                    {catItems.map((item) => {
                      const isUsed = usedItemIds.has(item.id);
                      return (
                        <button
                          key={item.id}
                          className={isUsed ? addableItemDisabled : addableItem}
                          data-hometab-add={item.id}
                          disabled={isUsed || !addToGroupId}
                          onClick={() => {
                            if (!isUsed && addToGroupId) {
                              addItem(addToGroupId, item.id);
                            }
                          }}
                          title={isUsed ? "Already in a group" : `Add to ${layout.groups.find((g) => g.id === addToGroupId)?.label ?? "group"}`}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center" }}>
                            {homeTabIcon(item.id, 12) ?? item.icon}
                          </span>
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          </DialogPane>
        </DialogBody>

        {/* Footer */}
        <div className={footer}>
          <button className={secondaryBtn} data-hometab-reset="" onClick={handleReset}>
            Reset to Default
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={secondaryBtn} data-hometab-cancel="" onClick={onClose}>
              Cancel
            </button>
            <button className={primaryBtn} data-hometab-save="" onClick={() => void handleSave()}>
              Save
            </button>
          </div>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}

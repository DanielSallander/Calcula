//! FILENAME: app/extensions/BuiltIn/HomeTab/components/HomeTabCustomizeDialog.tsx
// PURPOSE: Dialog for customizing which items appear in the Home ribbon tab.
// CONTEXT: Opened via the cog wheel icon in the Home tab.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api/uiTypes";
import {
  loadLayout,
  saveLayout,
  resetLayout,
  ALL_ITEMS,
  ITEMS_BY_ID,
  getCategories,
  type HomeTabLayout,
  type HomeTabGroup,
} from "../homeTabConfig";

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
  width: 600px;
  max-height: 80vh;
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

const body = css`
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
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

const addSection = css`
  border: 1px dashed var(--border-default, #444);
  border-radius: 6px;
  padding: 10px 12px;
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
  const dialogRef = useRef<HTMLDivElement>(null);

  const [layout, setLayout] = useState<HomeTabLayout>(() => loadLayout());
  const [newGroupName, setNewGroupName] = useState("");
  const [addToGroupId, setAddToGroupId] = useState<string>("");

  // Set initial "add to" group
  useEffect(() => {
    if (layout.groups.length > 0 && !addToGroupId) {
      setAddToGroupId(layout.groups[0].id);
    }
  }, [layout.groups, addToGroupId]);

  // Collect all currently used item IDs
  const usedItemIds = new Set<string>();
  for (const group of layout.groups) {
    for (const id of group.items) usedItemIds.add(id);
  }

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // Remove item from a group
  const removeItem = (groupId: string, itemId: string) => {
    setLayout((prev) => ({
      groups: prev.groups.map((g) =>
        g.id === groupId
          ? { ...g, items: g.items.filter((id) => id !== itemId) }
          : g
      ),
    }));
  };

  // Add item to a group
  const addItem = (groupId: string, itemId: string) => {
    setLayout((prev) => ({
      groups: prev.groups.map((g) =>
        g.id === groupId ? { ...g, items: [...g.items, itemId] } : g
      ),
    }));
  };

  // Remove entire group
  const removeGroup = (groupId: string) => {
    setLayout((prev) => ({
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
      return { groups };
    });
  };

  // Move item within group
  const moveItem = (groupId: string, itemId: string, direction: -1 | 1) => {
    setLayout((prev) => ({
      groups: prev.groups.map((g) => {
        if (g.id !== groupId) return g;
        const idx = g.items.indexOf(itemId);
        if (idx < 0) return g;
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= g.items.length) return g;
        const items = [...g.items];
        [items[idx], items[newIdx]] = [items[newIdx], items[idx]];
        return { ...g, items };
      }),
    }));
  };

  // Add new group
  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (layout.groups.some((g) => g.id === id)) return;
    setLayout((prev) => ({
      groups: [...prev.groups, { id, label: name, items: [] }],
    }));
    setNewGroupName("");
    setAddToGroupId(id);
  };

  // Save and close
  const handleSave = () => {
    // Remove empty groups
    const cleaned: HomeTabLayout = {
      groups: layout.groups.filter((g) => g.items.length > 0),
    };
    saveLayout(cleaned);
    window.dispatchEvent(new Event("homeTab:layoutChanged"));
    onClose();
  };

  // Reset to defaults
  const handleReset = () => {
    const defaultLayout = resetLayout();
    setLayout(defaultLayout);
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
      <div className={dialog} ref={dialogRef}>
        {/* Header */}
        <div className={header}>
          <span className={title}>Customize Home Tab</span>
          <button className={closeBtn} onClick={onClose}>X</button>
        </div>

        {/* Body */}
        <div className={body}>
          {/* Current Groups */}
          <div>
            <div className={sectionLabel}>Current Groups</div>
            {layout.groups.map((group, gIdx) => (
              <div key={group.id} className={groupCard} style={{ marginBottom: 8 }}>
                <div className={groupHeader}>
                  <span className={groupTitle}>{group.label}</span>
                  <div className={groupActions}>
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
                      <span key={itemId} className={itemChip}>
                        <button
                          className={smallBtn}
                          onClick={() => moveItem(group.id, itemId, -1)}
                          disabled={iIdx === 0}
                          style={{ padding: "0 3px", fontSize: "9px", border: "none" }}
                          title="Move left"
                        >
                          {"<"}
                        </button>
                        <span style={{ fontSize: "12px" }}>{item.icon}</span>
                        {item.label}
                        <button
                          className={smallBtn}
                          onClick={() => moveItem(group.id, itemId, 1)}
                          disabled={iIdx === group.items.length - 1}
                          style={{ padding: "0 3px", fontSize: "9px", border: "none" }}
                          title="Move right"
                        >
                          {">"}
                        </button>
                        <span
                          className={chipRemove}
                          onClick={() => removeItem(group.id, itemId)}
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

          {/* Available Items */}
          <div className={addSection}>
            <div className={addSectionHeader}>Available Commands</div>
            {layout.groups.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: "12px", marginRight: 8 }}>Add to:</span>
                <select
                  className={selectGroup}
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
                          disabled={isUsed || !addToGroupId}
                          onClick={() => {
                            if (!isUsed && addToGroupId) {
                              addItem(addToGroupId, item.id);
                            }
                          }}
                          title={isUsed ? "Already in a group" : `Add to ${layout.groups.find((g) => g.id === addToGroupId)?.label ?? "group"}`}
                        >
                          <span>{item.icon}</span>
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className={footer}>
          <button className={secondaryBtn} onClick={handleReset}>
            Reset to Default
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={secondaryBtn} onClick={onClose}>
              Cancel
            </button>
            <button className={primaryBtn} onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
//
// LOOK. Painted with theme tokens only (LT from @api/layout, and the dialog
// tokens every other dialog uses), so the dialog follows the skin; the
// buttons are @api/layout primitives and the arrows / close marks are the
// RibbonIcon set. Three things are deliberately NOT restyled into something
// else, because tests and journeys drive them:
//   - both pickers stay NATIVE selects (@api Select): the Customize journey
//     drives `[data-hometab-add-to]` with Playwright's selectOption;
//   - an item chip's controls keep their `title`s ("Move left", "Move right",
//     "Remove item"), which homeTabCustomizeDialog.test.tsx anchors on, and
//     the remove control stays a <span> for the same reason;
//   - every `data-hometab-*` hook stays on the element it was on.

import React, { useState, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import { RibbonIcon } from "@api";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import { DialogBody, DialogPane, dialogWidth, dialogHeight } from "@api/dialogLayout";
import { alertAsync } from "@api/dialogs";
import { Button, IconButton, Input, LT, Select, FONT_FAMILY } from "@api/layout";
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
  background: var(--dialog-overlay-bg, rgba(0, 0, 0, 0.5));
  display: flex;
  align-items: center;
  justify-content: center;
`;

const dialog = css`
  background: var(--dialog-bg, #ffffff);
  border: 1px solid var(--dialog-border, #d1d5db);
  border-radius: ${LT.radiusPopover};
  box-shadow: ${LT.shadowRaised};
  width: ${dialogWidth(1000)};
  height: ${dialogHeight(680, 0.85)};
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
  font-size: 13px;
`;

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid ${LT.border};
  flex-shrink: 0;
`;

const title = css`
  font-weight: 600;
  font-size: 14px;
  color: var(--dialog-title-text, #111827);
`;

/** The one header recipe (12px/600, sentence case) the ribbon redesign uses
 *  for every section heading in a pane. */
const sectionLabel = css`
  font-weight: 600;
  font-size: 12px;
  color: ${LT.text};
  margin-bottom: 8px;
`;

/** A group reads as the ribbon cluster it becomes: the cluster tint, the
 *  cluster radius, a hairline instead of a border. */
const groupCard = css`
  border-radius: ${LT.radiusCluster};
  padding: 10px 12px;
  background: ${LT.clusterBg};
  box-shadow: inset 0 0 0 1px ${LT.clusterBorder};
`;

const groupHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
`;

const groupTitle = css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
`;

const groupGlyph = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
`;

const groupActions = css`
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
`;

const itemList = css`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`;

/** A placed item: the Chip recipe (pill, chip surface, inset hairline) with
 *  its three controls inside it. */
const itemChip = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 4px;
  border-radius: ${LT.radiusPill};
  background: ${LT.chipBg};
  box-shadow: inset 0 0 0 1px ${LT.chipBorder};
  color: ${LT.text};
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
`;

const chipGlyph = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 16px;
  font-size: 12px;
  font-weight: 600;
`;

/** The round 20px controls inside a chip (move left / right, remove). */
const chipControl = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  width: 20px;
  height: 20px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: ${LT.textSecondary};
  cursor: pointer;
  transition:
    background-color ${LT.motionHover},
    color ${LT.motionHover};

  &:hover:not(:disabled) {
    background: ${LT.hover};
    color: ${LT.text};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

/** Remove is destructive: it hovers in the danger tone. */
const chipRemoveTone = css`
  &:hover {
    background: ${LT.dangerBg};
    color: ${LT.dangerFg};
  }
`;

/** The palette owns its own pane, so it needs no box to say "this is a
 *  different thing" — the divider says it. */
const addSection = css`
  display: flex;
  flex-direction: column;
`;

const addToRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
`;

const categorySection = css`
  margin-bottom: 8px;
`;

const categoryLabel = css`
  font-size: 11px;
  font-weight: 600;
  color: ${LT.textSecondary};
  margin: 6px 0;
`;

/** An addable command: the same pill as a placed chip, so the palette and
 *  the arrangement read as one vocabulary. */
const addableItem = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: 28px;
  margin: 0 6px 6px 0;
  padding: 0 10px 0 7px;
  border: none;
  border-radius: ${LT.radiusPill};
  background-color: ${LT.chipBg};
  box-shadow: inset 0 0 0 1px ${LT.chipBorder};
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &:hover:not(:disabled) {
    background-image: linear-gradient(${LT.hover}, ${LT.hover});
    box-shadow: inset 0 0 0 1px ${LT.stateAccent};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const footer = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid ${LT.border};
  flex-shrink: 0;
`;

/** Save: the dialog's one primary action, on the state accent. */
const primaryButton = css`
  && {
    background: ${LT.stateAccent};
    border-color: ${LT.stateAccent};
    color: ${LT.onAccent};
  }

  &&:hover:not(:disabled) {
    background: linear-gradient(${LT.active}, ${LT.active}), ${LT.stateAccent};
  }
`;

const FOOTER_BUTTON_STYLE: React.CSSProperties = { minWidth: 80 };

const newGroupRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
`;

const emptyGroup = css`
  color: ${LT.textSecondary};
  font-style: italic;
  font-size: 12px;
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
          <IconButton
            size="sm"
            icon={<RibbonIcon.Close size={16} />}
            label="Close"
            onClick={onClose}
          />
        </div>

        {/* Body — the arrangement you are building on the left, the palette you
            build it from on the right. Stacked, adding a command meant scrolling
            past every group you had already made to reach the palette, and then
            back up to see where it landed. */}
        <DialogBody>
          <DialogPane scroll grow={1.15} minWidth={280} data-testid="hometab-current-groups">
          {/* Current Groups */}
          <div>
            <div className={sectionLabel}>Current groups</div>
            {layout.groups.map((group, gIdx) => (
              <div
                key={group.id}
                className={groupCard}
                data-hometab-group={group.id}
                style={{ marginBottom: 8 }}
              >
                <div className={groupHeader}>
                  <span className={groupTitle}>
                    <span className={groupGlyph}>{groupIconFor(group, 20)}</span>
                    {group.label}
                  </span>
                  <div className={groupActions}>
                    <Select
                      width={150}
                      value={group.iconId ?? ""}
                      onChange={(e) => setGroupIcon(group.id, e.target.value)}
                      title="Launcher icon (shown when this group collapses)"
                      aria-label={`Launcher icon for ${group.label}`}
                    >
                      <option value="">Icon: default</option>
                      {GROUP_ICON_IDS.map((iconId) => (
                        <option key={iconId} value={iconId}>
                          {iconId}
                        </option>
                      ))}
                    </Select>
                    <IconButton
                      size="sm"
                      icon={<RibbonIcon.ChevronLeft size={16} />}
                      label="Move group left"
                      onClick={() => moveGroup(group.id, -1)}
                      disabled={gIdx === 0}
                    />
                    <IconButton
                      size="sm"
                      icon={<RibbonIcon.ChevronRight size={16} />}
                      label="Move group right"
                      onClick={() => moveGroup(group.id, 1)}
                      disabled={gIdx === layout.groups.length - 1}
                    />
                    <Button
                      size="sm"
                      tone="danger"
                      icon={<RibbonIcon.Delete size={16} />}
                      tooltip="Remove group"
                      onClick={() => removeGroup(group.id)}
                    >
                      Remove
                    </Button>
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
                          type="button"
                          className={chipControl}
                          data-hometab-chip-left=""
                          onClick={() => moveItem(group.id, iIdx, -1)}
                          disabled={iIdx === 0}
                          title="Move left"
                          aria-label={`Move ${item.label} left`}
                        >
                          <RibbonIcon.ChevronLeft size={12} />
                        </button>
                        <span className={chipGlyph} aria-hidden>
                          {homeTabIcon(item.id, 16) ?? item.icon}
                        </span>
                        {item.label}
                        <button
                          type="button"
                          className={chipControl}
                          onClick={() => moveItem(group.id, iIdx, 1)}
                          disabled={iIdx === group.items.length - 1}
                          title="Move right"
                          aria-label={`Move ${item.label} right`}
                        >
                          <RibbonIcon.ChevronRight size={12} />
                        </button>
                        <span
                          role="button"
                          tabIndex={0}
                          className={`${chipControl} ${chipRemoveTone}`}
                          onClick={() => removeItem(group.id, iIdx)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              removeItem(group.id, iIdx);
                            }
                          }}
                          title="Remove item"
                          aria-label={`Remove ${item.label}`}
                        >
                          <RibbonIcon.Close size={12} />
                        </span>
                      </span>
                    );
                  })}
                  {group.items.length === 0 && (
                    <span className={emptyGroup}>
                      Empty group - add items below or it will be removed on save
                    </span>
                  )}
                </div>
              </div>
            ))}

            {/* New group */}
            <div className={newGroupRow}>
              <Input
                type="text"
                placeholder="New group name..."
                aria-label="New group name"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addGroup();
                }}
                style={{ flex: 1 }}
              />
              <Button
                variant="outlined"
                icon={<RibbonIcon.Plus size={16} />}
                onClick={addGroup}
              >
                Add Group
              </Button>
            </div>
          </div>

          </DialogPane>

          <DialogPane scroll minWidth={260} style={{ borderLeft: `1px solid ${LT.border}` }} data-testid="hometab-available-commands">
          {/* Available Items */}
          <div className={addSection}>
            <div className={sectionLabel}>Available commands</div>
            {layout.groups.length > 0 && (
              <label className={addToRow}>
                <span>Add to:</span>
                <Select
                  width={180}
                  data-hometab-add-to=""
                  value={addToGroupId}
                  onChange={(e) => setAddToGroupId(e.target.value)}
                >
                  {layout.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </Select>
              </label>
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
                          type="button"
                          key={item.id}
                          className={addableItem}
                          data-hometab-add={item.id}
                          disabled={isUsed || !addToGroupId}
                          onClick={() => {
                            if (!isUsed && addToGroupId) {
                              addItem(addToGroupId, item.id);
                            }
                          }}
                          title={isUsed ? "Already in a group" : `Add to ${layout.groups.find((g) => g.id === addToGroupId)?.label ?? "group"}`}
                        >
                          <span className={chipGlyph} aria-hidden>
                            {homeTabIcon(item.id, 16) ?? item.icon}
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
          <Button
            variant="outlined"
            style={FOOTER_BUTTON_STYLE}
            data-hometab-reset=""
            onClick={handleReset}
          >
            Reset to Default
          </Button>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="outlined"
              style={FOOTER_BUTTON_STYLE}
              data-hometab-cancel=""
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="outlined"
              className={primaryButton}
              style={FOOTER_BUTTON_STYLE}
              data-hometab-save=""
              onClick={() => void handleSave()}
            >
              Save
            </Button>
          </div>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}

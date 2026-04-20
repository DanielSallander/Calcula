//! FILENAME: app/extensions/QuickAccess/components/CommandPalette.tsx
// PURPOSE: Searchable command list rendered as customContent inside the "More..." submenu.
// CONTEXT: Lists all menu commands, allows searching and pinning to Quick Access menu.

import React, { useState, useRef, useEffect, useMemo } from "react";
import styled from "styled-components";
import { getMenus } from "@api/ui";
import type { MenuItemDefinition } from "@api/uiTypes";

// ============================================================================
// Types
// ============================================================================

export interface CommandEntry {
  /** Unique ID (from the menu item) */
  id: string;
  /** Display label (may include parent path, e.g. "Data > Sort...") */
  label: string;
  /** Short label (just the item's own label) */
  shortLabel: string;
  /** The menu item's action or commandId — used to execute it */
  action?: () => void;
  commandId?: string;
  /** Keyboard shortcut hint */
  shortcut?: string;
  /** Icon from the menu item */
  icon?: React.ReactNode;
  /** Whether this is a toggle item with checked state */
  checked?: boolean;
  /** Reference to the source menu item (for reading dynamic checked state) */
  sourceItem?: MenuItemDefinition;
}

interface CommandPaletteProps {
  onClose: () => void;
  pinnedIds: Set<string>;
  onTogglePin: (entry: CommandEntry) => void;
  onExecute: (entry: CommandEntry) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Recursively collect all actionable menu items from all menus. */
function collectAllCommands(): CommandEntry[] {
  const entries: CommandEntry[] = [];
  const menus = getMenus();

  function walk(items: MenuItemDefinition[], parentPath: string): void {
    for (const item of items) {
      if (item.separator || item.hidden) continue;

      // If this item has an action or commandId, it's actionable
      if (item.action || item.commandId) {
        entries.push({
          id: item.id,
          label: parentPath ? `${parentPath} > ${item.label}` : item.label,
          shortLabel: item.label,
          action: item.action,
          commandId: item.commandId,
          shortcut: item.shortcut,
          icon: item.icon,
          checked: item.checked,
          sourceItem: item,
        });
      }

      // Recurse into children
      if (item.children) {
        walk(item.children, parentPath ? `${parentPath} > ${item.label}` : item.label);
      }
    }
  }

  for (const menu of menus) {
    // Skip the Quick Access menu itself to avoid circular references
    if (menu.id === "quickAccess") continue;
    walk(menu.items, menu.label);
  }

  return entries;
}

// ============================================================================
// Styled Components
// ============================================================================

const v = (name: string) => `var(${name})`;

const Container = styled.div`
  width: 320px;
  max-height: 400px;
  display: flex;
  flex-direction: column;
  background-color: ${v("--menu-dropdown-bg")};
`;

const SearchBox = styled.input`
  margin: 8px;
  padding: 6px 10px;
  font-size: 13px;
  border: 1px solid ${v("--menu-border")};
  border-radius: 4px;
  background-color: ${v("--menu-dropdown-bg")};
  color: ${v("--menu-text")};
  outline: none;

  &:focus {
    border-color: ${v("--accent-color")};
  }

  &::placeholder {
    color: ${v("--menu-text-disabled")};
  }
`;

const List = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 0 0 4px;
`;

const Row = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 12px;
  background: transparent;
  border: none;
  color: ${v("--menu-text")};
  font-size: 13px;
  cursor: pointer;
  text-align: left;

  &:hover {
    background-color: ${v("--menu-item-hover-bg")};
  }
`;

const RowIcon = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 8px;
  flex-shrink: 0;
  opacity: 0.85;

  & > svg {
    width: 16px;
    height: 16px;
  }
`;

const RowLabel = styled.span`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Shortcut = styled.span`
  color: ${v("--menu-shortcut-text")};
  font-size: 11px;
  margin-left: 12px;
  flex-shrink: 0;
`;

const PinButton = styled.button<{ $pinned: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 4px;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  border-radius: 3px;
  color: ${({ $pinned }) => ($pinned ? v("--accent-color") : v("--menu-shortcut-text"))};
  opacity: ${({ $pinned }) => ($pinned ? 1 : 0.5)};

  &:hover {
    opacity: 1;
    background-color: ${v("--menu-item-hover-bg")};
  }
`;

const CheckIndicator = styled.span<{ $checked: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 4px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid ${({ $checked }) => ($checked ? v("--accent-color") : v("--menu-shortcut-text"))};
  transition: border-color 0.15s, background-color 0.15s;

  &::after {
    content: '';
    display: ${({ $checked }) => ($checked ? "block" : "none")};
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: ${v("--accent-color")};
  }
`;

const EmptyMessage = styled.div`
  padding: 16px;
  text-align: center;
  color: ${v("--menu-text-disabled")};
  font-size: 13px;
`;

// Pin icon SVG (simple thumbtack) - exported for use in Quick Access menu items
export function PinIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.146 14.854a.5.5 0 0 1-.057-.638l.057-.07L7.293 11H3.5a.5.5 0 0 1-.09-.992L3.5 10h5.793l2.354-2.354a.5.5 0 0 1 .057-.638l.057-.07 1.5-1.5a.5.5 0 0 1 .765.638l-.057.07-.646.647L14.5 7.5a.5.5 0 0 1 .09.992L14.5 8.5h-.793l-2.854 2.854a.5.5 0 0 1-.057.638l-.057.07L8.707 14.5a.5.5 0 0 1-.765-.638l.057-.07.647-.646L7.293 12H5.5l-1.354 1.354a.5.5 0 0 1-.638.057l-.07-.057-.292-.5z" />
    </svg>
  );
}

// ============================================================================
// Component
// ============================================================================

export function CommandPalette({
  onClose,
  pinnedIds,
  onTogglePin,
  onExecute,
}: CommandPaletteProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the search box when mounted
  useEffect(() => {
    // Small delay to ensure the submenu is rendered
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const allCommands = useMemo(() => collectAllCommands(), []);

  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands;
    const lower = query.toLowerCase();
    return allCommands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lower) ||
        cmd.shortLabel.toLowerCase().includes(lower),
    );
  }, [allCommands, query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Prevent the menu bar's global keydown handler from stealing keys
    e.stopPropagation();
  };

  return (
    <Container onKeyDown={handleKeyDown}>
      <SearchBox
        ref={inputRef}
        type="text"
        placeholder="Search commands..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <List>
        {filtered.length === 0 ? (
          <EmptyMessage>No commands found</EmptyMessage>
        ) : (
          filtered.map((cmd) => (
            <Row key={cmd.id}>
              {cmd.icon && <RowIcon>{cmd.icon}</RowIcon>}
              <RowLabel
                onClick={() => {
                  onExecute(cmd);
                  onClose();
                }}
                title={cmd.label}
              >
                {cmd.shortLabel}
              </RowLabel>
              {cmd.shortcut && <Shortcut>{cmd.shortcut}</Shortcut>}
              {cmd.sourceItem?.checked !== undefined && (
                <CheckIndicator
                  $checked={!!cmd.sourceItem.checked}
                  title={cmd.sourceItem.checked ? "Enabled" : "Disabled"}
                />
              )}
              <PinButton
                $pinned={pinnedIds.has(cmd.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(cmd);
                }}
                title={pinnedIds.has(cmd.id) ? "Unpin from Quick Access" : "Pin to Quick Access"}
              >
                <PinIcon />
              </PinButton>
            </Row>
          ))
        )}
      </List>
    </Container>
  );
}

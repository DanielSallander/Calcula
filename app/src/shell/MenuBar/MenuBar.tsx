//! FILENAME: app/src/shell/MenuBar/MenuBar.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as UI from '../../api/ui';
import { CommandRegistry } from '../../api/commands';
import { restoreFocusToGrid } from './MenuBar.events';
import * as S from './MenuBar.styles';

// Re-export for external consumers
export type { MenuItem, Menu } from './MenuBar.types';

// ============================================================================
// Recursive helper: find shortcut match at any nesting depth
// ============================================================================

function findShortcutItem(
  items: UI.MenuItemDefinition[],
  keyCombo: string
): UI.MenuItemDefinition | null {
  for (const item of items) {
    if (item.shortcut && normalizeShortcut(item.shortcut) === keyCombo && !item.disabled) {
      return item;
    }
    if (item.children) {
      const found = findShortcutItem(item.children, keyCombo);
      if (found) return found;
    }
  }
  return null;
}

// ============================================================================
// RecursiveMenuItem - self-contained component for any nesting depth
// ============================================================================

interface RecursiveMenuItemProps {
  item: UI.MenuItemDefinition;
  index: number;
  executeMenuItem: (item: UI.MenuItemDefinition) => void;
}

function RecursiveMenuItem({ item, index, executeMenuItem }: RecursiveMenuItemProps): React.ReactElement {
  const [isSubmenuOpen, setIsSubmenuOpen] = useState(false);

  if (item.separator) {
    return <S.Separator key={`sep-${index}`} />;
  }

  const hasChildren = item.children && item.children.length > 0;

  return (
    <S.SubMenuContainer
      onMouseEnter={() => { if (hasChildren) setIsSubmenuOpen(true); }}
      onMouseLeave={() => { if (hasChildren) setIsSubmenuOpen(false); }}
    >
      <S.MenuItemButton
        $disabled={item.disabled}
        onClick={() => {
          if (hasChildren) {
            if (item.action || item.commandId) {
              executeMenuItem(item);
            }
          } else {
            executeMenuItem(item);
          }
        }}
        disabled={item.disabled}
      >
        <S.MenuItemContent>
          {item.checked !== undefined && (
            <S.Checkmark>{item.checked ? '[x]' : '[ ]'}</S.Checkmark>
          )}
          <span>{item.label}</span>
        </S.MenuItemContent>
        <S.RightContent>
          {item.shortcut && (
            <S.Shortcut>{item.shortcut}</S.Shortcut>
          )}
          {hasChildren && (
            <S.SubmenuArrow>&#9656;</S.SubmenuArrow>
          )}
        </S.RightContent>
      </S.MenuItemButton>

      {hasChildren && isSubmenuOpen && (
        <S.SubMenuDropdown>
          {item.children!.filter(child => !child.hidden).map((child, childIndex) => (
            <RecursiveMenuItem
              key={child.id || childIndex}
              item={child}
              index={childIndex}
              executeMenuItem={executeMenuItem}
            />
          ))}
        </S.SubMenuDropdown>
      )}
    </S.SubMenuContainer>
  );
}

// ============================================================================
// MenuBar
// ============================================================================

export function MenuBar(): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [menus, setMenus] = useState<UI.MenuDefinition[]>(() => UI.getMenus());
  const menuBarRef = useRef<HTMLDivElement>(null);

  const closeAll = useCallback(() => {
    setOpenMenu(null);
  }, []);

  const executeMenuItem = useCallback((item: UI.MenuItemDefinition) => {
    if (item.action) {
      item.action();
    }
    else if (item.commandId) {
      console.log('Executing Command:', item.commandId);
      CommandRegistry.execute(item.commandId).catch((err) => {
        console.error(`[MenuBar] Failed to execute command ${item.commandId}:`, err);
      });
    }

    closeAll();
    restoreFocusToGrid();
  }, [closeAll]);

  // 1. Subscribe to the Menu Registry for updates
  useEffect(() => {
    const unsubscribe = UI.subscribeToMenus(() => {
      setMenus(UI.getMenus());
    });
    return unsubscribe;
  }, []);

  // 2. Handle click outside to close menu
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        closeAll();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [closeAll]);

  // 3. Dynamic Keyboard Shortcuts (recursive search through all nesting depths)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputField = target.tagName === 'INPUT' ||
                           target.tagName === 'TEXTAREA' ||
                           target.isContentEditable;

      if (isInputField && !e.ctrlKey && !e.metaKey) return;

      const keyCombo = parseKeyboardEvent(e);
      if (!keyCombo) return;

      for (const menu of menus) {
        const match = findShortcutItem(menu.items, keyCombo);
        if (match) {
          e.preventDefault();
          executeMenuItem(match);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [menus, executeMenuItem]);

  const handleMenuClick = (menuId: string) => {
    if (openMenu === menuId) {
      closeAll();
    } else {
      setOpenMenu(menuId);
    }
  };

  const handleMenuHover = (menuId: string) => {
    if (openMenu) {
      setOpenMenu(menuId);
    }
  };

  return (
    <S.MenuBarContainer ref={menuBarRef}>
      {menus.filter((menu) => !menu.hidden).map((menu) => (
        <S.MenuContainer key={menu.id}>
          <S.MenuButton
            $isOpen={openMenu === menu.id}
            onClick={() => handleMenuClick(menu.id)}
            onMouseEnter={() => handleMenuHover(menu.id)}
          >
            {menu.label}
          </S.MenuButton>

          {openMenu === menu.id && (
            <S.Dropdown>
              {menu.items.filter(item => !item.hidden).map((item, index) => (
                <RecursiveMenuItem
                  key={item.id || index}
                  item={item}
                  index={index}
                  executeMenuItem={executeMenuItem}
                />
              ))}
            </S.Dropdown>
          )}
        </S.MenuContainer>
      ))}
    </S.MenuBarContainer>
  );
}

function normalizeShortcut(shortcut: string): string {
  return shortcut.toLowerCase().replace(/\s/g, '');
}

function parseKeyboardEvent(e: KeyboardEvent): string | null {
  if (!e.ctrlKey && !e.metaKey) return null;

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null;

  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

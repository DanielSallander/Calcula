//! FILENAME: app/src/shell/MenuBar/MenuBar.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as UI from '../../api/ui';
import { CommandRegistry } from '../../api/commands';
import { restoreFocusToGrid } from './MenuBar.events';
import * as S from './MenuBar.styles';

// Re-export for external consumers
export type { MenuItem, Menu } from './MenuBar.types';

export function MenuBar(): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [menus, setMenus] = useState<UI.MenuDefinition[]>(() => UI.getMenus());
  const menuBarRef = useRef<HTMLDivElement>(null);

  const closeAll = useCallback(() => {
    setOpenMenu(null);
    setOpenSubmenu(null);
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

  // 3. Dynamic Keyboard Shortcuts
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
        for (const item of menu.items) {
          if (item.shortcut && normalizeShortcut(item.shortcut) === keyCombo) {
             if (item.disabled) return;

             e.preventDefault();
             executeMenuItem(item);
             return;
          }
          // Also check children for shortcuts
          if (item.children) {
            for (const child of item.children) {
              if (child.shortcut && normalizeShortcut(child.shortcut) === keyCombo) {
                if (child.disabled) return;

                e.preventDefault();
                executeMenuItem(child);
                return;
              }
            }
          }
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
      setOpenSubmenu(null);
    }
  };

  const handleMenuHover = (menuId: string) => {
    if (openMenu) {
      setOpenMenu(menuId);
      setOpenSubmenu(null);
    }
  };

  const renderMenuItem = (item: UI.MenuItemDefinition, index: number) => {
    if (item.separator) {
      return <S.Separator key={`sep-${index}`} />;
    }

    const hasChildren = item.children && item.children.length > 0;

    return (
      <S.SubMenuContainer
        key={item.id || index}
        onMouseEnter={() => hasChildren && setOpenSubmenu(item.id)}
        onMouseLeave={() => hasChildren && setOpenSubmenu(null)}
      >
        <S.MenuItemButton
          $disabled={item.disabled}
          onClick={() => {
            if (hasChildren) {
              // Items with children: clicking the main item still executes its action/command
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

        {hasChildren && openSubmenu === item.id && (
          <S.SubMenuDropdown>
            {item.children!.filter(child => !child.hidden).map((child, childIndex) =>
              child.separator ? (
                <S.Separator key={`sub-sep-${childIndex}`} />
              ) : (
                <S.MenuItemButton
                  key={child.id || childIndex}
                  $disabled={child.disabled}
                  onClick={() => executeMenuItem(child)}
                  disabled={child.disabled}
                >
                  <S.MenuItemContent>
                    {child.checked !== undefined && (
                      <S.Checkmark>{child.checked ? '[x]' : '[ ]'}</S.Checkmark>
                    )}
                    <span>{child.label}</span>
                  </S.MenuItemContent>
                  {child.shortcut && (
                    <S.Shortcut>{child.shortcut}</S.Shortcut>
                  )}
                </S.MenuItemButton>
              )
            )}
          </S.SubMenuDropdown>
        )}
      </S.SubMenuContainer>
    );
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
              {menu.items.filter(item => !item.hidden).map((item, index) =>
                renderMenuItem(item, index)
              )}
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
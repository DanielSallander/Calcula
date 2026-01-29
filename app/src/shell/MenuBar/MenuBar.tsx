//! FILENAME: app/src/shell/MenuBar/MenuBar.tsx
import React, { useState, useEffect, useRef } from 'react';
import * as UI from '../../api/ui'; // Import the facade
import { restoreFocusToGrid } from './MenuBar.events';
import * as S from './MenuBar.styles';

// Re-export for external consumers
export type { MenuItem, Menu } from './MenuBar.types'; // Legacy types, might want to deprecate later

export function MenuBar(): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [menus, setMenus] = useState<UI.MenuDefinition[]>([]);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // 1. Subscribe to the Menu Registry
  useEffect(() => {
    // Initial fetch
    setMenus(UI.getMenus());
    
    // Subscribe to updates (e.g. when an extension loads late)
    const unsubscribe = UI.subscribeToMenus(() => {
      setMenus(UI.getMenus());
    });
    return unsubscribe;
  }, []);

  // 2. Handle click outside to close menu
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 3. Dynamic Keyboard Shortcuts
  // Instead of hardcoding keys, we scan the registered menus for matching shortcuts.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputField = target.tagName === 'INPUT' || 
                           target.tagName === 'TEXTAREA' || 
                           target.isContentEditable;

      // Don't trigger shortcuts while typing in a cell/input, unless it's a specific override
      // (This logic might need refinement based on exact requirements)
      if (isInputField && !e.ctrlKey && !e.metaKey) return;

      const keyCombo = parseKeyboardEvent(e);
      if (!keyCombo) return;

      // Scan all menus for a matching shortcut
      for (const menu of menus) {
        for (const item of menu.items) {
          if (item.shortcut && normalizeShortcut(item.shortcut) === keyCombo) {
             if (item.disabled) return;
             
             e.preventDefault();
             executeMenuItem(item);
             return; // Stop after first match
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [menus]); // Re-bind if menus change

  const handleMenuClick = (menuId: string) => {
    setOpenMenu(openMenu === menuId ? null : menuId);
  };

  const handleMenuHover = (menuId: string) => {
    if (openMenu) {
      setOpenMenu(menuId);
    }
  };

  const executeMenuItem = (item: UI.MenuItemDefinition) => {
    if (item.action) {
      item.action();
    } 
    else if (item.commandId) {

      console.log('Executing Command:', item.commandId);
      
    }

    setOpenMenu(null);
    restoreFocusToGrid();
  };

  return (
    <S.MenuBarContainer ref={menuBarRef}>
      {menus.map((menu) => (
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
                item.separator ? (
                  <S.Separator key={`sep-${index}`} />
                ) : (
                  <S.MenuItemButton
                    key={item.id || index}
                    $disabled={item.disabled}
                    onClick={() => executeMenuItem(item)}
                    disabled={item.disabled}
                  >
                    <S.MenuItemContent>
                      {item.checked !== undefined && (
                        <S.Checkmark>{item.checked ? '[x]' : '[ ]'}</S.Checkmark>
                      )}
                      <span>{item.label}</span>
                    </S.MenuItemContent>
                    {item.shortcut && (
                      <S.Shortcut>{item.shortcut}</S.Shortcut>
                    )}
                  </S.MenuItemButton>
                )
              )}
            </S.Dropdown>
          )}
        </S.MenuContainer>
      ))}
    </S.MenuBarContainer>
  );
}

// Helper to normalize "Ctrl+S" vs "ctrl+s" for comparison
function normalizeShortcut(shortcut: string): string {
  return shortcut.toLowerCase().replace(/\s/g, '');
}

// Helper to turn event into "ctrl+s" string
function parseKeyboardEvent(e: KeyboardEvent): string | null {
  if (!e.ctrlKey && !e.metaKey) return null; // Simplified for now
  
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl'); // Treat cmd/ctrl as same
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  
  // Ignore modifier key presses themselves
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null;
  
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}
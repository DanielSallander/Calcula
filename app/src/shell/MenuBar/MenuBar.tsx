import React, { useState, useEffect, useRef } from 'react';
import { useGridContext } from '../../core/state/GridContext';
import { CreatePivotDialog } from '../../core/components/pivot/CreatePivotDialog';
import type { MenuItem } from './MenuBar.types';
import { restoreFocusToGrid } from './MenuBar.events';
import { useFileMenu, useEditMenu, useViewMenu, useInsertMenu } from './menus';
import * as S from './MenuBar.styles';

// Re-export for external consumers
export { MenuEvents, emitMenuEvent } from './MenuBar.events';
export type { MenuItem, Menu } from './MenuBar.types';

export function MenuBar(): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  const { state, dispatch } = useGridContext();
  const { selection } = state;

  // Initialize all menus
  const { menu: fileMenu, handlers: fileHandlers } = useFileMenu();
  const { menu: editMenu, handlers: editHandlers, canMerge } = useEditMenu({ selection });
  const { menu: viewMenu } = useViewMenu({ dispatch });
  const { menu: insertMenu, handlers: insertHandlers, isPivotDialogOpen } = useInsertMenu();

  const menus = [fileMenu, editMenu, viewMenu, insertMenu];

  // Handle click outside to close menu
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputField = target.tagName === 'INPUT' ||
                          target.tagName === 'TEXTAREA' ||
                          target.isContentEditable;

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 's':
            e.preventDefault();
            if (e.shiftKey) {
              fileHandlers.handleSaveAs();
            } else {
              fileHandlers.handleSave();
            }
            break;
          case 'o':
            e.preventDefault();
            fileHandlers.handleOpen();
            break;
          case 'n':
            e.preventDefault();
            fileHandlers.handleNew();
            break;
          case 'z':
            if (!isInputField) {
              e.preventDefault();
              editHandlers.handleUndo();
            }
            break;
          case 'y':
            if (!isInputField) {
              e.preventDefault();
              editHandlers.handleRedo();
            }
            break;
          case 'f':
            e.preventDefault();
            editHandlers.handleFind();
            break;
          case 'h':
            e.preventDefault();
            editHandlers.handleReplace();
            break;
          case 'm':
            if (!isInputField && canMerge) {
              e.preventDefault();
              editHandlers.handleMergeCells();
            }
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fileHandlers, editHandlers, canMerge]);

  const handleMenuClick = (menuLabel: string) => {
    setOpenMenu(openMenu === menuLabel ? null : menuLabel);
  };

  const handleMenuHover = (menuLabel: string) => {
    if (openMenu) {
      setOpenMenu(menuLabel);
    }
  };

  const handleItemClick = (item: MenuItem) => {
    console.log('[MenuBar] handleItemClick:', item.label, 'disabled:', item.disabled, 'hasAction:', !!item.action);
    if (item.action && !item.disabled) {
      item.action();
      setOpenMenu(null);
      restoreFocusToGrid();
    }
  };

  return (
    <>
      <S.MenuBarContainer ref={menuBarRef}>
        {menus.map((menu) => (
          <S.MenuContainer key={menu.label}>
            <S.MenuButton
              $isOpen={openMenu === menu.label}
              onClick={() => handleMenuClick(menu.label)}
              onMouseEnter={() => handleMenuHover(menu.label)}
            >
              {menu.label}
            </S.MenuButton>
            {openMenu === menu.label && (
              <S.Dropdown>
                {menu.items.map((item, index) =>
                  item.separator ? (
                    <S.Separator key={index} />
                  ) : (
                    <S.MenuItemButton
                      key={item.label}
                      $disabled={item.disabled}
                      onClick={() => handleItemClick(item)}
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

      <CreatePivotDialog
        isOpen={isPivotDialogOpen}
        onClose={insertHandlers.handlePivotDialogClose}
        onCreated={insertHandlers.handlePivotCreated}
        selection={selection}
      />
    </>
  );
}
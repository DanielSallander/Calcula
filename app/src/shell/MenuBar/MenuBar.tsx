// FILENAME: app/src/shell/MenuBar/MenuBar.tsx

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { newFile, openFile, saveFile, saveFileAs, isFileModified } from '../../core/lib/file-api';
import { undo, redo, setFreezePanes, getFreezePanes } from '../../core/lib/tauri-api';
import { useGridContext } from '../../core/state/GridContext';
import { setFreezeConfig } from '../../core/state/gridActions';

interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
  checked?: boolean;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

// Custom events for menu actions that need to be handled by other components
export const MenuEvents = {
  CUT: 'menu:cut',
  COPY: 'menu:copy',
  PASTE: 'menu:paste',
  FIND: 'menu:find',
  REPLACE: 'menu:replace',
  FREEZE_CHANGED: 'menu:freezeChanged',
} as const;

export function emitMenuEvent(eventName: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

// Helper to restore focus to the grid after menu actions
function restoreFocusToGrid(): void {
  setTimeout(() => {
    const focusContainer = document.querySelector('[tabindex="0"][style*="outline: none"]') as HTMLElement;
    if (focusContainer) {
      focusContainer.focus();
    }
  }, 0);
}

export function MenuBar(): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [hoveredMenuButton, setHoveredMenuButton] = useState<string | null>(null);
  const [freezeState, setFreezeState] = useState<{ row: boolean; col: boolean }>({ row: false, col: false });
  const menuBarRef = useRef<HTMLDivElement>(null);
  
  // Get dispatch to update React state
  const { dispatch } = useGridContext();

  // Load freeze state on mount
  useEffect(() => {
    const loadFreezeState = async () => {
      console.log('[MenuBar] Loading freeze state...');
      try {
        const config = await getFreezePanes();
        console.log('[MenuBar] Loaded freeze config:', config);
        const hasRow = config.freezeRow !== null && config.freezeRow > 0;
        const hasCol = config.freezeCol !== null && config.freezeCol > 0;
        setFreezeState({
          row: hasRow,
          col: hasCol,
        });
        // Also update React state on load
        dispatch(setFreezeConfig(
          hasRow ? config.freezeRow : null,
          hasCol ? config.freezeCol : null
        ));
      } catch (error) {
        console.error('[MenuBar] Failed to load freeze state:', error);
      }
    };
    loadFreezeState();
  }, [dispatch]);

  const handleNew = useCallback(async () => {
    try {
      const modified = await isFileModified();
      if (modified) {
        const confirmed = window.confirm('You have unsaved changes. Create new file anyway?');
        if (!confirmed) return;
      }
      await newFile();
      window.location.reload();
    } catch (error) {
      console.error('[MenuBar] handleNew error:', error);
      alert('Failed to create new file: ' + String(error));
    }
  }, []);

  const handleOpen = useCallback(async () => {
    try {
      const modified = await isFileModified();
      if (modified) {
        const confirmed = window.confirm('You have unsaved changes. Open file anyway?');
        if (!confirmed) return;
      }
      const cells = await openFile();
      if (cells) {
        window.location.reload();
      }
    } catch (error) {
      console.error('[MenuBar] handleOpen error:', error);
      alert('Failed to open file: ' + String(error));
    }
  }, []);

  const handleSave = useCallback(async () => {
    try {
      const path = await saveFile();
      if (path) {
        console.log('[MenuBar] Saved to:', path);
      }
    } catch (error) {
      console.error('[MenuBar] handleSave error:', error);
      alert('Failed to save file: ' + String(error));
    }
  }, []);

  const handleSaveAs = useCallback(async () => {
    try {
      const path = await saveFileAs();
      if (path) {
        console.log('[MenuBar] Saved as:', path);
      }
    } catch (error) {
      console.error('[MenuBar] handleSaveAs error:', error);
      alert('Failed to save file: ' + String(error));
    }
  }, []);

  const handleUndo = useCallback(async () => {
    try {
      const result = await undo();
      console.log('[MenuBar] Undo result:', result);
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[MenuBar] handleUndo error:', error);
    }
  }, []);

  const handleRedo = useCallback(async () => {
    try {
      const result = await redo();
      console.log('[MenuBar] Redo result:', result);
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[MenuBar] handleRedo error:', error);
    }
  }, []);

  const handleCut = useCallback(() => {
    emitMenuEvent(MenuEvents.CUT);
    restoreFocusToGrid();
  }, []);

  const handleCopy = useCallback(() => {
    emitMenuEvent(MenuEvents.COPY);
    restoreFocusToGrid();
  }, []);

  const handlePaste = useCallback(() => {
    emitMenuEvent(MenuEvents.PASTE);
    restoreFocusToGrid();
  }, []);

  const handleFind = useCallback(() => {
    emitMenuEvent(MenuEvents.FIND);
  }, []);

  const handleReplace = useCallback(() => {
    emitMenuEvent(MenuEvents.REPLACE);
  }, []);

  // View menu handlers for freeze panes
  const handleFreezeTopRow = useCallback(async () => {
    console.log('[MenuBar] handleFreezeTopRow called, current state:', freezeState);
    try {
      const newRowState = !freezeState.row;
      const freezeRow = newRowState ? 1 : null;
      const freezeCol = freezeState.col ? 1 : null;
      console.log('[MenuBar] Calling setFreezePanes with:', { freezeRow, freezeCol });
      const result = await setFreezePanes(freezeRow, freezeCol);
      console.log('[MenuBar] setFreezePanes result:', result);
      setFreezeState(prev => ({ ...prev, row: newRowState }));
      // Update React state so renderer gets the new config
      dispatch(setFreezeConfig(freezeRow, freezeCol));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[MenuBar] handleFreezeTopRow error:', error);
    }
  }, [freezeState, dispatch]);

  const handleFreezeFirstColumn = useCallback(async () => {
    console.log('[MenuBar] handleFreezeFirstColumn called, current state:', freezeState);
    try {
      const newColState = !freezeState.col;
      const freezeRow = freezeState.row ? 1 : null;
      const freezeCol = newColState ? 1 : null;
      console.log('[MenuBar] Calling setFreezePanes with:', { freezeRow, freezeCol });
      const result = await setFreezePanes(freezeRow, freezeCol);
      console.log('[MenuBar] setFreezePanes result:', result);
      setFreezeState(prev => ({ ...prev, col: newColState }));
      // Update React state so renderer gets the new config
      dispatch(setFreezeConfig(freezeRow, freezeCol));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[MenuBar] handleFreezeFirstColumn error:', error);
    }
  }, [freezeState, dispatch]);

  const handleFreezeBoth = useCallback(async () => {
    console.log('[MenuBar] handleFreezeBoth called, current state:', freezeState);
    try {
      const bothFrozen = freezeState.row && freezeState.col;
      const newState = !bothFrozen;
      const freezeRow = newState ? 1 : null;
      const freezeCol = newState ? 1 : null;
      console.log('[MenuBar] Calling setFreezePanes with:', { freezeRow, freezeCol });
      const result = await setFreezePanes(freezeRow, freezeCol);
      console.log('[MenuBar] setFreezePanes result:', result);
      setFreezeState({ row: newState, col: newState });
      // Update React state so renderer gets the new config
      dispatch(setFreezeConfig(freezeRow, freezeCol));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow, freezeCol });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[MenuBar] handleFreezeBoth error:', error);
    }
  }, [freezeState, dispatch]);

  const handleUnfreeze = useCallback(async () => {
    console.log('[MenuBar] handleUnfreeze called');
    try {
      console.log('[MenuBar] Calling setFreezePanes with:', { freezeRow: null, freezeCol: null });
      const result = await setFreezePanes(null, null);
      console.log('[MenuBar] setFreezePanes result:', result);
      setFreezeState({ row: false, col: false });
      // Update React state so renderer gets the new config
      dispatch(setFreezeConfig(null, null));
      emitMenuEvent(MenuEvents.FREEZE_CHANGED, { freezeRow: null, freezeCol: null });
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[MenuBar] handleUnfreeze error:', error);
    }
  }, [dispatch]);

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', action: handleNew },
        { label: 'Open...', shortcut: 'Ctrl+O', action: handleOpen },
        { separator: true, label: '' },
        { label: 'Save', shortcut: 'Ctrl+S', action: handleSave },
        { label: 'Save As...', shortcut: 'Ctrl+Shift+S', action: handleSaveAs },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: handleUndo },
        { label: 'Redo', shortcut: 'Ctrl+Y', action: handleRedo },
        { separator: true, label: '' },
        { label: 'Cut', shortcut: 'Ctrl+X', action: handleCut },
        { label: 'Copy', shortcut: 'Ctrl+C', action: handleCopy },
        { label: 'Paste', shortcut: 'Ctrl+V', action: handlePaste },
        { separator: true, label: '' },
        { label: 'Find...', shortcut: 'Ctrl+F', action: handleFind },
        { label: 'Replace...', shortcut: 'Ctrl+H', action: handleReplace },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Freeze Top Row', action: handleFreezeTopRow, checked: freezeState.row },
        { label: 'Freeze First Column', action: handleFreezeFirstColumn, checked: freezeState.col },
        { separator: true, label: '' },
        { label: 'Freeze Top Row and First Column', action: handleFreezeBoth, checked: freezeState.row && freezeState.col },
        { separator: true, label: '' },
        { label: 'Unfreeze Panes', action: handleUnfreeze, disabled: !freezeState.row && !freezeState.col },
      ],
    },
  ];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
              handleSaveAs();
            } else {
              handleSave();
            }
            break;
          case 'o':
            e.preventDefault();
            handleOpen();
            break;
          case 'n':
            e.preventDefault();
            handleNew();
            break;
          case 'z':
            if (!isInputField) {
              e.preventDefault();
              handleUndo();
            }
            break;
          case 'y':
            if (!isInputField) {
              e.preventDefault();
              handleRedo();
            }
            break;
          case 'f':
            e.preventDefault();
            handleFind();
            break;
          case 'h':
            e.preventDefault();
            handleReplace();
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNew, handleOpen, handleSave, handleSaveAs, handleUndo, handleRedo, handleFind, handleReplace]);

  const handleMenuClick = (menuLabel: string) => {
    setOpenMenu(openMenu === menuLabel ? null : menuLabel);
  };

  const handleItemClick = (item: MenuItem) => {
    console.log('[MenuBar] handleItemClick:', item.label, 'disabled:', item.disabled, 'hasAction:', !!item.action);
    if (item.action && !item.disabled) {
      item.action();
      setOpenMenu(null);
      restoreFocusToGrid();
    }
  };

  const getMenuButtonStyle = (menuLabel: string): React.CSSProperties => {
    const isOpen = openMenu === menuLabel;
    const isHovered = hoveredMenuButton === menuLabel;
    
    return {
      ...styles.menuButton,
      ...(isOpen ? styles.menuButtonActive : {}),
      ...(!isOpen && isHovered ? styles.menuButtonHover : {}),
    };
  };

  const getMenuItemStyle = (item: MenuItem, menuLabel: string): React.CSSProperties => {
    const itemKey = `${menuLabel}-${item.label}`;
    const isHovered = hoveredItem === itemKey;
    
    return {
      ...styles.menuItem,
      ...(item.disabled ? styles.menuItemDisabled : {}),
      ...(!item.disabled && isHovered ? styles.menuItemHover : {}),
    };
  };

  return (
    <div ref={menuBarRef} style={styles.menuBar}>
      {menus.map((menu) => (
        <div key={menu.label} style={styles.menuContainer}>
          <button
            style={getMenuButtonStyle(menu.label)}
            onClick={() => handleMenuClick(menu.label)}
            onMouseEnter={() => {
              setHoveredMenuButton(menu.label);
              if (openMenu) setOpenMenu(menu.label);
            }}
            onMouseLeave={() => setHoveredMenuButton(null)}
          >
            {menu.label}
          </button>
          {openMenu === menu.label && (
            <div style={styles.dropdown}>
              {menu.items.map((item, index) =>
                item.separator ? (
                  <div key={index} style={styles.separator} />
                ) : (
                  <button
                    key={item.label}
                    style={getMenuItemStyle(item, menu.label)}
                    onClick={() => handleItemClick(item)}
                    onMouseEnter={() => setHoveredItem(`${menu.label}-${item.label}`)}
                    onMouseLeave={() => setHoveredItem(null)}
                    disabled={item.disabled}
                  >
                    <span style={styles.menuItemContent}>
                      {item.checked !== undefined && (
                        <span style={styles.checkmark}>{item.checked ? '[x]' : '[ ]'}</span>
                      )}
                      <span>{item.label}</span>
                    </span>
                    {item.shortcut && (
                      <span style={styles.shortcut}>{item.shortcut}</span>
                    )}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  menuBar: {
    display: 'flex',
    alignItems: 'center',
    height: '28px',
    backgroundColor: '#3c3c3c',
    borderBottom: '1px solid #252526',
    padding: '0 8px',
    userSelect: 'none',
  },
  menuContainer: {
    position: 'relative',
  },
  menuButton: {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#cccccc',
    padding: '4px 8px',
    fontSize: '13px',
    cursor: 'pointer',
    borderRadius: '4px',
  },
  menuButtonHover: {
    backgroundColor: '#454545',
  },
  menuButtonActive: {
    backgroundColor: '#505050',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: '0',
    minWidth: '260px',
    backgroundColor: '#252526',
    border: '1px solid #454545',
    borderRadius: '4px',
    padding: '4px 0',
    zIndex: 1000,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
  },
  menuItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '6px 24px 6px 12px',
    backgroundColor: 'transparent',
    border: 'none',
    color: '#cccccc',
    fontSize: '13px',
    cursor: 'pointer',
    textAlign: 'left',
  },
  menuItemContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  checkmark: {
    fontFamily: 'monospace',
    fontSize: '11px',
    width: '24px',
  },
  menuItemHover: {
    backgroundColor: '#094771',
  },
  menuItemDisabled: {
    color: '#6c6c6c',
    cursor: 'default',
  },
  shortcut: {
    color: '#888888',
    fontSize: '12px',
    marginLeft: '24px',
  },
  separator: {
    height: '1px',
    backgroundColor: '#454545',
    margin: '4px 0',
  },
};
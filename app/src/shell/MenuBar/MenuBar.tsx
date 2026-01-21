import React, { useState, useCallback, useEffect, useRef } from 'react';
import { newFile, openFile, saveFile, saveFileAs, isFileModified } from '../../core/lib/file-api';
import { undo, redo } from '../../core/lib/tauri-api';

interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
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
} as const;

export function emitMenuEvent(eventName: string): void {
  window.dispatchEvent(new CustomEvent(eventName));
}

// Helper to restore focus to the grid after menu actions
function restoreFocusToGrid(): void {
  // Small delay to let menu close first
  setTimeout(() => {
    // Find the spreadsheet focus container and focus it
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
  const menuBarRef = useRef<HTMLDivElement>(null);

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

  // Edit menu handlers
  const handleUndo = useCallback(async () => {
    try {
      const result = await undo();
      console.log('[MenuBar] Undo result:', result);
      // Emit event so grid can refresh
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[MenuBar] handleUndo error:', error);
    }
  }, []);

  const handleRedo = useCallback(async () => {
    try {
      const result = await redo();
      console.log('[MenuBar] Redo result:', result);
      // Emit event so grid can refresh
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
  ];

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input field
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
    if (item.action && !item.disabled) {
      item.action();
      setOpenMenu(null);
      // FIX: Restore focus to the grid after menu action
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
                    <span>{item.label}</span>
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

// FIX: Use backgroundColor consistently instead of mixing with background shorthand
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
    minWidth: '200px',
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
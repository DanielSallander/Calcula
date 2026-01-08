import React, { useState, useCallback, useEffect, useRef } from 'react';
import { newFile, openFile, saveFile, saveFileAs, isFileModified } from '../../core/lib/file-api';

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

export function MenuBar(): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
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
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNew, handleOpen, handleSave, handleSaveAs]);

  const handleMenuClick = (menuLabel: string) => {
    setOpenMenu(openMenu === menuLabel ? null : menuLabel);
  };

  const handleItemClick = (item: MenuItem) => {
    if (item.action && !item.disabled) {
      item.action();
      setOpenMenu(null);
    }
  };

  return (
    <div ref={menuBarRef} style={styles.menuBar}>
      {menus.map((menu) => (
        <div key={menu.label} style={styles.menuContainer}>
          <button
            style={{
              ...styles.menuButton,
              ...(openMenu === menu.label ? styles.menuButtonActive : {}),
            }}
            onClick={() => handleMenuClick(menu.label)}
            onMouseEnter={() => openMenu && setOpenMenu(menu.label)}
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
                    style={{
                      ...styles.menuItem,
                      ...(item.disabled ? styles.menuItemDisabled : {}),
                    }}
                    onClick={() => handleItemClick(item)}
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
    background: 'transparent',
    border: 'none',
    color: '#cccccc',
    padding: '4px 8px',
    fontSize: '13px',
    cursor: 'pointer',
    borderRadius: '4px',
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
    background: 'transparent',
    border: 'none',
    color: '#cccccc',
    fontSize: '13px',
    cursor: 'pointer',
    textAlign: 'left',
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
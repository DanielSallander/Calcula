//! FILENAME: app/src/shell/MenuBar/MenuBar.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as UI from '../../api/ui';
import { CommandRegistry } from '../../api/commands';
import { getActiveSkin, subscribeToAppearance } from '../../api/appearance';
import { restoreFocusToGrid } from './MenuBar.events';
import * as S from './MenuBar.styles';

// ============================================================================
// BrandingLogo - renders the active skin's logo asset (e.g. a corporate brand)
// in the menu-bar corner. Renders nothing when the active skin has no logo.
// ============================================================================

function BrandingLogo(): React.ReactElement | null {
  const [logo, setLogo] = useState<string | undefined>(() => getActiveSkin().assets?.logo);
  useEffect(() => subscribeToAppearance(() => setLogo(getActiveSkin().assets?.logo)), []);
  if (!logo) return null;
  return (
    <img
      src={logo}
      alt=""
      aria-hidden="true"
      style={{ height: 16, maxWidth: 120, marginLeft: "auto", marginRight: 8, alignSelf: "center", objectFit: "contain" }}
    />
  );
}

// Re-export for external consumers
export type { MenuItem, Menu } from './MenuBar.types';

// ============================================================================
// CustomContentRenderer - isolates custom content in its own component scope
// so that hooks inside the custom content don't bleed into RecursiveMenuItem.
// ============================================================================

function CustomContentRenderer({
  render,
  closeMenu,
}: {
  render: (onClose: () => void) => React.ReactNode;
  closeMenu: () => void;
}): React.ReactElement {
  return <>{render(closeMenu)}</>;
}

// ============================================================================
// RecursiveMenuItem - self-contained component for any nesting depth
// ============================================================================

interface RecursiveMenuItemProps {
  item: UI.MenuItemDefinition;
  index: number;
  executeMenuItem: (item: UI.MenuItemDefinition) => void;
  closeMenu: () => void;
}

function RecursiveMenuItem({ item, index, executeMenuItem, closeMenu }: RecursiveMenuItemProps): React.ReactElement {
  const [isSubmenuOpen, setIsSubmenuOpen] = useState(false);

  if (item.separator) {
    return <S.Separator key={`sep-${index}`} />;
  }

  const hasChildren = (item.children && item.children.length > 0) || !!item.customContent;

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
          {item.icon && <S.MenuIcon>{item.icon}</S.MenuIcon>}
          <span>{item.label}</span>
        </S.MenuItemContent>
        <S.RightContent>
          {item.shortcut && (
            <S.Shortcut>{item.shortcut}</S.Shortcut>
          )}
          {item.checked !== undefined && (
            <S.CheckIndicator $checked={item.checked} />
          )}
          {item.rightAction && (
            <S.RightActionButton
              onClick={(e) => {
                e.stopPropagation();
                item.rightAction!.onClick();
              }}
              title={item.rightAction.title}
            >
              {item.rightAction.icon}
            </S.RightActionButton>
          )}
          {hasChildren && (
            <S.SubmenuArrow>&#9656;</S.SubmenuArrow>
          )}
        </S.RightContent>
      </S.MenuItemButton>

      {hasChildren && isSubmenuOpen && (
        <S.SubMenuDropdown>
          {item.customContent
            ? <CustomContentRenderer render={item.customContent} closeMenu={closeMenu} />
            : item.children!.filter(child => !child.hidden).map((child, childIndex) => (
              <RecursiveMenuItem
                key={child.id || childIndex}
                item={child}
                index={childIndex}
                executeMenuItem={executeMenuItem}
                closeMenu={closeMenu}
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

  const closeMenu = useCallback(() => {
    closeAll();
    restoreFocusToGrid();
  }, [closeAll]);

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

  // 2b. Handle Escape to close menu
  useEffect(() => {
    if (!openMenu) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenu();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [openMenu, closeMenu]);

  // Keyboard shortcut DISPATCH is owned solely by the centralized keybinding
  // registry (app/src/api/keybindings.ts). Menu items keep their `shortcut`
  // string for DISPLAY only — see RecursiveMenuItem's <S.Shortcut> render. There
  // is intentionally no keydown listener here anymore.

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
              {UI.sortMenuItems(menu.items).filter(item => !item.hidden).map((item, index) => (
                <RecursiveMenuItem
                  key={item.id || index}
                  item={item}
                  index={index}
                  executeMenuItem={executeMenuItem}
                  closeMenu={closeMenu}
                />
              ))}
            </S.Dropdown>
          )}
        </S.MenuContainer>
      ))}
      <BrandingLogo />
    </S.MenuBarContainer>
  );
}


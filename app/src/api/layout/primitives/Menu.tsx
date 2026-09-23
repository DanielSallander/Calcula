//! FILENAME: app/src/api/layout/primitives/Menu.tsx
// PURPOSE: The command-list family of the Calcula Clusters grammar —
//          MenuButton (a trigger plus its card popover), Menu, MenuItem,
//          MenuSeparator and MenuHeading.
// CONTEXT: The grammar separates two lists that used to be one hand-rolled
//          <div> apiece: a MENU runs commands ("Edit Chart...", a trendline
//          type, "Show equation"), a DROPDOWN picks a value (Dropdown.tsx).
//          Both draw their rows with ONE recipe (listRow.ts) — a 30px row, a
//          16px check column holding an accent tick, an optional icon, the
//          label and a trailing hint or shortcut — so the user sees one list
//          language; MenuCheck, the tick column, is exported here for Dropdown.
//
//          KEYBOARD IS PART OF THE API (the WAI-ARIA menu button pattern):
//          - trigger: click/Enter/Space toggles, ArrowDown opens on the first
//            item, ArrowUp on the last;
//          - menu: ArrowUp/ArrowDown move (wrapping), Home/End jump, a letter
//            jumps to the next item starting with it, Enter/Space run the
//            focused item, Escape closes and returns focus to the trigger,
//            Tab closes and lets focus move on from the trigger.
//          Items are real <button>s, so a mouse click and a keyboard activation
//          run the same onClick; Enter/Space call click() themselves (and
//          preventDefault, which stops Chromium's own activation) because the
//          native activation is invisible to jsdom and the keyboard contract
//          has to be testable.
//
//          NESTING. A menu is often opened from inside another overlay — a
//          Launcher flyout, a card Popover — whose dismissal listens on
//          `document`. The open menu is a separate body portal, so to that
//          outer overlay a click on one of its items is an OUTSIDE press, and
//          its Escape is the outer overlay's Escape too. Both would close the
//          outer overlay, and a press that unmounts the outer overlay unmounts
//          the menu before its click lands. So an open menu stops mousedown
//          and Escape from propagating past its own portal (React's listener
//          for a portal sits on the portal's container, which is below
//          `document`), and the outer overlay never hears them.
//
//          Colours come only from LT (../theme).

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { css } from "@emotion/css";
import { LT } from "../theme";
import { FONT_FAMILY } from "../tokens";
import { RibbonIcon } from "../../ribbonIcons";
import {
  listCheckClass,
  listHintClass,
  listIconClass,
  listLabelClass,
  listRowClass,
  listShortcutClass,
  listTrailingClass,
} from "./listRow";
import { Popover, type PopoverPlacement } from "./Popover";
import {
  focusWhenVisible,
  isTypeaheadKey,
  moveForKey,
  stepIndex,
  typeaheadIndex,
} from "./roving";

// ============================================================================
// The check column (shared with Dropdown)
// ============================================================================

/** The check column of a row; renders the tick only when `checked`. */
export function MenuCheck({ checked }: { checked: boolean }): React.ReactElement {
  return (
    <span className={listCheckClass} aria-hidden>
      {checked && <RibbonIcon.Check size={16} />}
    </span>
  );
}

// ============================================================================
// MenuButton context
// ============================================================================

interface MenuContextValue {
  /** Close the owning MenuButton's popover and return focus to its trigger. */
  close: () => void;
  /** Whether running an item closes the menu. */
  closeOnSelect: boolean;
  /** Which item takes focus when the popup menu mounts. */
  initialFocus: "first" | "last";
}

const MenuContext = createContext<MenuContextValue | null>(null);

// ============================================================================
// Menu
// ============================================================================

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

const menuList = css`
  display: flex;
  flex-direction: column;
  outline: none;
`;

function menuItemsOf(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : [];
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

function labelOf(el: HTMLElement): string {
  return el.querySelector("[data-menu-label]")?.textContent ?? el.textContent ?? "";
}

export interface MenuProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "role" | "aria-label" | "children"> {
  children: React.ReactNode;
  /** Accessible name of the menu. */
  ariaLabel?: string;
}

/**
 * `<div role="menu">` with the menu keyboard model. Inside a MenuButton it is
 * a popup: focus lands on the first (or last) item when it opens, items are
 * reached with the arrows only, and Escape/Tab close it. Standalone (a
 * command list inside a Launcher flyout) it is a plain list whose items are
 * ordinary tab stops, and the arrows move between them as a convenience.
 */
export function Menu({
  children,
  ariaLabel,
  className,
  onKeyDown,
  onMouseDown,
  ...rest
}: MenuProps): React.ReactElement {
  const ctx = useContext(MenuContext);
  const listRef = useRef<HTMLDivElement>(null);
  const initialFocus = ctx?.initialFocus ?? null;

  // A popup menu takes focus when it opens (see focusWhenVisible for why this
  // cannot be a plain focus()).
  useEffect(() => {
    if (!initialFocus) return;
    const enabled = menuItemsOf(listRef.current).filter((el) => !isDisabled(el));
    focusWhenVisible(initialFocus === "last" ? enabled[enabled.length - 1] : enabled[0]);
  }, [initialFocus]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;

    const target = e.target as HTMLElement;
    const items = menuItemsOf(listRef.current);
    const current = items.indexOf(target);

    if (e.key === "Escape") {
      if (!ctx) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.close();
      return;
    }

    if (e.key === "Tab") {
      // Close and put focus back on the trigger WITHOUT preventDefault: the
      // browser's Tab then moves on from the trigger, as if the menu had never
      // been open.
      if (ctx) ctx.close();
      return;
    }

    // Everything below acts on an item; a custom focusable inside a menu row
    // (rare) keeps its own keys.
    if (current < 0) return;
    const disabled = items.map(isDisabled);

    const move = moveForKey(e.key, "vertical");
    if (move) {
      e.preventDefault();
      const next = stepIndex(move, current, disabled, true);
      if (next >= 0) items[next].focus();
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!disabled[current]) items[current].click();
      return;
    }

    if (isTypeaheadKey(e)) {
      const next = typeaheadIndex(e.key, current, items.map(labelOf), disabled);
      if (next >= 0) {
        e.preventDefault();
        items[next].focus();
      }
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    onMouseDown?.(e);
    // An open popup menu keeps its presses to itself (see NESTING above).
    if (ctx) e.stopPropagation();
  };

  return (
    <div
      {...rest}
      ref={listRef}
      role="menu"
      aria-label={ariaLabel}
      className={[menuList, className].filter(Boolean).join(" ")}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
    >
      {children}
    </div>
  );
}

// ============================================================================
// MenuItem
// ============================================================================

export type MenuItemRole = "menuitem" | "menuitemradio" | "menuitemcheckbox";

export interface MenuItemProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "role" | "onSelect" | "children" | "disabled"
  > {
  /** The label. */
  children: React.ReactNode;
  /** Runs the command. Called AFTER the menu closes, so a command that opens
   *  a dialog keeps the focus the dialog gives it. */
  onSelect: () => void;
  /** Shows the accent tick; also aria-checked for radio/checkbox items. */
  checked?: boolean;
  /** Default "menuitem". Radio/checkbox items announce their checked state. */
  role?: MenuItemRole;
  /** Leading icon (16 or 20px, sized by the caller). */
  icon?: React.ReactNode;
  /** Trailing secondary text ("task pane"). */
  hint?: React.ReactNode;
  /** Trailing keyboard shortcut ("Ctrl+B"), in the mono face. */
  shortcut?: string;
  disabled?: boolean;
  /** Rendered as data-testid. */
  testId?: string;
}

/** One command row. */
export function MenuItem({
  children,
  onSelect,
  checked = false,
  role = "menuitem",
  icon,
  hint,
  shortcut,
  disabled = false,
  testId,
  className,
  onClick,
  onMouseMove,
  ...rest
}: MenuItemProps): React.ReactElement {
  const ctx = useContext(MenuContext);
  const checkable = role === "menuitemradio" || role === "menuitemcheckbox";
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== "";

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || disabled) return;
    if (ctx?.closeOnSelect) ctx.close();
    onSelect();
  };

  // Inside a popup the pointer moves focus, so the hovered row and the
  // keyboard's current row are the same row. Standalone it does not: a
  // command list in a flyout must not pull focus out of a field beside it.
  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    onMouseMove?.(e);
    if (!ctx || disabled) return;
    const el = e.currentTarget;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  };

  return (
    <button
      {...rest}
      type="button"
      role={role}
      aria-checked={checkable ? checked : undefined}
      disabled={disabled}
      tabIndex={ctx ? -1 : rest.tabIndex}
      data-testid={testId}
      className={[listRowClass, className].filter(Boolean).join(" ")}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
    >
      <MenuCheck checked={checked} />
      {icon !== undefined && icon !== null && (
        <span className={listIconClass} aria-hidden>
          {icon}
        </span>
      )}
      <span className={listLabelClass} data-menu-label="">
        {children}
      </span>
      {(hasHint || shortcut) && (
        <span className={listTrailingClass}>
          {hasHint && <span className={listHintClass}>{hint}</span>}
          {shortcut && <kbd className={listShortcutClass}>{shortcut}</kbd>}
        </span>
      )}
    </button>
  );
}

// ============================================================================
// MenuSeparator / MenuHeading
// ============================================================================

const separatorClass = css`
  flex: none;
  height: 1px;
  margin: 5px 6px;
  background: ${LT.controlDivider};
`;

/** A hairline between groups of items. */
export function MenuSeparator(): React.ReactElement {
  return <div role="separator" className={separatorClass} />;
}

const headingClass = css`
  padding: 6px 8px 4px;
  font-family: ${FONT_FAMILY};
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: ${LT.textSecondary};
  user-select: none;
`;

/** A small caption over a group of items ("SERIES", "CATEGORIES"). */
export function MenuHeading({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div role="presentation" className={headingClass}>
      {children}
    </div>
  );
}

// ============================================================================
// MenuButton
// ============================================================================

/** The props the trigger clone chains or sets. */
type TriggerProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  "id" | "onClick" | "onKeyDown" | "aria-haspopup" | "aria-expanded" | "aria-controls"
>;

export interface MenuButtonProps {
  /** The control that opens the menu (a Button, IconButton, CommandButton...).
   *  It is cloned, not wrapped: it keeps its own DOM and gains onClick,
   *  onKeyDown, aria-haspopup="menu" and aria-expanded. */
  trigger: React.ReactElement;
  /** MenuItems, MenuSeparators and MenuHeadings. */
  children: React.ReactNode;
  /** Default "bottom-start". */
  placement?: PopoverPlacement;
  /** Close after an item runs. Default true; pass false for a menu of
   *  checkboxes the user toggles several of in a row. */
  closeOnSelect?: boolean;
  /** Popover width in px (content sizes it otherwise). */
  width?: number;
  /** Accessible name of the menu; defaults to the trigger (aria-labelledby). */
  ariaLabel?: string;
}

/**
 * A trigger that opens a card Popover holding a Menu. Commands use a menu;
 * values use Dropdown.
 */
export function MenuButton({
  trigger,
  children,
  placement = "bottom-start",
  closeOnSelect = true,
  width,
  ariaLabel,
}: MenuButtonProps): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const triggerProps = trigger.props as TriggerProps;
  const triggerId = triggerProps.id ?? `${baseId}-trigger`;

  const dismiss = useCallback(() => setOpen(false), []);
  const close = useCallback(() => {
    setOpen(false);
    anchor?.focus();
  }, [anchor]);

  const ctx = useMemo<MenuContextValue>(
    () => ({ close, closeOnSelect, initialFocus }),
    [close, closeOnSelect, initialFocus],
  );

  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    triggerProps.onClick?.(e);
    if (e.defaultPrevented) return;
    setAnchor(e.currentTarget);
    setInitialFocus("first");
    setOpen((was) => !was);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    triggerProps.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const where = e.key === "ArrowUp" ? "last" : "first";
    if (open) {
      // Already open (opened by a click that left focus here): step in.
      const enabled = menuItemsOf(document.getElementById(menuId)).filter((el) => !isDisabled(el));
      enabled[where === "last" ? enabled.length - 1 : 0]?.focus();
      return;
    }
    setAnchor(e.currentTarget);
    setInitialFocus(where);
    setOpen(true);
  };

  const clonedTrigger = React.cloneElement(trigger, {
    id: triggerId,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-haspopup": "menu",
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-expanded": open,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-controls": open ? menuId : undefined,
  } as TriggerProps);

  return (
    <>
      {clonedTrigger}
      <Popover
        anchorEl={anchor}
        open={open && anchor !== null}
        onClose={dismiss}
        card
        placement={placement}
        width={width}
        role="presentation"
      >
        <MenuContext.Provider value={ctx}>
          <Menu
            id={menuId}
            ariaLabel={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : triggerId}
          >
            {children}
          </Menu>
        </MenuContext.Provider>
      </Popover>
    </>
  );
}

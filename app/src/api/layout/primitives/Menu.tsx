//! FILENAME: app/src/api/layout/primitives/Menu.tsx
// PURPOSE: The command-list family of the Calcula Clusters grammar —
//          MenuButton (a trigger plus its card popover), Menu, MenuItem,
//          MenuSub (a row with a flyout), MenuSeparator, MenuHeading and
//          SplitMenuButton (Excel's split button with its menu, in three faces).
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
//          `document`), and the outer overlay never hears them. Every Popover
//          (a gallery card, a palette) and the Launcher follow the same rule
//          for Escape -- see ESCAPE NESTS in Popover.tsx: the INNERMOST open
//          overlay takes the key, and the next Escape the one below.
//
//          SUBMENUS (MenuSub, 2026-10-04). A row can open a nested card flyout
//          to its right (Excel's "Hide & Unhide >", Conditional Formatting's
//          "Highlight Cells Rules >" and its gallery flyouts). Three rules
//          follow from the NESTING paragraph above:
//          - The PARENT MENU owns which of its flyouts is open (one per level).
//            The parent stops presses at its own portal, so a flyout's own
//            outside-press listener never hears a press on a sibling row: if
//            the flyout owned its open state it would stay open beside the
//            next one. The parent closes it instead -- on keyboard focus moving
//            to another row, and on the pointer resting on another row.
//          - React events from a portal bubble through the COMPONENT tree, so
//            every key, move and focus inside a flyout also reaches each
//            ancestor Menu's handlers. Each Menu therefore acts only on events
//            whose target is DOM-inside its own list (a key the flyout handled
//            arrives defaultPrevented; a move inside the flyout tells the
//            parent "the pointer reached the flyout -- keep it").
//          - Choosing an item closes the WHOLE chain (MenuContext.close is the
//            top menu's close at every level), and focus returns to the control
//            that opened the top menu before the item runs. Escape and
//            ArrowLeft close ONE level (MenuContext.back) and refocus its row.
//            Escape always takes the INNERMOST open level: with a flyout the
//            pointer opened, keyboard focus is still on a row of the level
//            below it, and that level closes its open flyout before it would
//            close itself.
//            A flyout of custom content (a palette, a gallery) closes the
//            chain the same way through useMenuClose(); ColorPalette
//            (./Color.tsx) is the worked example, and it places its own
//            keyboard focus through useFlyoutFocus (see "Custom content that
//            places its own focus" below).
//
//          Colours come only from LT (../theme).

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { css } from "@emotion/css";
import { LT } from "../theme";
import { SurfaceLayoutProvider, popoverLayout } from "../context";
import { FONT_FAMILY, SUBMENU_ALIGN_OFFSET, SUBMENU_HOVER_DELAY_MS } from "../tokens";
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
import { Popover, firstFocusable, laterFlyoutIsOpen, type PopoverPlacement } from "./Popover";
import {
  DropdownChevron,
  IconButton,
  SplitButton,
  type IconButtonProps,
  type SplitFace,
} from "./Button";
import { resolveShortcutLabel } from "./Tooltip";
import { softDisabled } from "./disabled";
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
  /** Close the owning MenuButton's popover and return focus to its trigger.
   *  Inside a submenu this is STILL the top menu's close: choosing an item
   *  closes the whole chain. */
  close: () => void;
  /** Whether running an item closes the menu. */
  closeOnSelect: boolean;
  /** Which item takes focus when the popup menu mounts; null = none (a
   *  submenu the pointer opened leaves focus on the row it hovered). */
  initialFocus: "first" | "last" | null;
  /** A submenu level only: close THIS level and refocus the row that opened
   *  it (Escape, ArrowLeft). Absent on the top menu, where Escape closes. */
  back?: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

/** The closer of the enclosing menu chain, or a no-op outside any menu. */
const NO_CLOSE = (): void => undefined;

/**
 * The function that closes the WHOLE enclosing menu chain and returns focus
 * to the control that opened it -- for custom content inside a MenuSub flyout
 * (a palette, a gallery) that finishes on its own pick, the way a MenuItem
 * finishes on its click. Outside any menu it is a harmless no-op.
 */
export function useMenuClose(): () => void {
  return useContext(MenuContext)?.close ?? NO_CLOSE;
}

/**
 * Kit-internal (not in the barrel): content hosted in a card that is NOT a
 * MenuButton's -- RegisteredMenuButton's customContent body (MenuTree.tsx) --
 * gets `close` as its menu chain, so useMenuClose() and any MenuItem inside it
 * close that card the way they close a menu.
 */
export function MenuCloseScope({
  close,
  children,
}: {
  close: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const value = useMemo<MenuContextValue>(() => ({ close, closeOnSelect: true, initialFocus: null }), [close]);
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

// ============================================================================
// Submenu host (each Menu owns which of its MenuSubs is open)
// ============================================================================

/** The open flyout of one menu level, and whether it opened with focus. */
interface OpenSubmenu {
  id: string;
  focus: "first" | "last" | null;
}

interface SubmenuHostValue {
  /** The MenuSub whose flyout is open at this level, or null. */
  openId: string | null;
  /** How that flyout opened: from the keyboard it takes focus, from the
   *  pointer it does not. */
  focusOnOpen: "first" | "last" | null;
  /** Open `id`'s flyout now (closing any other at this level). */
  open: (id: string, focus: "first" | "last" | null) => void;
  /** Close this level's open flyout now. */
  close: () => void;
}

const SubmenuHostContext = createContext<SubmenuHostValue | null>(null);

/** The attribute a MenuSub row carries its id in, for the host's hover logic. */
const SUBMENU_ATTR = "data-menu-sub";

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
 *
 * Either way it HOSTS its MenuSubs: it holds which one's flyout is open, opens
 * one after the pointer has rested on its row for SUBMENU_HOVER_DELAY_MS,
 * closes it after the pointer has rested as long on a different row (a pointer
 * that reaches the flyout first keeps it -- the diagonal path across a
 * sibling row), and closes it at once when the keyboard moves focus to another
 * row. Inside a flyout, Escape and ArrowLeft close that level only.
 */
export function Menu({
  children,
  ariaLabel,
  className,
  onKeyDown,
  onMouseDown,
  onMouseMove,
  onMouseMoveCapture,
  onMouseLeave,
  onFocus,
  ...rest
}: MenuProps): React.ReactElement {
  const ctx = useContext(MenuContext);
  const listRef = useRef<HTMLDivElement>(null);
  const initialFocus = ctx?.initialFocus ?? null;

  // ---- The submenu host --------------------------------------------------
  const [sub, setSub] = useState<OpenSubmenu | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row the pointer last rested on: a MenuSub's id, "" for any other
  // enabled row, null for no row (a heading, a separator, the padding), and
  // undefined before the pointer has moved at all. A timer starts only when
  // this CHANGES, so a pointer jittering inside one row never restarts it.
  const hoverRow = useRef<string | null | undefined>(undefined);
  // True for the length of one mousemove dispatch (set in the capture phase,
  // cleared in the bubble phase): the focus a hovered row takes from the
  // pointer is the HOVER's business, with its delay, not a keyboard move.
  const pointerMoving = useRef(false);

  const cancelHover = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  useEffect(() => cancelHover, [cancelHover]);

  const host = useMemo<SubmenuHostValue>(
    () => ({
      openId: sub?.id ?? null,
      focusOnOpen: sub?.focus ?? null,
      open: (id, focus) => {
        cancelHover();
        setSub({ id, focus });
      },
      close: () => {
        cancelHover();
        setSub(null);
      },
    }),
    [sub, cancelHover],
  );

  // A popup menu takes focus when it opens (see focusWhenVisible for why this
  // cannot be a plain focus()).
  useEffect(() => {
    if (!initialFocus) return;
    const enabled = menuItemsOf(listRef.current).filter((el) => !isDisabled(el));
    focusWhenVisible(initialFocus === "last" ? enabled[enabled.length - 1] : enabled[0]);
  }, [initialFocus]);

  const handleMouseMoveCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    onMouseMoveCapture?.(e);
    pointerMoving.current = true;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    onMouseMove?.(e);
    pointerMoving.current = false;
    const list = listRef.current;
    const target = e.target as Node;
    if (!list) return;
    if (!list.contains(target)) {
      // A move inside one of this level's flyouts (a portal below a row): the
      // pointer reached the open flyout, which keeps it whatever it crossed.
      cancelHover();
      hoverRow.current = sub?.id;
      return;
    }
    const row = target instanceof Element ? target.closest<HTMLElement>(ITEM_SELECTOR) : null;
    const rowKey = row && list.contains(row) && !isDisabled(row) ? (row.getAttribute(SUBMENU_ATTR) ?? "") : null;
    if (rowKey === hoverRow.current) return;
    hoverRow.current = rowKey;
    cancelHover();
    if (rowKey === null) return;
    if (sub && rowKey === sub.id) return; // back on the open flyout's own row
    if (rowKey === "" && !sub) return; // an ordinary row, nothing to close
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setSub(rowKey === "" ? null : { id: rowKey, focus: null });
    }, SUBMENU_HOVER_DELAY_MS);
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    onMouseLeave?.(e);
    // Leaving the list (into the card's padding on the way to a flyout, or out
    // of the menu) cancels a pending change but keeps an open flyout. React
    // counts a flyout as INSIDE the list, so a move straight from a row into
    // its flyout fires no leave at all.
    cancelHover();
    hoverRow.current = undefined;
  };

  const handleFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    onFocus?.(e);
    if (pointerMoving.current) return;
    const list = listRef.current;
    const target = e.target as Node;
    if (!list || !list.contains(target)) return; // focus inside a flyout
    cancelHover();
    if (!sub) return;
    const row = target instanceof Element ? target.closest(ITEM_SELECTOR) : null;
    if (row && row.getAttribute(SUBMENU_ATTR) === sub.id) return;
    // The keyboard moved to another row: the open flyout goes at once.
    setSub(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;

    const target = e.target as HTMLElement;
    // A key from inside a flyout below one of the rows reaches this handler
    // through the component tree; it belongs to that level (a gallery's own
    // ArrowLeft must not close the menu around it).
    if (!listRef.current || !listRef.current.contains(target)) return;
    const items = menuItemsOf(listRef.current);
    const current = items.indexOf(target);

    if (e.key === "Escape") {
      if (sub) {
        // Escape closes the INNERMOST open popup (Windows, Office). A flyout
        // the pointer opened leaves keyboard focus on a row of THIS level, so
        // the key arrives here rather than in the flyout; it closes that
        // flyout and nothing else. Focus stays where it is -- on the row the
        // pointer rested on -- and the next Escape takes this level.
        e.preventDefault();
        e.stopPropagation();
        cancelHover();
        setSub(null);
        return;
      }
      if (!ctx) return;
      e.preventDefault();
      e.stopPropagation();
      if (ctx.back) ctx.back();
      else ctx.close();
      return;
    }

    if (e.key === "ArrowLeft" && ctx?.back) {
      // Only a submenu level answers ArrowLeft: it closes itself, as Escape
      // does. On the top menu the key is left alone.
      e.preventDefault();
      e.stopPropagation();
      ctx.back();
      return;
    }

    if (e.key === "Tab") {
      // Close and put focus back on the trigger WITHOUT preventDefault: the
      // browser's Tab then moves on from the trigger, as if the menu had never
      // been open. From a submenu `close` is the whole chain's, and the parent
      // levels need not hear the key again.
      if (ctx) ctx.close();
      if (ctx?.back) e.stopPropagation();
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
      onMouseMoveCapture={handleMouseMoveCapture}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
    >
      <SubmenuHostContext.Provider value={host}>{children}</SubmenuHostContext.Provider>
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
  /** Show the LIVE binding of this command as the shortcut instead of a
   *  literal (a rebound key is never contradicted by a stale menu); the
   *  literal 'shortcut' wins when both are given. */
  shortcutCommandId?: string;
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
  shortcut: shortcutLiteral,
  shortcutCommandId,
  disabled = false,
  testId,
  className,
  onClick,
  onMouseMove,
  ...rest
}: MenuItemProps): React.ReactElement {
  const ctx = useContext(MenuContext);
  const shortcut = resolveShortcutLabel(shortcutLiteral, shortcutCommandId) ?? undefined;
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
// MENU_ICON_BLANK
// ============================================================================

/**
 * Pass as a MenuItem's or MenuSub's `icon` to RESERVE the icon column without
 * drawing anything. Excel's menus mix rows with and without pictures ("Row
 * Height..." has one, "AutoFit Row Height" has none) and still line every
 * label up, because every row keeps the picture column. A row with no `icon`
 * at all has no column, so its label would start 29px further left.
 */
export const MENU_ICON_BLANK: React.ReactElement = <span data-menu-icon-blank="" />;

// ============================================================================
// MenuSub
// ============================================================================

/** The flyout's horizontal offset from its row: the card overlaps the parent
 *  card's padding by a few pixels, so the two read as stacked (Windows 11). */
const SUBMENU_OFFSET = 4;

/** The row keeps the hover wash while its flyout is open and focus is in it,
 *  so the user can see which row the flyout belongs to. Same specificity as
 *  the row's own background, later in the stylesheet. */
const subRowClass = css`
  &[aria-expanded="true"] {
    background: ${LT.hover};
  }
`;

/** The grammar's chevron, turned to point at the flyout. */
const subChevronClass = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: ${LT.textSecondary};
  transform: rotate(-90deg);
`;

function isMenuPart(type: unknown): boolean {
  return type === MenuItem || type === MenuSub || type === MenuSeparator || type === MenuHeading;
}

/**
 * Whether a flyout's children are a MENU (MenuItems, MenuSubs, separators and
 * headings, through fragments and arrays) -- rendered as role="menu" with the
 * menu keyboard model -- or custom content (a palette, a gallery), rendered as
 * a labelled role="group" that keeps its own keys. A role="menu" may only own
 * menu items, so mixing the two is custom content.
 */
function isMenuContent(children: React.ReactNode): boolean {
  let parts = 0;
  let other = 0;
  const visit = (nodes: React.ReactNode): void => {
    React.Children.forEach(nodes, (child) => {
      if (child === null || child === undefined || typeof child === "boolean") return;
      if (!React.isValidElement(child)) {
        other += 1;
        return;
      }
      if (child.type === React.Fragment) {
        visit((child.props as { children?: React.ReactNode }).children);
        return;
      }
      if (isMenuPart(child.type)) parts += 1;
      else other += 1;
    });
  };
  visit(children);
  return parts > 0 && other === 0;
}

/** Move focus into an open flyout: its first enabled item, or (custom
 *  content) its first focusable. */
function focusIntoFlyout(flyoutId: string): void {
  const flyout = document.getElementById(flyoutId);
  if (!flyout) return;
  const target =
    flyout.getAttribute("role") === "menu"
      ? menuItemsOf(flyout).find((el) => !isDisabled(el))
      : firstFocusable(flyout);
  target?.focus();
}

// ---- Custom content that places its own focus ------------------------------
//
// "The first focusable" is the right first stop for most custom content, and
// the wrong one for a palette: ColorPalette opens with focus on the SELECTED
// swatch (its own rule, the one ColorPopover follows), and its theme grid
// arrives asynchronously -- focusing the first button at mount would land on a
// standard swatch that the theme grid then pushes down. So custom content may
// REGISTER how it takes focus (useFlyoutFocus). Registered content then owns
// both of its focus moments: the initial one on a keyboard open (it is told
// how the flyout opened and focuses when it is ready), and the step-in when
// ArrowRight / Enter / an assistive click lands on a row whose flyout the
// pointer already opened (MenuSub calls the registered function).

interface FlyoutFocusValue {
  /** How the flyout opened: "first"/"last" from the keyboard, null from the pointer. */
  initialFocus: "first" | "last" | null;
  /** Register the content's own way to take focus; null unregisters. */
  register: (focus: (() => void) | null) => void;
}

const FlyoutFocusContext = createContext<FlyoutFocusValue | null>(null);

/**
 * Kit-internal (not in the barrel): custom MenuSub content that places its own
 * focus registers `focus` -- called when the keyboard steps into an already
 * open flyout -- and gets back how the flyout opened, so it can take the
 * initial focus itself ("first"/"last": the keyboard; null: the pointer, or no
 * flyout at all). Registered in a LAYOUT effect, which runs before the flyout's
 * own (passive) initial-focus effect, so the flyout knows to leave it alone.
 */
export function useFlyoutFocus(focus: () => void): "first" | "last" | null {
  const ctx = useContext(FlyoutFocusContext);
  const latest = useRef(focus);
  useLayoutEffect(() => {
    latest.current = focus;
  });
  useLayoutEffect(() => {
    if (!ctx) return;
    ctx.register(() => latest.current());
    return () => ctx.register(null);
  }, [ctx]);
  return ctx?.initialFocus ?? null;
}

/** Custom flyout content: a labelled group that keeps its own keys except
 *  Escape (one level back), focuses its first focusable when the flyout was
 *  opened from the keyboard (unless the content registered its own focus,
 *  useFlyoutFocus), and keeps its presses away from the overlays around it,
 *  as an open Menu does. */
function SubmenuContent({
  id,
  labelledBy,
  initialFocus,
  back,
  contentFocusRef,
  children,
}: {
  id: string;
  labelledBy: string;
  initialFocus: "first" | "last" | null;
  back: () => void;
  /** Where registered content's focus function is kept (owned by MenuSub,
   *  which calls it to step in). */
  contentFocusRef: React.MutableRefObject<(() => void) | null>;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const focusValue = useMemo<FlyoutFocusValue>(
    () => ({
      initialFocus,
      register: (focus) => {
        contentFocusRef.current = focus;
      },
    }),
    [initialFocus, contentFocusRef],
  );
  useEffect(() => {
    if (!initialFocus || !ref.current) return;
    if (contentFocusRef.current) return; // the content places its own focus
    focusWhenVisible(firstFocusable(ref.current));
  }, [initialFocus, contentFocusRef]);

  return (
    // No host: a MenuSub inside custom content must not open and close its
    // siblings' flyouts through the PARENT level's host.
    <SubmenuHostContext.Provider value={null}>
      <FlyoutFocusContext.Provider value={focusValue}>
        <div
          ref={ref}
          id={id}
          role="group"
          aria-labelledby={labelledBy}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || e.defaultPrevented) return;
            // An overlay this content opened is still open (a palette its
            // trigger opened by the pointer, focus left on the trigger): that
            // one is the innermost and closes on this Escape through the
            // document rule (Popover's ESCAPE NESTS); this level on the next.
            if (laterFlyoutIsOpen(ref.current?.closest<HTMLElement>("[data-section-flyout]") ?? null)) return;
            e.preventDefault();
            e.stopPropagation();
            back();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </FlyoutFocusContext.Provider>
    </SubmenuHostContext.Provider>
  );
}

export interface MenuSubProps {
  /** The row's label. */
  label: React.ReactNode;
  /** Leading icon (16 or 20px, sized by the caller); MENU_ICON_BLANK reserves
   *  the column without drawing. */
  icon?: React.ReactNode;
  /** Rendered as the ROW's data-testid. */
  testId?: string;
  /** Natively disabled, like a MenuItem: skipped by the arrows, opens by no route. */
  disabled?: boolean;
  /** Flyout width in px (content sizes it otherwise). */
  width?: number;
  /** MenuItems / MenuSubs / MenuSeparators / MenuHeadings -- a menu -- or any
   *  other content (a palette, a gallery), which may close the whole chain
   *  with useMenuClose(). */
  children: React.ReactNode;
}

/**
 * A menu row that opens a nested card flyout at "right-start" (it flips left
 * when there is no room): Excel's "Hide & Unhide >". The flyout is lifted by
 * the card's border + padding (SUBMENU_ALIGN_OFFSET), so its first row is
 * level with this row, as Excel's are. The row says `aria-haspopup="menu"`
 * when its children are a menu and `"dialog"` when they are custom content.
 *
 * OPENS on click, Enter, Space, ArrowRight, or the pointer resting on the row
 * for SUBMENU_HOVER_DELAY_MS. The keyboard (and an assistive click, detail 0)
 * moves focus to the flyout's first row; the pointer does not -- the hovered
 * row keeps it, and the flyout's rows take it as the pointer reaches them.
 * ArrowRight on a row whose flyout is already open steps into it.
 *
 * CLOSES: Escape / ArrowLeft inside it (this level only, focus back on the
 * row); Escape on the row itself while the pointer holds it open (the
 * innermost popup goes first, as in Windows); the keyboard moving to another
 * row, or the pointer resting on one;
 * choosing an item anywhere in it (the whole chain, see MenuContext.close);
 * a press outside every level.
 *
 * Its flyout content is laid out as a popover surface (`popoverLayout`), never
 * as the ribbon band the top menu may have been opened from, so a gallery in
 * it draws its grid and not its 61px strip.
 */
export function MenuSub({
  label,
  icon,
  testId,
  disabled = false,
  width,
  children,
}: MenuSubProps): React.ReactElement {
  const ctx = useContext(MenuContext);
  const host = useContext(SubmenuHostContext);
  const id = useId();
  const rowId = `${id}-row`;
  const flyoutId = `${id}-flyout`;
  const [row, setRow] = useState<HTMLButtonElement | null>(null);
  // Only used without a host (a MenuSub placed outside any Menu).
  const [ownOpen, setOwnOpen] = useState<OpenSubmenu | null>(null);
  // Custom content's own way to take focus, when it registered one
  // (useFlyoutFocus: a palette lands on its SELECTED swatch).
  const contentFocusRef = useRef<(() => void) | null>(null);

  const open = !disabled && (host ? host.openId === id : ownOpen !== null);
  const focusOnOpen = host ? host.focusOnOpen : (ownOpen?.focus ?? null);

  const show = useCallback(
    (focus: "first" | "last" | null) => {
      if (host) host.open(id, focus);
      else setOwnOpen({ id, focus });
    },
    [host, id],
  );
  const hide = useCallback(() => {
    if (host) host.close();
    else setOwnOpen(null);
  }, [host]);
  const back = useCallback(() => {
    hide();
    row?.focus();
  }, [hide, row]);

  const subCtx = useMemo<MenuContextValue>(
    () => ({
      // The whole chain's close at every level; standalone (no MenuButton
      // above), choosing an item closes this flyout and refocuses its row.
      close: ctx ? ctx.close : back,
      closeOnSelect: ctx ? ctx.closeOnSelect : true,
      initialFocus: focusOnOpen,
      back,
    }),
    [ctx, back, focusOnOpen],
  );

  /** The keyboard steps into the open flyout: registered content places its
   *  own focus, anything else gets its first item / focusable. */
  const stepIn = () => {
    if (contentFocusRef.current) contentFocusRef.current();
    else focusIntoFlyout(flyoutId);
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    // detail 0: activated by the keyboard or assistive technology, not by a
    // pointer press -- treat it as the keyboard does.
    const fromKeys = e.detail === 0;
    if (open) {
      // A second click keeps the flyout (Windows): it does not toggle.
      if (fromKeys) stepIn();
      return;
    }
    show(fromKeys ? "first" : null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key !== "ArrowRight" && e.key !== "Enter" && e.key !== " ") return;
    // Consumed here, so the Menu does not also click() the row.
    e.preventDefault();
    if (open) stepIn();
    else show("first");
  };

  // Inside a popup the pointer moves focus, as on a MenuItem. The host Menu
  // decides, with its delay, what the hover OPENS.
  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!ctx || disabled) return;
    const el = e.currentTarget;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  };

  const hasIcon = icon !== undefined && icon !== null;
  const asMenu = isMenuContent(children);
  const rowAttrs = { [SUBMENU_ATTR]: id } as React.HTMLAttributes<HTMLButtonElement>;

  return (
    <>
      <button
        {...rowAttrs}
        ref={setRow}
        type="button"
        role="menuitem"
        id={rowId}
        // What the row opens: a menu of items, or custom content (a palette,
        // a gallery) -- a labelled role=group with its OWN keys. Announcing
        // "menu" for that would promise menu-item arrows it does not have;
        // ARIA has no "group" popup type, and "dialog" is the generic one
        // (ColorSwatch's palette chevron says the same).
        aria-haspopup={asMenu ? "menu" : "dialog"}
        aria-expanded={open}
        aria-controls={open ? flyoutId : undefined}
        disabled={disabled}
        tabIndex={ctx ? -1 : undefined}
        data-testid={testId}
        className={`${listRowClass} ${subRowClass}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseMove={handleMouseMove}
      >
        <MenuCheck checked={false} />
        {hasIcon && (
          <span className={listIconClass} aria-hidden>
            {icon}
          </span>
        )}
        <span className={listLabelClass} data-menu-label="">
          {label}
        </span>
        <span className={listTrailingClass}>
          <span className={subChevronClass} data-submenu-chevron="" aria-hidden>
            <DropdownChevron size={9} />
          </span>
        </span>
      </button>
      <Popover
        anchorEl={row}
        open={open && row !== null}
        onClose={hide}
        card
        placement="right-start"
        offset={SUBMENU_OFFSET}
        // Lifted by the card's border + padding, so the flyout's first row
        // sits level with this row (Excel), not 9px below it.
        alignOffset={SUBMENU_ALIGN_OFFSET}
        width={width}
        role="presentation"
      >
        <SurfaceLayoutProvider value={popoverLayout(width ?? 0)}>
          <MenuContext.Provider value={subCtx}>
            {asMenu ? (
              // A menu of items places focus by the menu rules; nothing in it
              // registers with an outer custom content's flyout.
              <FlyoutFocusContext.Provider value={null}>
                <Menu id={flyoutId} aria-labelledby={rowId}>
                  {children}
                </Menu>
              </FlyoutFocusContext.Provider>
            ) : (
              <SubmenuContent
                id={flyoutId}
                labelledBy={rowId}
                initialFocus={focusOnOpen}
                back={back}
                contentFocusRef={contentFocusRef}
              >
                {children}
              </SubmenuContent>
            )}
          </MenuContext.Provider>
        </SurfaceLayoutProvider>
      </Popover>
    </>
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
  /**
   * The id of an element (inside the menu's own content) whose text DESCRIBES
   * the menu: read by a screen reader as the menu opens, before its first item.
   * For a menu that shows facts above its commands -- presentation rows that
   * arrow keys, which move between items only, never reach.
   */
  ariaDescribedBy?: string;
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
  ariaDescribedBy,
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
            aria-describedby={ariaDescribedBy}
          >
            {children}
          </Menu>
        </MenuContext.Provider>
      </Popover>
    </>
  );
}

// ============================================================================
// SplitMenuButton
// ============================================================================

// A disabled half is aria-disabled, never native (see SplitMenuButton below),
// so it takes its look from `softDisabled` (./disabled.ts) -- the ONE
// aria-disabled rule the split colour button and RegisteredMenuButton's
// trigger use too.

export interface SplitMenuButtonProps
  extends Omit<IconButtonProps, "split" | "chevron" | "onChevronClick" | "chevronProps" | "children"> {
  /** MenuItems, MenuSeparators and MenuHeadings of the chevron's menu. */
  children: React.ReactNode;
  /** data-testid of the chevron half. */
  chevronTestId?: string;
  /** Accessible name of the menu; defaults to the chevron's label. */
  menuLabel?: string;
  /** Default "bottom-start": under the whole control, left edges aligned. */
  placement?: PopoverPlacement;
  /** Popover width in px (content sizes it otherwise). */
  width?: number;
  /**
   * What the control looks like (the behaviour is the same in all three):
   * - "icon" (default): IconButton's split, the icon half beside a 16px
   *   chevron half -- Underline, Borders, Accounting;
   * - "labelled": Excel's MEDIUM split, [icon label][v] in one 28px row --
   *   "Merge & Center v", "AutoSum v";
   * - "hero": Excel's LARGE split in the ribbon band, one 61px column -- the
   *   picture on top runs the command, the label and chevron below open the
   *   menu (Paste, Insert, Delete); outside the band it is "labelled".
   * `data-testid` stays on the half that runs the command, `chevronTestId` on
   * the half that opens the menu, in every face.
   */
  face?: SplitFace;
  /** "hero" only: the label on one line (default) or Excel's two, with the
   *  chevron after the last word (see CommandButton `labelLines`). */
  labelLines?: 1 | 2;
}

/**
 * Excel's split button WITH its menu: the icon half runs the command
 * (`onClick`), the chevron half opens a card Popover holding a Menu -- with
 * the popup menu's full keyboard model (focus on open, arrows, type-ahead,
 * Escape back to the half that opened it, Tab out, close on select), which a
 * standalone Menu beside an IconButton `split` does not get. `face` picks the
 * look: icon-only (the default), labelled (medium) or hero (large); the
 * halves keep one DOM contract (span.split > .split-main + .split-chevron), so
 * everything below applies to all three.
 *
 * KEYBOARD (Excel's split button):
 * - icon half: Enter/Space run the command (it is a native button);
 *   ArrowDown opens the menu on the first item, ArrowUp on the last;
 * - chevron half: click/Enter/Space toggle the menu; ArrowDown/ArrowUp open
 *   it on the first/last item;
 * - the menu: everything `Menu` does inside a MenuButton.
 *
 * The menu drops under the WHOLE control (the split wrapper is the anchor),
 * as Excel's does, and a press on either half while it is open is not an
 * outside press: the chevron toggles it shut, the icon half closes it and runs.
 *
 * DISABLED IS aria-disabled, NOT the native attribute. A natively disabled
 * button never shows its tooltip -- React drops onMouseEnter on a disabled
 * control, and it cannot take keyboard focus -- so a control greyed out FOR A
 * REASON ("isn't available on a protected sheet") could never say why. Both
 * halves stay hoverable and focusable, look disabled (the one disabled idiom,
 * DISABLED_LOOK, and no hover tint), announce aria-disabled, and do nothing
 * when pressed. Disabled WHILE the menu is open closes it (aria-expanded
 * false), and re-enabling does not reopen it.
 */
export function SplitMenuButton({
  children,
  chevronLabel,
  chevronTestId,
  menuLabel,
  placement = "bottom-start",
  width,
  face = "icon",
  labelLines,
  label,
  disabled,
  onClick,
  onKeyDown,
  ...rest
}: SplitMenuButtonProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  // The half that opened the menu: Escape and a chosen item give focus back
  // to it, so the keyboard user is where they started.
  const returnTo = useRef<HTMLElement | null>(null);
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const halfLabel = chevronLabel ?? `${label} options`;

  // DISABLED WHILE OPEN CLOSES. A caller can compute `disabled` asynchronously
  // (Merge & Center: protection, table regions, editing), so it can flip while
  // the menu is open. Gating only the Popover hid the menu but left `open`
  // true: aria-expanded kept saying "true", and the menu popped back by itself
  // on re-enable. Adjusted during render (React's "previous props" pattern),
  // so no frame shows a stale state -- which is also why aria-expanded needs
  // no `!disabled` gate of its own (a gate here was measured to change
  // nothing: the state is already false when the attribute is written).
  if (disabled && open) setOpen(false);

  const dismiss = useCallback(() => setOpen(false), []);
  const close = useCallback(() => {
    setOpen(false);
    returnTo.current?.focus();
  }, []);
  const ctx = useMemo<MenuContextValue>(
    () => ({ close, closeOnSelect: true, initialFocus }),
    [close, initialFocus],
  );

  const openFrom = (half: HTMLElement, where: "first" | "last"): void => {
    returnTo.current = half;
    setAnchor(half.parentElement ?? half);
    setInitialFocus(where);
    setOpen(true);
  };

  /** ArrowDown/ArrowUp on either half: open (or step into) the menu. */
  const arrowOpens = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const where = e.key === "ArrowUp" ? "last" : "first";
    if (open) {
      const enabled = menuItemsOf(document.getElementById(menuId)).filter((el) => !isDisabled(el));
      enabled[where === "last" ? enabled.length - 1 : 0]?.focus();
      return;
    }
    openFrom(e.currentTarget, where);
  };

  const chevronProps = {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "data-testid": chevronTestId,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-haspopup": "menu",
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-expanded": open,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-controls": open ? menuId : undefined,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-disabled": disabled ? true : undefined,
    className: disabled ? softDisabled : undefined,
    onKeyDown: arrowOpens,
  } as React.ButtonHTMLAttributes<HTMLButtonElement>;

  // One set of half props for every face: the faces differ in pixels only.
  const halves: Omit<IconButtonProps, "split" | "chevron"> = {
    ...rest,
    label,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-disabled": disabled ? true : undefined,
    className: [rest.className, disabled ? softDisabled : undefined].filter(Boolean).join(" ") || undefined,
    chevronLabel: halfLabel,
    chevronProps,
    onClick: (e) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      if (open) setOpen(false);
      onClick?.(e);
    },
    onKeyDown: (e) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      arrowOpens(e);
    },
    onChevronClick: (e) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      if (open) {
        setOpen(false);
        return;
      }
      openFrom(e.currentTarget, "first");
    },
  };

  return (
    <>
      {face === "icon" ? (
        <IconButton {...halves} split />
      ) : (
        <SplitButton {...halves} face={face} labelLines={labelLines} />
      )}
      <Popover
        anchorEl={anchor}
        open={open && anchor !== null && !disabled}
        onClose={dismiss}
        card
        placement={placement}
        width={width}
        role="presentation"
      >
        <MenuContext.Provider value={ctx}>
          <Menu id={menuId} ariaLabel={menuLabel ?? halfLabel}>
            {children}
          </Menu>
        </MenuContext.Provider>
      </Popover>
    </>
  );
}

//! FILENAME: app/src/api/layout/primitives/MenuTree.tsx
// PURPOSE: The registered-menu seam of @api/layout -- RegisteredMenuButton and
//          useRegisteredMenuItem: a ribbon control that hosts a subtree ANOTHER
//          extension registered in the menu bar, through getMenus() from
//          @api/ui.
// CONTEXT: Excel shows Conditional Formatting twice -- on the Home tab and in
//          no menu at all -- but Calcula already HAS the whole tree, galleries
//          included, as Format > Conditional Formatting, registered by the
//          Conditional Formatting extension (homeMenuBuilder.ts). The Home tab
//          may not import that extension (the Facade and Seam rules), and a
//          copied tree is a second source of truth that drifts on the owner's
//          first change. So the Home tab names the item it wants (menu
//          "format", item "format:conditionalFormatting") and this file draws
//          whatever the owner registered there, live: the Format menu and the
//          ribbon show ONE tree. Format as Table works the same way with the
//          Table extension's gallery as the item's customContent.
//
//          HOW A REGISTERED ITEM MAPS (MenuItemDefinition, uiTypes.ts):
//          - the item has `children` -> the trigger opens a Menu of them;
//          - the item has ONLY `customContent` -> the trigger opens a card
//            whose whole body is customContent(onClose) (a gallery);
//          - the item only runs (`action` / `commandId`) -> the trigger runs it;
//          - the item is missing, hidden or disabled -> the trigger is drawn
//            aria-disabled (never natively: a natively disabled button cannot
//            show the tooltip that says WHY -- see SplitMenuButton).
//          Inside the menu, child by child: `children` -> MenuSub; a
//          `customContent` child -> a MenuSub whose flyout is
//          customContent(onClose), where onClose closes the WHOLE chain and
//          returns focus to the trigger; `action` runs it, else `commandId`
//          goes through CommandRegistry.execute (the menu bar's precedence);
//          `disabled`, `checked` (a menuitemcheckbox), `shortcut` and
//          `separator` as named; `hidden` rows are left out; `icon` is fitted
//          to 16px (the menu-bar glyphs carry no size of their own). A row's
//          data-testid is its registered id, the one identity both doors share.
//          Not drawn: `rightAction` (a menu-bar-only affordance), and the
//          action of an item that also has children (a MenuSub row opens its
//          flyout; it has nothing to run).
//
//          LIVE. The registry patches items IN PLACE (updateMenuItem, and the
//          documented "mutate, then notifyMenusChanged()"), so the item object
//          is the same before and after a change and nothing can compare
//          identities: the hook re-renders on every registry notification
//          (subscribeToMenus) and reads the tree afresh.

import React, { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { css } from "@emotion/css";
import { getMenus, subscribeToMenus } from "../../ui";
import type { MenuItemDefinition } from "../../uiTypes";
import { CommandRegistry } from "../../commands";
import { alertAsync } from "../../dialogs";
import { SurfaceLayoutProvider, popoverLayout } from "../context";
import {
  MenuButton,
  MenuCloseScope,
  MenuItem,
  MenuSeparator,
  MenuSub,
  useMenuClose,
} from "./Menu";
import { softDisabled } from "./disabled";
import { Popover, firstFocusable, type PopoverPlacement } from "./Popover";
import { focusWhenVisible } from "./roving";

// ============================================================================
// Reading the registry
// ============================================================================

function findIn(items: readonly MenuItemDefinition[], itemId: string): MenuItemDefinition | null {
  for (const item of items) if (item.id === itemId) return item;
  for (const item of items) {
    if (!item.children || item.children.length === 0) continue;
    const below = findIn(item.children, itemId);
    if (below) return below;
  }
  return null;
}

/** The item `itemId` (at any depth, a top-level match first) of the
 *  registered menu `menuId`, or null. */
function findRegisteredMenuItem(menuId: string, itemId: string): MenuItemDefinition | null {
  const menu = getMenus().find((m) => m.id === menuId);
  return menu ? findIn(menu.items, itemId) : null;
}

/**
 * The menu-bar item `itemId` of menu `menuId` as it is registered NOW, or null
 * when nothing is -- re-rendering the caller whenever any extension registers,
 * patches or takes back a menu item. For a control that needs the item's state
 * beside RegisteredMenuButton (an explanatory tooltip while it is missing).
 */
export function useRegisteredMenuItem(menuId: string, itemId: string): MenuItemDefinition | null {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const unsubscribe = subscribeToMenus(refresh);
    // A registration between this component's render and this subscription
    // notified nobody: read once more now that we are listening.
    refresh();
    return () => {
      unsubscribe();
    };
  }, []);
  return findRegisteredMenuItem(menuId, itemId);
}

// ============================================================================
// Drawing a registered subtree
// ============================================================================

/** A menu-bar glyph (a viewBox-only svg) fitted to the 16px menu size. */
const registeredIcon = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;

  & > svg {
    display: block;
    width: 16px;
    height: 16px;
  }
`;

function iconOf(item: MenuItemDefinition): React.ReactNode {
  const icon = item.icon;
  if (icon === undefined || icon === null || icon === false || icon === "") return undefined;
  return <span className={registeredIcon}>{icon}</span>;
}

/**
 * A refusal a registered item THREW, shown to the user in its own words -- the
 * console is not the user. alertAsync, never awaited (the dialog's lifetime is
 * the user's, not the click's), as every Home runner does; still logged, for
 * the log. Items hosted through this seam are other extensions', third-party
 * ones included, and some refuse by throwing (a protected sheet's backend
 * error): before this, such a refusal did nothing visible.
 */
function reportRefusal(what: string, err: unknown): void {
  console.error(`[RegisteredMenuButton] ${what} failed:`, err);
  void alertAsync(err instanceof Error ? err.message : String(err));
}

/** Run a registered leaf: its action, else its command (the menu bar's order).
 *  Never throws: a refusal reaches the user (reportRefusal). An action is
 *  typed `() => void` but may be async in practice, so a returned promise's
 *  rejection is caught too. */
function runRegisteredItem(item: MenuItemDefinition): void {
  if (item.action) {
    const what = `action of ${item.id}`;
    try {
      const result: unknown = item.action();
      if (result instanceof Promise) result.catch((err: unknown) => reportRefusal(what, err));
    } catch (err) {
      reportRefusal(what, err);
    }
    return;
  }
  if (item.commandId) {
    const commandId = item.commandId;
    CommandRegistry.execute(commandId).catch((err: unknown) => reportRefusal(`command ${commandId}`, err));
  }
}

/** A registered item's customContent, rendered in a component of its own so
 *  hooks inside the content stay in their own scope (as the menu bar's
 *  CustomContentRenderer does), with the enclosing chain's close. */
function RegisteredCustomContent({
  render,
}: {
  render: (onClose: () => void) => React.ReactNode;
}): React.ReactElement {
  const close = useMenuClose();
  return <>{render(close)}</>;
}

function visibleOf(items: readonly MenuItemDefinition[] | undefined): MenuItemDefinition[] {
  return (items ?? []).filter((item) => !item.hidden);
}

/** Whether an item has a visible row below it (separators alone do not count). */
function hasVisibleRows(item: MenuItemDefinition): boolean {
  return visibleOf(item.children).some((child) => !child.separator);
}

/**
 * The rows of a registered list, as MenuItem / MenuSub / MenuSeparator
 * ELEMENTS (never a wrapper component: MenuSub decides "menu or custom
 * content" from its children's element types). Separators are tidied as the
 * list is drawn -- hidden rows can leave two in a row, or one at an end -- so
 * the menu never shows a doubled or dangling line.
 */
function renderRegisteredRows(items: readonly MenuItemDefinition[] | undefined): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  let separatorPending = false;
  for (const item of visibleOf(items)) {
    if (item.separator) {
      if (rows.length > 0) separatorPending = true;
      continue;
    }
    if (separatorPending) {
      rows.push(<MenuSeparator key={`separator-before-${item.id}`} />);
      separatorPending = false;
    }
    rows.push(renderRegisteredRow(item));
  }
  return rows;
}

function renderRegisteredRow(item: MenuItemDefinition): React.ReactElement {
  const icon = iconOf(item);
  if (hasVisibleRows(item)) {
    return (
      <MenuSub key={item.id} label={item.label} icon={icon} testId={item.id} disabled={item.disabled}>
        {renderRegisteredRows(item.children)}
      </MenuSub>
    );
  }
  if (item.customContent) {
    return (
      <MenuSub key={item.id} label={item.label} icon={icon} testId={item.id} disabled={item.disabled}>
        <RegisteredCustomContent render={item.customContent} />
      </MenuSub>
    );
  }
  const runs = Boolean(item.action || item.commandId);
  const checkable = item.checked !== undefined;
  return (
    <MenuItem
      key={item.id}
      testId={item.id}
      icon={icon}
      role={checkable ? "menuitemcheckbox" : "menuitem"}
      checked={item.checked ?? false}
      shortcut={item.shortcut}
      shortcutCommandId={item.commandId}
      // A row that runs nothing is shown disabled, never as a live row that
      // does nothing.
      disabled={item.disabled || !runs}
      onSelect={() => runRegisteredItem(item)}
    >
      {item.label}
    </MenuItem>
  );
}

// ============================================================================
// The trigger in each of its states
// ============================================================================

/** The props a trigger clone chains or sets. */
type TriggerProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  "className" | "onClick" | "onKeyDown" | "aria-disabled" | "aria-haspopup" | "aria-expanded" | "aria-controls"
>;

/** Nothing to open or run: aria-disabled (still hoverable and focusable, so
 *  its tooltip can say why), the one disabled look, and a click that does
 *  nothing -- not even the trigger's own onClick. */
function DisabledTrigger({ trigger }: { trigger: React.ReactElement }): React.ReactElement {
  const own = trigger.props as TriggerProps;
  return React.cloneElement(trigger, {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-disabled": true,
    className: [own.className, softDisabled].filter(Boolean).join(" "),
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
    },
  } as TriggerProps);
}

/** A leaf item: the trigger runs it. */
function RunTrigger({ trigger, item }: { trigger: React.ReactElement; item: MenuItemDefinition }): React.ReactElement {
  const own = trigger.props as TriggerProps;
  return React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      own.onClick?.(e);
      if (e.defaultPrevented) return;
      runRegisteredItem(item);
    },
  } as TriggerProps);
}

/** The body of a customContent card: the content, and focus into it when the
 *  card was opened from the keyboard. */
function ContentBody({
  id,
  focusOnOpen,
  render,
  close,
}: {
  id: string;
  focusOnOpen: boolean;
  render: (onClose: () => void) => React.ReactNode;
  close: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusOnOpen || !ref.current) return;
    focusWhenVisible(firstFocusable(ref.current));
  }, [focusOnOpen]);
  return (
    <div ref={ref} id={id}>
      {render(close)}
    </div>
  );
}

/**
 * An item with only customContent: the trigger toggles a CARD popover whose
 * body is customContent(onClose). The card is the chrome: the galleries hosted
 * this way (the CF galleries, the table-style gallery) draw no background of
 * their own. onClose closes the card and returns focus to the trigger;
 * Escape and an outside press close it too (Popover) -- Escape the card ONLY,
 * never a collapsed group's flyout around it (Popover's ESCAPE NESTS).
 * Click/Enter/Space toggle it; ArrowDown/ArrowUp open it with focus inside,
 * as on every other popup hero.
 */
function ContentTrigger({
  trigger,
  item,
  render,
  placement,
  width,
}: {
  trigger: React.ReactElement;
  item: MenuItemDefinition;
  render: (onClose: () => void) => React.ReactNode;
  placement: PopoverPlacement;
  width?: number;
}): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const bodyId = `${useId()}-body`;
  const own = trigger.props as TriggerProps;

  const dismiss = useCallback(() => setOpen(false), []);
  const close = useCallback(() => {
    setOpen(false);
    anchor?.focus();
  }, [anchor]);

  /** ArrowDown / ArrowUp open the card with focus inside, as they open every
   *  other popup hero (MenuButton's trigger rule); a gallery has no "last
   *  item", so both arrows open it the same way. Already open (a pointer open
   *  left focus here): step in. Arrows the trigger handled itself are its own. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    own.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (open) {
      const body = document.getElementById(bodyId);
      focusWhenVisible(body ? firstFocusable(body) : null);
      return;
    }
    setAnchor(e.currentTarget);
    setFocusOnOpen(true);
    setOpen(true);
  };

  const cloned = React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      own.onClick?.(e);
      if (e.defaultPrevented) return;
      setAnchor(e.currentTarget);
      // detail 0: the keyboard (or assistive technology) pressed it.
      setFocusOnOpen(e.detail === 0);
      setOpen((was) => !was);
    },
    onKeyDown: handleKeyDown,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-haspopup": "dialog",
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-expanded": open,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
    "aria-controls": open ? bodyId : undefined,
  } as TriggerProps);

  return (
    <>
      {cloned}
      <Popover
        anchorEl={anchor}
        open={open && anchor !== null}
        onClose={dismiss}
        card
        placement={placement}
        width={width}
        ariaLabel={item.label}
      >
        <SurfaceLayoutProvider value={popoverLayout(width ?? 0)}>
          <MenuCloseScope close={close}>
            <ContentBody id={bodyId} focusOnOpen={focusOnOpen} render={render} close={close} />
          </MenuCloseScope>
        </SurfaceLayoutProvider>
      </Popover>
    </>
  );
}

// ============================================================================
// RegisteredMenuButton
// ============================================================================

export interface RegisteredMenuButtonProps {
  /** The registered menu-bar menu ("format"). */
  menuId: string;
  /** The item in it ("format:conditionalFormatting"); found at any depth. */
  itemId: string;
  /** The control that opens it (a CommandButton hero, a Button...). Cloned,
   *  not wrapped: it keeps its own DOM, data-testid and tooltip. */
  trigger: React.ReactElement;
  /** Default "bottom-start". */
  placement?: PopoverPlacement;
  /** Popover width in px (content sizes it otherwise). */
  width?: number;
}

/**
 * A ribbon control that opens what another extension registered at
 * `menuId` > `itemId` in the menu bar, kept live as that registration
 * changes (see the header for how each kind of item is drawn). The trigger is
 * drawn disabled while nothing usable is registered there; pair it with
 * useRegisteredMenuItem to give that state an explanatory tooltip.
 */
export function RegisteredMenuButton({
  menuId,
  itemId,
  trigger,
  placement = "bottom-start",
  width,
}: RegisteredMenuButtonProps): React.ReactElement {
  const item = useRegisteredMenuItem(menuId, itemId);

  if (!item || item.hidden || item.disabled) return <DisabledTrigger trigger={trigger} />;

  if (hasVisibleRows(item)) {
    return (
      <MenuButton trigger={trigger} placement={placement} width={width}>
        {renderRegisteredRows(item.children)}
      </MenuButton>
    );
  }

  if (item.customContent) {
    return (
      <ContentTrigger
        trigger={trigger}
        item={item}
        render={item.customContent}
        placement={placement}
        width={width}
      />
    );
  }

  if (item.action || item.commandId) return <RunTrigger trigger={trigger} item={item} />;

  return <DisabledTrigger trigger={trigger} />;
}

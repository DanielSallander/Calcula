//! FILENAME: app/extensions/BuiltIn/HomeTab/components/clipboard/FormatPainterButton.tsx
// PURPOSE: Excel's Format Painter button for the Home tab's Clipboard group:
//          a click copies the formatting once, a double-click LOCKS the painter
//          on until Escape or another click, and the button shows pressed while
//          the painter is on.
// CONTEXT: Rendered for the catalog item "formatPainter" (contract 3.2,
//          2026-10-04). Beside the Paste hero in the band it is Excel's medium
//          button, icon and "Format Painter" (`labelled`); elsewhere icon-only,
//          as the group's other commands are.
//
//          WHAT A DOUBLE-CLICK IS, TO A BROWSER: click (detail 1), click
//          (detail 2), dblclick. Sent as two FORMAT_PAINTERs and a LOCK, the
//          FormatPainter extension still ends LOCKED (its table, in
//          formatPainterLogic.ts activateFormatPainter: a second start while
//          the first is reading its source is ignored; a click on an ARMED
//          painter switches it off and the LOCK then arms a new one) -- but on
//          the second timing the painter goes off and on again: the marching
//          ants and the paintbrush cursor flicker, focus is handed back to the
//          grid twice, and the source cells are read a second time. So the
//          SECOND click of a pair is left to the dblclick that always follows
//          it: one FORMAT_PAINTER, then one LOCK, which upgrades the one
//          painter in place on both timings and never starts a second.
//          Windows pairs clicks the same way (down, up, DBLCLK, up), so a
//          third click (detail 3) is a plain click again, as in Excel: it
//          switches the locked painter off. A keyboard or assistive activation
//          has detail 0 and is a click.
//
//          PRESSED reads @api/formatPainterState, which the extension alone
//          writes on every transition -- armed, locked, stopped by a paint,
//          Escape, the button or its own deactivation -- so the button never
//          has to guess what the painter did. `data-locked` says which kind of
//          on it is (Excel draws both the same).
//
//          The commands run through CommandRegistry (runCommand), the door
//          Ctrl+Shift+C and the Edit menu use too; a refusal (a floating
//          grid's cell owning the selection) reaches the user, never the
//          console.

import React from "react";
import { RibbonIcon } from "@api";
import { CoreCommands } from "@api/commands";
import { useFormatPainterState } from "@api/formatPainterState";
import { Button, IconButton, ICON_SIZE_SM } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { homeTabIcon } from "../homeTabIcons";
import { itemTooltip } from "../itemTooltip";
import { runCommand } from "../runCommand";

export interface FormatPainterButtonProps extends HomeItemProps {
  /** Show the label beside the icon (Excel's medium button) -- the caller
   *  passes it where the group lays a hero beside its stack, as it does for
   *  Cut and Copy. Default false: icon-only. */
  labelled?: boolean;
}

/**
 * The browser's click count on the SECOND click of a double-click. That click
 * is followed by a dblclick, which runs the lock (see the header).
 */
const SECOND_CLICK_OF_A_PAIR = 2;

/** Excel's Format Painter button (catalog item "formatPainter"). */
export function FormatPainterButton({ item, labelled = false }: FormatPainterButtonProps): React.ReactElement {
  const { active, locked } = useFormatPainterState();
  const tip = itemTooltip(item);
  const icon = homeTabIcon(item.id, ICON_SIZE_SM) ?? <RibbonIcon.FormatPainter size={ICON_SIZE_SM} />;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (e.detail === SECOND_CLICK_OF_A_PAIR) return;
    void runCommand(CoreCommands.FORMAT_PAINTER);
  };
  const handleDoubleClick = (): void => {
    void runCommand(CoreCommands.FORMAT_PAINTER_LOCK);
  };

  // `data-active` / `data-locked` are ABSENT at rest (`|| undefined`), so a
  // selector for `[data-active]` / `[data-locked]` means exactly "on" /
  // "locked" -- the convention every Home toggle's `data-active` follows.
  if (labelled) {
    return (
      <Button
        data-testid={`fmt-${item.id}`}
        data-active={active || undefined}
        data-locked={locked || undefined}
        icon={icon}
        aria-pressed={active}
        tooltip={tip.tooltip}
        shortcut={tip.shortcut}
        commandId={tip.commandId}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {item.label}
      </Button>
    );
  }

  return (
    <IconButton
      data-testid={`fmt-${item.id}`}
      data-active={active || undefined}
      data-locked={locked || undefined}
      icon={icon}
      label={item.label}
      pressed={active}
      tooltip={tip.tooltip}
      shortcut={tip.shortcut}
      commandId={tip.commandId}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    />
  );
}

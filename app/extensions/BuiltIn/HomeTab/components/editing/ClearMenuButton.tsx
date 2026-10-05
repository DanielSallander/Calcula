//! FILENAME: app/extensions/BuiltIn/HomeTab/components/editing/ClearMenuButton.tsx
// PURPOSE: Excel's Clear menu button for the Home tab's Editing group
//          (CONTRACT 3.16): Clear All, Clear Formats, Clear Contents, Clear
//          Comments and Notes, Clear Hyperlinks, then Remove Hyperlinks.
// CONTEXT: Rendered for the catalog item "clear". Every row is one of Core's
//          clear gestures (core/lib/clearGestures): one undo step each, every
//          Ctrl+click block, refusals alerted by Core itself; a thrown one
//          still reaches the user through runCommand. Every row's test id is
//          `fmt-clear-<slug>` -- Clear All's is `fmt-clear-all`. It used to
//          keep `fmt-clearAll`, the standalone Clear All button's id, but a
//          layout migrated from version 1 keeps that button AND gains this
//          menu, so an open menu put two `fmt-clearAll` elements in the
//          document and a journey's "the visible fmt-clearAll" clicked the
//          button instead of opening the menu (review finding, 2026-10-04).
//          The standalone button keeps `fmt-clearAll` (every catalog item's
//          control is `fmt-<itemId>`).
//
//          TWO ROWS ARE GREYED, as Excel greys them (measured live, Excel 16
//          build 20430, 2026-10-04 -- scratchpad home-editing-probe/probe2.out
//          and probe3.out, GetEnabledMso):
//          - Remove Hyperlinks, unless some cell of the selection -- in any
//            Ctrl+click area -- holds a hyperlink. There it would do nothing
//            (Core's removeHyperlinks opens no undo step without a link).
//          - Clear Comments and Notes, unless some cell holds a note or a
//            threaded comment. (Beyond CONTRACT 3.16, which names only Remove
//            Hyperlinks; it is the same rule, measured the same way, and the
//            menu screenshot in scratchpad excel-icons/menu-Clear-1.png shows
//            both greyed.) Clear Hyperlinks stays LIVE without a link: Excel's
//            does too.
//
//          WHEN THE MENU OPENS. The facts are backend reads, so they are asked
//          once per opening (and again if the selection moves while it is
//          open), from ClearMenuRows, which mounts only while the menu is open
//          -- never on every selection change of a closed ribbon button.
//
//          UNKNOWN IS GREY, A FAILURE IS LIVE. While a read is in flight the
//          row is greyed (it is usually answered before the pointer gets
//          there). If a read FAILS the row is live: a failed read is not "no
//          link", the command decides for itself, and it does nothing harmful
//          when there is nothing to remove. Greying it would claim an absence
//          nobody measured.

import React, { useEffect, useMemo, useState } from "react";
import { RibbonIcon } from "@api";
import { CoreCommands } from "@api/commands";
import { useGridState } from "@api/grid";
import { getHyperlinksInRange, getCommentIndicatorsInRange, getNoteIndicatorsInRange } from "@api/lib";
import { MenuButton, IconButton, MenuItem, MenuSeparator, MENU_ICON_BLANK, ICON_SIZE_SM } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import { selectionBlocks, type SelectionBlock } from "@api/selectionBlocks";
import { MENU_ROW_ICON_SIZE, runCommand } from "../runCommand";

/** What the menu knows about one fact of the selection. */
type Presence = "unknown" | "present" | "absent" | "unreadable";

/** Whether a row gated on `presence` is live (see "UNKNOWN IS GREY"). */
function liveFor(presence: Presence): boolean {
  return presence === "present" || presence === "unreadable";
}

/** Whether any block holds at least one of what `read` lists. Rejects when a read fails. */
async function anyIn(
  blocks: SelectionBlock[],
  read: (startRow: number, startCol: number, endRow: number, endCol: number) => Promise<unknown[]>,
): Promise<boolean> {
  const found = await Promise.all(
    blocks.map(async (b) => {
      const list = await read(b.startRow, b.startCol, b.endRow, b.endCol);
      return Array.isArray(list) && list.length > 0;
    }),
  );
  return found.some(Boolean);
}

/**
 * Ask the backend `ask` about `blocks` whenever `key` changes, and report what
 * it said. `key` is the blocks' identity (a string), so a re-render that
 * produced equal blocks asks nothing again.
 */
function usePresence(
  key: string,
  blocks: SelectionBlock[],
  ask: (blocks: SelectionBlock[]) => Promise<boolean>,
): Presence {
  const [state, setState] = useState<{ key: string; presence: Presence }>({ key, presence: "unknown" });

  useEffect(() => {
    if (blocks.length === 0) {
      setState({ key, presence: "absent" });
      return undefined;
    }
    let cancelled = false;
    setState({ key, presence: "unknown" });
    // Started inside a resolved promise, so a read that throws synchronously
    // (a test double, a missing export) lands in the catch like an IPC error.
    Promise.resolve()
      .then(() => ask(blocks))
      .then((present) => {
        if (!cancelled) setState({ key, presence: present ? "present" : "absent" });
      })
      .catch(() => {
        if (!cancelled) setState({ key, presence: "unreadable" });
      });
    return () => {
      cancelled = true;
    };
    // `blocks` is derived from `key`; asking again for an equal key is waste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A selection that moved since the last answer is not known yet.
  return state.key === key ? state.presence : "unknown";
}

const hasLink = (blocks: SelectionBlock[]) => anyIn(blocks, getHyperlinksInRange);
// Notes and threaded comments are two stores; Clear Comments and Notes clears
// both, so either one makes it live.
const hasCommentOrNote = async (blocks: SelectionBlock[]) => {
  const [comments, notes] = await Promise.all([
    anyIn(blocks, getCommentIndicatorsInRange),
    anyIn(blocks, getNoteIndicatorsInRange),
  ]);
  return comments || notes;
};

/** The menu's rows. Mounted only while the menu is open. */
function ClearMenuRows({ testId }: { testId: string }): React.ReactElement {
  const selection = useGridState().selection;
  const blocks = useMemo(() => selectionBlocks(selection), [selection]);
  const key = blocks.map((b) => `${b.startRow},${b.startCol},${b.endRow},${b.endCol}`).join(";");

  const links = usePresence(key, blocks, hasLink);
  const commentsOrNotes = usePresence(key, blocks, hasCommentOrNote);

  return (
    <>
      <MenuItem
        icon={<RibbonIcon.Clear size={MENU_ROW_ICON_SIZE} />}
        // NOT fmt-clearAll: that is the standalone Clear All button's, which a
        // migrated layout shows beside this menu (see the header).
        testId={`${testId}-all`}
        onSelect={() => void runCommand(CoreCommands.CLEAR_ALL)}
      >
        Clear All
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.ClearFormatting size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-formats`}
        onSelect={() => void runCommand(CoreCommands.CLEAR_FORMATTING)}
      >
        Clear Formats
      </MenuItem>
      <MenuItem
        icon={MENU_ICON_BLANK}
        testId={`${testId}-contents`}
        // The Delete key: Calcula's live binding, shown where it is learned.
        shortcutCommandId={CoreCommands.CLEAR_CONTENTS}
        onSelect={() => void runCommand(CoreCommands.CLEAR_CONTENTS)}
      >
        Clear Contents
      </MenuItem>
      <MenuItem
        icon={MENU_ICON_BLANK}
        testId={`${testId}-comments`}
        disabled={!liveFor(commentsOrNotes)}
        onSelect={() => void runCommand(CoreCommands.CLEAR_COMMENTS)}
      >
        Clear Comments and Notes
      </MenuItem>
      <MenuItem
        icon={MENU_ICON_BLANK}
        testId={`${testId}-hyperlinks`}
        onSelect={() => void runCommand(CoreCommands.CLEAR_HYPERLINKS)}
      >
        Clear Hyperlinks
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<RibbonIcon.RemoveHyperlinks size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-removeHyperlinks`}
        disabled={!liveFor(links)}
        onSelect={() => void runCommand(CoreCommands.REMOVE_HYPERLINKS)}
      >
        Remove Hyperlinks
      </MenuItem>
    </>
  );
}

export function ClearMenuButton({ item }: HomeItemProps): React.ReactElement {
  const tip = itemTooltip(item);
  const testId = `fmt-${item.id}`;

  return (
    <MenuButton
      trigger={
        <IconButton
          icon={<RibbonIcon.Clear size={ICON_SIZE_SM} />}
          label={item.label}
          chevron
          tooltip={tip.tooltip}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={testId}
        />
      }
    >
      <ClearMenuRows testId={testId} />
    </MenuButton>
  );
}

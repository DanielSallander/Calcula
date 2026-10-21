//! FILENAME: app/extensions/BuiltIn/HomeTab/components/alignment/orientationMenu.ts
// PURPOSE: What Excel's Orientation menu (CONTRACT 3.6) holds and what each of
//          its rows runs: the five check rows' values, words and pictures, the
//          rows an indent disables, and the two actions -- a rotation (made
//          readable by a grow-only AutoFit, in one undo step) and Format Cell
//          Alignment.
// CONTEXT: The data and behaviour behind OrientationMenuButton.tsx, kept out of
//          the component file so that file exports only the component.
//
//          WHAT EXCEL DOES, measured live (survey alignment.md section 2):
//          - Only the row matching the ACTIVE cell's orientation is checked;
//            horizontal text, and any angle no row names (30 degrees), check
//            nothing. The backend reports 0 / 90 / -90 as the named values
//            ("none", "rotate90", "rotate270"), so a plain string comparison of
//            `textRotation` is exact.
//          - Choosing the CHECKED row returns the text to horizontal; choosing
//            another row switches straight to it.
//          - While the cell has an indent, the four ANGLE rows are disabled
//            (running them fails in Excel); Vertical Text stays enabled.
//
//          ROTATED TEXT MUST STAY READABLE. Excel's rows have AUTOMATIC height:
//          "Sample text" in a default 14.3pt row became 49.2pt at 45 degrees,
//          55.5pt at 90 and 157.5pt stacked. A Calcula row has an explicit
//          height, so rotating text in a default 20px row would show a sliver
//          of it. So after a rotation the menu runs AUTOFIT_ROW_HEIGHT with
//          `{ growOnly: true }` (CONTRACT section 10): a row too short for its
//          rotated text grows, and NOTHING shrinks -- a height the user chose
//          is never undone. The rotation and the growth are ONE undo step (one
//          transaction around both), because in Excel one Ctrl+Z restores the
//          orientation and the automatic height together; two steps would
//          leave the first Ctrl+Z showing clipped rotated text.
//
//          Returning to horizontal grows nothing (there is nothing to make
//          readable) and, because nothing may shrink, a row the rotation grew
//          stays tall. Excel's automatic height would shrink back; Calcula has
//          no "automatic" row height to return to (see the lane report).

import { CommandRegistry, CoreCommands } from "@api/commands";
import { alertAsync } from "@api/dialogs";
import { beginUndoTransaction, commitUndoTransaction, cancelUndoTransaction } from "@api/lib";
import { ownUndoTransaction } from "@api/undoTicket";
import { resolveCellTarget } from "@api/cellTarget";
import type { RibbonIconKey } from "@api";
import type { HomeTabState } from "../homeItemProps";

/** The `textRotation` values the five check rows write (the backend's own
 *  vocabulary: `custom:N` counter-clockwise degrees, the two named quarter
 *  turns, and stacked text). */
export type OrientationValue = "custom:45" | "custom:-45" | "vertical" | "rotate90" | "rotate270";

/** One check row of the menu. */
export interface OrientationRow {
  /** What the row writes, and what checks it. */
  value: OrientationValue;
  /** Excel's words. Also the action a refusal names, and the undo step. */
  label: string;
  /** Test-id suffix: the row is `fmt-<itemId>-<slug>`. */
  slug: string;
  /** Its picture (CONTRACT section 7). A KEY, resolved at render: the icon
   *  set is never touched while this module loads. */
  icon: RibbonIconKey;
  /** An angle: disabled while the cell has an indent (Excel). */
  angle: boolean;
}

/** Excel's five orientation rows, in Excel's order. */
export const ORIENTATION_ROWS: readonly OrientationRow[] = [
  { value: "custom:45", label: "Angle Counterclockwise", slug: "angleCounterclockwise", icon: "AngleCounterclockwise", angle: true },
  { value: "custom:-45", label: "Angle Clockwise", slug: "angleClockwise", icon: "AngleClockwise", angle: true },
  { value: "vertical", label: "Vertical Text", slug: "verticalText", icon: "VerticalText", angle: false },
  { value: "rotate90", label: "Rotate Text Up", slug: "rotateTextUp", icon: "RotateTextUp", angle: true },
  { value: "rotate270", label: "Rotate Text Down", slug: "rotateTextDown", icon: "RotateTextDown", angle: true },
];

/** The rows Excel disables while the active cell has an indent. */
export const ORIENTATION_UNAVAILABLE_WHILE_INDENTED: readonly OrientationValue[] = ORIENTATION_ROWS.filter(
  (row) => row.angle,
).map((row) => row.value);

/** The last row: Format Cells on its Alignment tab, with the button's own
 *  picture (Excel's is the same drawing). */
export const FORMAT_CELL_ALIGNMENT = {
  label: "Format Cell Alignment",
  slug: "formatCellAlignment",
  icon: "TextOrientation",
} as const satisfies { label: string; slug: string; icon: RibbonIconKey };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one orientation row: Excel's toggle (the checked row returns the text to
 * horizontal), else the rotation followed by a grow-only AutoFit of the rows,
 * as ONE undo step. Never throws: a refusal reaches the user.
 */
export async function chooseOrientation(state: HomeTabState, row: OrientationRow, checked: boolean): Promise<void> {
  const action = row.label;
  try {
    if (checked) {
      // Back to horizontal: one write, its own step, nothing to grow.
      await state.applyFormat({ textRotation: "none" }, action);
      return;
    }

    // Asked HERE, once, before a transaction is opened: the door below would
    // refuse the write itself, but the AutoFit after it is a second door with
    // a second refusal toast, and an opened step would have nothing in it.
    // WHICH cells (P3): a floating grid that admits the act answers with its
    // own; applyFormat asks again and writes there, and the AutoFit goes
    // through the grid command, which asks the same owner ("lineSize").
    if (resolveCellTarget(action, "format") === null) return;

    // A begin that fails still lets the rotation apply, as two steps (what
    // every formatting button does without a transaction). A begin that JOINS
    // a script's batch closes nothing: the holder closes it.
    const tx = ownUndoTransaction(await beginUndoTransaction(action).catch(() => null), {
      commitUndoTransaction,
      cancelUndoTransaction,
    });
    try {
      // `applyFormat` reports a refused write as `false` (or throws); either
      // way there is no rotated text to make readable. Read as unknown so a
      // door that reports nothing (void) still counts as written.
      const written: unknown = await state.applyFormat({ textRotation: row.value }, action);
      if (written === false) return;
      await CommandRegistry.execute(CoreCommands.AUTOFIT_ROW_HEIGHT, { growOnly: true });
    } finally {
      // COMMIT, never cancel: what landed stays undoable (a cancel drops the
      // undo record and keeps the writes). An empty step commits to nothing.
      await tx.commit().catch((err) => console.error("[HomeTab] Orientation: closing the undo step failed:", err));
    }
  } catch (err) {
    void alertAsync(messageOf(err));
  }
}

/** Format Cell Alignment: the FORMAT_CELLS command, the ONE door to the dialog
 *  (it refuses while something else owns the selection). Never throws. */
export async function openFormatCellAlignment(): Promise<void> {
  try {
    await CommandRegistry.execute(CoreCommands.FORMAT_CELLS, { tab: "alignment" });
  } catch (err) {
    void alertAsync(messageOf(err));
  }
}

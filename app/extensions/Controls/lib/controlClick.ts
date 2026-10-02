//! FILENAME: app/extensions/Controls/lib/controlClick.ts
// PURPOSE: The click of a button CONTROL -- floating (index.ts
//          runFloatingButtonClick) and in-cell (Button/interceptors.ts
//          executeButtonAction) -- through the Rust button door.
// CONTEXT: Phase 4 of BUG-0257 (M6). Both paths used to read the control's
//          `onSelect` on the page and compose it with the user's own modules
//          (the deleted `planInlineButtonRun`), then hand the result to
//          `run_script`. Now the click names the BUTTON and the door
//          (`run_control_action`, app/src-tauri/src/scripting/control_action.rs)
//          decides what runs, from its own store: a macro link answers `link`;
//          the user's own inline code runs with the user's own modules; an
//          application's HELD inline code runs as its exact bytes, only after
//          the approval of those bytes, and every run and refusal of it is on
//          the audit trail. The answers are said once, by the shared
//          `clickButtonThroughDoor` (extensions/_shared/lib/buttonClickDoor.ts).
//
//          A LINK keeps the phase-3 route unchanged: the macro-run seam, behind
//          the application's approval and the Rust run gate
//          (lib/applicationMacroLink.ts `runButtonMacroLink`), fed the control's
//          metadata as it is NOW.

import { showToast } from "@api/notifications";
import { clickButtonThroughDoor, type ButtonGesturePass } from "../../_shared/lib/buttonClickDoor";
import { getControlMetadata } from "./controlApi";
import { runButtonMacroLink } from "./applicationMacroLink";

/**
 * The door answered `link`: run the macro the control links, through the
 * phase-3 route. The metadata is read now; a link that vanished between the
 * door's read and this one is said, never a silent no-op. `gesture` is the
 * person's click, handed on untouched (owner decision B).
 */
async function followMacroLink(
  sheetIndex: number,
  row: number,
  col: number,
  gesture: ButtonGesturePass | undefined,
): Promise<void> {
  const metadata = await getControlMetadata(sheetIndex, row, col);
  if (await runButtonMacroLink(sheetIndex, row, col, metadata?.properties, gesture)) return;
  showToast(
    "This button's macro link changed while it was being clicked, so nothing ran. Click it again.",
    { variant: "warning" },
  );
}

/**
 * Click the button control at (sheetIndex, row, col): the door first, every
 * answer said once. `nothing` is the surface's own word for a button with
 * nothing on it to run (the floating path diagnoses its object script; the
 * in-cell path has nothing more to add).
 *
 * `sheetIndex` is the TRUE state-vector index of the button's sheet. Never
 * throws: a failure is a toast.
 *
 * `gesture` is THE PERSON'S CLICK (owner decision B): given only by the two
 * pointer gesture handlers (index.ts `handleButtonPress`, Button/interceptors.ts
 * `buttonClickInterceptor`), and only a linked macro uses it. A caller that is
 * not a person's gesture passes none, and the macro runs restricted.
 */
export async function clickButtonControl(
  sheetIndex: number,
  row: number,
  col: number,
  nothing: (message: string | null) => void | Promise<void>,
  gesture?: ButtonGesturePass,
): Promise<void> {
  await clickButtonThroughDoor(
    { kind: "control", sheetIndex, row, col },
    {
      link: () => followMacroLink(sheetIndex, row, col, gesture),
      nothing,
    },
  );
}

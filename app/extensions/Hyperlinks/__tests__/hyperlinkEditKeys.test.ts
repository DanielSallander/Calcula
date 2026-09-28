//! FILENAME: app/extensions/Hyperlinks/__tests__/hyperlinkEditKeys.test.ts
// PURPOSE: Hyperlinks' own Ctrl+K listener stands down while a cell edit owns
//          the keyboard, and still takes the key when nothing is being edited.
// CONTEXT: Fix round 4, F2. The listener's text-field tag list could not see a
//          floating grid's live cell edit PARKED with the keyboard on the grid
//          container, where Ctrl+K opened Insert Hyperlink for Core's hidden
//          active cell. The handler claims the key (preventDefault) only when
//          it goes on to act, so defaultPrevented is the witness here.

import { describe, it, expect, afterEach } from "vitest";

import { handleKeyDown } from "../index";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

function focus(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  el.focus();
  return el;
}
function gridContainer(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = 0;
  return el;
}
function startFloatingGridEdit(): void {
  cleanups.push(
    registerExternalFormulaTarget({
      isExpectingReference: () => false,
      insertReference: () => undefined,
      session: {} as never,
    }),
  );
}
async function ctrlK(): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: document.activeElement ?? document.body });
  await handleKeyDown(e);
  return e;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Hyperlinks Ctrl+K while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, PARKED with the keyboard on the grid container: the key is left alone", async () => {
    startFloatingGridEdit();
    focus(gridContainer());
    expect((await ctrlK()).defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit with the keyboard momentarily on the grid: the key is left alone", async () => {
    setGlobalIsEditing(true);
    focus(gridContainer());
    expect((await ctrlK()).defaultPrevented).toBe(false);
  });

  it("the formula bar focused (unchanged: a text field): the key is left alone", async () => {
    focus(document.createElement("input"));
    expect((await ctrlK()).defaultPrevented).toBe(false);
  });

  it("positive control: nothing being edited, grid focused -> Ctrl+K is taken", async () => {
    focus(gridContainer());
    expect((await ctrlK()).defaultPrevented).toBe(true);
  });
});

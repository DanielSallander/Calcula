//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/argumentHint.test.tsx
// PURPOSE: The function screen tip is a live answer to "which argument am I
//          standing in", and the card carrying that answer is usable: its
//          parameters select their argument in the editor, and it can be
//          dragged off the cells it is covering.
//
// CONTEXT: Everything the card DISPLAYS was already right — the innermost open
//          call, the bolded active argument, the optional-parameter label. What
//          was wrong is that the store only ever heard about a value CHANGE, so
//          none of that logic re-ran when the caret moved: arrowing from an
//          outer call into a nested one left the previous function's tip on
//          screen, and an edit opened on an existing formula got no tip at all.
//
//          The dropdown is the opposite case and is why the caret report cannot
//          simply be treated as typing: it is an as-you-type affordance, and a
//          list that opened because the caret moved would swallow the next
//          Enter (the editors route Enter to the dropdown whenever it is up) and
//          insert a function instead of committing the cell.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FunctionInfo } from "@api/types";

// Hoisted: the mock factory below runs while this module's own imports are
// still being evaluated, so a plain `const` declared here would not exist yet.
const { CATALOG } = vi.hoisted(() => ({
  CATALOG: {
    SUM: {
      name: "SUM",
      syntax: "SUM(number1, [number2], ...)",
      description: "Adds its arguments.",
      category: "Math",
    },
    ROUND: {
      name: "ROUND",
      syntax: "ROUND(number, num_digits)",
      description: "Rounds a number to a given number of digits.",
      category: "Math",
    },
    VLOOKUP: {
      name: "VLOOKUP",
      syntax: "VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])",
      description: "Looks up a value in the first column of a range.",
      category: "Lookup",
    },
  } as Record<string, FunctionInfo>,
}));

vi.mock("../../_shared/lib/functionCatalog", () => ({
  getFunctionByName: (name: string) => CATALOG[name.toUpperCase()],
  filterSuggestions: (token: string) =>
    Object.values(CATALOG)
      .filter((f) => f.name.startsWith(token.toUpperCase()))
      .map((f) => ({
        kind: "function" as const,
        name: f.name,
        info: f,
        matchRanges: [[0, token.length]] as Array<[number, number]>,
        score: 1,
      })),
  loadFunctionCatalog: async () => [],
  loadNamedRanges: async () => {},
}));

import { useAutocompleteStore } from "./useAutocompleteStore";
import { FormulaAutocompleteOverlay } from "./FormulaAutocompleteOverlay";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const ANCHOR = { x: 100, y: 200, width: 300, height: 20 };

/** What an editor reports: the text it holds and where the caret is in it. */
function report(value: string, cursorPosition: number): void {
  useAutocompleteStore.getState().handleInput({
    value,
    cursorPosition,
    anchorRect: ANCHOR,
    source: "inline",
  });
}

describe("the screen tip follows the CARET, not just the text", () => {
  beforeEach(() => {
    useAutocompleteStore.getState().reset();
  });

  it("shows a tip for an edit opened on an existing formula, with no keystroke", () => {
    report("=VLOOKUP(A1,B:C,2,FALSE)", 10);

    const s = useAutocompleteStore.getState();
    expect(s.argumentHintVisible).toBe(true);
    expect(s.argumentHintFunction?.name).toBe("VLOOKUP");
    expect(s.argumentHintIndex).toBe(0);
  });

  it("switches to the innermost call when the caret moves into a nested one", () => {
    const value = "=ROUND(SUM(A1,B1),2)";

    report(value, value.indexOf("SUM"));
    expect(useAutocompleteStore.getState().argumentHintFunction?.name).toBe("ROUND");

    // Not one character of the formula changes here — only where the caret is.
    report(value, value.indexOf("B1"));
    const inner = useAutocompleteStore.getState();
    expect(inner.argumentHintFunction?.name).toBe("SUM");
    expect(inner.argumentHintIndex).toBe(1);

    // ...and back out again, once the caret leaves the nested call.
    report(value, value.length - 2);
    expect(useAutocompleteStore.getState().argumentHintFunction?.name).toBe("ROUND");
  });

  it("does not open the suggestion list for a caret that merely moved", () => {
    const value = "=ROUND(SUM(A1),2)";
    report("=", 1);
    report(value, value.length);

    // The caret lands just after the nested name, where the token behind it is
    // a complete function name the filter would happily offer completions for.
    // The list must stay shut: the editors route Enter to it whenever it is up,
    // so a list opened by a caret would insert a function in place of
    // committing the cell.
    report(value, value.indexOf("SUM") + 3);

    const s = useAutocompleteStore.getState();
    expect(s.visible, "a caret move opened the function list under the formula").toBe(false);
    expect(s.argumentHintVisible).toBe(true);
    expect(s.argumentHintFunction?.name).toBe("ROUND");
  });

  it("still opens the suggestion list for a name being typed", () => {
    // Positive control: the caret rule must not have switched the list off.
    report("=", 1);
    report("=SU", 3);

    const s = useAutocompleteStore.getState();
    expect(s.visible).toBe(true);
    expect(s.items.map((i) => i.name)).toContain("SUM");
  });

  it("leaves an open list alone when the caret is reported after the keystroke", () => {
    // Every editor reports the caret on keyup as well as the text on input, so
    // the keystroke that opens the list is followed immediately by a same-value
    // report. A rule that closed the list on that report would close it one
    // keystroke after every keystroke that opened it.
    report("=", 1);
    report("=SU", 3);
    report("=SU", 3);

    expect(useAutocompleteStore.getState().visible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The card itself
// ---------------------------------------------------------------------------

let host: HTMLDivElement;
let root: Root;
let editor: HTMLInputElement;

function renderOverlay(): void {
  act(() => {
    root.render(<FormulaAutocompleteOverlay onClose={() => {}} />);
  });
}

function card(): HTMLElement {
  const el = host.querySelector('[data-testid="formula-argument-hint"]');
  if (!el) throw new Error("the argument hint card did not render");
  return el as HTMLElement;
}

/** The rendered parameter with this exact name, as the user would click it. */
function parameter(name: string): HTMLElement {
  const match = Array.from(card().querySelectorAll("span")).find(
    (el) => el.textContent === name
  );
  if (!match) throw new Error(`the card renders no parameter named "${name}"`);
  return match as HTMLElement;
}

function press(el: EventTarget, type: string, clientX = 0, clientY = 0): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

describe("the tip card is something you can use, not just read", () => {
  beforeEach(() => {
    useAutocompleteStore.getState().reset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    // A stand-in for whichever formula editor is live. The card finds it as
    // `document.activeElement`, which is exactly why the same handler serves
    // the grid editor, the formula bar and the dialogs alike.
    editor = document.createElement("input");
    editor.type = "text";
    editor.value = "=VLOOKUP(A1,B:C,2,FALSE)";
    document.body.appendChild(editor);
    editor.focus();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    editor.remove();
  });

  it("selects an argument's text in the editor when its parameter is clicked", () => {
    report(editor.value, 10);
    renderOverlay();

    press(parameter("table_array"), "mousedown", 120, 260);

    expect(editor.selectionStart).toBe(editor.value.indexOf("B:C"));
    expect(editor.selectionEnd).toBe(editor.value.indexOf("B:C") + "B:C".length);
  });

  it("keeps the edit alive when a parameter is clicked", () => {
    report(editor.value, 10);
    renderOverlay();

    const event = press(parameter("lookup_value"), "mousedown", 120, 260);

    // The press must be refused its default action: the browser would otherwise
    // move focus to the card, and the blur would commit the cell out from under
    // the click.
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  it("moves to where it is dragged and stays there", () => {
    report(editor.value, 10);
    renderOverlay();

    const start = { left: card().style.left, top: card().style.top };
    expect(start.left).toBe("100px");

    const grab = press(card(), "mousedown", 400, 300);
    press(window, "mousemove", 460, 340);
    press(window, "mouseup", 460, 340);

    expect(grab.defaultPrevented, "dragging the card blurred the editor").toBe(true);
    expect(document.activeElement).toBe(editor);
    expect(card().style.left).toBe("160px");
    expect(card().style.top).toBe(`${parseFloat(start.top) + 40}px`);

    // The card stays put once released: a further pointer move is not a drag.
    press(window, "mousemove", 900, 900);
    expect(card().style.left).toBe("160px");
  });

  it("goes back under the editor for the next edit", () => {
    report(editor.value, 10);
    renderOverlay();
    press(card(), "mousedown", 400, 300);
    press(window, "mousemove", 460, 340);
    press(window, "mouseup", 460, 340);
    expect(card().style.left).toBe("160px");

    // The edit ends; the card a user shoved aside belongs to the call they
    // shoved it aside for, not to the next one.
    act(() => {
      useAutocompleteStore.getState().reset();
    });
    report(editor.value, 10);
    renderOverlay();

    expect(card().style.left).toBe("100px");
  });
});

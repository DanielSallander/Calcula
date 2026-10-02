//! FILENAME: app/extensions/Controls/__tests__/heldButtonCodeUi.test.tsx
// PURPOSE: A button whose code is HELD (BUG-0257): a click is the Rust door's
//          to answer (phase 4) and the page's no-op diagnosis never speaks for
//          it, the Properties pane shows the code read-only and says what a
//          click does with it by the door's rule, tabbing through the code
//          field writes nothing, and replacing the code -- or making it the
//          author's own -- is a deliberate step that shows it first and fails
//          closed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const confirmAsync = vi.fn();
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => confirmAsync(...a),
}));

import { diagnoseButtonClick } from "../lib/buttonClickDiagnosis";
import { PropertyRow, isUnchangedCommit } from "../PropertiesPane/PropertyRow";
import {
  HeldCodeSection,
  describeHeldAdoption,
  describeHeldReplacement,
  requestHeldAdoption,
  requestHeldReplacement,
  type HeldAdoptionShown,
} from "../PropertiesPane/HeldCodeSection";
import { adoptHeldButtonCode } from "../lib/controlApi";
import { controlsBackend } from "../lib/controlsBackend";
import { BUTTON_PROPERTIES } from "../lib/types";
import { heldInlineVerdict, type HeldButtonCode } from "@api/heldButtonCode";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const STAMP = JSON.stringify({ workspace: "ws", application: "Sales", version: "1.2.0" });

/** Inline code AND a macro link: the link wins a click (the door's precedence). */
const held: HeldButtonCode = {
  application: "Sales",
  version: "1.2.0",
  onSelect: "Report();",
  macroRef: "macro-report",
};
const heldVerdict = heldInlineVerdict("button", {
  heldOnSelect: { valueType: "static", value: "Report();" },
  heldMacroRef: { valueType: "static", value: "macro-report" },
  heldFrom: { valueType: "static", value: STAMP },
});

/** Inline code only, static, under a stamp Rust can read: approvable. */
const heldInline: HeldButtonCode = { application: "Sales", version: "1.2.0", onSelect: "Report();", macroRef: null };
const heldInlineRuns = heldInlineVerdict("button", {
  heldOnSelect: { valueType: "static", value: "Report();" },
  heldFrom: { valueType: "static", value: STAMP },
});

/** Every backend command the page sent through the Controls channel. */
const sent: { cmd: string; args: unknown }[] = [];
controlsBackend.set(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  sent.push({ cmd, args });
  return { controlType: "button", properties: {} } as T;
});
const adoptSent = () => sent.filter((c) => c.cmd === "adopt_held_button_code");

/** The pane's own wiring, minus React state: the shown texts straight to Rust. */
const adoptThroughBackend = (shown: HeldAdoptionShown) =>
  adoptHeldButtonCode(0, 2, 1, shown.onSelect, shown.macroRef).then(() => undefined);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  confirmAsync.mockReset();
  sent.length = 0;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
});

describe("a click on a held button", () => {
  // Phase 4 of BUG-0257: the Rust door answers a click on a button holding an
  // application's code -- it RUNS approved bytes and REFUSES the rest in its
  // own words (controlActionDoor.test.ts, heldButtonCodeWiring.test.tsx). The
  // page's diagnosis speaks only when the door answered `nothing`, so it has
  // no sentence of its own about held code: a page sentence claiming held
  // code "does not run" would contradict an approved click that just ran.
  //
  // SABOTAGE: give diagnoseButtonClick a held-code branch again (import
  // @api/heldButtonCode there) -> red.
  it("the no-op diagnosis knows nothing about held code", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../lib/buttonClickDiagnosis.ts"), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("@api/heldButtonCode");
    expect(code).not.toMatch(/\bheld\b/);
  });

  it("stays out of the way when an object script owns the click", () => {
    const script = { id: "s", name: "Macro" };
    expect(diagnoseButtonClick({ ranInline: false, script, mounted: true, hasClickHandler: true })).toBeNull();
  });
});

describe("THE TAB-THROUGH: an unchanged commit writes nothing", () => {
  it("compares against what the row shows, default included", () => {
    expect(isUnchangedCommit("", undefined, "")).toBe(true);
    expect(isUnchangedCommit("Go", { valueType: "static", value: "Go" }, "Button")).toBe(true);
    expect(isUnchangedCommit("Button", undefined, "Button")).toBe(true);
    expect(isUnchangedCommit("Mine();", undefined, "")).toBe(false);
    // A static "=" value shows with its escape; committing that display is no change.
    expect(isUnchangedCommit("'=x", { valueType: "static", value: "=x" }, "")).toBe(true);
  });

  // The field that erased the application's code: OnSelect reads "" on a held
  // button and commits on blur.
  //
  // SABOTAGE: remove the `isUnchangedCommit` early return in PropertyRow.handleCommit.
  it("focusing and leaving the empty OnSelect field of a held button does not write", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onSelectDef = BUTTON_PROPERTIES.find((d) => d.key === "onSelect")!;
    await act(async () => {
      root.render(<PropertyRow definition={onSelectDef} value={undefined} scripts={[]} onChange={onChange} />);
    });
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the held code in the Properties pane", () => {
  it("shows the code verbatim, read-only, and the macro it links", async () => {
    await act(async () => {
      root.render(<HeldCodeSection held={held} inlineVerdict={heldVerdict} onReplace={() => undefined} />);
    });
    expect(host.querySelector("[data-held-code='onSelect']")!.textContent).toBe("Report();");
    expect(host.querySelector("[data-held-code='macroRef']")!.textContent).toContain("macro-report");
    expect(host.querySelector("textarea, input")).toBeNull();
    expect(host.textContent).toContain("'Sales' (v1.2.0)");
  });

  // Phase 4 of BUG-0257: held INLINE code travels with its application and runs
  // through the Rust door once the approval screen has shown its exact bytes.
  // The note says that -- and, by the door's own rule, when no click can run
  // it (here: the link wins). It never says "inert": an approved click runs.
  //
  // SABOTAGE: render the old "Inline code: inert here, published unchanged."
  // note in HeldCodeSection -> red.
  it("says held inline code runs after approval -- or, by the door's rule, why it never runs", async () => {
    await act(async () => {
      root.render(<HeldCodeSection held={heldInline} inlineVerdict={heldInlineRuns} onReplace={() => undefined} />);
    });
    expect(host.querySelector("[data-held-code-note='onSelect']")!.textContent).toBe(
      "Runs when clicked, after you approve the application's code.",
    );
    expect(host.textContent).not.toMatch(/inert/i);

    await act(async () => {
      root.render(<HeldCodeSection held={held} inlineVerdict={heldVerdict} onReplace={() => undefined} />);
    });
    expect(host.querySelector("[data-held-code-note='onSelect']")!.textContent).toBe(
      "Never runs here: the button links a macro, and a click runs the link instead.",
    );
    expect(host.querySelector("[data-held-code='macroRef']")!.textContent).toBe(
      "Runs the application's macro macro-report when clicked, only after you approve the application's code.",
    );
    expect(host.textContent).not.toMatch(/inert/i);
    // The section no longer claims the whole button "does not run".
    expect(host.textContent).not.toMatch(/It does not\s+run in this working copy/);
  });

  // The replace step shows the code FIRST and fails closed. The double is the
  // Tauri shape (a Promise), never a synchronous boolean.
  //
  // SABOTAGE: call `onReplace()` without awaiting the confirm.
  it("unlocks OnSelect only after an explicit yes that showed the code", async () => {
    const onReplace = vi.fn();
    await act(async () => {
      root.render(<HeldCodeSection held={held} inlineVerdict={heldVerdict} onReplace={onReplace} />);
    });
    const button = host.querySelector<HTMLButtonElement>("[data-held-replace]")!;

    confirmAsync.mockReturnValue(Promise.resolve(false));
    await act(async () => {
      button.click();
    });
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(String(confirmAsync.mock.calls[0][0])).toContain("Report();");
    expect(onReplace).not.toHaveBeenCalled();

    confirmAsync.mockReturnValue(Promise.resolve(true));
    await act(async () => {
      button.click();
    });
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it("the confirm text carries the held code and what replacing it does", async () => {
    const text = describeHeldReplacement(held);
    expect(text).toContain("OnSelect:\nReport();");
    expect(text).toContain('Runs the macro "macro-report"');
    expect(text).toMatch(/next push publishes YOUR code/);
    // Phase 4: a subscriber holds code too, and an update puts it back.
    expect(text).toContain("in a subscribed workbook, the application's next update puts its own button back");
    const confirm = vi.fn(() => Promise.resolve(false));
    await expect(requestHeldReplacement(held, confirm)).resolves.toBe(false);
  });
});

// ============================================================================
// "Make this my own" (phase 4 of BUG-0257): the one way an application's
// button code becomes the author's own. It shows the code first (confirmAsync,
// awaited, failing closed), then asks Rust to MOVE exactly the texts it showed.
// ============================================================================

describe("Make this my own", () => {
  async function renderAdoptable(code: HeldButtonCode, verdict = heldVerdict): Promise<HTMLButtonElement> {
    await act(async () => {
      root.render(
        <HeldCodeSection held={code} inlineVerdict={verdict} onReplace={() => undefined} onAdopt={adoptThroughBackend} />,
      );
    });
    const button = host.querySelector<HTMLButtonElement>("[data-held-adopt]");
    expect(button, "no Make this my own step on a held button").not.toBeNull();
    expect(button!.textContent).toBe("Make this my own…");
    return button!;
  }

  // SABOTAGE: drop the `await` before `requestHeldAdoption(held)` in
  // HeldCodeSection (a Promise is truthy) -> the "false" answer adopts -> red.
  it("asks Rust only after an explicit yes: a no sends nothing", async () => {
    const button = await renderAdoptable(held);
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await act(async () => {
      button.click();
    });
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(String(confirmAsync.mock.calls[0][0])).toContain("OnSelect:\nReport();");
    expect(adoptSent(), "adopted without a yes").toEqual([]);
    expect(button.disabled, "the step stayed locked after a no").toBe(false);
  });

  // SABOTAGE: send `{ onSelect: held.onSelect }` only (drop the link), or a
  // value other than the shown text -> red.
  it("a yes sends EXACTLY the texts the dialog showed, null for a slot it did not show", async () => {
    let button = await renderAdoptable(held);
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await act(async () => {
      button.click();
    });
    expect(adoptSent()).toEqual([
      {
        cmd: "adopt_held_button_code",
        args: { sheetIndex: 0, row: 2, col: 1, shownOnSelect: "Report();", shownMacroRef: "macro-report" },
      },
    ]);

    sent.length = 0;
    button = await renderAdoptable(heldInline, heldInlineRuns);
    await act(async () => {
      button.click();
    });
    expect(adoptSent()).toEqual([
      {
        cmd: "adopt_held_button_code",
        args: { sheetIndex: 0, row: 2, col: 1, shownOnSelect: "Report();", shownMacroRef: null },
      },
    ]);
  });

  // The dialog may be open while the held code changes (Ctrl+Z, a refresh).
  // What goes to Rust is what the author SAW, captured before the dialog was
  // asked; Rust compares it with the store and refuses a change.
  //
  // SABOTAGE: read the held texts AFTER the confirm resolves (a ref to the
  // latest `held`) in HeldCodeSection -> the newer code is sent -> red.
  it("sends what was shown even when the held code changed while the dialog was open", async () => {
    const button = await renderAdoptable(heldInline, heldInlineRuns);
    let answer!: (yes: boolean) => void;
    confirmAsync.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
    await act(async () => {
      button.click();
    });
    expect(String(confirmAsync.mock.calls[0][0])).toContain("OnSelect:\nReport();");
    // The held code changes under the open dialog.
    await act(async () => {
      root.render(
        <HeldCodeSection
          held={{ ...heldInline, onSelect: "Exfiltrate();" }}
          inlineVerdict={heldInlineRuns}
          onReplace={() => undefined}
          onAdopt={adoptThroughBackend}
        />,
      );
    });
    await act(async () => {
      answer(true);
    });
    expect(adoptSent().map((c) => (c.args as Record<string, unknown>).shownOnSelect)).toEqual(["Report();"]);
  });

  // SABOTAGE: drop the try/catch in requestHeldAdoption -> the rejection
  // escapes (and the step never says "no") -> red.
  it("a dialog that rejects, or answers anything but true, is a refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const button = await renderAdoptable(held);
      confirmAsync.mockReturnValue(Promise.reject(new Error("dialog plugin unavailable")));
      await act(async () => {
        button.click();
      });
      expect(adoptSent(), "a rejected dialog adopted").toEqual([]);
      expect(button.disabled).toBe(false);

      // A truthy non-boolean is not a yes.
      const odd = vi.fn(() => Promise.resolve("yes" as unknown as boolean));
      await expect(requestHeldAdoption(held, odd)).resolves.toBe(false);
      await expect(requestHeldAdoption(held, () => Promise.reject(new Error("x")))).resolves.toBe(false);
      await expect(requestHeldAdoption(held, () => Promise.resolve(true))).resolves.toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("is offered only where the pane wires it", async () => {
    await act(async () => {
      root.render(<HeldCodeSection held={held} inlineVerdict={heldVerdict} onReplace={() => undefined} />);
    });
    expect(host.querySelector("[data-held-adopt]")).toBeNull();
  });

  // The confirm says what adopting MEANS, beside the code it shows: whose code
  // it becomes, what still needs the application's approval, what a push and
  // an update do, the undo and the audit row.
  it("the confirm text shows the code and what making it your own means", async () => {
    const text = describeHeldAdoption(held);
    expect(text.startsWith("This button's code came with the application 'Sales' (v1.2.0):")).toBe(true);
    expect(text).toContain("OnSelect:\nReport();");
    expect(text).toContain('Runs the macro "macro-report".');
    expect(text).toContain("becomes YOUR code: a click runs it without asking for the application's approval");
    // An adopted LINK still runs the application's macro, which the run gate
    // still asks the approval of: the dialog must not promise otherwise.
    expect(text).toContain(
      "The macro it runs stays the application's, and still runs only after you approve the application's code.",
    );
    expect(text).toContain(
      "In a working copy, the next push publishes it as YOUR code, and asks you to review it first if it " +
        "differs from the signed version.",
    );
    expect(text).toContain("In a subscribed workbook, the application's next update puts its own button back.");
    expect(text).toContain("Ctrl+Z brings the application's code back.");
    expect(text).toContain("recorded in the audit trail");

    const inlineOnly = describeHeldAdoption(heldInline);
    expect(inlineOnly).not.toContain("Runs the macro");
    expect(inlineOnly).toContain(
      "A macro of the application that it calls stays the application's, and still runs only after you " +
        "approve the application's code.",
    );

    const confirm = vi.fn((_m: string, _o?: { title?: string; kind?: string; okLabel?: string }) =>
      Promise.resolve(false),
    );
    await requestHeldAdoption(held, confirm);
    expect(confirm).toHaveBeenCalledWith(text, {
      title: "Make the application's code your own",
      kind: "warning",
      okLabel: "Make it my own",
    });
  });
});

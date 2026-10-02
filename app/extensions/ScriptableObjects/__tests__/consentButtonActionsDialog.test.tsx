//! FILENAME: app/extensions/ScriptableObjects/__tests__/consentButtonActionsDialog.test.tsx
// PURPOSE: M6 (phase 4 of BUG-0257), S9: the approval screen shows every button
//          action's CODE, verbatim, and every place it sits -- never a hash or
//          a summary in place of the code -- says which of the application's
//          macros a `Name()` runs, says when an approval stored in the workbook
//          was made on another computer, and Allow still answers the screen it
//          came from.
// CONTEXT: The payload is built by the one emitter
//          (ScriptableObjects/index.ts emitPackageConsentPrompt; wiring pinned in
//          packageConsentLoadPath.test.ts). This file covers the painting.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const emitted = vi.hoisted(() => [] as Array<{ name: string; detail: unknown }>);

vi.mock("@api/scriptEditorService", () => ({
  requireScriptEditorProvider: () => ({
    openMacroInEditor: async () => undefined,
    openDraftInEditor: async () => undefined,
  }),
}));
vi.mock("@api/events", () => ({
  emitAppEvent: (name: string, detail: unknown) => {
    emitted.push({ name, detail });
  },
}));

import ScriptConsentDialog from "../components/ScriptConsentDialog";
import type { ConsentButtonAction } from "../lib/consentButtonActions";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const CODE_A = "Calcula.setCellValue('Dashboard!A1', 'refreshed');\nCalcula.log('done');";

const ACTION_A: ConsentButtonAction = {
  id: `buttonAction:${HASH_A}`,
  hash: HASH_A,
  source: CODE_A,
  locations: [
    { cell: "Dashboard!B4", caption: "Run report" },
    { cell: "Sheet2!C3", caption: "" },
  ],
  runsMacro: null,
  refusedBecause: null,
};

const ACTION_B: ConsentButtonAction = {
  id: `buttonAction:${HASH_B}`,
  hash: HASH_B,
  source: "Report();",
  locations: [{ cell: "Dashboard!B6", caption: "Report" }],
  runsMacro: "Report",
  refusedBecause: null,
};

const BASE = {
  promptId: "consent-7",
  packageName: "Sales",
  scriptCount: 0,
  scriptNames: [],
  scriptIds: [],
  moduleScriptNames: [],
  moduleScriptIds: [],
  unapprovableMacroNames: [],
  requestedCapabilities: [],
  changedScripts: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  emitted.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(data: Record<string, unknown>, onClose: () => void = () => undefined): void {
  act(() => {
    root.render(React.createElement(ScriptConsentDialog, { onClose, data } as never));
  });
}

/** The dialog box (not the overlay): its width says one or two columns. */
function dialogBox(): HTMLElement {
  return container.firstElementChild!.firstElementChild as HTMLElement;
}

describe("the button actions are shown as code, with every place they sit", () => {
  // SABOTAGE: render `action.hash` (or the id) in the <pre> instead of
  // `action.source` (components/ScriptConsentDialog.tsx) -> red.
  it("renders each action's code VERBATIM -- line breaks and quotes included", () => {
    render({ ...BASE, buttonActions: [ACTION_A, ACTION_B] });
    const pre = container.querySelector<HTMLPreElement>(`[data-consent-button-action='${HASH_A}']`)!;
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toBe(CODE_A);
    expect(container.querySelector(`[data-consent-button-action='${HASH_B}']`)!.textContent).toBe("Report();");
    expect(container.textContent).toContain("Button actions (2)");
  });

  // SABOTAGE: drop the locations block -> red.
  it("names EVERY place each one sits, with its caption", () => {
    render({ ...BASE, buttonActions: [ACTION_A] });
    const where = container.querySelector(`[data-consent-button-action-locations='${HASH_A}']`)!;
    expect(where.textContent).toContain("On 2 buttons:");
    expect(where.textContent).toContain('Dashboard!B4 "Run report"');
    expect(where.textContent).toContain("Sheet2!C3");
    expect(where.querySelectorAll("li")).toHaveLength(2);
  });

  it("says which of the application's macros a Name() runs, and why one will be refused", () => {
    render({
      ...BASE,
      buttonActions: [
        ACTION_B,
        { ...ACTION_A, refusedBecause: "it calls the macro Report by name, and Report runs as an object script" },
      ],
    });
    expect(container.querySelector(`[data-consent-button-action-runs='${HASH_B}']`)!.textContent).toBe(
      "Runs the application's macro Report.",
    );
    expect(container.querySelector(`[data-consent-button-action-refused='${HASH_A}']`)!.textContent).toContain(
      "Will not run even if you allow it: it calls the macro Report by name",
    );
  });

  it("introduces an application whose only code is its buttons' -- with no '0 object scripts'", () => {
    render({ ...BASE, buttonActions: [ACTION_A] });
    const text = container.textContent ?? "";
    expect(text).toContain('The package "Sales" put buttons in this workbook that carry code of their own');
    expect(text).toContain("it runs only after this approval, only when its button is clicked");
    expect(text).toContain("never mixed with yours");
    expect(text).not.toContain("0 object script");
    // The reach paragraph is the interpreter's, named for button actions.
    expect(text).toContain("A button action is not an object script and does not run in that realm");
    expect(text).toContain("no network, no files, no BI data");
    expect(text).not.toContain("restricted mode");
  });

  it("shows no button-action heading at all when there are none", () => {
    render({ ...BASE, scriptCount: 1, scriptNames: ["Refresh"], scriptIds: ["obj-1"] });
    expect(container.querySelector("[data-consent-button-actions]")).toBeNull();
    expect(container.textContent).not.toContain("Button actions");
    expect(container.textContent).not.toContain("A button action is not an object script");
  });

  // SABOTAGE: drop `buttonActions.length > 0 ||` from `twoColumn` -> the light
  // 460px column.
  //
  // The two-column layout is read from its pane titles, which render only
  // then: jsdom cannot parse the wide width's CSS `min()`, so the width alone
  // would keep its old value and prove nothing.
  it("one button action alone makes the dialog two columns", () => {
    render({ ...BASE, scriptCount: 1, scriptNames: ["Refresh"], scriptIds: ["obj-1"] });
    expect(dialogBox().style.width).toBe("460px");
    expect(container.textContent).not.toContain("What is in this application");
    act(() => root.unmount());
    root = createRoot(container);
    render({ ...BASE, scriptCount: 1, scriptNames: ["Refresh"], scriptIds: ["obj-1"], buttonActions: [ACTION_A] });
    expect(container.textContent).toContain("What is in this application");
    expect(container.textContent).toContain("What allowing permits");
    expect(dialogBox().style.width).not.toBe("460px");
  });

  it("names items whose id sits in the button-action namespace as unapprovable", () => {
    render({ ...BASE, scriptCount: 1, scriptNames: ["Fine"], scriptIds: ["obj-1"], reservedIdNames: ["Sneaky"] });
    expect(container.textContent).toContain("use an id Calcula reserves for button code");
    expect(container.textContent).toContain("Sneaky");
  });
});

describe("an approval that does not count here is said", () => {
  // SABOTAGE: drop the approvalMadeElsewhere block -> red.
  it("shows the 'another computer' line when the workbook carries an approval made elsewhere", () => {
    render({ ...BASE, buttonActions: [ACTION_A], approvalMadeElsewhere: true });
    const line = container.querySelector("[data-consent-approval-elsewhere]")!;
    expect(line.textContent).toContain("made on another computer, or before approvals were tied to a computer");
    expect(line.textContent).toContain("does not count here");
  });

  it("...and not otherwise", () => {
    render({ ...BASE, buttonActions: [ACTION_A] });
    expect(container.querySelector("[data-consent-approval-elsewhere]")).toBeNull();
    expect(container.textContent).toContain("Allowing is remembered with this workbook on this computer only");
  });
});

describe("Allow still answers the screen it came from", () => {
  it("emits consent-granted with the promptId, and closes", () => {
    const onClose = vi.fn();
    render({ ...BASE, buttonActions: [ACTION_A] }, onClose);
    const allow = [...container.querySelectorAll("button")].find((b) => b.textContent === "Allow Scripts")!;
    act(() => allow.click());
    expect(emitted).toEqual([
      { name: "scriptable-objects:consent-granted", detail: { packageName: "Sales", promptId: "consent-7" } },
    ]);
    expect(onClose).toHaveBeenCalled();
  });
});

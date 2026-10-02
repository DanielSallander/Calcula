//! FILENAME: app/extensions/ScriptableObjects/__tests__/consentButtonsListing.test.tsx
// PURPOSE: Phase 3 of BUG-0257, the approval screen. A button control from an
//          application now keeps its link to the application's macro and one
//          click runs it once the application's code is approved -- the
//          approval this screen gives. So under each macro the screen names
//          the buttons THAT APPLICATION put in the workbook to run it
//          (Sheet!A1 + caption), and nothing else:
//            * another application's button naming the same macro id is not
//              listed (approving P arms only P's buttons);
//            * the user's own button, and a button whose stamp cannot be read,
//              are not listed as the application's;
//            * a macro with no such button shows no heading at all.
//          The emitter's wiring into the prompt payload is pinned in
//          packageConsentLoadPath.test.ts (it activates the real extension).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ButtonRunningMacro } from "@api/heldButtonCode";

vi.mock("@api/scriptEditorService", () => ({
  requireScriptEditorProvider: () => ({
    openMacroInEditor: async () => undefined,
    openDraftInEditor: async () => undefined,
  }),
}));
vi.mock("@api/events", () => ({ emitAppEvent: () => undefined }));

import ScriptConsentDialog from "../components/ScriptConsentDialog";
import {
  applicationButtons,
  collectMacroButtons,
  describeConsentMacroButton,
} from "../lib/consentMacroButtons";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const row = (over: Partial<ButtonRunningMacro>): ButtonRunningMacro => ({
  sheetIndex: 1,
  sheetName: "Dashboard",
  row: 1,
  col: 1,
  heldBy: "Sales",
  kind: "control",
  caption: "Run report",
  application: "Sales",
  ...over,
});

/** What the backend lists for `macro-report`: Sales' two buttons, and three that are not Sales'. */
const LISTED: ButtonRunningMacro[] = [
  row({}),
  row({ row: 4, col: 2, kind: "cell", caption: "Go", heldBy: null }),
  row({ row: 7, col: 0, caption: "Theirs", application: "Someone Else", heldBy: "Someone Else" }),
  row({ row: 8, col: 0, caption: "Mine", application: null, heldBy: null }),
  row({ row: 9, col: 0, caption: "Unreadable", application: null, heldBy: "an application" }),
];

describe("which buttons are the application's", () => {
  // SABOTAGE: drop the `row.application === pkg` filter in applicationButtons
  // (lib/consentMacroButtons.ts) -> another application's and the user's own
  // buttons are listed as armed by this approval.
  it("keeps only the buttons whose stamp names this application", () => {
    expect(applicationButtons("Sales", LISTED)).toEqual([
      { cell: "Dashboard!B2", caption: "Run report", kind: "control" },
      { cell: "Dashboard!C5", caption: "Go", kind: "cell" },
    ]);
  });

  it("collects per macro, omits a macro with none, and survives a listing failure", async () => {
    const list = vi.fn(async (id: string) => {
      if (id === "macro-broken") throw new Error("backend down");
      return id === "macro-report" ? LISTED : [row({ application: "Someone Else" })];
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await collectMacroButtons("Sales", ["macro-report", "macro-other", "macro-broken"], list);
      expect(Object.keys(out)).toEqual(["macro-report"]);
      expect(out["macro-report"]).toHaveLength(2);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads as the cell, the caption in quotes, and the kind when it is a cell", () => {
    expect(describeConsentMacroButton({ cell: "Dashboard!B2", caption: "Run report", kind: "control" })).toBe(
      'Dashboard!B2 "Run report"',
    );
    expect(describeConsentMacroButton({ cell: "Dashboard!C5", caption: "", kind: "cell" })).toBe(
      "Dashboard!C5 (button cell)",
    );
  });
});

describe("the approval screen lists them under the right macro", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(data: Record<string, unknown>): void {
    act(() => {
      root.render(React.createElement(ScriptConsentDialog, { onClose: () => undefined, data } as never));
    });
  }

  const PROMPT = {
    packageName: "Sales",
    scriptCount: 0,
    scriptNames: [],
    scriptIds: [],
    moduleScriptNames: ["Report", "Cleanup"],
    moduleScriptIds: ["macro-report", "macro-cleanup"],
    requestedCapabilities: [],
    changedScripts: [],
  };

  // SABOTAGE: remove the `data-consent-macro-buttons` block from the macro list
  // in ScriptConsentDialog.tsx -> the buttons are never named.
  it("names each button's cell and caption under its macro, and nothing under a macro with none", () => {
    render({
      ...PROMPT,
      macroButtons: {
        "macro-report": [
          { cell: "Dashboard!B2", caption: "Run report", kind: "control" },
          { cell: "Dashboard!C5", caption: "Go", kind: "cell" },
        ],
      },
    });
    const report = container.querySelector("[data-consent-macro='macro-report']")!;
    expect(report.textContent).toContain("Report");
    expect(report.textContent).toContain("Buttons that run this macro:");
    expect(report.textContent).toContain('Dashboard!B2 "Run report"');
    expect(report.textContent).toContain('Dashboard!C5 "Go" (button cell)');

    const cleanup = container.querySelector("[data-consent-macro='macro-cleanup']")!;
    expect(cleanup.textContent).toContain("Cleanup");
    expect(cleanup.textContent).not.toContain("Buttons that run this macro");
    expect(container.querySelectorAll("[data-consent-macro-buttons]")).toHaveLength(1);
  });

  it("shows no heading anywhere when the prompt carries no buttons (an older emitter)", () => {
    render(PROMPT);
    expect(container.textContent).not.toContain("Buttons that run this macro");
    expect(container.querySelectorAll("[data-consent-macro]")).toHaveLength(2);
  });
});

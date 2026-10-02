//! FILENAME: app/extensions/CellTypes/__tests__/buttonScriptAction.test.ts
// PURPOSE: The `calcula.button` cell's click names the BUTTON and nothing else
//          (phase 4 of BUG-0257).
// CONTEXT: This surface used to resolve the bound module on the page and run
//          `<module source>\n<fn>();` through `run_script` -- a composition that
//          equals no stored record, so the Rust consent gate read it as an
//          ad-hoc run and let a publisher's module through, and a free-text
//          "Function to call" went straight into the program. The decision now
//          lives in the Rust button door (`run_control_action`,
//          app/src-tauri/src/scripting/control_action.rs `plan_cell_action`;
//          its cases -- verbatim source, the user's own module with its call
//          appended, a publisher's module refused, a non-identifier refused --
//          are in control_action_tests.rs). This file proves the page hands the
//          door the cell and runs nothing of its own: no module read, no
//          composition, no `run_script`, whatever the cached params say.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  door: null as unknown,
  toasts: [] as { message: string; variant?: string }[],
}));

vi.mock("../../../src/api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return cmd === "run_control_action" ? h.door : undefined;
  },
}));
vi.mock("../../../src/api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/notifications")>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
}));
vi.mock("../../../src/api/designMode", () => ({ getDesignMode: () => false }));
vi.mock("../../../src/api/gridDispatch", () => ({ dispatchGridAction: () => {} }));
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  setSelection: (s: unknown) => s,
  // The active sheet a clicked button cell sits on: the click names it.
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 4 } }),
}));

import { buttonCellType } from "../types/button";
import { isCellReleaseClaim, type CellReleaseClaim } from "@api/cellClickInterceptors";

/**
 * An in-cell button's press is CLAIMED for its release (BUG-0258 design phase
 * 4: buttons act on release, sliding off cancels): nothing ran at the press.
 * Release it on the same cell, as Core's press session does.
 */
async function releaseOnTheButton(answer: unknown, row: number, col: number): Promise<void> {
  expect(isCellReleaseClaim(answer), "the button's press was not claimed for its release").toBe(true);
  await (answer as CellReleaseClaim).runAtRelease({ clientX: 0, clientY: 0, row, col });
}


async function clickButton(params: Record<string, unknown>): Promise<void> {
  const answer = await buttonCellType.onClick?.({
    row: 6,
    col: 2,
    value: "Go",
    params,
    event: { clientX: 0, clientY: 0 } as MouseEvent,
  } as never);
  await releaseOnTheButton(answer, 6, 2);
}

const ran = (screenUpdating = true) => ({
  kind: "ran",
  result: { type: "success", output: [], cellsModified: 0, durationMs: 1, screenUpdating },
  unavailable: [],
});

beforeEach(() => {
  h.calls.length = 0;
  h.toasts.length = 0;
  h.door = ran();
});

const doorRequests = () =>
  h.calls.filter((c) => c.cmd === "run_control_action").map((c) => (c.args as { request: Record<string, unknown> }).request);

describe("the calcula.button cell's click", () => {
  // SABOTAGE: put runButtonCell back on getWorkbookScript + runWorkbookScript
  // (compose `<source>\n<fn>();` on the page) -> run_script appears, red.
  it("asks the door about THIS cell -- and sends none of the action it cached", async () => {
    await clickButton({
      label: "Go",
      action: { kind: "script", scriptId: "s1", functionName: "Go(); __publisherPayload()" },
    });
    expect(doorRequests()).toHaveLength(1);
    const request = doorRequests()[0];
    expect({ kind: request.kind, sheetIndex: request.sheetIndex, row: request.row, col: request.col }).toEqual({
      kind: "cell",
      sheetIndex: 4,
      row: 6,
      col: 2,
    });
    expect(Object.keys(request).sort()).toEqual(["col", "kind", "row", "sheetIndex", "viewState"]);
    expect(JSON.stringify(request)).not.toContain("__publisherPayload");
    const sent = h.calls.map((c) => c.cmd);
    expect(sent, "the click composed and ran code on the page").not.toContain("run_script");
    expect(sent, "the click read the module on the page").not.toContain("get_script");
  });

  // REVIEW OF M6b: a run that left screenUpdating off repaints too -- Excel turns
  // screen updating back on when a macro ends, and a button cannot resume it.
  it("every run repaints, also one that left screenUpdating off", async () => {
    let repainted = 0;
    const onRefresh = () => {
      repainted += 1;
    };
    window.addEventListener("grid:refresh", onRefresh);
    try {
      await clickButton({ action: { kind: "script", scriptId: "s1" } });
      h.door = ran(false);
      await clickButton({ action: { kind: "script", scriptId: "s1" } });
    } finally {
      window.removeEventListener("grid:refresh", onRefresh);
    }
    expect(repainted).toBe(2);
    expect(h.toasts).toEqual([]);
  });

  it("a run that stopped with an error says so", async () => {
    h.door = { kind: "ran", result: { type: "error", message: "boom", output: [] }, unavailable: [] };
    await clickButton({ action: { kind: "script", scriptId: "s1" } });
    expect(h.toasts).toEqual([{ message: "Button script couldn't run: boom", variant: "error" }]);
  });

  it("the door's refusal is said in its own words (a non-identifier 'Function to call')", async () => {
    const message =
      "\"Go(); x()\" is not a function name, so this button will not run. The \"Function to call\" field takes a single name, e.g. RunReport.";
    h.door = { kind: "refused", reason: "notAFunctionName", message };
    await clickButton({ action: { kind: "script", scriptId: "s1", functionName: "Go(); x()" } });
    expect(h.toasts).toEqual([{ message, variant: "error" }]);
  });

  it("a door that failed outright is said, never thrown", async () => {
    h.door = null;
    await clickButton({ action: { kind: "script", scriptId: "s1" } });
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toMatch(/^Button script couldn't run: The button door returned no answer/);
  });
});

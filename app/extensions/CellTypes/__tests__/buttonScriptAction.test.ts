//! FILENAME: app/extensions/CellTypes/__tests__/buttonScriptAction.test.ts
// PURPOSE: The third copy of the same rule, at the `calcula.button` cell type.
//
// This surface never built a preamble, but it broke the SAME source match: with
// `action.functionName` set it ran `<module source>\n<fn>();`, which equals no
// stored record, so the Rust consent gate (`distributed_module_refusal`) read it
// as an ad-hoc run and allowed a publisher's module through. It also appended a
// free-text field straight into the program.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
}

const runWorkbookScript = vi.fn(async (_source: string, _filename: string) => ({
  type: "success" as const,
  output: [] as string[],
  cellsModified: 0,
  durationMs: 1,
  screenUpdating: true,
}));

const showToast = vi.fn();

let stored: StoredScript = {
  id: "s1",
  name: "Report",
  description: null,
  source: "",
  sourcePackage: null,
};

vi.mock("../../../src/api/workbookScripts", () => ({
  getWorkbookScript: async () => stored,
  runWorkbookScript: (source: string, filename: string) =>
    runWorkbookScript(source, filename),
}));

vi.mock("../../../src/api/notifications", () => ({
  showToast: (message: string, options?: unknown) => showToast(message, options),
}));

vi.mock("../../../src/api/designMode", () => ({ getDesignMode: () => false }));

vi.mock("../../../src/api/gridDispatch", () => ({ dispatchGridAction: () => {} }));

vi.mock("../../../src/api/grid", () => ({ setSelection: (s: unknown) => s }));

import { buttonCellType } from "../types/button";

async function clickButton(action: Record<string, unknown>): Promise<void> {
  const handled = await buttonCellType.onClick?.({
    row: 0,
    col: 0,
    value: "Go",
    params: { action },
    event: { clientX: 0, clientY: 0 } as MouseEvent,
  } as never);
  expect(handled).toBe(true);
}

beforeEach(() => {
  runWorkbookScript.mockClear();
  showToast.mockClear();
});

describe("the calcula.button cell type's script action", () => {
  it("runs a distributed module's stored source unchanged", async () => {
    stored = {
      id: "s1",
      name: "Report",
      description: null,
      source: "__publisherPayload();",
      sourcePackage: "SalesApp",
    };
    await clickButton({ kind: "script", scriptId: "s1" });

    // Byte-for-byte the stored record: the only shape the Rust gate can rule on.
    expect(runWorkbookScript).toHaveBeenCalledWith(
      "__publisherPayload();",
      "button_Report.js",
    );
  });

  it("refuses to append a call into a module that arrived in an application", async () => {
    stored = {
      id: "s1",
      name: "Report",
      description: null,
      source: "function Go() { __publisherPayload(); }",
      sourcePackage: "SalesApp",
    };
    await clickButton({ kind: "script", scriptId: "s1", functionName: "Go" });

    expect(runWorkbookScript).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain("SalesApp");
  });

  it("still appends the call for the user's own module", async () => {
    stored = {
      id: "s1",
      name: "Mine",
      description: null,
      source: "function Go() { Calcula.log(1); }",
      sourcePackage: null,
    };
    await clickButton({ kind: "script", scriptId: "s1", functionName: "Go" });

    expect(runWorkbookScript).toHaveBeenCalledWith(
      "function Go() { Calcula.log(1); }\nGo();",
      "button_Mine.js",
    );
  });

  it("refuses a functionName that is not an identifier", async () => {
    stored = {
      id: "s1",
      name: "Mine",
      description: null,
      source: "var a = 1;",
      sourcePackage: null,
    };
    await clickButton({
      kind: "script",
      scriptId: "s1",
      functionName: "Go(); __publisherPayload()",
    });

    expect(runWorkbookScript).not.toHaveBeenCalled();
    expect(showToast.mock.calls[0][0]).toContain("is not a function name");
  });
});

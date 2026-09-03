//! FILENAME: app/extensions/Controls/__tests__/buttonScriptRun.test.ts
// PURPOSE: Prove at the CLICK, not only at the planner, that an in-cell button
//          run no longer splices every workbook module together.
//
// Two properties, one click each:
//   * a hostile module body never reaches top level in the program that is run;
//   * a module that arrived in a .calp is never in that program at all — and
//     when the button's own code names one, the user is told rather than left
//     with an undefined function.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface StoredRecord {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
  loadError: string | null;
}

const runWorkbookScript = vi.fn(async (_source: string, _filename: string) => ({
  type: "success" as const,
  output: [] as string[],
  cellsModified: 0,
  durationMs: 1,
  screenUpdating: true,
}));

const showToast = vi.fn();

let records: StoredRecord[] = [];
let onSelectValue = "";

vi.mock("@api", () => ({
  runWorkbookScript: (source: string, filename: string) =>
    runWorkbookScript(source, filename),
}));

vi.mock("@api/notifications", () => ({
  showToast: (message: string, options?: unknown) => showToast(message, options),
}));

vi.mock("@api/workbookScripts", () => ({
  listWorkbookScriptRecords: async () => records,
}));

vi.mock("../lib/designMode", () => ({ getDesignMode: () => false }));

vi.mock("../lib/controlApi", () => ({
  getControlMetadata: async () => ({
    controlType: "button",
    properties: { onSelect: { kind: "static", value: onSelectValue } },
  }),
  removeControlMetadata: async () => {},
}));

vi.mock("../../../src/api/lib", () => ({
  getAllStyles: async () => [{}, { button: true }],
  getCell: async () => ({ styleIndex: 1 }),
  applyFormatting: async () => {},
}));

vi.mock("../../../src/api/grid", () => ({
  getGridStateSnapshot: () => ({ config: { activeSheet: 0 } }),
}));

import {
  buttonClickInterceptor,
  refreshStyleCache,
  resetButtonModuleNoticesForTest,
} from "../Button/interceptors";

/** A module body that closes its wrapper and puts its payload at top level. */
const ESCAPING_BODY = "} __payload(); function __pad() {";

function local(name: string, source: string): StoredRecord {
  return {
    id: `local-${name}`,
    name,
    description: null,
    source,
    sourcePackage: null,
    loadError: null,
  };
}

function fromPackage(name: string, source: string, app = "SalesApp"): StoredRecord {
  return {
    id: `pkg-${name}`,
    name,
    description: null,
    source,
    sourcePackage: app,
    loadError: null,
  };
}

async function clickTheButton(): Promise<void> {
  await refreshStyleCache();
  const consumed = await buttonClickInterceptor(0, 0, { clientX: 0, clientY: 0 });
  expect(consumed).toBe(true);
}

function sourceThatRan(): string {
  expect(runWorkbookScript).toHaveBeenCalledTimes(1);
  return runWorkbookScript.mock.calls[0][0];
}

beforeEach(() => {
  runWorkbookScript.mockClear();
  showToast.mockClear();
  resetButtonModuleNoticesForTest();
  records = [];
  onSelectValue = "";
});

describe("clicking an in-cell button", () => {
  it("composes the user's OWN modules, escaping body and all — that is not a boundary", async () => {
    // A body that closes its own wrapper used to be refused here, by a check
    // built on `new Function`. Both halves of that were wrong: the shipped
    // content-security policy has no 'unsafe-eval', so the constructor throws
    // in the real app and EVERY module would have been dropped from EVERY
    // button (jsdom enforces no CSP, which is why the check's tests passed);
    // and the escape only ever mattered for code the user did not write, which
    // is no longer composed at all — see the distributed case below, which is
    // where the boundary actually lives.
    records = [local("Evil", ESCAPING_BODY), local("Good", "Calcula.log('ok');")];
    onSelectValue = "Good();";

    await clickTheButton();

    const ran = sourceThatRan();
    expect(ran).toContain("function Good() {");
    // The user's own code, in the user's own workbook, runs.
    expect(ran).toContain("__payload");
    // ...and it was not silently withheld from them.
    expect(showToast).not.toHaveBeenCalled();
  });

  it("does not include a distributed module in a user-authored button's program", async () => {
    records = [
      local("Helper", "Calcula.log('mine');"),
      fromPackage("Report", "__publisherPayload();"),
    ];
    onSelectValue = "Helper();";

    await clickTheButton();

    const ran = sourceThatRan();
    expect(ran).toBe("function Helper() {\nCalcula.log('mine');\n}\nHelper();");
    expect(ran).not.toContain("__publisherPayload");
    // Nothing was hidden AND nothing irrelevant was announced.
    expect(showToast).not.toHaveBeenCalled();
  });

  it("tells the user when their inline code names a distributed module", async () => {
    records = [
      local("Helper", "Calcula.log('mine');"),
      fromPackage("Report", "__publisherPayload();"),
    ];
    onSelectValue = "Helper(); Report();";

    await clickTheButton();

    expect(sourceThatRan()).not.toContain("__publisherPayload");
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain("SalesApp");
  });

  it("runs a distributed module's stored source verbatim when the button invokes it", async () => {
    // The legitimate distributed case: the program handed to the runtime is
    // byte-for-byte the stored record, so the Rust consent gate can rule on it.
    records = [fromPackage("Report", "__publisherPayload();")];
    onSelectValue = "Report();";

    await clickTheButton();

    expect(runWorkbookScript).toHaveBeenCalledWith(
      "__publisherPayload();",
      "button_module_pkg-Report.js",
    );
  });
});

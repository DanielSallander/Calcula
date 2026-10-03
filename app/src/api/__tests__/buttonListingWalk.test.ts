//! FILENAME: app/src/api/__tests__/buttonListingWalk.test.ts
// PURPOSE: ONE walk of the workbook's controls and cell types serves all three
//          button listings (held button code, inline button actions,
//          application command buttons) -- and each listing gives the same
//          answer from the shared walk as from its own.
// CONTEXT: The status bar's code-and-scripts indicator needs all three on every
//          read of the file. Each used to walk every sheet on its own, so one
//          read cost get_all_controls twice and get_all_cell_types twice per
//          sheet -- about 600 backend round trips on a 150-sheet workbook,
//          repeated on every poll and every return to the window.

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "get_sheets") {
      return { sheets: [{ index: 0, name: "Data" }, { index: 1, name: "Dashboard" }] };
    }
    if (cmd === "get_all_controls") {
      if (args?.sheetIndex !== 1) return [];
      return [
        {
          sheetIndex: 1,
          row: 1,
          col: 1,
          metadata: {
            controlType: "button",
            properties: {
              text: { valueType: "static", value: "Mine" },
              onSelect: { valueType: "static", value: "Calcula.setCellValue('A1', 1);" },
            },
          },
        },
      ];
    }
    if (cmd === "get_all_cell_types") {
      if (args?.sheetIndex !== 1) return [];
      return [
        {
          sheetIndex: 1,
          row: 4,
          col: 2,
          typeId: "calcula.button",
          params: {
            label: "Refresh",
            action: { kind: "command", commandId: "reader.refresh" },
            fromApplication: { workspace: "ws", application: "Sales", version: "1.0.0" },
          },
        },
      ];
    }
    throw new Error(`unexpected ${cmd}`);
  },
}));

import {
  listApplicationCellCommands,
  listButtonInlineActions,
  listHeldButtonCode,
  readButtonListing,
} from "../heldButtonCode";

beforeEach(() => {
  calls.length = 0;
});

const count = (cmd: string): number => calls.filter((c) => c === cmd).length;

describe("one walk, three listings", () => {
  it("with a shared walk, every sheet's controls and cell types are read ONCE for all three", async () => {
    const listing = await readButtonListing();
    calls.length = 0;
    await listButtonInlineActions(listing);
    await listHeldButtonCode(listing);
    await listApplicationCellCommands(listing);
    expect(calls).toEqual([]);
  });

  it("the walk itself reads each sheet's controls and cell types once", async () => {
    await readButtonListing();
    expect(count("get_sheets")).toBe(1);
    expect(count("get_all_controls")).toBe(2);
    expect(count("get_all_cell_types")).toBe(2);
  });

  it("each listing answers the SAME from the shared walk as from its own", async () => {
    const listing = await readButtonListing();
    expect(await listButtonInlineActions(listing)).toEqual(await listButtonInlineActions());
    expect(await listHeldButtonCode(listing)).toEqual(await listHeldButtonCode());
    expect(await listApplicationCellCommands(listing)).toEqual(await listApplicationCellCommands());
    // ...and the fixture is not empty, so "the same" means something.
    expect((await listButtonInlineActions(listing)).map((a) => a.provenance)).toEqual(["local"]);
    expect((await listApplicationCellCommands(listing)).map((c) => c.commandId)).toEqual(["reader.refresh"]);
  });

  it("without a walk each listing reads only what it needs", async () => {
    await listButtonInlineActions();
    expect(count("get_all_cell_types")).toBe(0);
    calls.length = 0;
    await listApplicationCellCommands();
    expect(count("get_all_controls")).toBe(0);
  });

  it("a walk that skipped a kind is completed by the listing that needs it", async () => {
    const controlsOnly = await readButtonListing({ controls: true, cellTypes: false });
    calls.length = 0;
    expect((await listApplicationCellCommands(controlsOnly)).map((c) => c.commandId)).toEqual(["reader.refresh"]);
    expect(count("get_all_cell_types")).toBe(2);
    expect(count("get_all_controls")).toBe(0);
  });
});

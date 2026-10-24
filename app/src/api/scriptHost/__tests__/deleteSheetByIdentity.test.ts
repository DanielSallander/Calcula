//! FILENAME: app/src/api/scriptHost/__tests__/deleteSheetByIdentity.test.ts
// PURPOSE: The script door `api.deleteSheet(ref)` deletes the sheet the script
//          NAMED, never the one that slid into its index -- review
//          SCRIPT-DELETE-BY-STALE-INDEX.
// COVERS:  executeDeleteSheet over a fake lib whose backend checks the delete's
//          `expectedSheetId` the way sheets.rs does: the id travels with the
//          index from ONE read; a temporary sheet's discard landing between
//          that read and the delete is refused (nothing deleted) and reaches
//          the script as an error naming the sheet and the backend's own
//          reason; a list without ids is refused rather than deleted unguarded;
//          the door itself runs through the executor.
// CONTEXT: A sheet delete ends the undo history, so a wrong delete cannot be
//          taken back. The scenario: Sales, Drillthrough (temporary, active),
//          Costs, Summary; a macro switches to Sales and deletes "Costs". The
//          switch's announcement makes the tab strip read the list and send
//          the temporary sheet's discard; the macro's own read can still
//          answer the list from before it, so "Costs" resolves to index 2 --
//          and by the time the delete arrives, index 2 is Summary.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { executeDeleteSheet } from "../host";
import { BrokerError } from "../broker";
import type { SheetInfo, SheetsResult } from "../../lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

/** The backend's refusal of a delete whose index no longer names the expected sheet (sheets.rs). */
const SHEETS_CHANGED = "The sheets changed while that sheet was being deleted, so nothing was deleted.";

interface ModelSheet {
  id: string;
  name: string;
}

/**
 * A backend model: `getSheets` answers the list as it stands, `deleteSheet`
 * refuses -- deleting nothing -- when `expectedSheetId` no longer names the
 * sheet at `index`, and `discard` removes a sheet behind the script's back.
 */
function makeBackend(names: string[]) {
  let sheets: ModelSheet[] = names.map((name) => ({ id: `id-${name}`, name }));
  const list = (): SheetsResult => ({
    sheets: sheets.map((s, index): SheetInfo => ({ index, name: s.name, visibility: "visible", sheetId: s.id })),
    activeIndex: 0,
  });
  const lib = {
    getSheets: vi.fn(async () => list()),
    deleteSheet: vi.fn(async (index: number, options?: { expectedSheetId?: string }) => {
      if (!Number.isInteger(index) || index < 0 || index >= sheets.length) throw `Sheet index ${index} out of range`;
      if (options?.expectedSheetId !== undefined && sheets[index].id !== options.expectedSheetId) throw SHEETS_CHANGED;
      sheets = sheets.filter((_, i) => i !== index);
      return list();
    }),
  };
  return {
    lib,
    names: () => sheets.map((s) => s.name),
    /** A temporary sheet's discard lands: every sheet after it moves down an index. */
    discard: (name: string) => {
      sheets = sheets.filter((s) => s.name !== name);
    },
    /** The NEXT read answers the list as it is now, and the discard lands right after it answered. */
    discardAfterNextRead: (name: string) => {
      lib.getSheets.mockImplementationOnce(async () => {
        const answered = list();
        sheets = sheets.filter((s) => s.name !== name);
        return answered;
      });
    },
  };
}

const LAYOUT = ["Sales", "Drillthrough", "Costs", "Summary"];

describe("executeDeleteSheet -- the delete names its sheet by the id read WITH the index", () => {
  it("passes the stable id of the row its ref resolved to, from the same read", async () => {
    const b = makeBackend(LAYOUT);
    await executeDeleteSheet(asLib(b.lib), "Costs");
    expect(b.lib.deleteSheet).toHaveBeenCalledTimes(1);
    expect(b.lib.deleteSheet).toHaveBeenCalledWith(2, { expectedSheetId: "id-Costs" });
    expect(b.names()).toEqual(["Sales", "Drillthrough", "Summary"]);
  });

  it("an INDEX ref means the sheet the script saw there: its id travels too", async () => {
    const b = makeBackend(LAYOUT);
    await executeDeleteSheet(asLib(b.lib), 3);
    expect(b.lib.deleteSheet).toHaveBeenCalledWith(3, { expectedSheetId: "id-Summary" });
    expect(b.names()).toEqual(["Sales", "Drillthrough", "Costs"]);
  });

  it("a discard landing between the read and the delete: REFUSED, nothing deleted -- Summary, which slid into the index, survives", async () => {
    const b = makeBackend(LAYOUT);
    b.discardAfterNextRead("Drillthrough");
    const outcome = executeDeleteSheet(asLib(b.lib), "Costs");
    await expect(outcome).rejects.toBeInstanceOf(BrokerError);
    await expect(outcome).rejects.toMatchObject({ code: "HostError" });
    // The script's error names the sheet it asked for and the backend's own reason.
    await expect(outcome).rejects.toThrow(`deleteSheet: sheet "Costs" was not deleted: ${SHEETS_CHANGED}`);
    expect(b.lib.deleteSheet).toHaveBeenCalledWith(2, { expectedSheetId: "id-Costs" });
    expect(b.names(), "a sheet was deleted after all").toEqual(["Sales", "Costs", "Summary"]);
  });

  it("the same for an index ref: the sheet at 2 when the script read it was Costs, and nothing else is deleted", async () => {
    const b = makeBackend(LAYOUT);
    b.discardAfterNextRead("Drillthrough");
    await expect(executeDeleteSheet(asLib(b.lib), 2)).rejects.toThrow(/sheet "Costs" was not deleted/);
    expect(b.names()).toEqual(["Sales", "Costs", "Summary"]);
  });

  it("a renumbering that lands BEFORE the read is no conflict: the fresh read resolves the name to its new index", async () => {
    const b = makeBackend(LAYOUT);
    b.discard("Drillthrough");
    await executeDeleteSheet(asLib(b.lib), "Costs");
    expect(b.lib.deleteSheet).toHaveBeenCalledWith(1, { expectedSheetId: "id-Costs" });
    expect(b.names()).toEqual(["Sales", "Summary"]);
  });

  it("any refusal of the delete reaches the script naming the sheet, with nothing deleted", async () => {
    const b = makeBackend(LAYOUT);
    b.lib.deleteSheet.mockImplementationOnce(async () => {
      throw "Cannot delete the last visible sheet";
    });
    await expect(executeDeleteSheet(asLib(b.lib), "Summary")).rejects.toThrow(
      'deleteSheet: sheet "Summary" was not deleted: Cannot delete the last visible sheet',
    );
    expect(b.names()).toEqual(LAYOUT);
  });

  it("a list without the sheet's id is refused rather than deleted unguarded", async () => {
    const b = makeBackend(LAYOUT);
    b.lib.getSheets.mockImplementationOnce(async () => ({
      sheets: LAYOUT.map((name, index): SheetInfo => ({ index, name, visibility: "visible" })),
      activeIndex: 0,
    }));
    const outcome = executeDeleteSheet(asLib(b.lib), "Costs");
    await expect(outcome).rejects.toMatchObject({ code: "HostError" });
    await expect(outcome).rejects.toThrow(/did not report which sheet "Costs" is, so nothing was deleted/);
    expect(b.lib.deleteSheet).not.toHaveBeenCalled();
    expect(b.names()).toEqual(LAYOUT);
  });

  it("keeps its old refusals: the last remaining sheet, and a ref that names no sheet", async () => {
    const one = makeBackend(["Only"]);
    await expect(executeDeleteSheet(asLib(one.lib), "Only")).rejects.toMatchObject({
      code: "ValidationError",
      message: "Cannot delete the last remaining sheet",
    });
    expect(one.lib.deleteSheet).not.toHaveBeenCalled();
    const b = makeBackend(LAYOUT);
    await expect(executeDeleteSheet(asLib(b.lib), "Nope")).rejects.toMatchObject({ code: "ValidationError" });
    expect(b.lib.deleteSheet).not.toHaveBeenCalled();
  });
});

describe("the api.deleteSheet door runs through executeDeleteSheet", () => {
  it("the case delegates the delete (and resumes the batch, announces) -- it no longer deletes by the bare index itself", () => {
    const host = readFileSync(resolve(__dirname, "../host.ts"), "utf8");
    const at = host.indexOf('    case "api.deleteSheet": {');
    expect(at, "the api.deleteSheet door is gone").toBeGreaterThan(-1);
    const body = host.slice(at, host.indexOf("\n    }\n", at));
    expect(body).toMatch(/const result = await executeDeleteSheet\(lib, ref\);/);
    expect(body).not.toMatch(/lib\.deleteSheet\(/);
  });
});

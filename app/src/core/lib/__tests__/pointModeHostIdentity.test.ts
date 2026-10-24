//! FILENAME: app/src/core/lib/__tests__/pointModeHostIdentity.test.ts
// PURPOSE: An external edit session (a floating grid's cell edit) follows its
//          HOST sheet by the sheet's identity (its name) when the sheets are
//          renumbered under it: parking, the return to the host on Enter /
//          Escape, and the return when its owner goes away.
// CONTEXT: Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT. The owner's
//          `session.hostSheetIndex` is the host's index when the edit OPENED.
//          A temporary sheet's discard (or an MCP / script delete) renumbered
//          the host underneath it: a point-mode trip to the sheet that slid
//          into the old index UN-parked the edit on a foreign sheet, and Enter
//          "returned" to that index -- another sheet -- and un-parked there.
//          Driven through the REAL point-mode switch and the real external-edit
//          store, against a fake backend that holds a sheet list and an active
//          sheet. Sheets: Sales, Drillthrough (temporary), Costs, Summary (the
//          floating grid's host), Extra.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const backend = vi.hoisted(() => {
  const b = {
    sheets: [] as string[],
    /** Each sheet's STABLE id, parallel to `sheets`; null = a backend that reports none. */
    ids: null as string[] | null,
    active: 0,
    switches: [] as number[],
    reads: 0,
    list() {
      return {
        sheets: b.sheets.map((name, index) => ({
          index,
          name,
          visibility: "visible" as const,
          ...(b.ids ? { sheetId: b.ids[index] } : {}),
        })),
        activeIndex: b.active,
      };
    },
    remove(at: number) {
      b.sheets.splice(at, 1);
      b.ids?.splice(at, 1);
      if (b.active > at) b.active -= 1;
    },
    rename(at: number, name: string) {
      b.sheets[at] = name;
    },
  };
  return b;
});

vi.mock("../tauri-api", () => ({
  getSheets: vi.fn(async () => {
    backend.reads += 1;
    return backend.list();
  }),
  setActiveSheet: vi.fn(async (index: number) => {
    backend.switches.push(index);
    if (index < 0 || index >= backend.sheets.length) throw new Error(`Sheet index ${index} is out of range`);
    backend.active = index;
    return backend.list();
  }),
}));

// Core's grid snapshot: the sheet the grid SHOWS (its context), which is the
// host while the session is not parked.
const grid = vi.hoisted(() => ({
  snapshot: null as null | { sheetContext: { activeSheetIndex: number; activeSheetName: string; activeSheetId?: string } },
}));
vi.mock("../../state/GridContext", () => ({
  getGridStateSnapshot: () => grid.snapshot,
}));

import {
  switchSheetForPointMode,
  endExternalFormulaSession,
  returnParkedViewToHost,
  followShownSheetForExternalSession,
} from "../pointModeSheetSwitch";
import {
  isExternalSessionParked,
  getExternalSessionHostIndex,
  getExternalSessionHostName,
  getCrossSheetPointModeKey,
  getParkedViewSheetIndex,
  isExternalSessionHostSheet,
  setExternalSessionParked,
  noteExternalSessionHost,
  __resetExternalEditForTests,
} from "../formulaEditTarget";
import { createFakeExternalEdit } from "./helpers/fakeExternalEdit";
import { setActiveSheet } from "../../state/gridActions";

const dispatch = vi.fn();

function showing(index: number, name: string): void {
  grid.snapshot = { sheetContext: { activeSheetIndex: index, activeSheetName: name } };
}

/** A floating grid's edit opened on Summary (sheet 3); the grid shows Summary. */
function openOnSummary() {
  const fake = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
  fake.register();
  showing(3, "Summary");
  return fake;
}

beforeEach(() => {
  backend.sheets = ["Sales", "Drillthrough", "Costs", "Summary", "Extra"];
  backend.ids = null;
  backend.active = 3;
  backend.switches = [];
  backend.reads = 0;
  dispatch.mockReset();
  __resetExternalEditForTests();
});

afterEach(() => {
  __resetExternalEditForTests();
  grid.snapshot = null;
});

describe("the host renumbered while the edit is ON it (the discard landed)", () => {
  it("a trip to the sheet that slid into the host's OLD index parks the edit, and Enter returns to the host's NEW index", async () => {
    const fake = openOnSummary();
    // The discard lands: Drillthrough goes, Summary 3 -> 2, Extra slides into 3;
    // the strip moves Core's context to Summary at 2.
    backend.remove(1);
    showing(2, "Summary");

    await switchSheetForPointMode(3, dispatch); // the user picks on Extra
    expect(isExternalSessionParked(), "the edit stayed un-parked on a sheet that is not its host").toBe(true);
    expect(fake.session.parkedFlips).toEqual([true]);
    expect(getExternalSessionHostIndex()).toBe(2);
    expect(getExternalSessionHostName()).toBe("Summary");

    backend.switches = [];
    expect(await endExternalFormulaSession("commit", "down", dispatch)).toBe(true);
    expect(backend.switches, "the return went to the host's old index").toEqual([2]);
    expect(fake.session.parkedFlips).toEqual([true, false]);
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: ["down"] }]);
  });

  it("the tab strip's point-mode key carries the host's index as Core found it", async () => {
    openOnSummary();
    backend.remove(1);
    showing(2, "Summary");
    await switchSheetForPointMode(3, dispatch);
    expect(getCrossSheetPointModeKey()).toMatch(/^2:1:/);
  });
});

describe("the host renumbered while the edit is PARKED on another sheet", () => {
  it("Enter returns to the host by NAME at its new index -- never to its old one", async () => {
    const fake = openOnSummary();
    await switchSheetForPointMode(0, dispatch); // parked on Sales; the host learned as Summary@3
    expect(isExternalSessionParked()).toBe(true);

    backend.remove(1); // a script deletes Drillthrough: Summary 3 -> 2, Extra slides into 3
    backend.switches = [];

    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(backend.switches, "the return went to the host's old index (now Extra)").toEqual([2]);
    expect(isExternalSessionParked()).toBe(false);
    expect(fake.session.parkedFlips).toEqual([true, false]);
    expect(fake.calls.filter((c) => c.fn === "commit")).toHaveLength(1);
  });

  it("Escape returns there as well", async () => {
    const fake = openOnSummary();
    await switchSheetForPointMode(0, dispatch);
    backend.remove(1);
    backend.switches = [];

    expect(await endExternalFormulaSession("cancel", null, dispatch)).toBe(true);
    expect(backend.switches).toEqual([2]);
    expect(fake.calls.map((c) => c.fn)).toEqual(["cancel"]);
  });

  it("a click on the host's tab at its NEW index un-parks; one on the sheet at its OLD index does not", async () => {
    const fake = openOnSummary();
    await switchSheetForPointMode(0, dispatch);
    backend.remove(1);

    await switchSheetForPointMode(3, dispatch); // Extra, at the host's old index
    expect(isExternalSessionParked(), "a foreign sheet at the host's old index un-parked the edit").toBe(true);
    expect(getExternalSessionHostIndex(), "the host's index was not re-found in the switch's fresh list").toBe(2);
    await switchSheetForPointMode(2, dispatch); // Summary, at its new index
    expect(isExternalSessionParked(), "the host at its new index stayed parked").toBe(false);
    expect(fake.session.parkedFlips).toEqual([true, false]);
  });

  it("the host DELETED: no switch to its old index; parked is cleared and the owner's commit still runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = openOnSummary();
    await switchSheetForPointMode(0, dispatch);
    backend.remove(3); // Summary goes; Extra slides into 3
    backend.switches = [];

    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(backend.switches, "the return switched to the host's old index").toEqual([]);
    expect(isExternalSessionParked()).toBe(false);
    expect(fake.calls.filter((c) => c.fn === "commit")).toHaveLength(1);
    warn.mockRestore();
  });

  it("the host DELETED: a trip to the sheet that slid into its old index keeps the edit PARKED (by name)", async () => {
    const fake = openOnSummary();
    await switchSheetForPointMode(0, dispatch); // parked on Sales; the host learned as Summary@3
    backend.remove(3); // Summary goes; Extra slides into 3

    await switchSheetForPointMode(3, dispatch); // Extra
    expect(isExternalSessionParked(), "a foreign sheet at the deleted host's old index un-parked the edit").toBe(true);
    expect(fake.session.parkedFlips).toEqual([true]);
  });

  it("returnParkedViewToHost (the owner going away) returns to the host's new index, even with the session torn down right after the call", async () => {
    const fake = openOnSummary();
    await switchSheetForPointMode(0, dispatch);
    backend.remove(1);
    backend.switches = [];

    const returning = returnParkedViewToHost(dispatch);
    fake.session.cancel(); // the owner's synchronous teardown, as FloatingRange's deactivate does
    expect(await returning).toBe(true);
    expect(backend.switches, "the return went to the host's old index").toEqual([2]);
  });
});

describe("controls: what has not changed", () => {
  it("a session whose host name Core never learned (no grid snapshot) keeps the index rule, with no extra sheet read", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
    fake.register();
    await switchSheetForPointMode(0, dispatch);
    expect(isExternalSessionParked()).toBe(true);
    backend.switches = [];
    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(backend.switches).toEqual([3]);
    expect(backend.reads).toBe(0);
  });

  it("parking without a viewed name falls back to the host's index as Core last found it", () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
    fake.register();
    noteExternalSessionHost(2, "Summary");
    setExternalSessionParked(3);
    expect(isExternalSessionParked()).toBe(true);
    setExternalSessionParked(2);
    expect(isExternalSessionParked()).toBe(false);
    expect(fake.session.parkedFlips).toEqual([true, false]);
  });

  it("a new registration forgets the previous session's host", () => {
    const first = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
    first.register();
    noteExternalSessionHost(2, "Summary");
    const second = createFakeExternalEdit({ hostSheetIndex: 0, text: "=" });
    second.register();
    expect(getExternalSessionHostName()).toBeNull();
    expect(getExternalSessionHostIndex()).toBe(0);
  });
});

// Review F1-rename-refuses-entry / F3-strip-uses-owner-host-index (round 5):
// the host is followed by its STABLE id when the grid's context carries one,
// so a RENAME of the host while parked is followed; and the tab strip asks
// `isExternalSessionHostSheet` of a tab -- by identity -- instead of comparing
// the owner's opening index.
describe("the host followed by its STABLE id (a backend that reports ids)", () => {
  const IDS = ["S-sales", "S-drill", "S-costs", "S-summary", "S-extra"];

  /** A floating grid's edit opened on Summary (sheet 3); the grid shows Summary WITH its id. */
  function openOnSummaryWithIds() {
    backend.ids = [...IDS];
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
    fake.register();
    grid.snapshot = { sheetContext: { activeSheetIndex: 3, activeSheetName: "Summary", activeSheetId: "S-summary" } };
    return fake;
  }

  it("the host RENAMED while parked: Enter returns to it by id -- it is not taken for gone", async () => {
    const fake = openOnSummaryWithIds();
    await switchSheetForPointMode(0, dispatch); // parked on Sales; the host learned as Summary@3, S-summary
    backend.rename(3, "Totals"); // an MCP / script rename
    backend.switches = [];

    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(backend.switches, "the renamed host was taken for a deleted one").toEqual([3]);
    expect(isExternalSessionParked()).toBe(false);
    expect(fake.session.parkedFlips).toEqual([true, false]);
  });

  it("a trip to the RENAMED host un-parks the edit (by id), and Core learns the host's new name", async () => {
    const fake = openOnSummaryWithIds();
    await switchSheetForPointMode(0, dispatch);
    backend.rename(3, "Totals");
    await switchSheetForPointMode(3, dispatch);
    expect(isExternalSessionParked(), "the renamed host stayed parked").toBe(false);
    expect(fake.session.parkedFlips).toEqual([true, false]);
    expect(getExternalSessionHostName()).toBe("Totals");
  });

  it("isExternalSessionHostSheet after PARK-THEN-RENUMBER (no switch since): the host's tab at its NEW index is the host; the sheet at its OLD index is not", async () => {
    openOnSummaryWithIds();
    await switchSheetForPointMode(0, dispatch);
    backend.remove(1); // Summary 3 -> 2, Extra slides into 3 -- Core's own host index is still 3
    expect(getExternalSessionHostIndex(), "precondition: no switch has re-found the host yet").toBe(3);
    expect(isExternalSessionHostSheet({ index: 2, name: "Summary", sheetId: "S-summary" })).toBe(true);
    expect(isExternalSessionHostSheet({ index: 3, name: "Extra", sheetId: "S-extra" })).toBe(false);
  });

  it("isExternalSessionHostSheet after PARK-THEN-RENAME: the renamed host is the host; a namesake with another id is not", async () => {
    openOnSummaryWithIds();
    await switchSheetForPointMode(0, dispatch);
    expect(isExternalSessionHostSheet({ index: 3, name: "Totals", sheetId: "S-summary" })).toBe(true);
    expect(isExternalSessionHostSheet({ index: 3, name: "Summary", sheetId: "S-new" })).toBe(false);
  });

  it("isExternalSessionHostSheet without ids decides by name; before Core learned the host, by the owner's index; with no session, never", async () => {
    openOnSummary(); // no ids anywhere
    await switchSheetForPointMode(0, dispatch);
    backend.remove(1);
    expect(isExternalSessionHostSheet({ index: 2, name: "Summary" })).toBe(true);
    expect(isExternalSessionHostSheet({ index: 3, name: "Extra" })).toBe(false);

    __resetExternalEditForTests();
    grid.snapshot = null;
    createFakeExternalEdit({ hostSheetIndex: 3, text: "=" }).register(); // never parked: nothing learned
    expect(isExternalSessionHostSheet({ index: 3, name: "Summary" })).toBe(true);
    expect(isExternalSessionHostSheet({ index: 2, name: "Costs" })).toBe(false);

    __resetExternalEditForTests();
    expect(isExternalSessionHostSheet({ index: 3, name: "Summary" })).toBe(false);
  });
});

describe("the point-mode switch hands Core the landed sheet's STABLE id", () => {
  it("the context dispatch carries the id (an open edit follows its sheet by it); a list without ids carries none", async () => {
    backend.ids = ["S-sales", "S-drill", "S-costs", "S-summary", "S-extra"];
    await switchSheetForPointMode(2, dispatch);
    expect(dispatch).toHaveBeenCalledWith(setActiveSheet(2, "Costs", "grid", "S-costs"));
    dispatch.mockClear();
    backend.ids = null;
    await switchSheetForPointMode(0, dispatch);
    expect(dispatch).toHaveBeenCalledWith(setActiveSheet(0, "Sales", "grid"));
  });
});

// Review FR-RESYNC-COMMITS-ON-RENUMBER (round 6): Core learned the host only on
// the session's FIRST trip away, so a renumbering before that trip -- an MCP
// delete above the host, a temporary sheet's discard -- left every decision on
// the owner's opening index. The owner names its host's STABLE id with the
// session (`hostSheetId`), and Core decides by it from the first moment.
describe("the owner hands Core its host's STABLE id at registration", () => {
  const IDS = ["S-sales", "S-drill", "S-costs", "S-summary", "S-extra"];

  /** A floating grid's edit opened on Summary (sheet 3), its owner naming Summary's id; NO grid snapshot to learn from. */
  function openOnSummaryNamedById() {
    backend.ids = [...IDS];
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, hostSheetId: "S-summary", text: "=" });
    fake.register();
    return fake;
  }

  it("a renumbering BEFORE the first trip: a trip to the sheet that slid into the host's opening index PARKS, and Enter returns to the host's new index", async () => {
    const fake = openOnSummaryNamedById();
    backend.remove(1); // Summary 3 -> 2, Extra slides into 3
    await switchSheetForPointMode(3, dispatch); // Extra
    expect(isExternalSessionParked(), "the edit un-parked on the sheet at its host's opening index").toBe(true);
    expect(fake.session.parkedFlips).toEqual([true]);

    backend.switches = [];
    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(backend.switches, "the return went to the host's opening index").toEqual([2]);
    expect(fake.session.parkedFlips).toEqual([true, false]);
  });

  it("isExternalSessionHostSheet decides by the owner's id before any trip: the host's tab at its new index, not the tab at its opening one", () => {
    openOnSummaryNamedById();
    backend.remove(1);
    expect(isExternalSessionHostSheet({ index: 2, name: "Summary", sheetId: "S-summary" })).toBe(true);
    expect(isExternalSessionHostSheet({ index: 3, name: "Extra", sheetId: "S-extra" })).toBe(false);
  });

  it("a host known ONLY by the owner's id (no trip ever named it): the return looks it up by that id in a fresh list", async () => {
    const fake = openOnSummaryNamedById();
    // Parked without a switch's fresh list (the park alone, as a test of the
    // lookup): Core knows the host by nothing but the owner's id.
    setExternalSessionParked(0, "Sales", "S-sales");
    expect(getExternalSessionHostName(), "precondition: the host's name was never learned").toBeNull();
    backend.remove(1); // Summary 3 -> 2
    backend.switches = [];
    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(backend.switches, "the return trusted the owner's opening index instead of looking the id up").toEqual([2]);
    expect(fake.calls.filter((c) => c.fn === "commit")).toHaveLength(1);
  });

  it("a note naming ANOTHER stable id than the owner's is about another sheet, and is ignored", () => {
    openOnSummaryNamedById();
    noteExternalSessionHost(0, "Sales", "S-sales");
    expect(getExternalSessionHostIndex(), "another sheet was taken for the owner's host").toBe(3);
    expect(getExternalSessionHostName()).toBeNull();
    noteExternalSessionHost(2, "Summary", "S-summary");
    expect(getExternalSessionHostIndex()).toBe(2);
    expect(getExternalSessionHostName()).toBe("Summary");
  });

  it("a list that carries NO ids cannot be compared with an id-only host: the old index rule -- never 'the host is gone'", async () => {
    backend.ids = null;
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, hostSheetId: "S-summary", text: "=" });
    fake.register();
    await switchSheetForPointMode(0, dispatch);
    expect(isExternalSessionParked()).toBe(true);
    backend.switches = [];
    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(backend.switches, "an id it could not look up was taken for a deleted host").toEqual([3]);
    expect(fake.calls.filter((c) => c.fn === "commit")).toHaveLength(1);
  });
});

// Review FR-RESYNC-COMMITS-ON-RENUMBER (round 6): the PARKED VIEW was a bare
// index nothing followed, and an un-parked session's host was learned only on
// a trip. Every door that moves the grid -- a discard, a script's or an MCP
// tool's delete, move or rename, a script's activateSheet -- dispatches the
// sheet context with the sheet's stable id; useEditing.ts hands each rendered
// context to `followShownSheetForExternalSession`.
describe("the session follows the sheet the GRID is moved to (followShownSheetForExternalSession)", () => {
  const IDS = ["S-sales", "S-drill", "S-costs", "S-summary", "S-extra"];

  /** The owner names Summary (sheet 3) by id; the edit is parked on Extra (sheet 4). */
  async function parkedOnExtra() {
    backend.ids = [...IDS];
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, hostSheetId: "S-summary", text: "=" });
    fake.register();
    await switchSheetForPointMode(4, dispatch);
    expect(getParkedViewSheetIndex(), "precondition: parked on Extra").toBe(4);
    return fake;
  }

  it("PARKED, the VIEWED sheet renumbered (its context at its new index): the park follows it -- no flip, nothing ended", async () => {
    const fake = await parkedOnExtra();
    backend.remove(1); // Extra 4 -> 3, Summary 3 -> 2
    followShownSheetForExternalSession({ activeSheetIndex: 3, activeSheetName: "Extra", activeSheetId: "S-extra" });
    expect(isExternalSessionParked()).toBe(true);
    expect(getParkedViewSheetIndex(), "the parked view kept the index the renumbering took from it").toBe(3);
    expect(fake.session.parkedFlips).toEqual([true]);
    expect(fake.calls.filter((c) => c.fn === "commit" || c.fn === "cancel")).toEqual([]);
  });

  it("PARKED, the grid moved back to the HOST (a script activated it, at its new index): un-parked by id", async () => {
    const fake = await parkedOnExtra();
    backend.remove(1);
    followShownSheetForExternalSession({ activeSheetIndex: 2, activeSheetName: "Summary", activeSheetId: "S-summary" });
    expect(isExternalSessionParked(), "the grid shows the host and the edit stayed parked").toBe(false);
    expect(fake.session.parkedFlips).toEqual([true, false]);
  });

  it("PARKED, the grid moved to a THIRD sheet: the park is re-pointed there and the edit survives", async () => {
    const fake = await parkedOnExtra();
    followShownSheetForExternalSession({ activeSheetIndex: 2, activeSheetName: "Costs", activeSheetId: "S-costs" });
    expect(isExternalSessionParked()).toBe(true);
    expect(getParkedViewSheetIndex()).toBe(2);
    expect(fake.session.parkedFlips).toEqual([true]);
    expect(fake.calls.filter((c) => c.fn === "commit" || c.fn === "cancel")).toEqual([]);
  });

  it("NOT PARKED, the host renumbered and renamed under the edit (by id): Core follows its index and its name", () => {
    backend.ids = [...IDS];
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, hostSheetId: "S-summary", text: "=" });
    fake.register();
    followShownSheetForExternalSession({ activeSheetIndex: 2, activeSheetName: "Totals", activeSheetId: "S-summary" });
    expect(getExternalSessionHostIndex(), "the host's index was not followed").toBe(2);
    expect(getExternalSessionHostName()).toBe("Totals");
    expect(getCrossSheetPointModeKey()).toMatch(/^2:0:/);
    expect(isExternalSessionParked()).toBe(false);
    expect(fake.session.parkedFlips).toEqual([]);
  });

  it("NOT PARKED, the grid moved to ANOTHER sheet: never parked from here, the host untouched (a switch away is the owner's to commit)", () => {
    backend.ids = [...IDS];
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, hostSheetId: "S-summary", text: "=" });
    fake.register();
    followShownSheetForExternalSession({ activeSheetIndex: 0, activeSheetName: "Sales", activeSheetId: "S-sales" });
    expect(isExternalSessionParked(), "a switch away parked the edit instead of leaving it to its owner").toBe(false);
    expect(fake.session.parkedFlips).toEqual([]);
    expect(getExternalSessionHostIndex()).toBe(3);
    expect(getExternalSessionHostName(), "another sheet was learned as the host").toBeNull();
  });

  it("a context that names neither a sheet nor an id changes nothing; with no session nothing happens", async () => {
    const fake = await parkedOnExtra();
    followShownSheetForExternalSession({ activeSheetIndex: 3 });
    expect(getParkedViewSheetIndex()).toBe(4);
    expect(fake.session.parkedFlips).toEqual([true]);

    __resetExternalEditForTests();
    followShownSheetForExternalSession({ activeSheetIndex: 2, activeSheetName: "Costs", activeSheetId: "S-costs" });
    expect(isExternalSessionParked()).toBe(false);
  });
});
